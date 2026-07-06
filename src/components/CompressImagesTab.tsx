import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Download,
  RotateCcw,
  Images,
  Sliders,
  ZoomIn,
  CheckSquare,
  Square,
  CircleHelp,
} from "lucide-react";
import type {
  ExtractedImageInfo,
  CompressedImageEntry,
  CompressImagesResult,
  CompressedImagePreview,
} from "../types";
import { formatSize, formatDuration } from "../utils";
import { compressImage, formatKB, compressionRatio, type CompressFormat } from "../lib/imageCompress";
import { ImageDetailModal } from "./ImageDetailModal";

interface CompressImagesTabProps {
  extracting: boolean;
  extractError: string | null;
  extractedImages: ExtractedImageInfo[] | null;
  inputPath: string | null;
  extractProgress: {
    pct: number;
    msg: string;
    completed: number;
    total: number;
    active: number;
    workerThreads: number;
  } | null;
  onExtract: (workerThreads: number) => void;
  onReset: () => void;
  elapsedTime: number;
  startTime: number | null;
  endTime: number | null;
}

interface FilterState {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  minSizeKB: number;
  maxSizeKB: number;
  minCompressedWidth: number;
  maxCompressedWidth: number;
  minCompressedHeight: number;
  maxCompressedHeight: number;
  minCompressedSizeKB: number;
  maxCompressedSizeKB: number;
  pageFilter: number | null;
  compressionState: "all" | "compressed" | "uncompressed";
  formatFilter: Set<string>;
}

const DEFAULT_FILTERS: FilterState = {
  minWidth: 0,
  maxWidth: 0,
  minHeight: 0,
  maxHeight: 0,
  minSizeKB: 0,
  maxSizeKB: 0,
  minCompressedWidth: 0,
  maxCompressedWidth: 0,
  minCompressedHeight: 0,
  maxCompressedHeight: 0,
  minCompressedSizeKB: 0,
  maxCompressedSizeKB: 0,
  pageFilter: null,
  compressionState: "all",
  formatFilter: new Set(),
};

const IMAGE_LIST_PAGE_SIZE = 120;
const RAW_FORMAT_HELP =
  "raw 表示这张图是 PDF 内部的原始图像数据或特殊编码流，不是可直接保存的 JPEG/PNG/WebP。它通常需要结合宽高、颜色空间、位深和 DecodeParms 才能还原，部分 raw 图片可能无法压缩。";
const PDF_SIZE_HELP =
  "PDF 大小表示这张图片在 PDF 内部原始图片流中占用的空间。它可能远小于提取出来的 PNG/JPEG 临时文件；导出时会按这个内部流大小判断是否值得替换。";

function pdfImageSize(image: ExtractedImageInfo): number {
  return image.pdf_size ?? image.file_size;
}

function getDefaultExtractThreads(): number {
  const hardwareThreads = navigator.hardwareConcurrency || 4;
  return Math.min(8, Math.max(1, hardwareThreads));
}

function ExtractionDotMatrix({ completed, total, active }: { completed: number; total: number; active: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pulse, setPulse] = useState(0);
  const dotSize = total > 1200 ? 3 : total > 500 ? 4 : 6;
  const gap = total > 1200 ? 2 : 3;
  const columns = Math.max(1, Math.floor(620 / (dotSize + gap)));
  const rows = Math.ceil(total / columns);
  const cssWidth = columns * (dotSize + gap) - gap;
  const cssHeight = rows * (dotSize + gap) - gap;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPulse((value) => (value + 1) % 24);
    }, 90);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.ceil(cssWidth * dpr));
    canvas.height = Math.max(1, Math.ceil(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    for (let i = 0; i < total; i++) {
      const x = (i % columns) * (dotSize + gap);
      const y = Math.floor(i / columns) * (dotSize + gap);
      const isDone = i < completed;
      const isActive = i >= completed && i < completed + active;
      if (isDone) {
        ctx.fillStyle = "#60a5fa";
      } else if (isActive) {
        const alpha = 0.45 + 0.35 * Math.sin((pulse + i) / 4);
        ctx.fillStyle = `rgba(34, 211, 238, ${alpha.toFixed(2)})`;
      } else {
        ctx.fillStyle = "#262626";
      }
      ctx.fillRect(x, y, dotSize, dotSize);
    }
  }, [active, completed, total, dotSize, gap, columns, cssWidth, cssHeight, pulse]);

  return <canvas ref={canvasRef} className="block max-w-full" aria-hidden="true" />;
}

