import { useState, useCallback, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  X,
  Loader2,
  Sliders,
  CheckCircle2,
  AlertCircle,
  Maximize2,
  CircleHelp,
} from "lucide-react";
import type { ExtractedImageInfo, CompressedImagePreview } from "../types";
import {
  compressImage,
  formatKB,
  compressionRatio,
  type CompressFormat,
} from "../lib/imageCompress";
import { ImageCompare } from "./ImageCompare";

const RAW_FORMAT_HELP =
  "raw 表示这张图是 PDF 内部的原始图像数据或特殊编码流，不是可直接保存的 JPEG/PNG/WebP。它通常需要结合宽高、颜色空间、位深和 DecodeParms 才能还原，部分 raw 图片可能无法压缩。";

function pdfImageSize(image: ExtractedImageInfo): number {
  return image.pdf_size ?? image.file_size;
}

function ImageFormatBadge({ format }: { format: string }) {
  if (format !== "raw") {
    return <span>{format.toUpperCase()}</span>;
  }

  return (
    <span className="relative group inline-flex items-center gap-1">
      RAW
      <CircleHelp
        className="w-3.5 h-3.5 text-neutral-500"
        aria-label={RAW_FORMAT_HELP}
        tabIndex={0}
      />
      <span className="pointer-events-none absolute left-0 top-full z-20 mt-2 hidden w-72 rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-left text-xs leading-relaxed text-neutral-300 shadow-xl group-hover:block group-focus-within:block">
        {RAW_FORMAT_HELP}
      </span>
    </span>
  );
}

interface ImageDetailModalProps {
  image: ExtractedImageInfo;
  preview: CompressedImagePreview | null;
  onClose: () => void;
  onCompressed: (id: string, preview: CompressedImagePreview) => void;
  defaultFormat: CompressFormat;
  defaultQuality: number;
  defaultScale: number;
  defaultMaxWidth: number;
}

