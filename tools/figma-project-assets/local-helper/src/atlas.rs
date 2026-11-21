use crate::{Project, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, RgbaImage};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Component, Path},
};

fn small_file(path: &Path, max: u64) -> Result<Vec<u8>> {
    let file = fs::File::open(path).map_err(|_| "文件不可读")?;
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "文件不可读")?;
    if bytes.len() as u64 > max {
        return Err("文件超过小型图集限制");
    }
    Ok(bytes)
}
fn within(root: &Path, path: &Path) -> Result<std::path::PathBuf> {
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
        || sw > 1024
        || sh > 1024
        || x.checked_add(w).is_none_or(|v| v > atlas.width())
        || y.checked_add(h).is_none_or(|v| v > atlas.height())
        || ox.checked_add(w).is_none_or(|v| v > sw)
        || oy.checked_add(h).is_none_or(|v| v > sh)
    {
        return Err("帧越界或超过 1024 像素限制");
    }
    let mut restored = RgbaImage::new(sw, sh);
    for dy in 0..h {
        for dx in 0..w {
            restored.put_pixel(ox + dx, oy + dy, *atlas.get_pixel(x + dx, y + dy));
        }
    }
    let mut png = Cursor::new(Vec::new());
    restored
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| "PNG 编码失败")?;
    Ok(
        json!({"width":sw,"height":sh,"png":STANDARD.encode(png.into_inner()),"source":{
            "schemaVersion":1,"projectId":project.id,"kind":"atlas","relativePath":relative,"frameName":name,
            "identity":serde_json::to_string(&json!([project.id,"atlas",relative,name])).map_err(|_| "身份编码失败")?,
            "engineReference":format!("set:{relative} image:{name}"),"sourceSize":{"w":sw,"h":sh},
            "crop":{"x":x,"y":y,"w":w,"h":h},"offset":{"x":ox,"y":oy}
        }}),
    )
}
fn read_atlas(
    project: &Project,
    root: &Path,
    path: &Path,
    resources: &mut Vec<Value>,
    errors: &mut Vec<String>,
    pixels: &mut u64,
) -> Result<()> {
    let relative = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("图集名无效")?;
    if !safe_name(relative) {
        return Err("图集名无效");
    }
    let bytes = small_file(&within(root, path)?, 1024 * 1024)?;
    let doc: Value = serde_json::from_slice(&bytes).map_err(|_| "JSON 格式无效")?;
    let frames = doc["frames"].as_object().ok_or("需要对象式 frames")?;
    if frames.len() > 64 {
        return Err("单图集最多 64 帧");
    }
    let default_image = path
        .with_extension("png")
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let image_name = doc["meta"]["image"].as_str().unwrap_or(&default_image);
    if !safe_name(image_name)
        || Path::new(image_name).components().count() != 1
        || !matches!(
            Path::new(image_name).components().next(),
            Some(Component::Normal(_))
        )
        || !image_name.to_ascii_lowercase().ends_with(".png")
    {
        return Err("图集图片必须位于登记目录");
    }
    let image_bytes = small_file(&within(root, &root.join(image_name))?, 16 * 1024 * 1024)?;
    let mut reader = ImageReader::with_format(Cursor::new(image_bytes), ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(2048);
    limits.max_image_height = Some(2048);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let atlas = reader
        .decode()
        .map_err(|_| "PNG 无效或超过 2048 像素限制")?
        .into_rgba8();
    for (name, frame) in frames {
        if resources.len() >= 64 {
            return Err("本次最多导入 64 张散图");
        }
        match restore(project, relative, name, frame, &atlas) {
            Ok(resource) => {
                *pixels +=
                    resource["width"].as_u64().unwrap() * resource["height"].as_u64().unwrap();
                if *pixels > 8 * 1024 * 1024 {
                    return Err("本次恢复像素超过限制");
                }
                resources.push(resource);
            }
            Err(error) => errors.push(error.to_string()),
        }
    }
    Ok(())
}
pub fn scan(project: &Project) -> Result<Value> {
    let root = Path::new(&project.path)
        .canonicalize()
        .map_err(|_| "资源目录不可用")?;
    let mut paths = Vec::new();
    let mut skipped_directories = 0;
    for entry in fs::read_dir(&root).map_err(|_| "资源目录不可读")? {
        let entry = entry.map_err(|_| "目录项不可读")?;
        if entry.file_type().map_err(|_| "目录项不可读")?.is_dir() {
            skipped_directories += 1;
        }
        if entry
            .path()
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("json"))
        {
            paths.push(entry.path());
        }
        if paths.len() > 16 {
            return Err("登记目录最多支持 16 个 JSON 图集");
        }
    }
    paths.sort();
    let mut resources = Vec::new();
    let mut errors = Vec::new();
    let mut pixels = 0;
    for path in &paths {
        if let Err(error) = read_atlas(
            project,
            &root,
            path,
            &mut resources,
            &mut errors,
            &mut pixels,
        ) {
            errors.push(error.to_string());
        }
    }
    Ok(
        json!({"schemaVersion":1,"project":{"id":project.id,"name":project.name},"resources":resources,"errors":errors,
        "summary":{"atlases":paths.len(),"sprites":resources.len(),"errors":errors.len(),"skippedDirectories":skipped_directories},"complete":errors.is_empty() && skipped_directories == 0}),
    )
}
