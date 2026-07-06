use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Serialize, Clone, Deserialize)]
pub struct ImageSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct RemoveImagesResult {
    pub output_path: String,
    pub original_size: usize,
    pub output_size: usize,
    pub images_removed: usize,
    pub pages_affected: usize,
    pub actions: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImageInfo {
    pub page: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: f64,
    pub y: f64,
    pub object_id: String,
    pub ctm_a: f64,
    pub ctm_b: f64,
    pub ctm_c: f64,
    pub ctm_d: f64,
    pub ctm_e: f64,
    pub ctm_f: f64,
    pub mediabox: Vec<f64>,
    pub raw_ops: Vec<String>,
}

pub fn list_images(
    input_path: &str,
    progress: impl Fn(u8, &str),
    cancel: Arc<AtomicBool>,
) -> Result<Vec<ImageInfo>, String> {
    progress(5, "正在加载 PDF 文件...");
    if cancel.load(Ordering::Relaxed) { return Err("已取消".to_string()); }

    let doc = Document::load(input_path)
        .map_err(|e| format!("无法加载PDF文件: {}", e))?;

    if cancel.load(Ordering::Relaxed) { return Err("已取消".to_string()); }
    progress(20, "正在解析页面结构...");

    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    let total_pages = pages.len();

    if total_pages == 0 {
        return Err("PDF 文件没有页面".to_string());
    }

    let mut images: Vec<ImageInfo> = Vec::new();

    for (page_idx, (page_num, page_id)) in pages.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) { return Err("已取消".to_string()); }
        let pct = 20 + ((page_idx * 70) / total_pages.max(1));
        progress(pct as u8, &format!("正在扫描第 {} 页...", page_num));

        // Get page MediaBox
        let mediabox: Vec<f64> = {
            let mut mb = vec![0.0, 0.0, 595.0, 842.0]; // default A4
            if let Ok(page_dict) = doc.get_dictionary(*page_id) {
                if let Ok(mb_obj) = page_dict.get(b"MediaBox") {
                    if let Object::Array(arr) = mb_obj {
                        let vals: Vec<f64> = arr.iter().filter_map(obj_to_f64).collect();
                        if vals.len() == 4 {
                            mb = vals;
                        }
                    }
                }
            }
            mb
        };

        // Get XObject dictionary for this page
        let xobject_dict = get_xobject_dict(&doc, *page_id);

        // Build a map of all image names -> (ObjectId, width, height)
        let mut all_images: HashMap<Vec<u8>, (ObjectId, u32, u32)> = HashMap::new();
        if let Some(xobj_dict) = &xobject_dict {
            for (name, value) in xobj_dict.iter() {
                if let Object::Reference(id) = value {
                    if let Ok(Object::Stream(stream)) = doc.get_object(*id) {
                        if is_image_stream(stream) {
                            if let Some((w, h)) = get_image_dimensions(stream) {
                                all_images.insert(name.clone(), (*id, w, h));
                            }
                        }
                    }
                }
            }
        }

        if all_images.is_empty() {
            continue;
        }

        // Parse content streams to find Do operations and their positions
        // Concatenate all content streams first, since cm and Do may be in different streams
        let content_ids = doc.get_page_contents(*page_id);
        let mut all_content_data: Vec<u8> = Vec::new();
        for content_id in &content_ids {
            if let Ok(Object::Stream(stream)) = doc.get_object(*content_id) {
                match stream.decompressed_content() {
                    Ok(data) => all_content_data.extend_from_slice(&data),
                    Err(_) => all_content_data.extend_from_slice(&stream.content),
                }
            }
        }

        let content = match Content::decode(&all_content_data) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut ctm = Matrix::identity();
        let mut ctm_stack: Vec<Matrix> = Vec::new();
        let mut op_history: Vec<String> = Vec::new();

