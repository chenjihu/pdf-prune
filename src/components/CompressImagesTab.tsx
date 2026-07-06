import { useState, useCallback, useEffect, useMemo } from "react";
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
  onExtract: () => void;
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
  pageFilter: number | null;
  formatFilter: Set<string>;
}

const DEFAULT_FILTERS: FilterState = {
  minWidth: 0,
  maxWidth: 0,
  minHeight: 0,
  maxHeight: 0,
  minSizeKB: 0,
  maxSizeKB: 0,
  pageFilter: null,
  formatFilter: new Set(),
};

export function CompressImagesTab({
  extracting,
  extractError,
  extractedImages,
  inputPath,
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
  const [compressing, setCompressing] = useState(false);
  const [compressProgress, setCompressProgress] = useState<{ current: number; total: number } | null>(null);
  const [compressedPreviews, setCompressedPreviews] = useState<Map<string, CompressedImagePreview>>(new Map());
  const [detailImageId, setDetailImageId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [exportResult, setExportResult] = useState<CompressImagesResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [compressError, setCompressError] = useState<string | null>(null);

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
      if (filters.minWidth > 0 && img.width < filters.minWidth) return false;
      if (filters.maxWidth > 0 && img.width > filters.maxWidth) return false;
      if (filters.minHeight > 0 && img.height < filters.minHeight) return false;
      if (filters.maxHeight > 0 && img.height > filters.maxHeight) return false;
      if (filters.minSizeKB > 0 && img.file_size / 1024 < filters.minSizeKB) return false;
      if (filters.maxSizeKB > 0 && img.file_size / 1024 > filters.maxSizeKB) return false;
      if (filters.pageFilter !== null && img.page !== filters.pageFilter) return false;
      if (filters.formatFilter.size > 0 && !filters.formatFilter.has(img.format)) return false;
      return true;
    });
  }, [extractedImages, filters]);

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
        });

        // Write compressed data to temp file
        const compressedPath = img.temp_path.replace(/\.(jpg|png|jp2)$/, `_compressed.${compressFormat}`);
        await writeFile(compressedPath, new Uint8Array(result.data));

        // Generate preview URL from compressed data
        const blob = new Blob([result.data], { type: `image/${compressFormat}` });
        const previewUrl = URL.createObjectURL(blob);

        previews.set(img.id, {
          object_id: img.object_id,
          original_size: result.originalSize,
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
  }, [extractedImages, selectedIds, compressFormat, quality, scale]);

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
    return extractedImages.reduce((sum, img) => sum + img.file_size, 0);
  }, [extractedImages]);

  const totalCompressedSize = useMemo(() => {
    let sum = 0;
    for (const preview of compressedPreviews.values()) {
      sum += preview.compressed_size;
    }
    return sum;
  }, [compressedPreviews]);

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
        <button
          onClick={onExtract}
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
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center">
          <Loader2 className="w-10 h-10 text-blue-500 animate-spin mb-4" />
          <p className="text-neutral-300 text-sm font-medium">正在提取图片...</p>
          <p className="text-neutral-500 text-xs mt-1">已用时 {formatDuration(elapsedTime)}</p>
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

  const handleDetailCompressed = useCallback((id: string, preview: CompressedImagePreview) => {
    setCompressedPreviews((prev) => {
      const next = new Map(prev);
      next.set(id, preview);
      return next;
    });
  }, []);

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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {filteredImages.map((img) => {
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
                      <span className="text-neutral-600 font-mono">{img.format}</span>
                    </div>
                    <div className="font-mono text-neutral-300">
                      {img.width}×{img.height}px
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-neutral-500">{formatKB(img.file_size)}</span>
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
        )}
      </div>

      {/* Compression panel */}
      {selectedIds.size > 0 && (
        <div className="rounded-xl bg-neutral-800/30 border border-neutral-700/50 p-4 space-y-4">
          <div className="flex items-center gap-2 text-sm text-neutral-300">
            <Sliders className="w-4 h-4" />
            <span className="font-medium">压缩设置 (已选中 {selectedIds.size} 张图片)</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
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
                缩放: {scale}%
              </label>
              <input
                type="range"
                min={10}
                max={100}
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
                className="w-full accent-blue-500"
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
