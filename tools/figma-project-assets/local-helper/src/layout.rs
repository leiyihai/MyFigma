use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

const LAYOUT_DIR: &str = "res/layout";
const MAX_LAYOUT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LAYOUT_DEPTH: u32 = 32;
const MAX_LAYOUT_FILES: usize = 20_000;
const MAX_LAYOUT_USAGES: usize = 500_000;
const MAX_WARNINGS: usize = 50;

/// Image-bearing property names used by the three acceptance projects. Only
/// these are read as resource references; unknown properties never enter the
/// scan result.
const IMAGE_PROPERTIES: [&str; 13] = [
    "ImageName",
    "LayoutBackImage",
    "NormalImage",
    "PushedImage",
    "DisabledImage",
    "CheckedImage",
    "UncheckedImage",
    "ProgressBackImage",
    "ProgressImage",
    "ProgressHeaderImage",
    "EditBackImage",
    "ThumbImage",
    "TrackImage",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Margins {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

impl Margins {
    fn fits(self, width: u32, height: u32) -> bool {
        (self.left as u64) + (self.right as u64) < (width as u64)
            && (self.top as u64) + (self.bottom as u64) < (height as u64)
    }

    fn to_json(self) -> Value {
        json!({"left":self.left,"top":self.top,"right":self.right,"bottom":self.bottom})
    }

    fn key(self) -> String {
        format!("{} {} {} {}", self.left, self.top, self.right, self.bottom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Reference {
    /// Layout references name the atlas file, not its nested project path.
    Atlas { file: String, frame: String },
    /// Unpacked images are referenced by their project-relative path.
    Standalone { path: String },
}

impl Reference {
    fn raw(&self) -> String {
        match self {
            Reference::Atlas { file, frame } => format!("set:{file} image:{frame}"),
            Reference::Standalone { path } => format!("image:{path}"),
        }
    }
}

struct Usage {
    key: Reference,
    raw: String,
    file: String,
    node: String,
    nine_slice: bool,
    margins: Option<Margins>,
}

#[derive(Clone)]
pub struct ScannedResource {
    pub identity: String,
    pub kind: &'static str,
    pub relative_path: String,
    pub frame_name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Default)]
struct ResourceUsage {
    references: u64,
    variants: BTreeMap<Margins, u32>,
}

pub struct Chosen {
    pub margins: Margins,
    pub usage: u32,
}

pub struct ResourceLayout {
    pub references: u64,
    pub chosen: Option<Chosen>,
    pub variants: Vec<(Margins, u32)>,
}

#[derive(Default)]
pub struct LayoutScan {
    pub files: Vec<String>,
    pub references: u64,
    pub nine_slice: u64,
    pub ignored: u64,
    pub invalid: u64,
    pub dangling: u64,
    pub warnings: Vec<String>,
    pub usages: Vec<Value>,
    pub ignored_refs: Vec<Value>,
    pub per_identity: HashMap<String, ResourceLayout>,
    truncated: bool,
}

impl LayoutScan {
    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    /// Full local record: every layout node, margin usage, ignored public
    /// reference and warning. This stays on the helper; Figma only receives the
    /// chosen parameters and aggregate counts.
    pub fn full_json(&self) -> Value {
        json!({
            "files": self.files,
            "references": self.references,
            "nineSlice": self.nine_slice,
            "ignoredCount": self.ignored,
            "invalid": self.invalid,
            "dangling": self.dangling,
            "ignored": self.ignored_refs,
            "warnings": self.warnings,
            "usages": self.usages,
            "truncated": self.truncated,
        })
    }

    pub fn layout_json(&self, identity: &str) -> Option<Value> {
        let entry = self.per_identity.get(identity)?;
        let mut value = json!({"references":entry.references});
        if let Some(chosen) = &entry.chosen {
            value["nineSlice"] = json!({"margins":chosen.margins.to_json(),"usage":chosen.usage});
        }
        Some(value)
    }

    pub fn variants_json(&self, identity: &str) -> Vec<Value> {
        self.per_identity
            .get(identity)
            .map(|entry| {
                entry
                    .variants
                    .iter()
                    .map(|(margins, usage)| json!({"margins":margins.to_json(),"usage":usage}))
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn parse_reference(raw: &str) -> Option<Reference> {
    let value = raw.trim();
    if value
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("set:"))
    {
        let rest = &value[4..];
        let bytes = rest.as_bytes();
        let mut marker = None;
        for index in 0..bytes.len() {
            if !bytes[index].is_ascii_whitespace() {
                continue;
            }
            let mut end = index;
            while end < bytes.len() && bytes[end].is_ascii_whitespace() {
                end += 1;
            }
            if rest
                .get(end..end + 6)
                .is_some_and(|word| word.eq_ignore_ascii_case("image:"))
            {
                marker = Some((index, end + 6));
                break;
            }
        }
        let (separator, frame_start) = marker?;
        let atlas = rest[..separator].trim();
        let frame = rest[frame_start..].trim();
        if atlas.is_empty() || frame.is_empty() || !atlas.to_ascii_lowercase().ends_with(".json") {
            return None;
        }
        let file = atlas
            .rsplit(['/', '\\'])
            .next()
            .filter(|name| !name.is_empty())?;
        return Some(Reference::Atlas {
            file: file.to_string(),
            frame: frame.to_string(),
        });
    }
    if value
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("image:"))
    {
        let path = value[6..].trim();
        if path.is_empty() || path.len() > 512 {
            return None;
        }
        return Some(Reference::Standalone {
            path: path.to_string(),
        });
    }
    None
}

fn parse_margins(value: &Value) -> Option<Margins> {
    let text = value.as_str()?;
    let parts: Vec<&str> = text.split_ascii_whitespace().collect();
    if parts.len() != 4 {
        return None;
    }
    let mut numbers = [0u32; 4];
    for (index, part) in parts.iter().enumerate() {
        let number: f64 = part.parse().ok()?;
        if !number.is_finite() || !(0.0..=1_000_000.0).contains(&number) {
            return None;
        }
        numbers[index] = number.round() as u32;
    }
    Some(Margins {
        left: numbers[0],
        top: numbers[1],
        right: numbers[2],
        bottom: numbers[3],
    })
}

fn margins_from_json(value: &Value) -> Option<Margins> {
    let number = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|item| item.try_into().ok())
    };
    Some(Margins {
        left: number("left")?,
        top: number("top")?,
        right: number("right")?,
        bottom: number("bottom")?,
    })
}

fn previous_choices(data: &Path, project_id: &str) -> HashMap<String, Margins> {
    let path = data.join("scans").join(format!("{project_id}.json"));
    let Ok(bytes) = fs::read(path) else {
        return HashMap::new();
    };
    let Ok(document) = serde_json::from_slice::<Value>(&bytes) else {
        return HashMap::new();
    };
    let mut choices = HashMap::new();
    for resource in document["resources"].as_array().into_iter().flatten() {
        let Some(identity) = resource["source"]["identity"].as_str() else {
            continue;
        };
        if let Some(margins) = margins_from_json(&resource["layout"]["nineSlice"]["margins"]) {
            choices.insert(identity.to_string(), margins);
        }
    }
    choices
}

fn property_map(value: &Value) -> Option<HashMap<&str, &Value>> {
    let list = value.get("Property")?.as_array()?;
    let mut properties = HashMap::new();
    for item in list {
        if let (Some(name), Some(item_value)) =
            (item.get("Name").and_then(Value::as_str), item.get("Value"))
        {
            // Duplicate property names keep the last declaration, matching the
            // engine's own JSON property map.
            properties.insert(name, item_value);
        }
    }
    (!properties.is_empty()).then_some(properties)
}

fn walk_layout(value: &Value, file: &str, out: &mut Vec<Usage>) {
    match value {
        Value::Object(object) => {
            if let Some(properties) = property_map(value) {
                let nine_slice = properties
                    .get("StretchType")
                    .and_then(|value| value.as_str())
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("NineGrid"));
                let margins = if nine_slice {
                    properties
                        .get("StretchOffset")
                        .and_then(|value| parse_margins(value))
                } else {
                    None
                };
                let node = object
                    .get("Name")
                    .and_then(Value::as_str)
                    .unwrap_or("未命名节点")
                    .to_string();
                for name in IMAGE_PROPERTIES {
                    let Some(raw) = properties.get(name).and_then(|value| value.as_str()) else {
                        continue;
                    };
                    let Some(key) = parse_reference(raw) else {
                        continue;
                    };
                    out.push(Usage {
                        raw: key.raw(),
                        key,
                        file: file.to_string(),
                        node: node.clone(),
                        nine_slice,
                        margins,
                    });
                }
            }
            for child in object.values() {
                walk_layout(child, file, out);
            }
        }
        Value::Array(items) => {
            for child in items {
                walk_layout(child, file, out);
            }
        }
        _ => {}
    }
}

fn read_json(path: &Path) -> std::result::Result<Value, &'static str> {
    let file = fs::File::open(path).map_err(|_| "文件不可读")?;
    let mut bytes = Vec::new();
    use std::io::Read;
    file.take(MAX_LAYOUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "文件不可读")?;
    if bytes.len() as u64 > MAX_LAYOUT_BYTES {
        return Err("超过布局文件大小上限");
    }
    serde_json::from_slice(&bytes).map_err(|_| "JSON 格式无效")
}

fn layout_files(root: &Path) -> (Vec<PathBuf>, Vec<String>, bool) {
    let layout_root = root.join(LAYOUT_DIR);
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let mut truncated = false;
    if !layout_root.is_dir() {
        return (files, warnings, truncated);
    }
    let mut stack = vec![(layout_root, 0u32)];
    while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_LAYOUT_DEPTH {
            warnings.push(format!(
                "布局目录 {}：层级超过 {MAX_LAYOUT_DEPTH} 层，已跳过",
                directory
                    .strip_prefix(root)
                    .map(|path| path.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| "未知目录".to_string())
            ));
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            warnings.push(format!(
                "布局目录 {}：不可读",
                directory
                    .strip_prefix(root)
                    .map(|path| path.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| "未知目录".to_string())
            ));
            continue;
        };
        for entry in entries {
            let Ok(entry) = entry else { continue };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_symlink() {
                // Layout files never leave the registered project.
                continue;
            } else if file_type.is_dir() {
                stack.push((path, depth + 1));
            } else if file_type.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
            {
                if files.len() >= MAX_LAYOUT_FILES {
                    warnings.push("布局文件数量超过单次统计上限，结果不完整".to_string());
                    truncated = true;
                    break;
                }
                files.push(path);
            }
        }
        if truncated {
            break;
        }
    }
    files.sort_by_key(|path| path.to_string_lossy().replace('\\', "/"));
    (files, warnings, truncated)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| "未知布局".to_string())
}

