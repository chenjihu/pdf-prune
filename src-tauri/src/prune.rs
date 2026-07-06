use flate2::write::ZlibEncoder;
use flate2::Compression;
use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Deserialize, Clone)]
pub struct PruneOptions {
    pub remove_unused_objects: bool,
    pub remove_metadata: bool,
    pub remove_xmp_metadata: bool,
    pub remove_embedded_files: bool,
    pub remove_javascript: bool,
    pub remove_thumbnails: bool,
    pub remove_annotations: bool,
    pub remove_structure_tree: bool,
    pub compress_streams: bool,
    pub remove_page_labels: bool,
    pub remove_piece_info: bool,
    pub remove_mark_info: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct PruneResult {
    pub output_path: String,
    pub original_size: usize,
    pub pruned_size: usize,
    pub savings: usize,
    pub savings_percent: f64,
    pub actions: Vec<String>,
}

impl Default for PruneOptions {
    fn default() -> Self {
        PruneOptions {
            remove_unused_objects: true,
            remove_metadata: true,
            remove_xmp_metadata: true,
            remove_embedded_files: true,
            remove_javascript: true,
            remove_thumbnails: true,
            remove_annotations: false,
            remove_structure_tree: false,
            compress_streams: true,
            remove_page_labels: true,
            remove_piece_info: true,
            remove_mark_info: false,
        }
    }
}

fn name_eq(obj: &Object, expected: &[u8]) -> bool {
    if let Object::Name(name) = obj {
        return name.as_slice() == expected;
    }
    false
}

fn compress_stream_data(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap_or_else(|_| data.to_vec())
}

fn is_already_compressed(dict: &Dictionary) -> bool {
    if let Ok(filter) = dict.get(b"Filter") {
        match filter {
            Object::Name(name) => {
                let n = name.as_slice();
                return n == b"FlateDecode"
                    || n == b"LZWDecode"
                    || n == b"DCTDecode"
                    || n == b"CCITTFaxDecode"
                    || n == b"JPXDecode"
                    || n == b"RunLengthDecode";
            }
            Object::Array(arr) => {
                for item in arr {
                    if let Object::Name(name) = item {
                        let n = name.as_slice();
                        if n == b"FlateDecode" || n == b"LZWDecode" {
                            return true;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    false
}

fn is_image_stream(dict: &Dictionary) -> bool {
    dict.get(b"Subtype")
        .map(|v| name_eq(v, b"Image"))
        .unwrap_or(false)
}

fn is_font_program(dict: &Dictionary) -> bool {
    if let Ok(subtype) = dict.get(b"Subtype") {
        if name_eq(subtype, b"Type1C")
            || name_eq(subtype, b"OpenType")
            || name_eq(subtype, b"CIDFontType0C")
        {
            return true;
        }
    }
    dict.get(b"Type")
        .map(|v| name_eq(v, b"FontFile"))
        .unwrap_or(false)
}

pub fn prune_pdf(
    input_path: &str,
    output_path: &str,
    options: &PruneOptions,
    progress: impl Fn(u8, &str),
    cancel: Arc<AtomicBool>,
) -> Result<PruneResult, String> {
    let input = Path::new(input_path);
    let original_size = input
        .metadata()
        .map_err(|e| format!("无法读取原文件: {}", e))?
        .len() as usize;

    progress(5, "正在加载 PDF 文件...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    let mut doc = Document::load(input).map_err(|e| format!("无法加载PDF: {}", e))?;
    let mut actions = Vec::new();

    progress(15, "正在移除元数据和脚本...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // Helper: get catalog ObjectId from trailer
    let catalog_id = doc.trailer.get(b"Root").and_then(Object::as_reference).ok();

    // 1. Remove XMP metadata stream
    if options.remove_xmp_metadata {
        if let Some(cat_id) = catalog_id {
            if let Ok(cat_dict) = doc.get_dictionary_mut(cat_id) {
                if cat_dict.remove(b"Metadata").is_some() {
                    actions.push("移除XMP元数据流".to_string());
                }
            }
        }
    }

    // 2. Remove Info dictionary metadata
    if options.remove_metadata {
        if let Ok(info_id) = doc.trailer.get(b"Info").and_then(Object::as_reference) {
            if let Ok(info_obj) = doc.get_object_mut(info_id) {
                if let Object::Dictionary(info_dict) = info_obj {
                    let keys: Vec<Vec<u8>> = info_dict.iter().map(|(k, _)| k.clone()).collect();
                    if !keys.is_empty() {
                        for key in keys {
                            info_dict.remove(&key);
                        }
                        actions.push("清空文档信息字典(作者、标题、关键词等)".to_string());
                    }
                }
            }
        }
    }

    // 3. Remove JavaScript
    if options.remove_javascript {
        if let Some(cat_id) = catalog_id {
            if let Ok(cat_dict) = doc.get_dictionary_mut(cat_id) {
                if cat_dict.remove(b"Names").is_some() {
                    actions.push("移除JavaScript和命名树".to_string());
                }
                if cat_dict.remove(b"AcroForm").is_some() {
                    actions.push("移除AcroForm(含JavaScript)".to_string());
                }
                if cat_dict.remove(b"OpenAction").is_some() {
                    actions.push("移除打开时动作(可能含JavaScript)".to_string());
                }
            }
        }
    }

    // 4. Remove embedded files / attachments
    if options.remove_embedded_files {
        if let Some(cat_id) = catalog_id {
            if let Ok(cat_dict) = doc.get_dictionary(cat_id) {
                if let Ok(Object::Reference(names_id)) = cat_dict.get(b"Names") {
                    if let Ok(names_obj) = doc.get_object_mut(*names_id) {
                        if let Object::Dictionary(names_dict) = names_obj {
                            if names_dict.remove(b"EmbeddedFiles").is_some() {
                                actions.push("移除嵌入文件/附件".to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // 5. Remove thumbnails from pages
    if options.remove_thumbnails {
        let page_ids: Vec<ObjectId> = doc.get_pages().values().cloned().collect();
        let mut thumb_removed = 0;
        for page_id in page_ids {
            if let Ok(page_obj) = doc.get_object_mut(page_id) {
                if let Object::Dictionary(page_dict) = page_obj {
                    if page_dict.remove(b"Thumb").is_some() {
                        thumb_removed += 1;
                    }
                }
            }
        }
        if thumb_removed > 0 {
            actions.push(format!("移除{}个页面缩略图", thumb_removed));
        }
    }

    // 6. Remove annotations
    if options.remove_annotations {
        let page_ids: Vec<ObjectId> = doc.get_pages().values().cloned().collect();
        let mut annot_removed = 0;
        for page_id in page_ids {
            if let Ok(page_obj) = doc.get_object_mut(page_id) {
                if let Object::Dictionary(page_dict) = page_obj {
                    if page_dict.remove(b"Annots").is_some() {
                        annot_removed += 1;
                    }
                }
            }
        }
        if annot_removed > 0 {
            actions.push(format!("移除{}个页面的注释", annot_removed));
        }
    }

    // 7. Remove structure tree (tagged PDF)
    if options.remove_structure_tree {
        if let Some(cat_id) = catalog_id {
            if let Ok(cat_dict) = doc.get_dictionary_mut(cat_id) {
                if cat_dict.remove(b"MarkInfo").is_some() {
                    actions.push("移除标记信息".to_string());
                }
                if cat_dict.remove(b"StructTreeRoot").is_some() {
                    actions.push("移除结构树(标签化PDF)".to_string());
                }
            }
        }
    }

    // 8. Remove page labels
    if options.remove_page_labels {
        if let Some(cat_id) = catalog_id {
            if let Ok(cat_dict) = doc.get_dictionary_mut(cat_id) {
                if cat_dict.remove(b"PageLabels").is_some() {
                    actions.push("移除页面标签".to_string());
                }
            }
        }
    }

    // 9. Remove piece info
    if options.remove_piece_info {
        if let Some(cat_id) = catalog_id {
            if let Ok(cat_dict) = doc.get_dictionary_mut(cat_id) {
                if cat_dict.remove(b"PieceInfo").is_some() {
                    actions.push("移除PieceInfo".to_string());
                }
            }
        }
        let page_ids: Vec<ObjectId> = doc.get_pages().values().cloned().collect();
        for page_id in page_ids {
            if let Ok(page_obj) = doc.get_object_mut(page_id) {
                if let Object::Dictionary(page_dict) = page_obj {
                    page_dict.remove(b"PieceInfo");
                }
            }
        }
    }

    // 10. Remove mark info
    if options.remove_mark_info {
        if let Some(cat_id) = catalog_id {
            if let Ok(cat_dict) = doc.get_dictionary_mut(cat_id) {
                if cat_dict.remove(b"MarkInfo").is_some() {
                    actions.push("移除MarkInfo".to_string());
                }
            }
        }
    }

    progress(40, "正在压缩未压缩的流对象...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // 11. Compress uncompressed streams (not images, not font programs)
    if options.compress_streams {
        let obj_ids: Vec<ObjectId> = doc.objects.keys().cloned().collect();
        let mut compressed_count = 0;

        for obj_id in obj_ids {
            let should_skip = {
                if let Ok(obj) = doc.get_object(obj_id) {
                    if let Object::Stream(stream) = obj {
                        is_image_stream(&stream.dict) || is_font_program(&stream.dict)
                    } else {
                        true
                    }
                } else {
                    true
                }
            };

            if should_skip {
                continue;
            }

            if let Ok(obj) = doc.get_object_mut(obj_id) {
                if let Object::Stream(stream) = obj {
                    if !is_already_compressed(&stream.dict) && stream.content.len() > 100 {
                        let original_len = stream.content.len();
                        let compressed = compress_stream_data(&stream.content);
                        if compressed.len() < original_len {
                            stream.content = compressed;
                            stream
                                .dict
                                .set("Filter", Object::Name(b"FlateDecode".to_vec()));
                            let new_len = stream.content.len() as i64;
                            stream.dict.set("Length", Object::Integer(new_len));
                            compressed_count += 1;
                        }
                    }
                }
            }
        }
        if compressed_count > 0 {
            actions.push(format!("压缩{}个未压缩的流对象", compressed_count));
        }
    }

    progress(70, "正在清理未使用对象...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // 12. Remove unused objects (garbage collect) - use lopdf's built-in traverse
    if options.remove_unused_objects {
        let reachable: HashSet<ObjectId> = doc.traverse_objects(|_| {}).into_iter().collect();
        let all_ids: Vec<ObjectId> = doc.objects.keys().cloned().collect();
        let mut removed_count = 0;

        for obj_id in all_ids {
            if !reachable.contains(&obj_id) {
                // Don't remove the catalog or info dict
                if let Some(cat_id) = catalog_id {
                    if obj_id == cat_id {
                        continue;
                    }
                }
                if doc.objects.remove(&obj_id).is_some() {
                    removed_count += 1;
                }
            }
        }
        if removed_count > 0 {
            actions.push(format!("移除{}个未使用的孤立对象", removed_count));
        }
    }

    progress(85, "正在保存修剪后的文件...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // Save the pruned document
    doc.compress();
    doc.save(output_path)
        .map_err(|e| format!("无法保存修剪后的PDF: {}", e))?;

    let pruned_size = Path::new(output_path)
        .metadata()
        .map_err(|e| format!("无法读取输出文件: {}", e))?
        .len() as usize;

    let savings = original_size.saturating_sub(pruned_size);
    let savings_percent = if original_size > 0 {
        (savings as f64 / original_size as f64) * 100.0
    } else {
        0.0
    };

    Ok(PruneResult {
        output_path: output_path.to_string(),
        original_size,
        pruned_size,
        savings,
        savings_percent,
        actions,
    })
}
