use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::hash::Hasher;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Debug, Serialize, Clone)]
pub struct ComponentInfo {
    pub name: String,
    pub count: usize,
    pub size: usize,
    pub description: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct FontInfo {
    pub name: String,
    pub subtype: String,
    pub size: usize,
    pub embedded: bool,
    pub object_id: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DuplicateImageObject {
    pub object_id: String,
    pub width: u32,
    pub height: u32,
    pub pdf_size: usize,
    pub pages: Vec<u32>,
    pub occurrences: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct DuplicateImageGroup {
    pub fingerprint: String,
    pub width: u32,
    pub height: u32,
    pub objects: Vec<DuplicateImageObject>,
    pub total_pdf_size: usize,
    pub estimated_savings: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct PdfAnalysis {
    pub file_path: String,
    pub file_size: usize,
    pub page_count: usize,
    pub pdf_version: String,
    pub components: Vec<ComponentInfo>,
    pub fonts: Vec<FontInfo>,
    pub total_object_count: usize,
    pub unused_object_count: usize,
    pub potential_savings: usize,
    pub duplicate_image_groups: Vec<DuplicateImageGroup>,
    pub reused_image_objects: Vec<DuplicateImageObject>,
    pub duplicate_image_savings: usize,
}

fn estimate_dict_size(dict: &Dictionary) -> usize {
    let mut size = 0usize;
    for (key, value) in dict.iter() {
        size += key.len() + 4; // key + overhead
        size += estimate_object_size(value);
    }
    size
}

fn stream_content_size(stream: &Stream) -> usize {
    // If content was loaded, use actual size
    if !stream.content.is_empty() {
        return stream.content.len();
    }
    // Otherwise estimate from Length field in dict
    if let Ok(Object::Integer(len)) = stream.dict.get(b"Length") {
        return (*len).max(0) as usize;
    }
    0
}

fn estimate_object_size(obj: &Object) -> usize {
    match obj {
        Object::Stream(stream) => stream_content_size(stream) + estimate_dict_size(&stream.dict),
        Object::Dictionary(dict) => estimate_dict_size(dict),
        Object::Array(arr) => arr.iter().map(estimate_object_size).sum::<usize>() + 8,
        Object::String(s, _) => s.len() + 4,
        Object::Name(n) => n.len() + 4,
        Object::Integer(_) | Object::Real(_) => 16,
        Object::Boolean(_) => 5,
        Object::Null => 4,
        Object::Reference(_) => 16,
    }
}

fn get_object_size(obj: &Object) -> usize {
    estimate_object_size(obj)
}

fn format_file_size(size: usize) -> String {
    if size >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", size as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if size >= 1024 * 1024 {
        format!("{:.1} MB", size as f64 / (1024.0 * 1024.0))
    } else if size >= 1024 {
        format!("{:.1} KB", size as f64 / 1024.0)
    } else {
        format!("{} B", size)
    }
}

#[derive(Default)]
struct PartialStats {
    image_count: usize,
    image_size: usize,
    font_size: usize,
    metadata_size: usize,
    form_xobject_count: usize,
    form_xobject_size: usize,
    content_stream_count: usize,
    content_stream_size: usize,
    other_stream_count: usize,
    other_stream_size: usize,
    unused_size: usize,
    dict_object_count: usize,
    dict_object_size: usize,
}

fn name_eq(obj: &Object, expected: &[u8]) -> bool {
    if let Object::Name(name) = obj {
        return name.as_slice() == expected;
    }
    false
}

fn qpdf_dict_get_str(dict: &serde_json::Value, key: &str) -> Option<String> {
    dict.get(key)?.as_str().map(|s| s.to_string())
}

fn qpdf_dict_get_i64(dict: &serde_json::Value, key: &str) -> Option<i64> {
    dict.get(key)?.as_i64()
}

fn parse_qpdf_ref(s: &str) -> Option<ObjectId> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() == 3 && parts[2] == "R" {
        let obj = parts[0].parse::<u32>().ok()?;
        let gen = parts[1].parse::<u16>().ok()?;
        return Some((obj, gen));
    }
    None
}

fn collect_qpdf_refs(value: &serde_json::Value, refs: &mut HashSet<ObjectId>) {
    match value {
        serde_json::Value::String(s) => {
            if let Some(oid) = parse_qpdf_ref(s) {
                refs.insert(oid);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                collect_qpdf_refs(v, refs);
            }
        }
        serde_json::Value::Object(map) => {
            for v in map.values() {
                collect_qpdf_refs(v, refs);
            }
        }
        _ => {}
    }
}

#[derive(Debug, Clone)]
struct ImageRefInfo {
    object_id: ObjectId,
    width: u32,
    height: u32,
    pages: HashSet<u32>,
    occurrences: usize,
}

fn format_object_id(id: ObjectId) -> String {
    format!("{} {}", id.0, id.1)
}

fn parse_qpdf_image_line(line: &str, page: u32) -> Option<ImageRefInfo> {
    let trimmed = line.trim();
    if !trimmed.starts_with('/') {
        return None;
    }

    let (_, rest) = trimmed.split_once(':')?;
    let (ref_part, dim_part) = rest.trim().split_once(',')?;
    let object_id = parse_qpdf_ref(ref_part.trim())?;

    let mut dim_tokens = dim_part.split_whitespace();
    let width = dim_tokens.next()?.parse::<u32>().ok()?;
    if dim_tokens.next()? != "x" {
        return None;
    }
    let height = dim_tokens.next()?.parse::<u32>().ok()?;

    let mut pages = HashSet::new();
    pages.insert(page);
    Some(ImageRefInfo {
        object_id,
        width,
        height,
        pages,
        occurrences: 1,
    })
}

fn collect_image_refs_with_qpdf(path: &Path) -> Result<HashMap<ObjectId, ImageRefInfo>, String> {
    let output = std::process::Command::new("qpdf")
        .args(["--show-pages", "--with-images"])
        .arg(path)
        .output()
        .map_err(|e| format!("qpdf 图片引用扫描失败: {}", e))?;

    if output.stdout.is_empty() {
        return Err(format!(
            "qpdf 图片引用扫描无输出，退出码: {:?}",
            output.status.code()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut current_page = 0u32;
    let mut images: HashMap<ObjectId, ImageRefInfo> = HashMap::new();

    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("page ") {
            if let Some((page_num, _)) = rest.split_once(':') {
                current_page = page_num.trim().parse::<u32>().unwrap_or(0);
            }
            continue;
        }

        if current_page == 0 {
            continue;
        }

        if let Some(info) = parse_qpdf_image_line(trimmed, current_page) {
            images
                .entry(info.object_id)
                .and_modify(|existing| {
                    existing.pages.insert(current_page);
                    existing.occurrences += 1;
                })
                .or_insert(info);
        }
    }

    Ok(images)
}

fn hash_bytes_and_dict(bytes: &[u8], dict: &serde_json::Value) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(bytes);
    if let Ok(dict_bytes) = serde_json::to_vec(dict) {
        hasher.write(&dict_bytes);
    }
    format!("{:016x}", hasher.finish())
}

fn qpdf_object_key_to_id(key: &str) -> Option<ObjectId> {
    key.strip_prefix("obj:")
        .and_then(|s| parse_qpdf_ref(s.trim()))
}

fn hash_candidate_image_streams(
    path: &Path,
    candidate_ids: &[ObjectId],
) -> Result<HashMap<ObjectId, (String, usize)>, String> {
    if candidate_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let temp_dir = tempfile::Builder::new()
        .prefix("pdf-prune-duplicate-images-")
        .tempdir()
        .map_err(|e| format!("创建重复图片分析临时目录失败: {}", e))?;

    let mut hashes: HashMap<ObjectId, (String, usize)> = HashMap::new();

    for (chunk_idx, chunk) in candidate_ids.chunks(200).enumerate() {
        let prefix = temp_dir
            .path()
            .join(format!("stream-{}-", chunk_idx))
            .to_string_lossy()
            .to_string();

        let mut cmd = std::process::Command::new("qpdf");
        cmd.args([
            "--json",
            "--json-key=qpdf",
            "--json-stream-data=file",
            "--decode-level=none",
        ]);
        cmd.arg(format!("--json-stream-prefix={}", prefix));
        for id in chunk {
            cmd.arg(format!("--json-object={},{}", id.0, id.1));
        }
        cmd.arg(path);

        let output = cmd
            .output()
            .map_err(|e| format!("qpdf 图片 stream 提取失败: {}", e))?;
        if output.stdout.is_empty() {
            return Err(format!(
                "qpdf 图片 stream 提取无输出，退出码: {:?}",
                output.status.code()
            ));
        }

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("解析 qpdf 图片 stream JSON 失败: {}", e))?;
        let Some(objects) = json
            .get("qpdf")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.get(1))
            .and_then(|v| v.as_object())
        else {
            continue;
        };

        for (key, value) in objects {
            let Some(object_id) = qpdf_object_key_to_id(key) else {
                continue;
            };
            let Some(stream) = value.get("stream") else {
                continue;
            };
            let Some(datafile) = stream.get("datafile").and_then(|v| v.as_str()) else {
                continue;
            };
            let data = match std::fs::read(datafile) {
                Ok(data) => data,
                Err(_) => continue,
            };
            let dict = stream
                .get("dict")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
            let hash = hash_bytes_and_dict(&data, &dict);
            hashes.insert(object_id, (hash, data.len()));
        }
    }

    Ok(hashes)
}

fn duplicate_object_from_ref(info: &ImageRefInfo, pdf_size: usize) -> DuplicateImageObject {
    let mut pages: Vec<u32> = info.pages.iter().copied().collect();
    pages.sort_unstable();
    DuplicateImageObject {
        object_id: format_object_id(info.object_id),
        width: info.width,
        height: info.height,
        pdf_size,
        pages,
        occurrences: info.occurrences,
    }
}

fn analyze_duplicate_images(path: &Path) -> (Vec<DuplicateImageGroup>, Vec<DuplicateImageObject>, usize) {
    let image_refs = match collect_image_refs_with_qpdf(path) {
        Ok(images) => images,
        Err(e) => {
            eprintln!("duplicate image analysis skipped: {}", e);
            return (Vec::new(), Vec::new(), 0);
        }
    };

    let mut by_dimensions: HashMap<(u32, u32), Vec<ObjectId>> = HashMap::new();
    for (id, info) in &image_refs {
        by_dimensions
            .entry((info.width, info.height))
            .or_default()
            .push(*id);
    }

    let candidate_ids: Vec<ObjectId> = by_dimensions
        .values()
        .filter(|ids| ids.len() > 1)
        .flat_map(|ids| ids.iter().copied())
        .collect();

    let stream_hashes = match hash_candidate_image_streams(path, &candidate_ids) {
        Ok(hashes) => hashes,
        Err(e) => {
            eprintln!("duplicate image hash analysis skipped: {}", e);
            HashMap::new()
        }
    };

    let mut by_hash: HashMap<String, Vec<ObjectId>> = HashMap::new();
    for (id, (hash, _)) in &stream_hashes {
        by_hash.entry(hash.clone()).or_default().push(*id);
    }

    let mut groups: Vec<DuplicateImageGroup> = by_hash
        .into_iter()
        .filter_map(|(fingerprint, ids)| {
            if ids.len() < 2 {
                return None;
            }
            let first_info = image_refs.get(&ids[0])?;
            let mut objects: Vec<DuplicateImageObject> = ids
                .iter()
                .filter_map(|id| {
                    let info = image_refs.get(id)?;
                    let size = stream_hashes.get(id).map(|(_, size)| *size).unwrap_or(0);
                    Some(duplicate_object_from_ref(info, size))
                })
                .collect();
            objects.sort_by(|a, b| b.pdf_size.cmp(&a.pdf_size));
            let total_pdf_size = objects.iter().map(|obj| obj.pdf_size).sum::<usize>();
            let keep_size = objects.iter().map(|obj| obj.pdf_size).min().unwrap_or(0);
            Some(DuplicateImageGroup {
                fingerprint,
                width: first_info.width,
                height: first_info.height,
                objects,
                total_pdf_size,
                estimated_savings: total_pdf_size.saturating_sub(keep_size),
            })
        })
        .collect();

    groups.sort_by(|a, b| b.estimated_savings.cmp(&a.estimated_savings));

    let duplicate_ids: HashSet<String> = groups
        .iter()
        .flat_map(|group| group.objects.iter().map(|obj| obj.object_id.clone()))
        .collect();

    let mut reused: Vec<DuplicateImageObject> = image_refs
        .values()
        .filter(|info| info.occurrences > 1 && !duplicate_ids.contains(&format_object_id(info.object_id)))
        .map(|info| {
            let pdf_size = stream_hashes
                .get(&info.object_id)
                .map(|(_, size)| *size)
                .unwrap_or(0);
            duplicate_object_from_ref(info, pdf_size)
        })
        .collect();
    reused.sort_by(|a, b| b.occurrences.cmp(&a.occurrences));

    let savings = groups
        .iter()
        .map(|group| group.estimated_savings)
        .sum::<usize>();

    (groups, reused, savings)
}

/// Fast analysis using qpdf JSON output. Avoids loading the entire PDF with lopdf.
fn analyze_with_qpdf(
    path: &Path,
    file_size: usize,
    progress: Arc<dyn Fn(u8, &str) + Send + Sync>,
    cancel: Arc<AtomicBool>,
) -> Result<PdfAnalysis, String> {
    progress(10, "检测到超大 PDF，使用 qpdf 进行快速扫描...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // Get page count from pdfinfo (fast, reliable)
    let page_count = std::process::Command::new("pdfinfo")
        .arg(path)
        .output()
        .ok()
        .and_then(|o| {
            let stdout = String::from_utf8_lossy(&o.stdout);
            for line in stdout.lines() {
                if line.starts_with("Pages:") {
                    return line[6..].trim().parse::<usize>().ok();
                }
            }
            None
        })
        .unwrap_or(0);

    let output = std::process::Command::new("qpdf")
        .args(["--json", "--decode-level=none", "--json-object=*"])
        .arg(path)
        .output()
        .map_err(|e| format!("qpdf 执行失败 (请确认已安装 qpdf): {}", e))?;
    // qpdf may exit with code 3 due to warnings (e.g. objects with offset 0),
    // but the JSON output on stdout is still valid. Only fail if stdout is empty.
    if output.stdout.is_empty() {
        return Err(format!(
            "qpdf 未产生输出，退出码: {:?}",
            output.status.code()
        ));
    }

    progress(40, "正在解析 qpdf 结果...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("解析 qpdf JSON 失败: {}", e))?;

    let qpdf_arr = json
        .get("qpdf")
        .and_then(|v| v.as_array())
        .ok_or("qpdf JSON 格式错误: 缺少 qpdf 数组")?;
    if qpdf_arr.len() < 2 {
        return Err("qpdf JSON 格式错误: qpdf 数组长度不足".to_string());
    }
    let meta = qpdf_arr[0].as_object().ok_or("qpdf JSON 元数据格式错误")?;
    let objects = qpdf_arr[1].as_object().ok_or("qpdf JSON 对象格式错误")?;

    let pdf_version = meta
        .get("pdfversion")
        .and_then(|v| v.as_str())
        .map(|s| s.replace("PDF", ""))
        .unwrap_or_else(|| "1.7".to_string());
    let total_object_count = objects.len().saturating_sub(1); // exclude trailer

    progress(50, "正在提取对象信息...");

    // Build object info map
    let mut object_sizes: std::collections::HashMap<ObjectId, usize> =
        std::collections::HashMap::new();
    let mut object_dicts: std::collections::HashMap<ObjectId, serde_json::Value> =
        std::collections::HashMap::new();
    let mut object_is_stream: std::collections::HashSet<ObjectId> =
        std::collections::HashSet::new();
    let mut root_ref: Option<ObjectId> = None;

    for (key, val) in objects.iter() {
        if key == "trailer" {
            // trailer structure: {"value": {"/Root": "1 0 R", ...}}
            if let Some(trailer_value) = val.get("value") {
                if let Some(root_str) = trailer_value.get("/Root").and_then(|v| v.as_str()) {
                    root_ref = parse_qpdf_ref(root_str);
                    eprintln!("Debug: Found root ref: {:?}", root_ref);
                }
            }
            continue;
        }
        let obj_id = if key.starts_with("obj:") {
            let s = &key[4..];
            parse_qpdf_ref(s)
        } else {
            None
        };
        let Some(oid) = obj_id else { continue };

        let (dict, _is_stream, raw_size) = if let Some(stream) = val.get("stream") {
            let dict = stream
                .get("dict")
                .cloned()
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
            let len = qpdf_dict_get_i64(&dict, "/Length").unwrap_or(0) as usize;
            object_is_stream.insert(oid);
            (dict, true, len.max(256))
        } else if let Some(value) = val.get("value") {
            let is_dict = value.is_object();
            // Estimate size from JSON representation for non-stream objects
            let est = if is_dict {
                serde_json::to_string(value).unwrap_or_default().len()
            } else {
                128
            };
            (value.clone(), false, est.max(64))
        } else {
            (serde_json::Value::Object(serde_json::Map::new()), false, 64)
        };

        object_sizes.insert(oid, raw_size);
        object_dicts.insert(oid, dict);
    }

    progress(60, "正在分析对象引用关系...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // BFS reachable objects from root
    let mut reachable: HashSet<ObjectId> = HashSet::new();
    if let Some(root) = root_ref {
        let mut queue = vec![root];
        while let Some(oid) = queue.pop() {
            if !reachable.insert(oid) {
                continue;
            }
            if let Some(dict) = object_dicts.get(&oid) {
                let mut refs = HashSet::new();
                collect_qpdf_refs(dict, &mut refs);
                for r in refs {
                    if !reachable.contains(&r) {
                        queue.push(r);
                    }
                }
            }
        }
    }

    // Debug: Check if we have objects that aren't in object_dicts but are referenced
    let missing_in_dicts: HashSet<_> = reachable
        .iter()
        .filter(|oid| !object_dicts.contains_key(oid))
        .cloned()
        .collect();
    if !missing_in_dicts.is_empty() {
        eprintln!(
            "Warning: {} reachable objects not in object_dicts",
            missing_in_dicts.len()
        );
    }

    // Debug: Check if we have objects in object_dicts that aren't reachable
    let unreachable_objects: Vec<_> = object_dicts
        .keys()
        .filter(|oid| !reachable.contains(oid))
        .collect();
    eprintln!(
        "Total objects: {}, Reachable: {}, Unreachable: {}",
        total_object_count,
        reachable.len(),
        unreachable_objects.len()
    );

    let unused_object_count = total_object_count - reachable.len();

    progress(70, "正在分类对象...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // Collect image IDs and font program IDs by following references
    let mut image_ids: HashSet<ObjectId> = HashSet::new();
    let mut font_program_ids: HashSet<ObjectId> = HashSet::new();
    let mut content_stream_ids: HashSet<ObjectId> = HashSet::new();
    let mut form_xobject_ids: HashSet<ObjectId> = HashSet::new();
    let mut metadata_ids: HashSet<ObjectId> = HashSet::new();

    // First pass: identify streams by type
    for (oid, dict) in &object_dicts {
        let typ = qpdf_dict_get_str(dict, "/Type").unwrap_or_default();
        let subtype = qpdf_dict_get_str(dict, "/Subtype").unwrap_or_default();
        if subtype == "/Image" {
            image_ids.insert(*oid);
        } else if subtype == "/Form" {
            form_xobject_ids.insert(*oid);
        } else if typ == "/Metadata" {
            metadata_ids.insert(*oid);
        }
    }

    // Second pass: identify font programs from FontDescriptor references
    for (_oid, dict) in &object_dicts {
        let typ = qpdf_dict_get_str(dict, "/Type").unwrap_or_default();
        if typ == "/FontDescriptor" {
            for key in ["/FontFile", "/FontFile2", "/FontFile3"] {
                if let Some(s) = qpdf_dict_get_str(dict, key) {
                    if let Some(fid) = parse_qpdf_ref(&s) {
                        font_program_ids.insert(fid);
                    }
                }
            }
        }
    }

    // Content streams: streams not yet categorized and referenced by Pages
    for oid in object_is_stream.iter() {
        if !image_ids.contains(oid)
            && !font_program_ids.contains(oid)
            && !form_xobject_ids.contains(oid)
            && !metadata_ids.contains(oid)
        {
            content_stream_ids.insert(*oid);
        }
    }

    // Collect font info
    let mut fonts: Vec<FontInfo> = Vec::new();
    for (oid, dict) in &object_dicts {
        let typ = qpdf_dict_get_str(dict, "/Type").unwrap_or_default();
        if typ == "/Font" {
            let name = qpdf_dict_get_str(dict, "/BaseFont")
                .map(|s| s.trim_start_matches('/').to_string())
                .unwrap_or_else(|| "未知字体".to_string());
            let subtype = qpdf_dict_get_str(dict, "/Subtype")
                .map(|s| s.trim_start_matches('/').to_string())
                .unwrap_or_else(|| "未知".to_string());
            let embedded = font_program_ids.iter().any(|fid| {
                // check if this font references a font descriptor with a font program
                if let Some(fd_str) = qpdf_dict_get_str(dict, "/FontDescriptor") {
                    if let Some(fd_id) = parse_qpdf_ref(&fd_str) {
                        if let Some(fd_dict) = object_dicts.get(&fd_id) {
                            for key in ["/FontFile", "/FontFile2", "/FontFile3"] {
                                if let Some(ff_str) = qpdf_dict_get_str(fd_dict, key) {
                                    if let Some(ff_id) = parse_qpdf_ref(&ff_str) {
                                        if ff_id == *fid {
                                            return true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                false
            });
            let size = object_sizes.get(oid).copied().unwrap_or(0);
            fonts.push(FontInfo {
                name,
                subtype,
                embedded,
                size,
                object_id: format!("{} {}", oid.0, oid.1),
            });
        }
    }

    // Sum sizes by category
    let sum_size = |ids: &HashSet<ObjectId>| {
        ids.iter()
            .filter_map(|id| object_sizes.get(id))
            .sum::<usize>()
    };
    let image_size = sum_size(&image_ids);
    let image_count = image_ids.len();
    let font_size = sum_size(&font_program_ids);
    let font_count = font_program_ids.len();
    let form_xobject_size = sum_size(&form_xobject_ids);
    let form_xobject_count = form_xobject_ids.len();
    let content_stream_size = sum_size(&content_stream_ids);
    let content_stream_count = content_stream_ids.len();
    let metadata_size = sum_size(&metadata_ids);
    let metadata_count = metadata_ids.len();

    // Other size = total file size - categorized stream sizes - rough non-stream overhead
    // For simplicity, compute other as file_size - sum of all known stream sizes
    let total_known_stream_size =
        image_size + font_size + form_xobject_size + content_stream_size + metadata_size;
    let other_size = file_size.saturating_sub(total_known_stream_size);
    let other_count = total_object_count.saturating_sub(
        image_count + font_count + form_xobject_count + content_stream_count + metadata_count,
    );

    let unused_size: usize = object_sizes
        .iter()
        .filter(|(id, _)| !reachable.contains(id))
        .map(|(_, size)| *size)
        .sum();
    let potential_savings = unused_size;

    let components = vec![
        ComponentInfo {
            name: "图片".to_string(),
            count: image_count,
            size: image_size,
            description: "PDF 中内嵌的图片流".to_string(),
        },
        ComponentInfo {
            name: "字体".to_string(),
            count: font_count,
            size: font_size,
            description: "字体描述与字体程序".to_string(),
        },
        ComponentInfo {
            name: "内容流".to_string(),
            count: content_stream_count,
            size: content_stream_size,
            description: "页面绘制指令".to_string(),
        },
        ComponentInfo {
            name: "表单对象".to_string(),
            count: form_xobject_count,
            size: form_xobject_size,
            description: "Form XObject".to_string(),
        },
        ComponentInfo {
            name: "元数据".to_string(),
            count: metadata_count,
            size: metadata_size,
            description: "文档信息元数据".to_string(),
        },
        ComponentInfo {
            name: "其他对象".to_string(),
            count: other_count,
            size: other_size,
            description: "目录、数组、引用等".to_string(),
        },
        ComponentInfo {
            name: "未使用对象".to_string(),
            count: unused_object_count,
            size: unused_size,
            description: "垃圾对象".to_string(),
        },
    ];

    progress(92, "正在分析重复图片...");
    let (duplicate_image_groups, reused_image_objects, duplicate_image_savings) =
        analyze_duplicate_images(path);

    progress(95, "正在汇总结果...");

    Ok(PdfAnalysis {
        file_path: path.to_string_lossy().to_string(),
        file_size,
        page_count,
        pdf_version,
        components,
        total_object_count,
        unused_object_count,
        potential_savings,
        duplicate_image_groups,
        reused_image_objects,
        duplicate_image_savings,
        fonts,
    })
}

fn is_image_stream(dict: &Dictionary) -> bool {
    dict.get(b"Subtype")
        .map(|v| name_eq(v, b"Image"))
        .unwrap_or(false)
}

fn is_form_xobject(dict: &Dictionary) -> bool {
    dict.get(b"Subtype")
        .map(|v| name_eq(v, b"Form"))
        .unwrap_or(false)
}

fn is_font_program(dict: &Dictionary) -> bool {
    // Check by Subtype
    if let Ok(subtype) = dict.get(b"Subtype") {
        if name_eq(subtype, b"Type1C")
            || name_eq(subtype, b"OpenType")
            || name_eq(subtype, b"CIDFontType0C")
        {
            return true;
        }
    }
    // Font file streams have Length1 (and optionally Length2/Length3 for Type1 fonts)
    if dict.get(b"Length1").is_ok() {
        return true;
    }
    dict.get(b"Type")
        .map(|v| name_eq(v, b"FontFile"))
        .unwrap_or(false)
}

fn is_metadata_stream(dict: &Dictionary) -> bool {
    dict.get(b"Type")
        .map(|v| name_eq(v, b"Metadata"))
        .unwrap_or(false)
}

fn get_name_string(dict: &Dictionary, key: &[u8]) -> Option<String> {
    dict.get(key).ok().and_then(|obj| match obj {
        Object::Name(name) => Some(String::from_utf8_lossy(name).to_string()),
        Object::String(s, _) => Some(String::from_utf8_lossy(s).to_string()),
        _ => None,
    })
}

fn is_font_embedded(font_dict: &Dictionary, doc: &Document) -> bool {
    if let Ok(Object::Reference(desc_id)) = font_dict.get(b"FontDescriptor") {
        if let Ok(Object::Dictionary(desc_dict)) = doc.get_object(*desc_id) {
            for key in [&b"FontFile"[..], &b"FontFile2"[..], &b"FontFile3"[..]] {
                if desc_dict.get(key).is_ok() {
                    return true;
                }
            }
        }
    }
    false
}

fn collect_font_info(doc: &Document) -> Vec<FontInfo> {
    let mut fonts = Vec::new();
    for (obj_id, obj) in &doc.objects {
        if let Object::Dictionary(dict) = obj {
            if dict
                .get(b"Type")
                .map(|v| name_eq(v, b"Font"))
                .unwrap_or(false)
            {
                let name = get_name_string(dict, b"BaseFont")
                    .or_else(|| get_name_string(dict, b"Name"))
                    .unwrap_or_else(|| "未命名字体".to_string());
                let subtype =
                    get_name_string(dict, b"Subtype").unwrap_or_else(|| "未知".to_string());
                let embedded = is_font_embedded(dict, doc);

                let mut total_size = estimate_object_size(obj);
                if let Ok(Object::Reference(desc_id)) = dict.get(b"FontDescriptor") {
                    if let Ok(desc_obj) = doc.get_object(*desc_id) {
                        total_size += estimate_object_size(desc_obj);
                        if let Object::Dictionary(desc_dict) = desc_obj {
                            for key in [&b"FontFile"[..], &b"FontFile2"[..], &b"FontFile3"[..]] {
                                if let Ok(Object::Reference(prog_id)) = desc_dict.get(key) {
                                    if let Ok(prog_obj) = doc.get_object(*prog_id) {
                                        total_size += estimate_object_size(prog_obj);
                                    }
                                }
                            }
                        }
                    }
                }

                fonts.push(FontInfo {
                    name,
                    subtype,
                    size: total_size,
                    embedded,
                    object_id: format!("{} {}", obj_id.0, obj_id.1),
                });
            }
        }
    }
    fonts
}

fn collect_reachable_objects(doc: &Document, start: ObjectId, visited: &mut HashSet<ObjectId>) {
    if !visited.insert(start) {
        return;
    }

    if let Ok(obj) = doc.get_object(start) {
        let mut refs = Vec::new();
        collect_refs_from_object(doc, obj, &mut refs);
        for id in refs {
            collect_reachable_objects(doc, id, visited);
        }
    }
}

fn collect_refs_from_object(doc: &Document, obj: &Object, refs: &mut Vec<ObjectId>) {
    match obj {
        Object::Dictionary(dict) => {
            for (_, value) in dict.iter() {
                collect_refs_from_object(doc, value, refs);
            }
        }
        Object::Array(arr) => {
            for item in arr {
                collect_refs_from_object(doc, item, refs);
            }
        }
        Object::Reference(id) => {
            refs.push(*id);
        }
        Object::Stream(stream) => {
            for (_, value) in stream.dict.iter() {
                collect_refs_from_object(doc, value, refs);
            }
        }
        _ => {}
    }
}

fn parallel_traverse_objects(
    doc: &Document,
    progress: Arc<dyn Fn(u8, &str) + Send + Sync>,
) -> HashSet<ObjectId> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    let visited = Mutex::new(HashSet::new());
    let next_frontier = Mutex::new(Vec::new());
    let processed = AtomicUsize::new(0);
    let total = doc.objects.len();
    let last_reported = AtomicUsize::new(0);

    // Seed roots
    {
        let mut v = visited.lock().unwrap();
        let mut frontier = next_frontier.lock().unwrap();
        for key in [
            &b"Root"[..],
            &b"Info"[..],
            &b"Encrypt"[..],
            &b"AcroForm"[..],
            &b"Names"[..],
        ] {
            if let Ok(id) = doc.trailer.get(key).and_then(Object::as_reference) {
                if v.insert(id) {
                    frontier.push(id);
                }
            }
        }
    }

    let mut current_frontier = Vec::new();
    while {
        let mut frontier = next_frontier.lock().unwrap();
        current_frontier.clear();
        std::mem::swap(&mut current_frontier, &mut *frontier);
        !current_frontier.is_empty()
    } {
        current_frontier.par_chunks(1000).for_each(|chunk| {
            let mut local_refs: Vec<ObjectId> = Vec::with_capacity(chunk.len() * 4);
            for &id in chunk {
                if let Ok(obj) = doc.get_object(id) {
                    collect_refs_from_object(doc, obj, &mut local_refs);
                }
            }

            let processed_count = processed.fetch_add(chunk.len(), Ordering::Relaxed);
            let done = processed_count + chunk.len();
            let last = last_reported.load(Ordering::Relaxed);
            if done.saturating_sub(last) >= 1000
                && last_reported
                    .compare_exchange(last, done, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
            {
                let pct = (50 + (done * 14).min(total * 14) / total.max(1)) as u8;
                progress(
                    pct,
                    &format!("正在分析对象引用关系... (已处理 {} / {} 对象)", done, total),
                );
            }

            if local_refs.is_empty() {
                return;
            }

            let mut v = visited.lock().unwrap();
            let mut frontier = next_frontier.lock().unwrap();
            for id in local_refs {
                if v.insert(id) {
                    frontier.push(id);
                }
            }
        });
    }

    visited.into_inner().unwrap()
}

fn find_all_reachable(
    doc: &Document,
    progress: Arc<dyn Fn(u8, &str) + Send + Sync>,
) -> HashSet<ObjectId> {
    // For small documents, use sequential traversal (less overhead)
    // For large documents, use parallel BFS to utilize multiple cores
    let total = doc.objects.len();
    if total < 50_000 {
        let mut visited = HashSet::new();
        if let Ok(catalog_id) = doc.trailer.get(b"Root").and_then(Object::as_reference) {
            collect_reachable_objects(doc, catalog_id, &mut visited);
        }
        if let Ok(info_id) = doc.trailer.get(b"Info").and_then(Object::as_reference) {
            collect_reachable_objects(doc, info_id, &mut visited);
        }
        visited
    } else {
        parallel_traverse_objects(doc, progress)
    }
}

pub fn analyze_pdf(
    file_path: &str,
    progress: impl Fn(u8, &str) + Send + Sync + 'static,
    cancel: Arc<AtomicBool>,
) -> Result<PdfAnalysis, String> {
    let path = Path::new(file_path);
    let file_size = path
        .metadata()
        .map_err(|e| format!("无法读取文件信息: {}", e))?
        .len() as usize;

    let progress_arc: Arc<dyn Fn(u8, &str) + Send + Sync> = Arc::new(progress);
    progress_arc(5, "正在读取文件基本信息...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // Quick scan: read the last 512 bytes to find xref start and get basic info
    // This gives the user immediate feedback before the full parse begins
    {
        use std::io::{Read, Seek, SeekFrom};
        if let Ok(mut file) = std::fs::File::open(path) {
            let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
            if file_len > 512 {
                let mut tail = vec![0u8; 512];
                if file.seek(SeekFrom::End(-512)).is_ok() {
                    let _ = file.read_exact(&mut tail);
                    // Check if it's a valid PDF
                    if tail.windows(5).any(|w| w == b"%PDF-")
                        || tail.windows(5).any(|w| w == b"%%EOF")
                    {
                        progress_arc(
                            10,
                            &format!(
                                "文件大小: {}，正在解析对象表...",
                                format_file_size(file_size)
                            ),
                        );
                    }
                }
            } else {
                progress_arc(10, "正在解析对象表...");
            }
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // Use load_filtered to skip stream content — we only need dict metadata for analysis.
    // The filter stores the actual content length as a direct Integer in the dict before
    // clearing content, so sizes can be estimated without holding hundreds of MB in memory.
    // NOTE: lopdf discards the return value of filter_func; only the &mut Object side effect matters.
    let filter_func: fn((u32, u16), &mut Object) -> Option<((u32, u16), Object)> = |id, obj| {
        if let Object::Stream(stream) = obj {
            // Replace Length (which may be an indirect reference) with the actual content size
            let content_len = stream.content.len();
            if content_len > 0 {
                stream
                    .dict
                    .set(b"Length", Object::Integer(content_len as i64));
            }
            // Clear content to avoid holding hundreds of MB in memory
            stream.content.clear();
        }
        Some((id, Object::Null))
    };

    // Large PDFs with many objects or compressed xref streams can make lopdf
    // extremely slow (especially in debug builds).  Use the qpdf JSON fast path
    // which avoids loading the entire PDF with lopdf.
    // Threshold lowered from 50MB to 20MB: a 44MB / 2000-page / 10k-object file
    // was taking minutes via lopdf but only seconds via qpdf.
    if file_size > 20_000_000 {
        return analyze_with_qpdf(path, file_size, progress_arc, cancel);
    }

    let doc = Document::load_filtered(path, filter_func)
        .map_err(|e| format!("无法加载PDF文件: {}", e))?;

    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }
    progress_arc(40, "正在解析页面结构...");

    // Page count: read Count directly from root Pages dictionary first (fastest and most reliable)
    let page_count = {
        let count_from_pages = doc
            .trailer
            .get(b"Root")
            .ok()
            .and_then(|obj| obj.as_reference().ok())
            .and_then(|cat_id| doc.get_object(cat_id).ok())
            .and_then(|cat_obj| cat_obj.as_dict().ok())
            .and_then(|cat_dict| cat_dict.get(b"Pages").ok())
            .and_then(|obj| obj.as_reference().ok())
            .and_then(|pages_id| doc.get_object(pages_id).ok())
            .and_then(|pages_obj| pages_obj.as_dict().ok())
            .and_then(|pages_dict| pages_dict.get(b"Count").ok())
            .and_then(|v| v.as_i64().ok())
            .map(|c| c.max(0) as usize);

        if let Some(count) = count_from_pages {
            count
        } else {
            // Fallback 1: traverse Pages tree
            let pages = doc.get_pages();
            let n = pages.len();
            if n > 0 {
                n
            } else {
                // Fallback 2: pdfinfo (handles compressed xref streams that lopdf can't)
                std::process::Command::new("pdfinfo")
                    .arg(path)
                    .output()
                    .ok()
                    .and_then(|o| {
                        let stdout = String::from_utf8_lossy(&o.stdout);
                        for line in stdout.lines() {
                            if line.starts_with("Pages:") {
                                return line[6..].trim().parse::<usize>().ok();
                            }
                        }
                        None
                    })
                    .unwrap_or(0)
            }
        }
    };
    let pdf_version = format!("{}", doc.version);

    let total_object_count = doc.objects.len();

    // Find reachable objects using parallel BFS for large documents
    let progress_clone = progress_arc.clone();
    progress_clone(50, "正在分析对象引用关系...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }
    let reachable: HashSet<ObjectId> = find_all_reachable(&doc, progress_clone);
    let unused_object_count = total_object_count - reachable.len();

    progress_arc(65, "正在分类对象...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // Analyze each object
    let mut image_count = 0usize;
    let mut image_size = 0usize;
    let mut font_size = 0usize;
    let mut form_xobject_count = 0usize;
    let mut form_xobject_size = 0usize;
    let mut metadata_size = 0usize;
    let mut content_stream_count = 0usize;
    let mut content_stream_size = 0usize;
    let mut other_stream_count = 0usize;
    let mut other_stream_size = 0usize;
    let mut dict_object_count = 0usize;
    let mut dict_object_size = 0usize;
    let mut unused_size = 0usize;

    // Track font program object IDs referenced by FontDescriptor dictionaries (parallel)
    let font_program_ids: HashSet<ObjectId> = doc
        .objects
        .par_iter()
        .filter_map(|(_, obj)| {
            if let Object::Dictionary(dict) = obj {
                if dict
                    .get(b"Type")
                    .map(|v| name_eq(v, b"FontDescriptor"))
                    .unwrap_or(false)
                {
                    let mut ids = Vec::new();
                    for key in [&b"FontFile"[..], &b"FontFile2"[..], &b"FontFile3"[..]] {
                        if let Ok(Object::Reference(id)) = dict.get(key) {
                            ids.push(*id);
                        }
                    }
                    if !ids.is_empty() {
                        return Some(ids);
                    }
                }
            }
            None
        })
        .flatten()
        .collect();

    // Count font objects (parallel)
    let font_count = doc
        .objects
        .par_iter()
        .filter(|(_, obj)| {
            if let Object::Dictionary(dict) = obj {
                dict.get(b"Type")
                    .map(|v| name_eq(v, b"Font"))
                    .unwrap_or(false)
            } else {
                false
            }
        })
        .count();

    let obj_count = doc.objects.len();
    let processed = AtomicUsize::new(0);
    let class_last_reported = AtomicUsize::new(0);

    // Parallel classification of objects with progress reporting every 500
    let progress_class = progress_arc.clone();
    let object_list: Vec<(&ObjectId, &Object)> = doc.objects.iter().collect();
    let chunk_results: Vec<PartialStats> = object_list
        .par_chunks(500)
        .map(|chunk| {
            let mut stats = PartialStats::default();
            for (obj_id, obj) in chunk {
                if cancel.load(Ordering::Relaxed) {
                    return PartialStats::default();
                }
                let obj_size = get_object_size(obj);
                let is_reachable = reachable.contains(obj_id);

                match obj {
                    Object::Stream(stream) => {
                        let dict = &stream.dict;
                        let content_size = stream_content_size(stream);

                        if is_image_stream(dict) {
                            stats.image_count += 1;
                            stats.image_size += obj_size;
                        } else if font_program_ids.contains(obj_id) || is_font_program(dict) {
                            stats.font_size += obj_size;
                        } else if is_metadata_stream(dict) {
                            stats.metadata_size += obj_size;
                        } else if is_form_xobject(dict) {
                            stats.form_xobject_count += 1;
                            stats.form_xobject_size += obj_size;
                        } else {
                            let is_content = dict.get(b"Length").is_ok();
                            if is_content && content_size > 0 {
                                stats.content_stream_count += 1;
                                stats.content_stream_size += obj_size;
                            } else {
                                stats.other_stream_count += 1;
                                stats.other_stream_size += obj_size;
                            }
                        }
                    }
                    Object::Dictionary(dict) => {
                        if !is_reachable {
                            stats.unused_size += obj_size;
                        } else {
                            let is_info = dict.get(b"Creator").is_ok()
                                || dict.get(b"Producer").is_ok()
                                || dict.get(b"Title").is_ok()
                                || dict.get(b"Author").is_ok()
                                || dict.get(b"Subject").is_ok()
                                || dict.get(b"Keywords").is_ok()
                                || dict.get(b"CreationDate").is_ok()
                                || dict.get(b"ModDate").is_ok();

                            if is_info {
                                stats.metadata_size += obj_size;
                            } else {
                                stats.dict_object_count += 1;
                                stats.dict_object_size += obj_size;
                            }
                        }
                    }
                    _ => {
                        if !is_reachable {
                            stats.unused_size += obj_size;
                        }
                    }
                }
            }

            let done = processed.fetch_add(chunk.len(), Ordering::Relaxed) + chunk.len();
            let last = class_last_reported.load(Ordering::Relaxed);
            if done.saturating_sub(last) >= 2000
                && class_last_reported
                    .compare_exchange(last, done, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
            {
                let pct = (65 + (done * 29).min(obj_count * 29) / obj_count.max(1)) as u8;
                progress_class(
                    pct,
                    &format!("正在分类对象... (已处理 {} / {} 对象)", done, obj_count),
                );
            }

            stats
        })
        .collect();

    // Merge chunk results
    for chunk in chunk_results {
        image_count += chunk.image_count;
        image_size += chunk.image_size;
        font_size += chunk.font_size;
        metadata_size += chunk.metadata_size;
        form_xobject_count += chunk.form_xobject_count;
        form_xobject_size += chunk.form_xobject_size;
        content_stream_count += chunk.content_stream_count;
        content_stream_size += chunk.content_stream_size;
        other_stream_count += chunk.other_stream_count;
        other_stream_size += chunk.other_stream_size;
        unused_size += chunk.unused_size;
        dict_object_count += chunk.dict_object_count;
        dict_object_size += chunk.dict_object_size;
    }

    progress_arc(95, "正在汇总结果...");
    let potential_savings = unused_size + metadata_size;

    let fonts = collect_font_info(&doc);

    let mut components = Vec::new();

    components.push(ComponentInfo {
        name: "图片".to_string(),
        count: image_count,
        size: image_size,
        description: "PDF中嵌入的位图图像（JPEG、PNG等）".to_string(),
    });

    components.push(ComponentInfo {
        name: "嵌入字体".to_string(),
        count: font_count,
        size: font_size,
        description: "嵌入的字体文件（Type1、TrueType、OpenType等）".to_string(),
    });

    components.push(ComponentInfo {
        name: "内容流".to_string(),
        count: content_stream_count,
        size: content_stream_size,
        description: "页面绘制指令（文本、矢量图形等）".to_string(),
    });

    components.push(ComponentInfo {
        name: "表单X对象".to_string(),
        count: form_xobject_count,
        size: form_xobject_size,
        description: "可复用的表单和矢量图形对象".to_string(),
    });

    components.push(ComponentInfo {
        name: "元数据".to_string(),
        count: 0,
        size: metadata_size,
        description: "文档信息字典、XMP元数据等".to_string(),
    });

    components.push(ComponentInfo {
        name: "其他流对象".to_string(),
        count: other_stream_count,
        size: other_stream_size,
        description: "注释、附件、JavaScript等其他流".to_string(),
    });

    components.push(ComponentInfo {
        name: "结构对象".to_string(),
        count: dict_object_count,
        size: dict_object_size,
        description: "页面树、字体字典、目录等结构信息".to_string(),
    });

    components.push(ComponentInfo {
        name: "未使用对象".to_string(),
        count: unused_object_count,
        size: unused_size,
        description: "孤立的、未被引用的对象（可安全删除）".to_string(),
    });

    progress_arc(92, "正在分析重复图片...");
    let (duplicate_image_groups, reused_image_objects, duplicate_image_savings) =
        analyze_duplicate_images(path);

    Ok(PdfAnalysis {
        file_path: file_path.to_string(),
        file_size,
        page_count,
        pdf_version,
        components,
        fonts,
        total_object_count,
        unused_object_count,
        potential_savings,
        duplicate_image_groups,
        reused_image_objects,
        duplicate_image_savings,
    })
}
