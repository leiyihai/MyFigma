use crate::{Project, Result, layout};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, RgbaImage};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
};

const SCAN_SCHEMA_VERSION: u32 = 3;
const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// Restored sprites and atlas sheets share one dimension limit so a large
/// project is scanned whole rather than silently truncated.
const MAX_IMAGE_DIMENSION: u32 = 4096;
const MAX_SCAN_ENTRIES: u64 = 200_000;
const MAX_RESOURCES: usize = 20_000;
const MAX_TOTAL_PIXELS: u64 = 1_000_000_000;

fn small_file(path: &Path, max: u64) -> Result<Vec<u8>> {
    let file = fs::File::open(path).map_err(|_| "文件不可读")?;
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "文件不可读")?;
    if bytes.len() as u64 > max {
        return Err("文件超过扫描大小上限");
    }
    Ok(bytes)
}
fn within(root: &Path, path: &Path) -> Result<PathBuf> {
    let resolved = path.canonicalize().map_err(|_| "资源不存在")?;
    if !resolved.starts_with(root) {
        return Err("拒绝项目外资源");
    }
    Ok(resolved)
}
fn number(value: &Value, key: &str) -> Result<u32> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|v| v.try_into().ok())
        .ok_or("帧坐标或尺寸无效")
}
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.contains(['\\', ':'])
        && !name.starts_with('/')
        && !name.split('/').any(|p| p == "..")
        && !name.chars().any(char::is_control)
}
/// Portable path relative to the scan scope. Every segment is validated so the
/// value can travel to Figma without local directory information.
fn relative_path(scope: &Path, path: &Path) -> Result<String> {
    let relative = path.strip_prefix(scope).map_err(|_| "资源不在扫描范围")?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str().ok_or("资源名无效")?),
            _ => return Err("资源名无效"),
        }
    }
    let joined = parts.join("/");
    if !safe_name(&joined) {
        return Err("资源名无效");
    }
    Ok(joined)
}
fn decode_png(bytes: Vec<u8>) -> Result<RgbaImage> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map(|image| image.into_rgba8())
        .map_err(|_| "PNG 无效或超过 4096 像素限制")
}
fn encode_png(image: &RgbaImage) -> Result<String> {
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| "PNG 编码失败")?;
    Ok(STANDARD.encode(png.into_inner()))
}
fn restore(
    project: &Project,
    relative: &str,
    name: &str,
    frame: &Value,
    atlas: &RgbaImage,
) -> Result<Value> {
    if !safe_name(name) {
        return Err("散图名无效");
    }
    if frame.get("rotated").is_some_and(|v| v != false) {
        return Err("不支持旋转帧");
    }
    let rect = &frame["frame"];
    let (x, y, w, h) = (
        number(rect, "x")?,
        number(rect, "y")?,
        number(rect, "w")?,
        number(rect, "h")?,
    );
    let source = frame.get("sourceSize");
    let sw = source.map(|v| number(v, "w")).transpose()?.unwrap_or(w);
    let sh = source.map(|v| number(v, "h")).transpose()?.unwrap_or(h);
    let offset = frame
        .get("spriteSourceSize")
        .or_else(|| frame.get("offset"));
    if frame.get("trimmed") == Some(&Value::Bool(true)) && (source.is_none() || offset.is_none()) {
        return Err("裁切帧缺少原始尺寸或偏移");
    }
    let ox = offset.map(|v| number(v, "x")).transpose()?.unwrap_or(0);
    let oy = offset.map(|v| number(v, "y")).transpose()?.unwrap_or(0);
    if w == 0
        || h == 0
        || sw == 0
        || sh == 0
        || sw > MAX_IMAGE_DIMENSION
        || sh > MAX_IMAGE_DIMENSION
        || x.checked_add(w).is_none_or(|v| v > atlas.width())
        || y.checked_add(h).is_none_or(|v| v > atlas.height())
        || ox.checked_add(w).is_none_or(|v| v > sw)
        || oy.checked_add(h).is_none_or(|v| v > sh)
    {
        return Err("帧越界或超过 4096 像素限制");
    }
    let mut restored = RgbaImage::new(sw, sh);
    for dy in 0..h {
        for dx in 0..w {
            restored.put_pixel(ox + dx, oy + dy, *atlas.get_pixel(x + dx, y + dy));
        }
    }
    Ok(
        json!({"width":sw,"height":sh,"png":encode_png(&restored)?,"source":{
            "schemaVersion":1,"projectId":project.id,"kind":"atlas","relativePath":relative,"frameName":name,
            "identity":serde_json::to_string(&json!([project.id,"atlas",relative,name])).map_err(|_| "身份编码失败")?,
            "engineReference":format!("set:{relative} image:{name}"),"sourceSize":{"w":sw,"h":sh},
            "crop":{"x":x,"y":y,"w":w,"h":h},"offset":{"x":ox,"y":oy}
        }}),
    )
}
/// A PNG that no atlas consumes is its own source asset; crop is the whole
/// image and offset is zero, so it shares the main-component source record.
fn standalone(project: &Project, root: &Path, path: &Path) -> Result<Value> {
    let relative = relative_path(root, path)?;
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("资源名无效")?;
    if !safe_name(name) {
        return Err("散图名无效");
    }
    let bytes = small_file(&within(root, path)?, MAX_IMAGE_BYTES)?;
    let image = decode_png(bytes)?;
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return Err("图片尺寸无效");
    }
    Ok(
        json!({"width":w,"height":h,"png":encode_png(&image)?,"source":{
            "schemaVersion":1,"projectId":project.id,"kind":"standalone","relativePath":relative,"frameName":name,
            "identity":serde_json::to_string(&json!([project.id,"standalone",relative])).map_err(|_| "身份编码失败")?,
            "engineReference":format!("image:{relative}"),"sourceSize":{"w":w,"h":h},
            "crop":{"x":0,"y":0,"w":w,"h":h},"offset":{"x":0,"y":0}
        }}),
    )
}