export function ImageDetailModal({
  image,
  preview,
  onClose,
  onCompressed,
  defaultFormat,
  defaultQuality,
  defaultScale,
  defaultMaxWidth,
}: ImageDetailModalProps) {
  const [format, setFormat] = useState<CompressFormat>(defaultFormat);
  const [quality, setQuality] = useState(defaultQuality);
  const [scale, setScale] = useState(defaultScale);
  const [maxWidth, setMaxWidth] = useState(defaultMaxWidth);
  const [compressing, setCompressing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (fullscreen) setFullscreen(false);
        else onClose();
      }
    },
    [onClose, fullscreen],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleCompress = useCallback(async () => {
    if (!image.supported) return;
    setCompressing(true);
    setError(null);
    try {
      const response = await fetch(convertFileSrc(image.temp_path));
      const arrayBuffer = await response.arrayBuffer();
      const result = await compressImage(arrayBuffer, image.format, {
        format,
        quality,
        scale: scale / 100,
        maxWidth: maxWidth > 0 ? maxWidth : undefined,
      });

      const compressedPath = image.temp_path.replace(
        /\.(jpg|png|jp2|bin)$/,
        `_compressed.${format}`,
      );
      await writeFile(compressedPath, new Uint8Array(result.data));

      const blob = new Blob([result.data], { type: `image/${format}` });
      const previewUrl = URL.createObjectURL(blob);

      onCompressed(image.id, {
        object_id: image.object_id,
        original_size: pdfImageSize(image),
        compressed_size: result.compressedSize,
        compressed_preview_path: previewUrl,
        format,
        width: result.width,
        height: result.height,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setCompressing(false);
    }
  }, [image, format, quality, scale, maxWidth, onCompressed]);

  return (
    <>
      {/* Fullscreen viewer (Esc to go back to modal) */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-[60] bg-black flex items-center justify-center"
          onClick={() => setFullscreen(false)}
        >
          <img
            src={convertFileSrc(image.temp_path)}
            alt={image.name}
            className="max-w-full max-h-full object-contain"
          />
          <button
            onClick={() => setFullscreen(false)}
            className="absolute top-4 right-4 p-2 rounded-lg bg-black/60 text-white hover:bg-black/80"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}

      {/* Detail modal */}
      <div
        className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          className="w-full max-w-5xl bg-neutral-900 rounded-2xl border border-neutral-700 max-h-[92vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-neutral-900/95 backdrop-blur border-b border-neutral-800">
            <div className="flex items-center gap-3 min-w-0">
              <h3 className="font-bold text-base truncate">
                {image.name}
              </h3>
              <span className="text-xs text-neutral-500 flex-shrink-0">
                第 {image.page} 页 · <ImageFormatBadge format={image.format} /> ·{" "}
                {image.width}×{image.height}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setFullscreen(true)}
                className="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400"
                title="全屏查看"
              >
                <Maximize2 className="w-5 h-5" />
              </button>
              <button
                onClick={onClose}
                className="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="p-6 space-y-5">
            {/* Image comparison area */}
            <div className="relative">
              <ImageCompare
                originalSrc={convertFileSrc(image.temp_path)}
                compressedSrc={preview?.compressed_preview_path ?? null}
                originalSize={pdfImageSize(image)}
                compressedSize={preview?.compressed_size ?? 0}
                originalWidth={image.width}
                originalHeight={image.height}
                compressedWidth={preview?.width ?? image.width}
                compressedHeight={preview?.height ?? image.height}
                format={preview?.format ?? format}
              />
            </div>

            {/* Unsupported notice */}
            {!image.supported && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-950/40 border border-amber-800/50 text-amber-200">
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-sm">此图片格式暂不支持压缩</p>
                  <p className="text-xs mt-1 text-amber-300/80">
                    该图片使用了 JBIG2 或其他无法解码的编码格式，将原样保留在 PDF 中。
                  </p>
                </div>
              </div>
            )}

            {/* Single image compression controls */}
            {image.supported && (
              <div className="rounded-xl bg-neutral-800/30 border border-neutral-700/50 p-4 space-y-4">
                <div className="flex items-center gap-2 text-sm text-neutral-300">
                  <Sliders className="w-4 h-4" />
                  <span className="font-medium">单图压缩设置</span>
                  {preview && (
                    <span className="ml-auto flex items-center gap-1 text-xs text-green-400">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      已压缩 · 节省{" "}
                      {compressionRatio(
                        preview.original_size,
                        preview.compressed_size,
                      )}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {/* Format */}
                  <div>
                    <label className="text-xs text-neutral-500 mb-1 block">
                      输出格式
                    </label>
                    <select
                      value={format}
                      onChange={(e) =>
                        setFormat(e.target.value as CompressFormat)
                      }
                      className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm focus:border-blue-500 focus:outline-none"
                    >
                      <option value="jpeg">JPEG (照片)</option>
                      <option value="png">PNG (截图/无损)</option>
                      <option value="webp">WebP (高压缩率)</option>
                    </select>
                  </div>

                  {/* Quality */}
                  {(format === "jpeg" || format === "webp") && (
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

                  {/* Scale */}
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
                    <label className="text-xs text-neutral-500 mb-1 block">
                      目标最大宽度 (px)
                    </label>
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

                {/* Error */}
                {error && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-red-950/40 border border-red-800/50 text-red-200 text-xs">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                {/* Compress button */}
                <button
                  onClick={handleCompress}
                  disabled={compressing}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 transition-colors text-sm font-medium text-white disabled:opacity-50"
                >
                  {compressing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      正在压缩...
                    </>
                  ) : (
                    <>
                      <Sliders className="w-4 h-4" />
                      {preview ? "重新压缩" : "压缩此图片"}
                    </>
                  )}
                </button>

                {/* Size comparison stats */}
                {preview && (
                  <div className="grid grid-cols-3 gap-3 pt-1">
                    <div className="text-center p-3 rounded-lg bg-neutral-800/50">
                      <div className="text-xs text-neutral-500">原始大小</div>
                      <div className="text-sm font-bold font-mono">
                        {formatKB(preview.original_size)}
                      </div>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-neutral-800/50">
                      <div className="text-xs text-neutral-500">压缩后</div>
                      <div className="text-sm font-bold font-mono text-green-400">
                        {formatKB(preview.compressed_size)}
                      </div>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-green-950/30 border border-green-800/30">
                      <div className="text-xs text-neutral-500">节省</div>
                      <div className="text-sm font-bold font-mono text-green-400">
                        {compressionRatio(
                          preview.original_size,
                          preview.compressed_size,
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
