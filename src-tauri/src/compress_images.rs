use flate2::read::{DeflateDecoder, ZlibDecoder};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Debug, Serialize, Clone, Deserialize)]
pub struct ExtractedImageInfo {
    pub id: String,
    pub page: u32,
    pub name: String,
    pub object_id: String,
    pub width: u32,
    pub height: u32,
    pub file_size: usize,
    pub format: String,
    pub color_space: String,
    pub bits_per_component: u8,
    pub temp_path: String,
    pub preview_path: String,
    pub supported: bool,
}

#[derive(Debug, Serialize, Clone, Deserialize)]
pub struct CompressedImageEntry {
    pub object_id: String,
    pub temp_path: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Clone, Deserialize)]
pub struct CompressImagesResult {
    pub output_path: String,
    pub original_size: usize,
    pub output_size: usize,
    pub images_compressed: usize,
    pub actions: Vec<String>,
}

fn obj_to_f64(obj: &Object) -> Option<f64> {
    match obj {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

fn get_xobject_dict<'a>(doc: &'a Document, page_id: ObjectId) -> Option<&'a Dictionary> {
    let mut current_id = page_id;
    let mut visited = HashSet::new();

    loop {
        if visited.contains(&current_id) {
            break;
        }
        visited.insert(current_id);

        if let Ok(page_dict) = doc.get_dictionary(current_id) {
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
    stream
        .dict
        .get(b"Subtype")
        .map(|v| {
            if let Object::Name(n) = v {
                n.as_slice() == b"Image"
            } else {
                false
            }
        })
        .unwrap_or(false)
}

fn get_image_dimensions(stream: &Stream) -> Option<(u32, u32)> {
    let width = obj_to_f64(stream.dict.get(b"Width").ok()?).map(|v| v as u32)?;
    let height = obj_to_f64(stream.dict.get(b"Height").ok()?).map(|v| v as u32)?;
    Some((width, height))
}

fn get_color_space(stream: &Stream) -> String {
    if let Ok(cs) = stream.dict.get(b"ColorSpace") {
        match cs {
            Object::Name(n) => String::from_utf8_lossy(n).to_string(),
            Object::Array(arr) => {
                if let Some(Object::Name(n)) = arr.first() {
                    String::from_utf8_lossy(n).to_string()
                } else {
                    "Unknown".to_string()
                }
            }
            _ => "Unknown".to_string(),
        }
    } else {
        "Unknown".to_string()
    }
}

fn get_bits_per_component(stream: &Stream) -> u8 {
    stream
        .dict
        .get(b"BitsPerComponent")
        .ok()
        .and_then(|v| {
            if let Object::Integer(i) = v {
                Some(*i as u8)
            } else if let Object::Real(r) = v {
                Some(*r as u8)
            } else {
                None
            }
        })
        .unwrap_or(8)
}

fn get_filter_names(stream: &Stream) -> Vec<Vec<u8>> {
    match stream.dict.get(b"Filter") {
        Ok(Object::Name(n)) => vec![n.clone()],
        Ok(Object::Array(arr)) => arr
            .iter()
            .filter_map(|o| if let Object::Name(n) = o { Some(n.clone()) } else { None })
            .collect(),
        _ => vec![],
    }
}

fn get_decode_parms_list(stream: &Stream) -> Vec<Option<Dictionary>> {
    match stream.dict.get(b"DecodeParms") {
        Ok(Object::Dictionary(d)) => vec![Some(d.clone())],
        Ok(Object::Array(arr)) => arr
            .iter()
            .map(|o| if let Object::Dictionary(d) = o { Some(d.clone()) } else { None })
            .collect(),
        _ => vec![],
    }
}

/// Walks the PDF filter chain in array order, applying generic decompression
/// filters (Flate/ASCII85/ASCIIHex/RunLength) and stopping at the terminal
/// image-specific codec (DCTDecode/JPXDecode/CCITTFaxDecode/JBIG2Decode), or
/// "raw" if the chain contains only generic filters (or none).
/// Returns (buffer_after_generic_filters, final_format, decode_parms_for_terminal_filter).
fn resolve_stream_data_parts(
    content: Vec<u8>,
    filters: Vec<Vec<u8>>,
    parms: Vec<Option<Dictionary>>,
) -> Result<(Vec<u8>, String, Option<Dictionary>), String> {
    let mut buffer = content;
    let mut final_format = "raw".to_string();
    let mut final_parms: Option<Dictionary> = None;

    for (i, name) in filters.iter().enumerate() {
        let parm = parms.get(i).cloned().flatten();
        match name.as_slice() {
            b"FlateDecode" => {
                buffer = flate_decompress(&buffer)?;
            }
            b"ASCII85Decode" => {
                buffer = ascii85_decode(&buffer)?;
            }
            b"ASCIIHexDecode" => {
                buffer = asciihex_decode(&buffer)?;
            }
            b"RunLengthDecode" => {
                buffer = runlength_decode(&buffer)?;
            }
            b"LZWDecode" => {
                return Err("LZWDecode 暂不支持".to_string());
            }
            b"DCTDecode" => {
                final_format = "jpeg".to_string();
                final_parms = parm;
            }
            b"JPXDecode" => {
                final_format = "jpeg2000".to_string();
                final_parms = parm;
            }
            b"CCITTFaxDecode" => {
                final_format = "ccitt".to_string();
                final_parms = parm;
            }
            b"JBIG2Decode" => {
                final_format = "jbig2".to_string();
                final_parms = parm;
            }
            _ => {}
        }
    }
    Ok((buffer, final_format, final_parms))
}

fn ensure_jpx_hook_registered() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        hayro_jpeg2000::integration::register_decoding_hook();
    });
}