/// Registration stays compatible: a game root that holds `res/imageset` is
/// scanned from that private imageset directory, otherwise the registered
/// directory is the scan scope itself.
fn scan_scope(root: &Path) -> (PathBuf, String) {
    let imageset = root.join("res").join("imageset");
    match imageset.canonicalize() {
        Ok(path) if path.is_dir() && path.starts_with(root) => (path, "res/imageset".to_string()),
        _ => (root.to_path_buf(), ".".to_string()),
    }
}

struct Found {
    atlases: Vec<PathBuf>,
    images: Vec<PathBuf>,
    links: u64,
    entries: u64,
    errors: Vec<String>,
    truncated: bool,
}

fn finish(mut found: Found, root: &Path) -> Found {
    found
        .atlases
        .sort_by_key(|path| relative_path(root, path).unwrap_or_default());
    found
        .images
        .sort_by_key(|path| relative_path(root, path).unwrap_or_default());
    found
}

fn collect(root: &Path) -> Found {
    let mut found = Found {
        atlases: Vec::new(),
        images: Vec::new(),
        links: 0,
        entries: 0,
        errors: Vec::new(),
        truncated: false,
    };
    let mut stack = vec![(root.to_path_buf(), 0u32)];
    while let Some((directory, depth)) = stack.pop() {
        let label = relative_path(root, &directory).unwrap_or_else(|_| ".".to_string());
        if depth > 32 {
            found
                .errors
                .push(format!("目录 {label}：层级超过 32 层，已跳过"));
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                found.errors.push(format!("目录 {label}：不可读"));
                continue;
            }
        };
        for entry in entries {
            if found.entries >= MAX_SCAN_ENTRIES {
                found
                    .errors
                    .push("扫描条目超过上限，结果不完整".to_string());
                found.truncated = true;
                return finish(found, root);
            }
            found.entries += 1;
            let Ok(entry) = entry else {
                found.errors.push(format!("目录 {label}：存在不可读条目"));
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                found.errors.push(format!("目录 {label}：存在不可读条目"));
                continue;
            };
            let path = entry.path();
            if file_type.is_symlink() {
                // Never follow links: they can leave the registered project.
                found.links += 1;
            } else if file_type.is_dir() {
                stack.push((path, depth + 1));
            } else if file_type.is_file() {
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default();
                if extension.eq_ignore_ascii_case("json") {
                    found.atlases.push(path);
                } else if extension.eq_ignore_ascii_case("png") {
                    found.images.push(path);
                }
            }
        }
    }
    finish(found, root)
}

fn limit_error(resources: usize, pixels: u64, width: u64, height: u64) -> Option<&'static str> {
    if resources >= MAX_RESOURCES {
        return Some("资源数量超过单次扫描上限");
    }
    if pixels.saturating_add(width.saturating_mul(height)) > MAX_TOTAL_PIXELS {
        return Some("恢复像素总量超过单次扫描上限");
    }
    None
}