        for op in &content.operations {
                let op_str = format!("{} {}", op.operands.iter().map(|o| match o {
                    Object::Integer(i) => i.to_string(),
                    Object::Real(r) => r.to_string(),
                    Object::Name(n) => format!("/{}", String::from_utf8_lossy(n)),
                    _ => "?".to_string(),
                }).collect::<Vec<_>>().join(" "), op.operator);

                match op.operator.as_str() {
                    "q" => {
                        ctm_stack.push(ctm);
                        op_history.push(op_str);
                    }
                    "Q" => {
                        if let Some(prev) = ctm_stack.pop() {
                            ctm = prev;
                        }
                        op_history.push(op_str);
                    }
                    "cm" => {
                        if op.operands.len() == 6 {
                            let vals: Vec<f64> = op.operands.iter().filter_map(obj_to_f64).collect();
                            if vals.len() == 6 {
                                let transform = Matrix {
                                    a: vals[0], b: vals[1], c: vals[2],
                                    d: vals[3], e: vals[4], f: vals[5],
                                };
                                ctm = transform.prepend(&ctm);
                            }
                        }
                        op_history.push(op_str);
                    }
                    "Do" => {
                        if op.operands.len() == 1 {
                            if let Object::Name(name) = &op.operands[0] {
                                if let Some((id, w, h)) = all_images.get(name.as_slice()) {
                                    images.push(ImageInfo {
                                        page: *page_num,
                                        name: String::from_utf8_lossy(name).to_string(),
                                        width: *w,
                                        height: *h,
                                        x: ctm.e,
                                        y: ctm.f,
                                        object_id: format!("{} {}", id.0, id.1),
                                        ctm_a: ctm.a,
                                        ctm_b: ctm.b,
                                        ctm_c: ctm.c,
                                        ctm_d: ctm.d,
                                        ctm_e: ctm.e,
                                        ctm_f: ctm.f,
                                        mediabox: mediabox.clone(),
                                        raw_ops: op_history.iter().rev().take(10).rev().cloned().collect(),
                                    });
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
    }

    progress(100, "完成");
    Ok(images)
}

#[derive(Debug, Clone, Copy)]
struct Matrix {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Matrix {
    fn identity() -> Self {
        Matrix { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 }
    }

    // PDF spec: cm operator sets CTM' = M × CTM (M is prepended)
    fn prepend(&self, ctm: &Matrix) -> Matrix {
        // result = self × ctm
        Matrix {
            a: self.a * ctm.a + self.b * ctm.c,
            b: self.a * ctm.b + self.b * ctm.d,
            c: self.c * ctm.a + self.d * ctm.c,
            d: self.c * ctm.b + self.d * ctm.d,
            e: self.e * ctm.a + self.f * ctm.c + ctm.e,
            f: self.e * ctm.b + self.f * ctm.d + ctm.f,
        }
    }
}

fn obj_to_f64(obj: &Object) -> Option<f64> {
    match obj {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

fn get_xobject_dict<'a>(doc: &'a Document, page_id: ObjectId) -> Option<&'a Dictionary> {
    // Walk page and its parent(s) to find Resources > XObject
    let mut current_id = page_id;
    let mut visited = std::collections::HashSet::new();

    loop {
        if visited.contains(&current_id) {
            break;
        }
        visited.insert(current_id);

        if let Ok(page_dict) = doc.get_dictionary(current_id) {
            // Direct Resources dict
            if let Ok(res) = page_dict.get(b"Resources") {
                let res_dict = match res {
                    Object::Dictionary(d) => Some(d),
                    Object::Reference(id) => doc.get_object(*id).and_then(Object::as_dict).ok(),
                    _ => None,
                };
                if let Some(rd) = res_dict {
                    if let Ok(xobj) = rd.get(b"XObject") {
                        let xobj_dict = match xobj {
                            Object::Dictionary(d) => Some(d),
                            Object::Reference(id) => doc.get_object(*id).and_then(Object::as_dict).ok(),
                            _ => None,
                        };
                        if let Some(xd) = xobj_dict {
                            return Some(xd);
                        }
                    }
                }
            }
            // Walk up to parent
            if let Ok(Object::Reference(parent_id)) = page_dict.get(b"Parent") {
                current_id = *parent_id;
                continue;
            }
        }
        break;
    }
    None
}


fn is_image_stream(stream: &Stream) -> bool {
    stream.dict.get(b"Subtype")
        .map(|v| {
            if let Object::Name(n) = v { n.as_slice() == b"Image" } else { false }
        })
        .unwrap_or(false)
}

fn get_image_dimensions(stream: &Stream) -> Option<(u32, u32)> {
    let width = obj_to_f64(stream.dict.get(b"Width").ok()?).map(|v| v as u32)?;
    let height = obj_to_f64(stream.dict.get(b"Height").ok()?).map(|v| v as u32)?;
    Some((width, height))
}

pub fn remove_images_by_criteria(
    input_path: &str,
    output_path: &str,
    target_sizes: Vec<ImageSize>,
    y_min: f64,
    y_max: f64,
    progress: impl Fn(u8, &str),
    cancel: Arc<AtomicBool>,
) -> Result<RemoveImagesResult, String> {
    let start_path = Path::new(input_path);
    let original_size = start_path
        .metadata()
        .map_err(|e| format!("无法读取文件信息: {}", e))?
        .len() as usize;

    progress(5, "正在加载 PDF 文件...");
    if cancel.load(Ordering::Relaxed) { return Err("已取消".to_string()); }

    let mut doc = Document::load(input_path)
        .map_err(|e| format!("无法加载PDF文件: {}", e))?;

    if cancel.load(Ordering::Relaxed) { return Err("已取消".to_string()); }
    progress(20, "正在解析页面结构...");

    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    let total_pages = pages.len();

    if total_pages == 0 {
        return Err("PDF 文件没有页面".to_string());
    }

    let mut images_removed = 0usize;
    let mut pages_affected = 0usize;
    let mut actions: Vec<String> = Vec::new();
    let mut removed_image_ids: Vec<ObjectId> = Vec::new();

    for (page_idx, (page_num, page_id)) in pages.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) { return Err("已取消".to_string()); }
        let pct = 20 + ((page_idx * 70) / total_pages.max(1));
        progress(pct as u8, &format!("正在处理第 {} 页 (共 {} 页)...", page_num, total_pages));

        // Get XObject dictionary for this page
        let xobject_dict = get_xobject_dict(&doc, *page_id);

        // Concatenate all content streams for this page
        let content_ids = doc.get_page_contents(*page_id);
        if content_ids.is_empty() {
            continue;
        }

        // Build a map of image name -> (ObjectId, width, height) for matching images
        let mut matching_images: HashMap<Vec<u8>, (ObjectId, u32, u32)> = HashMap::new();
        if let Some(xobj_dict) = &xobject_dict {
            for (name, value) in xobj_dict.iter() {
                if let Object::Reference(id) = value {
                    if let Ok(Object::Stream(stream)) = doc.get_object(*id) {
                        if is_image_stream(stream) {
                            if let Some((w, h)) = get_image_dimensions(stream) {
                                if target_sizes.iter().any(|s| s.width == w && s.height == h) {
                                    matching_images.insert(name.clone(), (*id, w, h));
                                }
                            }
                        }
                    }
                }
            }
        }

        if matching_images.is_empty() {
            continue;
        }

        // Concatenate all content streams
        let mut all_content_data: Vec<u8> = Vec::new();
        for content_id in &content_ids {
            if let Ok(Object::Stream(stream)) = doc.get_object(*content_id) {
                match stream.decompressed_content() {
                    Ok(data) => all_content_data.extend_from_slice(&data),
                    Err(_) => all_content_data.extend_from_slice(&stream.content),
                }
            }
        }

        let content = Content::decode(&all_content_data)
            .map_err(|e| format!("解码内容流失败 (页 {}): {}", page_num, e))?;

        // Track CTM and graphics state stack
        let mut ctm = Matrix::identity();
        let mut ctm_stack: Vec<Matrix> = Vec::new();

        let mut new_operations: Vec<Operation> = Vec::new();
        let mut removed_in_this_stream = 0usize;

        for op in &content.operations {
                match op.operator.as_str() {
                    "q" => {
                        ctm_stack.push(ctm);
                        new_operations.push(op.clone());
                    }
                    "Q" => {
                        if let Some(prev) = ctm_stack.pop() {
                            ctm = prev;
                        }
                        new_operations.push(op.clone());
                    }
                    "cm" => {
                        if op.operands.len() == 6 {
                            let vals: Vec<f64> = op.operands.iter().filter_map(obj_to_f64).collect();
                            if vals.len() == 6 {
                                let transform = Matrix {
                                    a: vals[0], b: vals[1], c: vals[2],
                                    d: vals[3], e: vals[4], f: vals[5],
                                };
                                // PDF spec: CTM' = M × CTM (prepend)
                                ctm = transform.prepend(&ctm);
                            }
                        }
                        new_operations.push(op.clone());
                    }
                    "Do" => {
                        // Check if this Do references a matching image
                        let should_remove = if op.operands.len() == 1 {
                            if let Object::Name(name) = &op.operands[0] {
                                if matching_images.contains_key(name.as_slice()) {
                                    // Y position is the f component of current CTM
                                    let y = ctm.f;
                                    y >= y_min && y <= y_max
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        } else {
                            false
                        };

                        if should_remove {
                            removed_in_this_stream += 1;
                            if let Object::Name(name) = &op.operands[0] {
                                if let Some((img_id, w, h)) = matching_images.get(name.as_slice()) {
                                    removed_image_ids.push(*img_id);
                                    actions.push(format!(
                                        "第 {} 页: 移除图片 /{} ({}×{}px, Y={:.1})",
                                        page_num,
                                        String::from_utf8_lossy(name),
                                        w, h,
                                        ctm.f
                                    ));
                                }
                            }
                            // Skip this operation (don't add to new_operations)
                        } else {
                            new_operations.push(op.clone());
                        }
                    }
                    _ => {
                        new_operations.push(op.clone());
                    }
                }
            }

        let mut page_modified = false;
        if removed_in_this_stream > 0 {
            page_modified = true;
            images_removed += removed_in_this_stream;

            // Re-encode content and write back to the first content stream
            let new_content = Content { operations: new_operations };
            let encoded = new_content.encode()
                .map_err(|e| format!("编码内容流失败 (页 {}): {}", page_num, e))?;

            // Write to first content stream, clear the rest
            if let Some(first_id) = content_ids.first() {
                if let Ok(Object::Stream(stream)) = doc.get_object_mut(*first_id) {
                    let had_filter = stream.dict.get(b"Filter").is_ok();
                    stream.set_plain_content(encoded);
                    if had_filter {
                        let _ = stream.compress();
                    }
                }
            }
            // Clear remaining content streams
            for content_id in content_ids.iter().skip(1) {
                if let Ok(Object::Stream(stream)) = doc.get_object_mut(*content_id) {
                    stream.set_plain_content(Vec::new());
                }
            }
        }

        if page_modified {
            pages_affected += 1;
        }
    }

    if cancel.load(Ordering::Relaxed) { return Err("已取消".to_string()); }
    progress(92, "正在清理图片对象...");

    // Remove unused image objects (deduplicate first)
    let mut seen = std::collections::HashSet::new();
    for img_id in &removed_image_ids {
        if seen.insert(*img_id) {
            let _ = doc.delete_object(*img_id);
        }
    }

    progress(95, "正在保存 PDF 文件...");

    // Save (don't call doc.compress() - it recompresses ALL streams and may produce larger output)
    let tmp_path = format!("{}.tmp", output_path);
    doc.save(&tmp_path)
        .map_err(|e| format!("保存PDF失败: {}", e))?;

    // Atomic rename
    std::fs::rename(&tmp_path, output_path)
        .map_err(|e| format!("重命名文件失败: {}", e))?;

    let output_size = Path::new(output_path)
        .metadata()
        .map(|m| m.len() as usize)
        .unwrap_or(0);

    progress(100, "完成");

    Ok(RemoveImagesResult {
        output_path: output_path.to_string(),
        original_size,
        output_size,
        images_removed,
        pages_affected,
        actions,
    })
}