/// Decode a CCITT Group 3/4 encoded bitmap (as used by PDF's CCITTFaxDecode
/// filter) into an 8-bit grayscale PNG. Returns (png_bytes, width, height).
fn ccitt_decode_to_png(data: &[u8], width: u32, height: u32, parms: Option<&Dictionary>) -> Result<(Vec<u8>, u32, u32), String> {
    let k = parms
        .and_then(|d| d.get(b"K").ok())
        .and_then(|v| if let Object::Integer(i) = v { Some(*i) } else { None })
        .unwrap_or(0);
    let columns = parms
        .and_then(|d| d.get(b"Columns").ok())
        .and_then(|v| if let Object::Integer(i) = v { Some(*i as u32) } else { None })
        .filter(|&c| c > 0)
        .unwrap_or(if width > 0 { width } else { 1728 });

    let mut buf: Vec<u8> = Vec::with_capacity((columns as usize) * (height.max(1) as usize));
    let mut n_rows: usize = 0;
    let cb = |line: &[u16]| {
        n_rows += 1;
        buf.extend(fax::decoder::pels(line, columns as u16).map(|c| if c == fax::Color::Black { 0u8 } else { 255u8 }));
    };

    let result = if k < 0 {
        fax::decoder::decode_g4(data.iter().copied(), columns as u16, if height > 0 { Some(height as u16) } else { None }, cb)
    } else {
        fax::decoder::decode_g3(data.iter().copied(), cb)
    };

    if result.is_none() && n_rows == 0 {
        return Err("CCITT解码失败: 未解出任何行".to_string());
    }

    let h = if height > 0 { n_rows.min(height as usize) } else { n_rows } as u32;
    if h == 0 {
        return Err("CCITT解码失败: 解出0行".to_string());
    }
    buf.truncate((columns * h) as usize);

    let mut out = Cursor::new(Vec::new());
    image::write_buffer_with_format(&mut out, &buf, columns, h, image::ColorType::L8, image::ImageFormat::Png)
        .map_err(|e| format!("编码PNG失败: {}", e))?;
    Ok((out.into_inner(), columns, h))
}