function ImageFormatBadge({ format }: { format: string }) {
  if (format !== "raw") {
    return <span className="text-neutral-600 font-mono">{format}</span>;
  }

  return (
    <span className="relative group inline-flex items-center gap-1 text-neutral-600 font-mono">
      raw
      <CircleHelp
        className="w-3.5 h-3.5 text-neutral-500"
        aria-label={RAW_FORMAT_HELP}
        tabIndex={0}
      />
      <span className="pointer-events-none absolute right-0 top-full z-20 mt-2 hidden w-64 rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-left text-xs leading-relaxed text-neutral-300 shadow-xl group-hover:block group-focus-within:block">
        {RAW_FORMAT_HELP}
      </span>
    </span>
  );
}

function PdfSizeHelp() {
  return (
    <span className="relative group inline-flex items-center">
      <button
        type="button"
        className="text-[10px] text-neutral-500 underline decoration-dotted underline-offset-2 hover:text-neutral-300 focus:outline-none focus:text-neutral-300"
        aria-label={PDF_SIZE_HELP}
      >
        解释
      </button>
      <span className="pointer-events-none absolute left-0 bottom-full z-20 mb-2 hidden w-64 rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-left text-xs leading-relaxed text-neutral-300 shadow-xl group-hover:block group-focus-within:block">
        {PDF_SIZE_HELP}
      </span>
    </span>
  );
}