#[derive(Default)]
struct ScanState {
    resources: Vec<Value>,
    errors: Vec<String>,
    pixels: u64,
    atlas_frames: usize,
    /// Sheets already consumed by an atlas, keyed by canonical path so a packed
    /// sheet is never re-imported as a standalone image.
    claimed: HashSet<PathBuf>,
    truncated: bool,
}

fn read_atlas(project: &Project, root: &Path, path: &Path, state: &mut ScanState) -> Result<usize> {
    let relative = relative_path(root, path)?;
    let bytes = small_file(&within(root, path)?, MAX_JSON_BYTES)?;
    let default_image = path
        .with_extension("png")
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("图集名无效")?
        .to_string();
    let doc: Value = match serde_json::from_slice(&bytes) {
        Ok(doc) => doc,
        Err(_) => {
            // A broken atlas still owns its conventional same-name sheet.
            if let Ok(sheet) = path.with_extension("png").canonicalize()
                && sheet.starts_with(root)
            {
                state.claimed.insert(sheet);
            }
            return Err("JSON 格式无效");
        }
    };
    let frames = match doc["frames"].as_object() {
        Some(frames) => frames,
        None => {
            if let Ok(sheet) = path.with_extension("png").canonicalize()
                && sheet.starts_with(root)
            {
                state.claimed.insert(sheet);
            }
            return Err("需要对象式 frames");
        }
    };
    let image_name = doc["meta"]["image"].as_str().unwrap_or(&default_image);
    if !safe_name(image_name) || !image_name.to_ascii_lowercase().ends_with(".png") {
        return Err("图集图片必须位于项目扫描范围内");
    }
    let image_path = path.parent().ok_or("图集路径无效")?.join(image_name);
    let resolved = within(root, &image_path).map_err(|_| "图集图片必须位于项目扫描范围内")?;
    state.claimed.insert(resolved.clone());
    let atlas = decode_png(small_file(&resolved, MAX_IMAGE_BYTES)?)?;
    let mut processed = 0usize;
    for (name, frame) in frames {
        processed += 1;
        match restore(project, &relative, name, frame, &atlas) {
            Ok(resource) => {
                let width = resource["width"].as_u64().unwrap_or_default();
                let height = resource["height"].as_u64().unwrap_or_default();
                if let Some(limit) = limit_error(state.resources.len(), state.pixels, width, height)
                {
                    state
                        .errors
                        .push(format!("图集 {relative}：{limit}，扫描结果不完整"));
                    state.truncated = true;
                    return Ok(processed.saturating_sub(1));
                }
                state.pixels += width * height;
                state.resources.push(resource);
            }
            Err(error) => state
                .errors
                .push(format!("图集 {relative} 帧 {name}：{error}")),
        }
    }
    Ok(frames.len())
}

/// The complete scan record is kept next to the helper's own data so later
/// incremental work can rely on it; Figma only ever receives whitelisted
/// source fields.
fn cache_scan(data: &Path, project: &Project, scan: &Value) -> Result<()> {
    let directory = data.join("scans");
    fs::create_dir_all(&directory).map_err(|_| "扫描缓存目录不可写")?;
    let path = directory.join(format!("{}.json", project.id));
    let temp = directory.join(format!("{}.tmp", project.id));
    let bytes = serde_json::to_vec(scan).map_err(|_| "扫描缓存编码失败")?;
    if temp.exists() {
        fs::remove_file(&temp).map_err(|_| "扫描缓存不可写")?;
    }
    crate::private_write(&temp, &bytes).map_err(|_| "扫描缓存不可写")?;
    fs::rename(&temp, &path).map_err(|_| "扫描缓存不可写")
}