fn ascii85_decode(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut group = [0u8; 5];
    let mut group_len = 0;
    let mut iter = data.iter().copied().peekable();
    while let Some(b) = iter.next() {
        if b == b'~' { break; }
        if b.is_ascii_whitespace() { continue; }
        if b == b'z' && group_len == 0 {
            out.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        if !(b'!'..=b'u').contains(&b) { continue; }
        group[group_len] = b - b'!';
        group_len += 1;
        if group_len == 5 {
            let mut val: u32 = 0;
            for &g in &group { val = val.wrapping_mul(85).wrapping_add(g as u32); }
            out.extend_from_slice(&val.to_be_bytes());
            group_len = 0;
        }
    }
    if group_len > 0 {
        for i in group_len..5 { group[i] = 84; }
        let mut val: u32 = 0;
        for &g in &group { val = val.wrapping_mul(85).wrapping_add(g as u32); }
        let bytes = val.to_be_bytes();
        out.extend_from_slice(&bytes[..group_len - 1]);
    }
    Ok(out)
}

fn asciihex_decode(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut hi: Option<u8> = None;
    for &b in data {
        if b == b'>' { break; }
        let v = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            _ => continue,
        };
        match hi {
            None => hi = Some(v),
            Some(h) => { out.push((h << 4) | v); hi = None; }
        }
    }
    if let Some(h) = hi { out.push(h << 4); }
    Ok(out)
}

fn runlength_decode(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let len = data[i];
        i += 1;
        if len == 128 { break; }
        if len < 128 {
            let n = len as usize + 1;
            if i + n > data.len() { break; }
            out.extend_from_slice(&data[i..i + n]);
            i += n;
        } else {
            if i >= data.len() { break; }
            let n = 257 - len as usize;
            out.extend(std::iter::repeat(data[i]).take(n));
            i += 1;
        }
    }
    Ok(out)
}

fn make_placeholder_preview(width: u32, height: u32, out_path: &Path) -> Result<(), String> {
    let (pw, ph) = if width > height {
        (300u32, (300.0 * height as f64 / width as f64).max(1.0) as u32)
    } else {
        ((300.0 * width as f64 / height as f64).max(1.0) as u32, 300u32)
    };
    let img = image::ImageBuffer::from_fn(pw.max(1), ph.max(1), |x, y| {
        let border = x < 2 || y < 2 || x >= pw.saturating_sub(2) || y >= ph.saturating_sub(2);
        if border {
            image::Rgb([160u8, 160, 160])
        } else {
            image::Rgb([225u8, 225, 225])
        }
    });
    image::DynamicImage::ImageRgb8(img)
        .save(out_path)
        .map_err(|e| format!("保存占位预览失败: {}", e))?;
    Ok(())
}

fn create_session_temp_dir() -> Result<std::path::PathBuf, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("获取时间失败: {}", e))?
        .as_millis();
    let dir = std::env::temp_dir().join(format!("pdf-prune-{}", now));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建临时目录失败: {}", e))?;
    Ok(dir)
}

fn make_preview(image_data: &[u8], max_dim: u32, out_path: &Path) -> Result<(), String> {
    let img = image::load_from_memory(image_data)
        .map_err(|e| format!("解码图片失败: {}", e))?;
    save_preview_from_image(&img, max_dim, out_path)
}

fn save_preview_from_image(img: &image::DynamicImage, max_dim: u32, out_path: &Path) -> Result<(), String> {
    let thumb = img.resize(max_dim, max_dim, image::imageops::FilterType::Triangle);
    thumb.save(out_path)
        .map_err(|e| format!("保存预览失败: {}", e))?;
    Ok(())
}

fn flate_decompress(data: &[u8]) -> Result<Vec<u8>, String> {
    // Try zlib (with header) first
    let mut out = Vec::new();
    if ZlibDecoder::new(data).read_to_end(&mut out).is_ok() && !out.is_empty() {
        return Ok(out);
    }
    // Fall back to raw deflate (no header)
    out.clear();
    DeflateDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| format!("deflate解压失败: {}", e))?;
    Ok(out)
}