export function CompressImagesTab({
  extracting,
  extractError,
  extractedImages,
  inputPath,
  extractProgress,
  onExtract,
  onReset,
  elapsedTime,
  startTime,
  endTime,
}: CompressImagesTabProps) {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [compressFormat, setCompressFormat] = useState<CompressFormat>("jpeg");
  const [quality, setQuality] = useState(75);
  const [scale, setScale] = useState(100);
  const [maxWidth, setMaxWidth] = useState(0);
  const [compressing, setCompressing] = useState(false);
  const [compressProgress, setCompressProgress] = useState<{ current: number; total: number } | null>(null);
  const [compressedPreviews, setCompressedPreviews] = useState<Map<string, CompressedImagePreview>>(new Map());
  const [detailImageId, setDetailImageId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [exportResult, setExportResult] = useState<CompressImagesResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [compressError, setCompressError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(IMAGE_LIST_PAGE_SIZE);
  const [extractThreadCount, setExtractThreadCount] = useState(getDefaultExtractThreads);
  const maxExtractThreads = Math.min(32, Math.max(2, navigator.hardwareConcurrency || 8));

  // Listen for export progress
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<[number, string]>("compress-images-progress", (event) => {
      const [pct, msg] = event.payload;
      setExportProgress({ pct, msg });
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Filtered images
  const filteredImages = useMemo(() => {
    if (!extractedImages) return [];
    return extractedImages.filter((img) => {
      const preview = compressedPreviews.get(img.id);
      if (filters.minWidth > 0 && img.width < filters.minWidth) return false;
      if (filters.maxWidth > 0 && img.width > filters.maxWidth) return false;
      if (filters.minHeight > 0 && img.height < filters.minHeight) return false;
      if (filters.maxHeight > 0 && img.height > filters.maxHeight) return false;
      const sourceSize = pdfImageSize(img);
      if (filters.minSizeKB > 0 && sourceSize / 1024 < filters.minSizeKB) return false;
      if (filters.maxSizeKB > 0 && sourceSize / 1024 > filters.maxSizeKB) return false;
      if (filters.compressionState === "compressed" && !preview) return false;
      if (filters.compressionState === "uncompressed" && preview) return false;
      if (
        filters.minCompressedWidth > 0 ||
        filters.maxCompressedWidth > 0 ||
        filters.minCompressedHeight > 0 ||
        filters.maxCompressedHeight > 0 ||
        filters.minCompressedSizeKB > 0 ||
        filters.maxCompressedSizeKB > 0
      ) {
        if (!preview) return false;
        if (filters.minCompressedWidth > 0 && preview.width < filters.minCompressedWidth) return false;
        if (filters.maxCompressedWidth > 0 && preview.width > filters.maxCompressedWidth) return false;
        if (filters.minCompressedHeight > 0 && preview.height < filters.minCompressedHeight) return false;
        if (filters.maxCompressedHeight > 0 && preview.height > filters.maxCompressedHeight) return false;
        if (filters.minCompressedSizeKB > 0 && preview.compressed_size / 1024 < filters.minCompressedSizeKB) return false;
        if (filters.maxCompressedSizeKB > 0 && preview.compressed_size / 1024 > filters.maxCompressedSizeKB) return false;
      }
      if (filters.pageFilter !== null && img.page !== filters.pageFilter) return false;
      if (filters.formatFilter.size > 0 && !filters.formatFilter.has(img.format)) return false;
      return true;
    });
  }, [extractedImages, filters, compressedPreviews]);

  useEffect(() => {
    setVisibleCount(IMAGE_LIST_PAGE_SIZE);
  }, [extractedImages, filters]);

  const visibleImages = useMemo(
    () => filteredImages.slice(0, visibleCount),
    [filteredImages, visibleCount],
  );

  // Pages list for filter dropdown
  const pages = useMemo(() => {
    if (!extractedImages) return [];
    return [...new Set(extractedImages.map((img) => img.page))].sort((a, b) => a - b);
  }, [extractedImages]);

  // Formats list for filter
  const formats = useMemo(() => {
    if (!extractedImages) return [];
    return [...new Set(extractedImages.map((img) => img.format))];
  }, [extractedImages]);

  const toggleSelect = useCallback((id: string) => {
    const img = extractedImages?.find((i) => i.id === id);
    if (img && !img.supported) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [extractedImages]);

  const selectAllFiltered = useCallback(() => {
    setSelectedIds(new Set(filteredImages.filter((img) => img.supported).map((img) => img.id)));
  }, [filteredImages]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleCompress = useCallback(async () => {
    if (!extractedImages || selectedIds.size === 0) return;

    setCompressing(true);
    setCompressError(null);
    setCompressedPreviews(new Map());
    setCompressProgress({ current: 0, total: selectedIds.size });

    const targets = extractedImages.filter((img) => selectedIds.has(img.id));
    const previews = new Map<string, CompressedImagePreview>();

    for (let i = 0; i < targets.length; i++) {
      const img = targets[i];
      setCompressProgress({ current: i + 1, total: targets.length });

      try {
        // Fetch original image data
        const response = await fetch(convertFileSrc(img.temp_path));
        const arrayBuffer = await response.arrayBuffer();

        // Compress
        const result = await compressImage(arrayBuffer, img.format, {
          format: compressFormat,
          quality,
          scale: scale / 100,
          maxWidth: maxWidth > 0 ? maxWidth : undefined,
        });

        // Write compressed data to temp file
        const compressedPath = img.temp_path.replace(/\.(jpg|png|jp2)$/, `_compressed.${compressFormat}`);
        await writeFile(compressedPath, new Uint8Array(result.data));

        // Generate preview URL from compressed data
        const blob = new Blob([result.data], { type: `image/${compressFormat}` });
        const previewUrl = URL.createObjectURL(blob);

        previews.set(img.id, {
          object_id: img.object_id,
          original_size: pdfImageSize(img),
          compressed_size: result.compressedSize,
          compressed_preview_path: previewUrl,
          format: compressFormat,
          width: result.width,
          height: result.height,
        });
      } catch (e) {
        setCompressError(`图片 ${img.name} 压缩失败: ${String(e)}`);
      }
    }

    setCompressedPreviews(previews);
    setCompressing(false);
    setCompressProgress(null);
  }, [extractedImages, selectedIds, compressFormat, quality, scale, maxWidth]);

  const handleExport = useCallback(async () => {
    if (!inputPath || compressedPreviews.size === 0) return;

    try {
      const outputPath = await save({
        defaultPath: inputPath.replace(/\.pdf$/i, "_compressed.pdf"),
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      if (!outputPath) return;

      setExporting(true);
      setExportError(null);
      setExportResult(null);
      setExportProgress({ pct: 0, msg: "准备中..." });

      const entries: CompressedImageEntry[] = [];
      for (const [id, preview] of compressedPreviews) {
        const img = extractedImages?.find((i) => i.id === id);
        if (!img) continue;
        const compressedPath = img.temp_path.replace(/\.(jpg|png|jp2)$/, `_compressed.${preview.format}`);
        entries.push({
          object_id: img.object_id,
          temp_path: compressedPath,
          format: preview.format,
          width: preview.width,
          height: preview.height,
        });
      }

      const result = await invoke<CompressImagesResult>("write_compressed_images", {
        inputPath,
        outputPath,
        compressedImages: entries,
      });
      setExportResult(result);
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  }, [inputPath, compressedPreviews, extractedImages]);

  const resetAll = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setSelectedIds(new Set());
    setCompressedPreviews(new Map());
    setExportResult(null);
    setExportError(null);
    setCompressError(null);
    onReset();
  }, [onReset]);

  // Total size stats
  const totalOriginalSize = useMemo(() => {
    if (!extractedImages) return 0;
    let sum = 0;
    for (const id of compressedPreviews.keys()) {
      const img = extractedImages.find((item) => item.id === id);
      if (img) sum += pdfImageSize(img);
    }
    return sum;
  }, [extractedImages, compressedPreviews]);

  const totalCompressedSize = useMemo(() => {
    let sum = 0;
    for (const preview of compressedPreviews.values()) {
      sum += preview.compressed_size;
    }
    return sum;
  }, [compressedPreviews]);

  const handleDetailCompressed = useCallback((id: string, preview: CompressedImagePreview) => {
    setCompressedPreviews((prev) => {
      const next = new Map(prev);
      next.set(id, preview);
      return next;
    });
  }, []);

  // ===== Render =====

  if (exporting) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="w-full max-w-md space-y-6">
          <div className="flex flex-col items-center">
            <Loader2 className="w-10 h-10 text-blue-500 animate-spin mb-4" />
            <p className="text-neutral-300 text-sm font-medium">
              {exportProgress?.msg || "正在处理..."}
            </p>
            <p className="text-neutral-500 text-xs mt-1">
              正在将压缩图片回写 PDF
            </p>
          </div>
          <div className="w-full">
            <div className="flex items-center justify-between text-xs text-neutral-400 mb-2">
              <span>进度</span>
              <span className="font-mono">{exportProgress?.pct || 0}%</span>
            </div>
            <div className="h-2 rounded-full bg-neutral-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-500 transition-all duration-300 ease-out"
                style={{ width: `${exportProgress?.pct || 0}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (exportResult) {
    return (
      <div className="rounded-2xl bg-gradient-to-br from-green-950/30 to-neutral-900/50 border border-green-800/30 p-6">
        <div className="flex items-center gap-3 mb-5">
          <CheckCircle2 className="w-6 h-6 text-green-400" />
          <h3 className="font-bold text-base">压缩完成</h3>
        </div>
        <div className="grid grid-cols-3 gap-4 mb-5">
          <div className="text-center p-4 rounded-xl bg-neutral-800/30">
            <div className="text-xs text-neutral-500 mb-1">原始大小</div>
            <div className="text-lg font-bold font-mono">{formatSize(exportResult.original_size)}</div>
          </div>
          <div className="text-center p-4 rounded-xl bg-neutral-800/30">
            <div className="text-xs text-neutral-500 mb-1">输出大小</div>
            <div className="text-lg font-bold font-mono text-green-400">{formatSize(exportResult.output_size)}</div>
          </div>
          <div className="text-center p-4 rounded-xl bg-blue-950/30 border border-blue-800/30">
            <div className="text-xs text-neutral-500 mb-1">压缩图片数</div>
            <div className="text-lg font-bold font-mono text-blue-400">{exportResult.images_compressed}</div>
          </div>
        </div>
        {exportResult.actions.length > 0 && (
          <div className="mb-5">
            <h4 className="text-sm font-medium mb-3 text-neutral-300">操作详情：</h4>
            <div className="max-h-48 overflow-y-auto space-y-2">
              {exportResult.actions.map((action, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-neutral-300">
                  <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                  {action}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 p-3 rounded-xl bg-neutral-800/30 mb-5">
          <Download className="w-4 h-4 text-neutral-400 flex-shrink-0" />
          <span className="text-sm text-neutral-300 truncate flex-1">{exportResult.output_path}</span>
        </div>
        {endTime && startTime && (
          <div className="text-xs text-neutral-500 mb-4 text-right">
            总用时 {formatDuration(Math.floor((endTime - startTime) / 1000))}
          </div>
        )}
        <button
          onClick={resetAll}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 transition-colors font-medium"
        >
          <RotateCcw className="w-5 h-5" />
          处理另一个文件
        </button>
      </div>
    );
  }

  // Empty state
  if (!extractedImages && !extracting) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-blue-500/20 to-cyan-600/20 border border-neutral-800 flex items-center justify-center mb-6">
          <Images className="w-12 h-12 text-neutral-400" />
        </div>
        <h2 className="text-xl font-bold mb-2">压缩 PDF 中的图片</h2>
        <p className="text-neutral-400 text-sm mb-8 text-center max-w-lg">
          提取 PDF 中的所有图片，使用 WASM 编解码器压缩，支持前后对比预览
        </p>
        <div className="w-full max-w-sm mb-5 rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
          <div className="flex items-center justify-between gap-3 mb-2">
            <label className="text-xs text-neutral-400">并行提取线程</label>
            <input
              type="number"
              min={1}
              max={32}
              value={extractThreadCount}
              onChange={(e) => {
                const next = Math.min(32, Math.max(1, Number(e.target.value) || 1));
                setExtractThreadCount(next);
              }}
              className="w-16 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-xs text-right font-mono focus:border-blue-500 focus:outline-none"
            />
          </div>
          <input
            type="range"
            min={1}
            max={maxExtractThreads}
            value={Math.min(extractThreadCount, maxExtractThreads)}
            onChange={(e) => setExtractThreadCount(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="mt-1 flex items-center justify-between text-[10px] text-neutral-600">
            <span>稳</span>
            <span>{maxExtractThreads} 线程</span>
          </div>
        </div>
        <button
          onClick={() => onExtract(extractThreadCount)}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 transition-colors font-medium text-white shadow-lg shadow-blue-600/20"
        >
          <Images className="w-5 h-5" />
          选择 PDF 文件并提取图片
        </button>
      </div>
    );
  }

  // Extracting state
  if (extracting) {
    const totalDots = extractProgress?.total ?? 0;
    const completedDots = Math.min(extractProgress?.completed ?? 0, totalDots);
    const activeDots = Math.min(extractProgress?.active ?? 0, Math.max(0, totalDots - completedDots));
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center w-full max-w-2xl">
          <Loader2 className="w-10 h-10 text-blue-500 animate-spin mb-4" />
          <p className="text-neutral-300 text-sm font-medium">
            {extractProgress?.msg || "正在提取图片..."}
          </p>
          <p className="text-neutral-500 text-xs mt-1">已用时 {formatDuration(elapsedTime)}</p>
          {totalDots > 0 && (
            <div className="w-full mt-6 space-y-3">
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span>图片提取进度</span>
                <span className="font-mono">
                  {completedDots}/{totalDots} · {extractProgress?.workerThreads || extractThreadCount} 线程
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950/50 p-3">
                <ExtractionDotMatrix completed={completedDots} total={totalDots} active={activeDots} />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (extractError) {
    return (
      <div className="space-y-6">
        <div className="flex items-start gap-3 p-4 rounded-xl bg-red-950/40 border border-red-800/50 text-red-200">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-sm">提取失败</p>
            <p className="text-xs mt-1 text-red-300/80">{extractError}</p>
          </div>
        </div>
        <button
          onClick={resetAll}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 transition-colors font-medium"
        >
          <RotateCcw className="w-5 h-5" />
          重新选择
        </button>
      </div>
    );
  }

  // Main view: image list + filters + compression panel
  const detailImage = detailImageId ? extractedImages?.find((i) => i.id === detailImageId) : null;
  const detailPreview = detailImageId ? compressedPreviews.get(detailImageId) : null;

  return (
    <div className="space-y-4">
      {/* Export error */}
      {exportError && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-red-950/40 border border-red-800/50 text-red-200">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-sm">导出失败</p>
            <p className="text-xs mt-1 text-red-300/80">{exportError}</p>
          </div>
        </div>
      )}

      {/* Image detail modal */}
      {detailImage && (
        <ImageDetailModal
          image={detailImage}
          preview={detailPreview ?? null}
          onClose={() => setDetailImageId(null)}
          onCompressed={handleDetailCompressed}
          defaultFormat={compressFormat}
          defaultQuality={quality}
          defaultScale={scale}
          defaultMaxWidth={maxWidth}
        />
      )}

      {/* Header stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-neutral-800/30 p-3 text-center">
          <div className="text-xs text-neutral-500">图片总数</div>
          <div className="text-lg font-bold font-mono">{extractedImages?.length ?? 0}</div>
        </div>
        <div className="rounded-xl bg-neutral-800/30 p-3 text-center">
          <div className="text-xs text-neutral-500">筛选结果</div>
          <div className="text-lg font-bold font-mono text-blue-400">{filteredImages.length}</div>
        </div>
        <div className="rounded-xl bg-neutral-800/30 p-3 text-center">
          <div className="text-xs text-neutral-500">已选中</div>
          <div className="text-lg font-bold font-mono text-orange-400">{selectedIds.size}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl bg-neutral-800/30 border border-neutral-700/50 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-neutral-300">
          <Sliders className="w-4 h-4" />
          <span className="font-medium">筛选过滤</span>
        </div>
        <div className="text-xs font-medium text-neutral-400">原图</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Width range */}
          <div>
            <label className="text-xs text-neutral-500 mb-1 block">宽度范围 (px)</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                placeholder="最小"
                value={filters.minWidth || ""}
                onChange={(e) => setFilters({ ...filters, minWidth: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
              <span className="text-neutral-600">~</span>
              <input
                type="number"
                placeholder="最大"
                value={filters.maxWidth || ""}
                onChange={(e) => setFilters({ ...filters, maxWidth: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          {/* Height range */}
          <div>
            <label className="text-xs text-neutral-500 mb-1 block">高度范围 (px)</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                placeholder="最小"
                value={filters.minHeight || ""}
                onChange={(e) => setFilters({ ...filters, minHeight: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
              <span className="text-neutral-600">~</span>
              <input
                type="number"
                placeholder="最大"
                value={filters.maxHeight || ""}
                onChange={(e) => setFilters({ ...filters, maxHeight: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          {/* Size range */}
          <div>
            <label className="text-xs text-neutral-500 mb-1 block">体积范围 (KB)</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                placeholder="最小"
                value={filters.minSizeKB || ""}
                onChange={(e) => setFilters({ ...filters, minSizeKB: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
              <span className="text-neutral-600">~</span>
              <input
                type="number"
                placeholder="最大"
                value={filters.maxSizeKB || ""}
                onChange={(e) => setFilters({ ...filters, maxSizeKB: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          {/* Page filter */}
          <div>
            <label className="text-xs text-neutral-500 mb-1 block">页码</label>
            <input
              type="number"
              placeholder="全部"
              min={1}
              max={pages.length > 0 ? pages[pages.length - 1] : undefined}
              value={filters.pageFilter ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") { setFilters({ ...filters, pageFilter: null }); return; }
                const n = Number(v);
                if (Number.isNaN(n) || n < 1) { setFilters({ ...filters, pageFilter: null }); return; }
                const maxPage = pages.length > 0 ? pages[pages.length - 1] : n;
                setFilters({ ...filters, pageFilter: Math.min(n, maxPage) });
              }}
              className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
        <div className="text-xs font-medium text-neutral-400 pt-1">压缩后</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {/* Compressed width range */}
          <div>
            <label className="text-xs text-neutral-500 mb-1 block">宽度范围 (px)</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                placeholder="最小"
                value={filters.minCompressedWidth || ""}
                onChange={(e) => setFilters({ ...filters, minCompressedWidth: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
              <span className="text-neutral-600">~</span>
              <input
                type="number"
                placeholder="最大"
                value={filters.maxCompressedWidth || ""}
                onChange={(e) => setFilters({ ...filters, maxCompressedWidth: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          {/* Compressed height range */}
          <div>
            <label className="text-xs text-neutral-500 mb-1 block">高度范围 (px)</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                placeholder="最小"
                value={filters.minCompressedHeight || ""}
                onChange={(e) => setFilters({ ...filters, minCompressedHeight: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
              <span className="text-neutral-600">~</span>
              <input
                type="number"
                placeholder="最大"
                value={filters.maxCompressedHeight || ""}
                onChange={(e) => setFilters({ ...filters, maxCompressedHeight: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          {/* Compressed size range */}
          <div>
            <label className="text-xs text-neutral-500 mb-1 block">体积范围 (KB)</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                placeholder="最小"
                value={filters.minCompressedSizeKB || ""}
                onChange={(e) => setFilters({ ...filters, minCompressedSizeKB: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
              <span className="text-neutral-600">~</span>
              <input
                type="number"
                placeholder="最大"
                value={filters.maxCompressedSizeKB || ""}
                onChange={(e) => setFilters({ ...filters, maxCompressedSizeKB: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
        </div>
        {/* Compression state filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-neutral-500">压缩状态：</span>
          {[
            { value: "all", label: "全部" },
            { value: "compressed", label: "已压缩" },
            { value: "uncompressed", label: "未压缩" },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => setFilters({
                ...filters,
                compressionState: option.value as FilterState["compressionState"],
              })}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                filters.compressionState === option.value
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        {/* Format filter */}
        {formats.length > 1 && (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-neutral-500">格式：</span>
            {formats.map((f) => (
              <button
                key={f}
                onClick={() => {
                  const next = new Set(filters.formatFilter);
                  if (next.has(f)) next.delete(f);
                  else next.add(f);
                  setFilters({ ...filters, formatFilter: next });
                }}
                className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                  filters.formatFilter.has(f)
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        )}
        {/* Select all / deselect */}
        <div className="flex items-center gap-3">
          <button
            onClick={selectAllFiltered}
            className="flex items-center gap-1 px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-400 transition-colors"
          >
            <CheckSquare className="w-3.5 h-3.5" />
            全选筛选结果
          </button>
          <button
            onClick={deselectAll}
            className="flex items-center gap-1 px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-400 transition-colors"
          >
            <Square className="w-3.5 h-3.5" />
            取消全选
          </button>
        </div>
      </div>

      {/* Image list */}
      <div className="rounded-xl bg-neutral-800/30 border border-neutral-700/50 p-4 max-h-96 overflow-y-auto">
        {filteredImages.length === 0 ? (
          <p className="text-center text-neutral-500 text-sm py-8">没有匹配的图片</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {visibleImages.map((img) => {
                const isSelected = selectedIds.has(img.id);
                const preview = compressedPreviews.get(img.id);
                return (
                  <div
                    key={img.id}
                    className={`relative rounded-lg border p-2 transition-colors ${
                      !img.supported
                        ? "bg-neutral-900/50 border-neutral-800 opacity-60 cursor-not-allowed"
                        : isSelected
                        ? "bg-blue-950/30 border-blue-700/50 cursor-pointer"
                        : "bg-neutral-800/50 border-neutral-700/50 hover:border-neutral-600 cursor-pointer"
                    }`}
                    onClick={() => toggleSelect(img.id)}
                  >
                    {/* Thumbnail */}
                    <div className="relative aspect-video bg-neutral-900 rounded mb-2 overflow-hidden">
                      <img
                        src={convertFileSrc(img.preview_path)}
                        alt={img.name}
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-contain cursor-zoom-in"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetailImageId(img.id);
                        }}
                      />
                      {!img.supported && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="px-2 py-0.5 rounded bg-black/70 text-neutral-300 text-[10px] font-medium">
                            不支持解码
                          </span>
                        </div>
                      )}
                      {/* Selection checkbox */}
                      {img.supported && (
                        <div className="absolute top-1 right-1">
                          {isSelected ? (
                            <div className="w-5 h-5 rounded bg-blue-600 flex items-center justify-center">
                              <CheckSquare className="w-3.5 h-3.5 text-white" />
                            </div>
                          ) : (
                            <div className="w-5 h-5 rounded bg-black/50 border border-neutral-600" />
                          )}
                        </div>
                      )}
                      {/* Detail/compare button */}
                      {img.supported && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDetailImageId(img.id);
                          }}
                          className="absolute bottom-1 right-1 p-1 rounded bg-black/60 text-white hover:bg-black/80"
                          title="查看大图"
                        >
                          <ZoomIn className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {/* Info */}
                    <div className="space-y-0.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-neutral-500">第 {img.page} 页</span>
                        <ImageFormatBadge format={img.format} />
                      </div>
                      <div className="font-mono text-neutral-300">
                        {img.width}×{img.height}px
                      </div>
                      {preview && (
                        <div className="font-mono text-blue-300">
                          → {preview.width}×{preview.height}px
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1 text-neutral-500" title={`提取文件: ${formatKB(img.file_size)}`}>
                          <span>PDF {formatKB(pdfImageSize(img))}</span>
                          <PdfSizeHelp />
                        </span>
                        {preview && (
                          <span className="text-green-400">
                            {formatKB(preview.compressed_size)}
                            <span className="text-neutral-500 ml-1">
                              ({compressionRatio(preview.original_size, preview.compressed_size)})
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {visibleCount < filteredImages.length && (
              <button
                onClick={() => setVisibleCount((count) => count + IMAGE_LIST_PAGE_SIZE)}
                className="w-full px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-300 transition-colors"
              >
                加载更多图片 ({visibleCount}/{filteredImages.length})
              </button>
            )}
          </div>
        )}
      </div>

      {/* Compression panel */}
      {selectedIds.size > 0 && (
        <div className="rounded-xl bg-neutral-800/30 border border-neutral-700/50 p-4 space-y-4">
          <div className="flex items-center gap-2 text-sm text-neutral-300">
            <Sliders className="w-4 h-4" />
            <span className="font-medium">压缩设置 (已选中 {selectedIds.size} 张图片)</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Format selection */}
            <div>
              <label className="text-xs text-neutral-500 mb-1 block">输出格式</label>
              <select
                value={compressFormat}
                onChange={(e) => setCompressFormat(e.target.value as CompressFormat)}
                className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm focus:border-blue-500 focus:outline-none"
              >
                <option value="jpeg">JPEG (照片)</option>
                <option value="png">PNG (截图/无损)</option>
                <option value="webp">WebP (高压缩率)</option>
              </select>
            </div>

            {/* Quality slider */}
            {(compressFormat === "jpeg" || compressFormat === "webp") && (
              <div>
                <label className="text-xs text-neutral-500 mb-1 block">
                  质量: {quality}
                </label>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  className="w-full accent-blue-500"
                />
              </div>
            )}

            {/* Scale slider */}
            <div>
              <label className="text-xs text-neutral-500 mb-1 block">
                缩放: {maxWidth > 0 ? "由最大宽度决定" : `${scale}%`}
              </label>
              <input
                type="range"
                min={10}
                max={100}
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
                disabled={maxWidth > 0}
                className="w-full accent-blue-500"
              />
            </div>

            {/* Max width */}
            <div>
              <label className="text-xs text-neutral-500 mb-1 block">目标最大宽度 (px)</label>
              <input
                type="number"
                min={1}
                placeholder="不限制"
                value={maxWidth || ""}
                onChange={(e) => setMaxWidth(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Compress button */}
          <button
            onClick={handleCompress}
            disabled={compressing}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 transition-colors text-sm font-medium text-white disabled:opacity-50"
          >
            {compressing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                压缩中... ({compressProgress?.current}/{compressProgress?.total})
              </>
            ) : (
              <>
                <Sliders className="w-4 h-4" />
                {compressedPreviews.size > 0 ? "重新压缩" : "开始压缩"}
              </>
            )}
          </button>

          {compressError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-950/40 border border-red-800/50 text-red-200 text-xs">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{compressError}</span>
            </div>
          )}

          {/* Compression summary */}
          {compressedPreviews.size > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 rounded-lg bg-neutral-800/50">
                <div className="text-xs text-neutral-500">已压缩</div>
                <div className="text-sm font-bold font-mono text-blue-400">{compressedPreviews.size}</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-neutral-800/50">
                <div className="text-xs text-neutral-500">原始总大小</div>
                <div className="text-sm font-bold font-mono">{formatKB(totalOriginalSize)}</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-neutral-800/50">
                <div className="text-xs text-neutral-500">压缩后</div>
                <div className="text-sm font-bold font-mono text-green-400">
                  {formatKB(totalCompressedSize)}
                </div>
              </div>
            </div>
          )}

          {/* Export button */}
          {compressedPreviews.size > 0 && (
            <button
              onClick={handleExport}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-green-600 hover:bg-green-500 transition-colors font-medium text-white shadow-lg shadow-green-600/20"
            >
              <Download className="w-5 h-5" />
              导出压缩后的 PDF
            </button>
          )}
        </div>
      )}

      {/* Reset button */}
      <button
        onClick={resetAll}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 transition-colors text-sm text-neutral-400"
      >
        <RotateCcw className="w-4 h-4" />
        重新选择文件
      </button>
    </div>
  );
}