pub fn scan(data: &Path, project: &Project) -> Result<Value> {
    let root = Path::new(&project.path)
        .canonicalize()
        .map_err(|_| "资源目录不可用")?;
    let (scope, label) = scan_scope(&root);
    let found = collect(&scope);
    let mut state = ScanState {
        errors: found.errors.clone(),
        truncated: found.truncated,
        ..ScanState::default()
    };
    for path in &found.atlases {
        if state.truncated {
            break;
        }
        match read_atlas(project, &scope, path, &mut state) {
            Ok(frames) => state.atlas_frames += frames,
            Err(error) => {
                // An invalid atlas still owns its conventional same-name sheet.
                if let Ok(sheet) = path.with_extension("png").canonicalize()
                    && sheet.starts_with(&scope)
                {
                    state.claimed.insert(sheet);
                }
                let relative =
                    relative_path(&scope, path).unwrap_or_else(|_| "未知图集".to_string());
                state.errors.push(format!("图集 {relative}：{error}"));
            }
        }
    }
    for path in &found.images {
        if state.truncated {
            break;
        }
        let relative = relative_path(&scope, path).unwrap_or_else(|_| "未知图片".to_string());
        let Ok(resolved) = path.canonicalize() else {
            state
                .errors
                .push(format!("独立图片 {relative}：文件不可读"));
            continue;
        };
        if state.claimed.contains(&resolved) {
            continue;
        }
        match standalone(project, &scope, path) {
            Ok(resource) => {
                let width = resource["width"].as_u64().unwrap_or_default();
                let height = resource["height"].as_u64().unwrap_or_default();
                if let Some(limit) = limit_error(state.resources.len(), state.pixels, width, height)
                {
                    state
                        .errors
                        .push(format!("独立图片 {relative}：{limit}，扫描结果不完整"));
                    state.truncated = true;
                    break;
                }
                state.pixels += width * height;
                state.resources.push(resource);
            }
            Err(error) => state.errors.push(format!("独立图片 {relative}：{error}")),
        }
    }
    let sprites = state
        .resources
        .iter()
        .filter(|resource| resource["source"]["kind"] == "atlas")
        .count();
    let scanned: Vec<layout::ScannedResource> = state
        .resources
        .iter()
        .filter_map(|resource| {
            let source = &resource["source"];
            let kind = match source["kind"].as_str()? {
                "atlas" => "atlas",
                "standalone" => "standalone",
                _ => return None,
            };
            Some(layout::ScannedResource {
                identity: source["identity"].as_str()?.to_string(),
                kind,
                relative_path: source["relativePath"].as_str()?.to_string(),
                frame_name: source["frameName"].as_str()?.to_string(),
                width: resource["width"].as_u64()?.try_into().ok()?,
                height: resource["height"].as_u64()?.try_into().ok()?,
            })
        })
        .collect();
    let layout_scan = layout::scan(&root, data, &project.id, &scanned);
    for resource in &mut state.resources {
        let Some(identity) = resource["source"]["identity"].as_str() else {
            continue;
        };
        if let Some(value) = layout_scan.layout_json(identity) {
            resource["layout"] = value;
        }
    }
    let complete = state.errors.is_empty() && !state.truncated;
    let layout_truncated = layout_scan.is_truncated();
    let mut warnings = layout_scan.warnings.clone();
    if layout_truncated {
        warnings.push("布局统计结果不完整".to_string());
    }
    let mut value = json!({"schemaVersion":SCAN_SCHEMA_VERSION,"project":{"id":project.id,"name":project.name},
        "resources":state.resources,"errors":state.errors,"warnings":warnings,
        "summary":{"scanRoot":label,"atlases":found.atlases.len(),"atlasFrames":state.atlas_frames,
            "sprites":sprites,"standalone":state.resources.len()-sprites,"resources":state.resources.len(),
            "errors":state.errors.len(),"skippedLinks":found.links,"entries":found.entries,
            "layoutFiles":layout_scan.files.len(),"layoutReferences":layout_scan.references,
            "layoutNineSlice":layout_scan.nine_slice,"layoutIgnored":layout_scan.ignored,
            "layoutInvalid":layout_scan.invalid},
        "truncated":state.truncated,"complete":complete});
    // Add the full local record for the cache write, then strip it from the
    // Figma payload. This avoids holding a second copy of every base64 image.
    value["layout"] = layout_scan.full_json();
    if let Some(resources) = value["resources"].as_array_mut() {
        for resource in resources {
            let Some(identity) = resource["source"]["identity"].as_str() else {
                continue;
            };
            let variants = layout_scan.variants_json(identity);
            if !variants.is_empty()
                && let Some(entry) = resource.get_mut("layout").and_then(Value::as_object_mut)
            {
                entry.insert("nineSliceVariants".to_string(), json!(variants));
            }
        }
    }
    let cache_result = cache_scan(data, project, &value);
    if let Some(object) = value.as_object_mut() {
        object.remove("layout");
    }
    if let Some(resources) = value["resources"].as_array_mut() {
        for resource in resources {
            if let Some(entry) = resource.get_mut("layout").and_then(Value::as_object_mut) {
                entry.remove("nineSliceVariants");
            }
        }
    }
    if let Err(error) = cache_result {
        if let Some(list) = value["errors"].as_array_mut() {
            list.push(json!(error));
        }
        let count = value["errors"].as_array().map_or(0, Vec::len);
        value["summary"]["errors"] = json!(count);
        value["complete"] = json!(false);
    }
    Ok(value)
}