fn png_predictor_decode(data: &[u8], width: u32, channels: u32, bpc: u8) -> Result<Vec<u8>, String> {
    // PDF PNG predictor: each row has a 1-byte filter tag followed by width*channels*(bpc/8) bytes
    let bytes_per_sample = (bpc as u32 / 8).max(1);
    let stride = (width * channels * bytes_per_sample) as usize;
    let row_len = stride + 1; // 1 filter byte + pixel data
    if data.len() % row_len != 0 {
        return Err(format!("predictor数据行长不匹配: data={}, row_len={}", data.len(), row_len));
    }
    let num_rows = data.len() / row_len;
    let mut out = Vec::with_capacity(stride * num_rows);
    let mut prev_row = vec![0u8; stride];

    for row_idx in 0..num_rows {
        let row_start = row_idx * row_len;
        let filter = data[row_start];
        let row = &data[row_start + 1..row_start + 1 + stride];
        let mut cur_row = row.to_vec();

        match filter {
            0 => {} // None
            1 => { // Sub
                let bpp = (channels * bytes_per_sample) as usize;
                for i in bpp..cur_row.len() {
                    cur_row[i] = cur_row[i].wrapping_add(cur_row[i - bpp]);
                }
            }
            2 => { // Up
                for i in 0..cur_row.len() {
                    cur_row[i] = cur_row[i].wrapping_add(prev_row[i]);
                }
            }
            3 => { // Average
                let bpp = (channels * bytes_per_sample) as usize;
                for i in 0..cur_row.len() {
                    let a = if i >= bpp { cur_row[i - bpp] as u16 } else { 0 };
                    let b = prev_row[i] as u16;
                    cur_row[i] = cur_row[i].wrapping_add(((a + b) / 2) as u8);
                }
            }
            4 => { // Paeth
                let bpp = (channels * bytes_per_sample) as usize;
                for i in 0..cur_row.len() {
                    let a = if i >= bpp { cur_row[i - bpp] as i32 } else { 0 };
                    let b = prev_row[i] as i32;
                    let c = if i >= bpp { prev_row[i - bpp] as i32 } else { 0 };
                    let p = a + b - c;
                    let pa = (p - a).abs();
                    let pb = (p - b).abs();
                    let pc = (p - c).abs();
                    let pr = if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c };
                    cur_row[i] = cur_row[i].wrapping_add(pr as u8);
                }
            }
            _ => return Err(format!("未知predictor filter类型: {}", filter)),
        }
        out.extend_from_slice(&cur_row);
        prev_row = cur_row;
    }
    Ok(out)
}

fn get_decode_parms_predictor(stream: &Stream) -> Option<(i64, u32)> {
    // Returns (Predictor, Columns) from DecodeParms if present
    let parms = stream.dict.get(b"DecodeParms").ok()?;
    let dict = match parms {
        Object::Dictionary(d) => d,
        Object::Array(arr) => {
            if let Some(Object::Dictionary(d)) = arr.first() { d } else { return None; }
        }
        _ => return None,
    };
    let predictor = dict.get(b"Predictor").ok()
        .and_then(|v| if let Object::Integer(i) = v { Some(*i) } else { None })
        .unwrap_or(1);
    let columns = dict.get(b"Colors").ok()
        .and_then(|v| if let Object::Integer(i) = v { Some(*i as u32) } else { None });
    let _ = columns; // unused, we compute from width*channels
    Some((predictor, 0))
}

fn raw_pixels_to_png(decompressed: Vec<u8>, predictor: i64, width: u32, height: u32, color_space: &str, bpc: u8) -> Result<Vec<u8>, String> {
    // Determine channel count from color space
    let channels: u32 = match color_space {
        "DeviceRGB" => 3,
        "DeviceGray" => 1,
        "DeviceCMYK" => 4,
        _ => {
            // Guess from decompressed size (with or without predictor row bytes)
            let px = (width * height) as usize;
            if decompressed.len() == px * 4 || decompressed.len() == px * 5 { 4 }
            else if decompressed.len() == px * 3 || decompressed.len() == px * 4 { 3 }
            else if decompressed.len() == px || decompressed.len() == px + height as usize { 1 }
            else { return Err(format!("无法推断色彩空间, 解压后大小: {}", decompressed.len())); }
        }
    };

    let raw = if predictor >= 10 {
        png_predictor_decode(&decompressed, width, channels, bpc)?
    } else if predictor == 2 {
        // TIFF predictor (horizontal differencing)
        let bpp = (channels * (bpc as u32 / 8)) as usize;
        let stride = (width as usize) * bpp;
        let mut out = decompressed.clone();
        for row in out.chunks_mut(stride) {
            for i in bpp..row.len() {
                row[i] = row[i].wrapping_add(row[i - bpp]);
            }
        }
        out
    } else {
        decompressed
    };

    let expected_len = (width * height * channels * (bpc as u32 / 8).max(1)) as usize;
    if raw.len() < expected_len {
        return Err(format!(
            "数据长度不匹配: 期望 {}, 实际 {}",
            expected_len, raw.len()
        ));
    }

    let color_type = match channels {
        1 => image::ColorType::L8,
        3 => image::ColorType::Rgb8,
        4 => image::ColorType::Rgba8,
        _ => return Err(format!("不支持的颜色通道数: {}", channels)),
    };

    let mut buf = Cursor::new(Vec::new());
    image::write_buffer_with_format(
        &mut buf,
        &raw[..expected_len],
        width,
        height,
        color_type,
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("编码PNG失败: {}", e))?;
    Ok(buf.into_inner())
}

