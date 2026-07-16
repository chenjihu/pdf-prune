mod analysis;
mod compress_images;
mod dependencies;
mod prune;
mod remove_images;

use analysis::PdfAnalysis;
use compress_images::{CompressImagesResult, CompressedImageEntry, ExtractedImageInfo};
use dependencies::RuntimeDependencyCheck;
use prune::{PruneOptions, PruneResult};
use remove_images::{ImageInfo, ImageSize, RemoveImagesResult};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
struct ExtractImagesDetailProgress {
    pct: u8,
    msg: String,
    completed: usize,
    total: usize,
    active: usize,
    worker_threads: usize,
}

#[tauri::command]
async fn check_runtime_dependencies() -> Result<RuntimeDependencyCheck, String> {
    Ok(dependencies::check_runtime_dependencies())
}

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
async fn list_images(app: AppHandle, input_path: String) -> Result<Vec<ImageInfo>, String> {
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
    worker_threads: Option<usize>,
    cache_dir: Option<String>,
) -> Result<Vec<ExtractedImageInfo>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let progress_app = app.clone();
    let detail_progress_app = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        compress_images::extract_images(
            &input_path,
            worker_threads.unwrap_or(0),
            cache_dir.as_deref(),
            |pct, msg| {
                let _ = progress_app.emit("extract-images-progress", (pct, msg));
            },
            |pct, msg, completed, total, active, worker_threads| {
                let _ = detail_progress_app.emit(
                    "extract-images-detail-progress",
                    ExtractImagesDetailProgress {
                        pct,
                        msg: msg.to_string(),
                        completed,
                        total,
                        active,
                        worker_threads,
                    },
                );
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
async fn get_default_cache_dir() -> Result<String, String> {
    Ok(compress_images::default_cache_root())
}

#[tauri::command]
async fn get_file_size(file_path: String) -> Result<usize, String> {
    std::fs::metadata(&file_path)
        .map(|m| m.len() as usize)
        .map_err(|e| format!("无法读取文件大小: {}", e))
}

#[tauri::command]
async fn write_cache_file(
    cache_dir: Option<String>,
    filename: String,
    data: Vec<u8>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        compress_images::write_cache_file(cache_dir.as_deref(), &filename, data)
    })
    .await
    .map_err(|e| format!("写入缓存任务执行失败: {}", e))?
}

#[tauri::command]
async fn clear_cache_dir(cache_dir: Option<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        compress_images::clear_cache_dir(cache_dir.as_deref())
    })
    .await
    .map_err(|e| format!("清空缓存任务执行失败: {}", e))?
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

/// On macOS, GUI apps launched from Finder/Spotlight inherit a minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin) that excludes Homebrew directories.
/// Prepend common Homebrew paths so that qpdf, pdfimages, pdfinfo etc. are found.
fn setup_path() {
    let extra_dirs: &[&str] = if cfg!(target_os = "macos") {
        &["/opt/homebrew/bin", "/usr/local/bin"]
    } else {
        &[]
    };

    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(&current).collect();

    for d in extra_dirs {
        let pb = std::path::PathBuf::from(d);
        if !dirs.contains(&pb) {
            dirs.insert(0, pb);
        }
    }

    let new_path = std::env::join_paths(dirs).unwrap_or(current);
    std::env::set_var("PATH", new_path);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup_path();
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
            get_default_cache_dir,
            get_file_size,
            write_cache_file,
            clear_cache_dir,
            check_runtime_dependencies,
            write_compressed_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