pub fn scan(
    root: &Path,
    data: &Path,
    project_id: &str,
    resources: &[ScannedResource],
) -> LayoutScan {
    let mut result = LayoutScan {
        warnings: Vec::new(),
        ..LayoutScan::default()
    };
    let previous = previous_choices(data, project_id);
    let (files, file_warnings, truncated) = layout_files(root);
    result.truncated = truncated;
    result.warnings.extend(file_warnings);

    let mut usages = Vec::new();
    for path in files {
        if usages.len() >= MAX_LAYOUT_USAGES {
            result
                .warnings
                .push("布局引用数量超过单次统计上限，结果不完整".to_string());
            result.truncated = true;
            break;
        }
        let file = relative(root, &path);
        result.files.push(file.clone());
        match read_json(&path) {
            Ok(document) => walk_layout(&document, &file, &mut usages),
            Err(error) => result
                .warnings
                .push(format!("布局 {file}：{error}，已跳过")),
        }
    }

    let mut atlas_by_file: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut standalone_by_path: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, resource) in resources.iter().enumerate() {
        match resource.kind {
            "atlas" => {
                let name = resource
                    .relative_path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&resource.relative_path);
                atlas_by_file.entry(name).or_default().push(index);
            }
            "standalone" => standalone_by_path
                .entry(resource.relative_path.as_str())
                .or_default()
                .push(index),
            _ => {}
        }
    }

    let mut usage_by_resource: HashMap<usize, ResourceUsage> = HashMap::new();
    let mut ignored: BTreeMap<String, u64> = BTreeMap::new();
    let mut warning_candidates = Vec::new();
    for usage in usages {
        result.references += 1;
        if usage.nine_slice {
            result.nine_slice += 1;
        }
        let (resolved, reason) = match &usage.key {
            Reference::Atlas { file, frame } => match atlas_by_file.get(file.as_str()) {
                None => (None, Some("public")),
                Some(candidates) => {
                    let matched: Vec<usize> = candidates
                        .iter()
                        .copied()
                        .filter(|index| resources[*index].frame_name == *frame)
                        .collect();
                    match matched.as_slice() {
                        [index] => (Some(*index), None),
                        [] => {
                            result.dangling += 1;
                            (None, Some("dangling"))
                        }
                        _ => {
                            result.dangling += 1;
                            (None, Some("ambiguous"))
                        }
                    }
                }
            },
            Reference::Standalone { path } => match standalone_by_path.get(path.as_str()) {
                Some(candidates) if candidates.len() == 1 => (Some(candidates[0]), None),
                Some(_) => {
                    result.dangling += 1;
                    (None, Some("ambiguous"))
                }
                None => (None, Some("public")),
            },
        };

        match resolved {
            Some(index) => {
                let resource = &resources[index];
                let usage_entry = usage_by_resource.entry(index).or_default();
                usage_entry.references += 1;
                if usage.nine_slice {
                    match usage.margins {
                        Some(margins) if margins.fits(resource.width, resource.height) => {
                            *usage_entry.variants.entry(margins).or_default() += 1;
                        }
                        Some(margins) => {
                            result.invalid += 1;
                            warning_candidates.push(format!(
                                "布局 {} 节点 {}：九宫格边距 {} 不适用于 {}×{} 散图，已忽略",
                                usage.file,
                                usage.node,
                                margins.key(),
                                resource.width,
                                resource.height
                            ));
                        }
                        None => {
                            result.invalid += 1;
                            warning_candidates.push(format!(
                                "布局 {} 节点 {}：九宫格边距格式无效，已忽略",
                                usage.file, usage.node
                            ));
                        }
                    }
                }
                result.usages.push(json!({
                    "file": usage.file, "node": usage.node, "reference": usage.raw,
                    "nineSlice": usage.nine_slice,
                    "margins": usage.margins.map(Margins::to_json),
                    "resolved": true, "reason": null,
                    "resourceIdentity": resource.identity,
                }));
            }
            None => {
                let reason = reason.unwrap_or("unresolved");
                if reason == "public" {
                    result.ignored += 1;
                    *ignored.entry(usage.raw.clone()).or_default() += 1;
                } else {
                    result.invalid += 1;
                    warning_candidates.push(format!(
                        "布局 {} 节点 {}：引用的散图不存在或无法唯一匹配（{}），已忽略",
                        usage.file, usage.node, usage.raw
                    ));
                }
                result.usages.push(json!({
                    "file": usage.file, "node": usage.node, "reference": usage.raw,
                    "nineSlice": usage.nine_slice,
                    "margins": usage.margins.map(Margins::to_json),
                    "resolved": false, "reason": reason,
                }));
            }
        }
    }

    for (index, usage) in usage_by_resource {
        let resource = &resources[index];
        let mut variants: Vec<(Margins, u32)> = usage.variants.into_iter().collect();
        variants.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        let chosen = variants.first().map(|(_, best)| {
            let candidates: Vec<Margins> = variants
                .iter()
                .filter(|(_, count)| count == best)
                .map(|(margins, _)| *margins)
                .collect();
            let margins = previous
                .get(&resource.identity)
                .filter(|old| candidates.contains(old))
                .copied()
                .unwrap_or(candidates[0]);
            let usage = variants
                .iter()
                .find(|(candidate, _)| *candidate == margins)
                .map(|(_, count)| *count)
                .unwrap_or_default();
            Chosen { margins, usage }
        });
        result.per_identity.insert(
            resource.identity.clone(),
            ResourceLayout {
                references: usage.references,
                chosen,
                variants,
            },
        );
    }

    if !ignored.is_empty() {
        result.warnings.push(format!(
            "已忽略项目外公共资源引用 {} 项（{} 个来源）",
            result.ignored,
            ignored.len()
        ));
        result.ignored_refs = ignored
            .into_iter()
            .map(|(reference, count)| json!({"reference":reference,"count":count}))
            .collect();
    }
    result
        .warnings
        .extend(warning_candidates.into_iter().take(MAX_WARNINGS));
    result
}