pub fn extract_images(
    input_path: &str,
    progress: impl Fn(u8, &str) + Sync,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<ExtractedImageInfo>, String> {
    progress(5, "正在加载 PDF 文件...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    let doc = Document::load(input_path).map_err(|e| format!("无法加载PDF文件: {}", e))?;
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    let temp_dir = create_session_temp_dir()?;
    progress(15, "正在解析页面结构...");

    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    let total_pages = pages.len();
    if total_pages == 0 {
        return Err("PDF 文件没有页面".to_string());
    }

    // Phase 1: walk the PDF structure and collect image stream metadata.
    // Keep this pass light: filter decompression can dominate extraction time
    // for raw/Flate images, so it is deferred to the parallel decode phase.
    let mut jobs: Vec<ImageJob> = Vec::new();
    let mut seen_ids: HashSet<ObjectId> = HashSet::new();

    for (page_idx, (page_num, page_id)) in pages.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".to_string());
        }
        let pct = 15 + ((page_idx * 30) / total_pages.max(1));
        progress(pct as u8, &format!("正在扫描第 {} 页图片...", page_num));

        let xobject_dict = get_xobject_dict(&doc, *page_id);
        if xobject_dict.is_none() {
            continue;
        }
        let xobj_dict = xobject_dict.unwrap();

        for (name, value) in xobj_dict.iter() {
            if let Object::Reference(id) = value {
                if seen_ids.contains(id) {
                    continue;
                }
                seen_ids.insert(*id);

                let stream = match doc.get_object(*id) {
                    Ok(Object::Stream(s)) => s,
                    _ => continue,
                };
                if !is_image_stream(stream) {
                    continue;
                }

                let (width, height) = match get_image_dimensions(stream) {
                    Some(d) => d,
                    None => continue,
                };

                let color_space = get_color_space(stream);
                let bpc = get_bits_per_component(stream);
                let name_str = String::from_utf8_lossy(name).to_string();
                let predictor = get_decode_parms_predictor(stream).map(|(p, _)| p).unwrap_or(1);

                jobs.push(ImageJob {
                    id: *id,
                    page_num: *page_num,
                    name: name_str,
                    width,
                    height,
                    color_space,
                    bpc,
                    predictor,
                    content: stream.content.clone(),
                    filters: get_filter_names(stream),
                    decode_parms: get_decode_parms_list(stream),
                });
            }
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    // Phase 2: resolve filters, decode pixels, and encode previews/PNGs in
    // parallel. This is the CPU-heavy part, so run it across all cores.
    progress(50, &format!("正在解码 {} 张图片...", jobs.len()));
    let total_jobs = jobs.len().max(1);
    let done = AtomicUsize::new(0);

    let mut images: Vec<ExtractedImageInfo> = jobs
        .into_par_iter()
        .filter_map(|job| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let result = decode_image_job(job, &temp_dir);
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            let pct = 50 + ((n * 50) / total_jobs);
            progress(pct.min(99) as u8, &format!("正在解码图片 ({}/{})...", n, total_jobs));
            result
        })
        .collect();

    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    images.sort_by(|a, b| a.page.cmp(&b.page).then_with(|| a.id.cmp(&b.id)));
    progress(100, &format!("完成，共提取 {} 张图片", images.len()));
    Ok(images)
}

struct ImageJob {
    id: ObjectId,
    page_num: u32,
    name: String,
    width: u32,
    height: u32,
    color_space: String,
    bpc: u8,
    predictor: i64,
    content: Vec<u8>,
    filters: Vec<Vec<u8>>,
    decode_parms: Vec<Option<Dictionary>>,
}

fn decode_image_job(job: ImageJob, temp_dir: &Path) -> Option<ExtractedImageInfo> {
    let ImageJob {
        id,
        page_num,
        name: name_str,
        width,
        height,
        color_space,
        bpc,
        predictor,
        content,
        filters,
        decode_parms,
    } = job;

    let id_str = format!("{} {}", id.0, id.1);
    let temp_filename = format!("img_{}_{}", id.0, id.1);
    let preview_filename = format!("img_{}_{}_preview.png", id.0, id.1);
    let mut out_width = width;
    let mut out_height = height;

    let (buffer, format, format_parms) = match resolve_stream_data_parts(content, filters, decode_parms) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[extract_images] skip {} on page {}: {}", name_str, page_num, e);
            return None;
        }
    };
    let mut out_format = format.clone();

    let (temp_path, preview_path, file_size, supported) = match format.as_str() {
        "jpeg" => {
            // buffer is raw JPEG bytes after any leading generic filters
            let file_size = buffer.len();
            let tp = temp_dir.join(format!("{}.jpg", temp_filename));
            let pp = temp_dir.join(&preview_filename);
            std::fs::write(&tp, &buffer).ok()?;
            if make_preview(&buffer, 400, &pp).is_err() {
                let _ = std::fs::copy(&tp, &pp);
            }
            (tp.to_string_lossy().to_string(), pp.to_string_lossy().to_string(), file_size, true)
        }
        "raw" => {
            // Fully generic-decompressed pixel data; encode as PNG
            match raw_pixels_to_png(buffer, predictor, width, height, &color_space, bpc) {
                Ok(png_data) => {
                    let file_size = png_data.len();
                    let tp = temp_dir.join(format!("{}.png", temp_filename));
                    let pp = temp_dir.join(&preview_filename);
                    std::fs::write(&tp, &png_data).ok()?;
                    if make_preview(&png_data, 400, &pp).is_err() {
                        let _ = std::fs::copy(&tp, &pp);
                    }
                    (tp.to_string_lossy().to_string(), pp.to_string_lossy().to_string(), file_size, true)
                }
                Err(e) => {
                    eprintln!("[extract_images] skip {} on page {} (raw decode failed): {}", name_str, page_num, e);
                    return None;
                }
            }
        }
        "jpeg2000" => {
            // Decode via hayro-jpeg2000, registered as an `image` crate hook
            ensure_jpx_hook_registered();
            match image::load_from_memory(&buffer) {
                Ok(img) => {
                    out_width = img.width();
                    out_height = img.height();
                    out_format = "png".to_string();
                    let mut png_buf = Cursor::new(Vec::new());
                    if let Err(e) = img.write_to(&mut png_buf, image::ImageFormat::Png) {
                        eprintln!("[extract_images] skip {} on page {} (jpx png encode failed): {}", name_str, page_num, e);
                        return None;
                    }
                    let png_data = png_buf.into_inner();
                    let file_size = png_data.len();
                    let tp = temp_dir.join(format!("{}.png", temp_filename));
                    let pp = temp_dir.join(&preview_filename);
                    std::fs::write(&tp, &png_data).ok()?;
                    if save_preview_from_image(&img, 400, &pp).is_err() {
                        let _ = std::fs::copy(&tp, &pp);
                    }
                    (tp.to_string_lossy().to_string(), pp.to_string_lossy().to_string(), file_size, true)
                }
                Err(e) => {
                    eprintln!("[extract_images] jpx decode failed for {} on page {}: {}", name_str, page_num, e);
                    // Fall back to placeholder so the image is still listed
                    let file_size = buffer.len();
                    let tp = temp_dir.join(format!("{}.jp2", temp_filename));
                    let pp = temp_dir.join(&preview_filename);
                    std::fs::write(&tp, &buffer).ok()?;
                    if make_placeholder_preview(width, height, &pp).is_err() {
                        return None;
                    }
                    (tp.to_string_lossy().to_string(), pp.to_string_lossy().to_string(), file_size, false)
                }
            }
        }
        "ccitt" => {
            match ccitt_decode_to_png(&buffer, width, height, format_parms.as_ref()) {
                Ok((png_data, w, h)) => {
                    out_width = w;
                    out_height = h;
                    out_format = "png".to_string();
                    let file_size = png_data.len();
                    let tp = temp_dir.join(format!("{}.png", temp_filename));
                    let pp = temp_dir.join(&preview_filename);
                    std::fs::write(&tp, &png_data).ok()?;
                    if make_preview(&png_data, 400, &pp).is_err() {
                        let _ = std::fs::copy(&tp, &pp);
                    }
                    (tp.to_string_lossy().to_string(), pp.to_string_lossy().to_string(), file_size, true)
                }
                Err(e) => {
                    eprintln!("[extract_images] ccitt decode failed for {} on page {}: {}", name_str, page_num, e);
                    let file_size = buffer.len();
                    let tp = temp_dir.join(format!("{}.bin", temp_filename));
                    let pp = temp_dir.join(&preview_filename);
                    std::fs::write(&tp, &buffer).ok()?;
                    if make_placeholder_preview(width, height, &pp).is_err() {
                        return None;
                    }
                    (tp.to_string_lossy().to_string(), pp.to_string_lossy().to_string(), file_size, false)
                }
            }
        }
        "jbig2" => {
            // No pure-Rust JBIG2 decoder available; store original bytes
            // and show a placeholder preview.
            let file_size = buffer.len();
            let tp = temp_dir.join(format!("{}.bin", temp_filename));
            let pp = temp_dir.join(&preview_filename);
            std::fs::write(&tp, &buffer).ok()?;
            if make_placeholder_preview(width, height, &pp).is_err() {
                return None;
            }
            (tp.to_string_lossy().to_string(), pp.to_string_lossy().to_string(), file_size, false)
        }
        _ => return None,
    };

    Some(ExtractedImageInfo {
        id: id_str.clone(),
        page: page_num,
        name: name_str,
        object_id: id_str,
        width: out_width,
        height: out_height,
        file_size,
        format: out_format,
        color_space,
        bits_per_component: bpc,
        temp_path,
        preview_path,
        supported,
    })
}

