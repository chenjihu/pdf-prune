mod analysis;
mod compress_images;
mod prune;
mod remove_images;

use analysis::PdfAnalysis;
use compress_images::{CompressedImageEntry, CompressImagesResult, ExtractedImageInfo};
use prune::{PruneOptions, PruneResult};
use remove_images::{RemoveImagesResult, ImageInfo, ImageSize};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[tauri::command]
async fn analyze_pdf(app: AppHandle, file_path: String) -> Result<PdfAnalysis, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel.clone();

    // Spawn a watcher task that checks for cancel events (cancel is handled by a separate command)
    let progress_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        analysis::analyze_pdf(
            &file_path,
            move |pct, msg| {
                let _ = progress_app.emit("analyze-progress", (pct, msg));
            },
            cancel_clone,
        )
    })
    .await
    .map_err(|e| format!("分析任务执行失败: {}", e))?;

    let _ = app.emit("analyze-progress", (100u8, "完成"));
    result
}

#[tauri::command]
async fn prune_pdf(
    app: AppHandle,
    input_path: String,
    output_path: String,
    options: PruneOptions,
) -> Result<PruneResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let progress_app = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        prune::prune_pdf(
            &input_path,
            &output_path,
            &options,
            |pct, msg| {
                let _ = progress_app.emit("prune-progress", (pct, msg));
            },
            cancel,
        )
    })
    .await
    .map_err(|e| format!("修剪任务执行失败: {}", e))?;

    let _ = app.emit("prune-progress", (100u8, "完成"));
    result
}

#[tauri::command]
async fn remove_images(
    app: AppHandle,
    input_path: String,
    output_path: String,
    target_sizes: Vec<ImageSize>,
    y_min: f64,
    y_max: f64,
) -> Result<RemoveImagesResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let progress_app = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        remove_images::remove_images_by_criteria(
            &input_path,
            &output_path,
            target_sizes,
            y_min,
            y_max,
            |pct, msg| {
                let _ = progress_app.emit("remove-images-progress", (pct, msg));
            },
            cancel,
        )
    })
    .await
    .map_err(|e| format!("移除图片任务执行失败: {}", e))?;

    let _ = app.emit("remove-images-progress", (100u8, "完成"));
    result
}

#[tauri::command]
async fn list_images(
    app: AppHandle,
    input_path: String,
) -> Result<Vec<ImageInfo>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let progress_app = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        remove_images::list_images(
            &input_path,
            |pct, msg| {
                let _ = progress_app.emit("list-images-progress", (pct, msg));
            },
            cancel,
        )
    })
    .await
    .map_err(|e| format!("扫描图片任务执行失败: {}", e))?;

    let _ = app.emit("list-images-progress", (100u8, "完成"));
    result
}

#[tauri::command]
async fn extract_images(
    app: AppHandle,
    input_path: String,
) -> Result<Vec<ExtractedImageInfo>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let progress_app = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        compress_images::extract_images(
            &input_path,
            |pct, msg| {
                let _ = progress_app.emit("extract-images-progress", (pct, msg));
            },
            cancel,
        )
    })
    .await
    .map_err(|e| format!("提取图片任务执行失败: {}", e))?;

    let _ = app.emit("extract-images-progress", (100u8, "完成"));
    result
}

#[tauri::command]
async fn write_compressed_images(
    app: AppHandle,
    input_path: String,
    output_path: String,
    compressed_images: Vec<CompressedImageEntry>,
) -> Result<CompressImagesResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let progress_app = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        compress_images::write_compressed_images(
            &input_path,
            &output_path,
            compressed_images,
            |pct, msg| {
                let _ = progress_app.emit("compress-images-progress", (pct, msg));
            },
            cancel,
        )
    })
    .await
    .map_err(|e| format!("压缩图片任务执行失败: {}", e))?;

    let _ = app.emit("compress-images-progress", (100u8, "完成"));
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            analyze_pdf,
            prune_pdf,
            remove_images,
            list_images,
            extract_images,
            write_compressed_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