pub fn write_compressed_images(
    input_path: &str,
    output_path: &str,
    compressed_images: Vec<CompressedImageEntry>,
    progress: impl Fn(u8, &str),
    cancel: Arc<AtomicBool>,
) -> Result<CompressImagesResult, String> {
    let original_size = Path::new(input_path)
        .metadata()
        .map_err(|e| format!("无法读取文件信息: {}", e))?
        .len() as usize;

    progress(5, "正在加载 PDF 文件...");
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    let mut doc = Document::load(input_path).map_err(|e| format!("无法加载PDF文件: {}", e))?;
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }

    progress(15, "正在回写压缩图片...");
    let total = compressed_images.len();
    if total == 0 {
        return Err("没有需要压缩的图片".to_string());
    }

    let mut actions: Vec<String> = Vec::new();
    let mut images_compressed = 0usize;

    for (idx, entry) in compressed_images.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".to_string());
        }
        let pct = 15 + ((idx * 70) / total.max(1));
        progress(pct as u8, &format!("正在回写第 {}/{} 张图片...", idx + 1, total));

        // Parse object id "gen num" → (num, gen)
        let parts: Vec<&str> = entry.object_id.split_whitespace().collect();
        if parts.len() != 2 {
            continue;
        }
        let obj_num: u32 = match parts[0].parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let gen_num: u16 = match parts[1].parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let obj_id = (obj_num, gen_num);

        // Read compressed image data
        let compressed_data = match std::fs::read(&entry.temp_path) {
            Ok(d) => d,
            Err(e) => {
                actions.push(format!("跳过 {}: 读取压缩文件失败 ({})", entry.object_id, e));
                continue;
            }
        };

        // Get the stream object
        let stream_obj = match doc.get_object_mut(obj_id) {
            Ok(Object::Stream(s)) => s,
            _ => {
                actions.push(format!("跳过 {}: 找不到对象", entry.object_id));
                continue;
            }
        };

        let original_size_stream = stream_obj.content.len();

        match entry.format.as_str() {
            "jpeg" => {
                // Set DCTDecode filter, write raw JPEG data
                stream_obj.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
                stream_obj.dict.set("Width", Object::Integer(entry.width as i64));
                stream_obj.dict.set("Height", Object::Integer(entry.height as i64));
                stream_obj.dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
                stream_obj.dict.set("BitsPerComponent", Object::Integer(8));
                // Remove any existing DecodeParms that might conflict
                let _ = stream_obj.dict.remove(b"DecodeParms");
                stream_obj.content = compressed_data;
            }
            "png" => {
                // Decode PNG, re-encode as FlateDecode raw pixels
                let img = match image::load_from_memory(&compressed_data) {
                    Ok(i) => i,
                    Err(e) => {
                        actions.push(format!("跳过 {}: 解码PNG失败 ({})", entry.object_id, e));
                        continue;
                    }
                };

                let rgb = img.to_rgb8();
                let raw_pixels = rgb.as_raw();

                stream_obj.dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
                stream_obj.dict.set("Width", Object::Integer(entry.width as i64));
                stream_obj.dict.set("Height", Object::Integer(entry.height as i64));
                stream_obj.dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
                stream_obj.dict.set("BitsPerComponent", Object::Integer(8));
                let _ = stream_obj.dict.remove(b"DecodeParms");
                stream_obj.set_plain_content(raw_pixels.clone());
                let _ = stream_obj.compress();
            }
            "webp" => {
                // WebP not natively supported in PDF — decode and re-encode as JPEG
                let img = match image::load_from_memory(&compressed_data) {
                    Ok(i) => i,
                    Err(e) => {
                        actions.push(format!("跳过 {}: 解码WebP失败 ({})", entry.object_id, e));
                        continue;
                    }
                };

                let mut jpeg_buf = Cursor::new(Vec::new());
                let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
                match rgb.write_to(&mut jpeg_buf, image::ImageFormat::Jpeg) {
                    Ok(_) => {}
                    Err(e) => {
                        actions.push(format!("跳过 {}: 编码JPEG失败 ({})", entry.object_id, e));
                        continue;
                    }
                }
                let jpeg_data = jpeg_buf.into_inner();

                stream_obj.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
                stream_obj.dict.set("Width", Object::Integer(entry.width as i64));
                stream_obj.dict.set("Height", Object::Integer(entry.height as i64));
                stream_obj.dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
                stream_obj.dict.set("BitsPerComponent", Object::Integer(8));
                let _ = stream_obj.dict.remove(b"DecodeParms");
                stream_obj.content = jpeg_data;
            }
            _ => {
                actions.push(format!("跳过 {}: 不支持的格式 {}", entry.object_id, entry.format));
                continue;
            }
        }

        let new_size = stream_obj.content.len();
        images_compressed += 1;
        actions.push(format!(
            "对象 {}: {} → {} ({}KB → {}KB)",
            entry.object_id,
            entry.format,
            entry.format,
            original_size_stream / 1024,
            new_size / 1024
        ));
    }

    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }
    progress(92, "正在保存 PDF 文件...");

    let tmp_path = format!("{}.tmp", output_path);
    doc.save(&tmp_path).map_err(|e| format!("保存PDF失败: {}", e))?;

    std::fs::rename(&tmp_path, output_path)
        .map_err(|e| format!("重命名文件失败: {}", e))?;

    let output_size = Path::new(output_path)
        .metadata()
        .map(|m| m.len() as usize)
        .unwrap_or(0);

    progress(100, "完成");

    Ok(CompressImagesResult {
        output_path: output_path.to_string(),
        original_size,
        output_size,
        images_compressed,
        actions,
    })
}
