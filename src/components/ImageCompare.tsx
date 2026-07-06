import { useRef, useState, useCallback } from "react";
import { formatKB, compressionRatio } from "../lib/imageCompress";

interface ImageCompareProps {
  originalSrc: string;
  compressedSrc: string | null;
  originalSize: number;
  compressedSize: number;
  originalWidth: number;
  originalHeight: number;
  compressedWidth: number;
  compressedHeight: number;
  format: string;
}

export function ImageCompare({
  originalSrc,
  compressedSrc,
  originalSize,
  compressedSize,
  originalWidth,
  originalHeight,
  compressedWidth,
  compressedHeight,
  format,
}: ImageCompareProps) {
  const [sliderPos, setSliderPos] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handleMove = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setSliderPos(pct);
  }, []);

  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging.current) handleMove(e.clientX);
    },
    [handleMove],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (isDragging.current && e.touches[0]) handleMove(e.touches[0].clientX);
    },
    [handleMove],
  );

  return (
    <div className="space-y-3">
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-xl bg-neutral-900 border border-neutral-700 select-none cursor-ew-resize"
        style={{ aspectRatio: `${originalWidth} / ${originalHeight}` }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleMouseUp}
      >
        {/* Original image (full) */}
        <img
          src={originalSrc}
          alt="Original"
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          draggable={false}
        />
        {/* Compressed image (clipped) */}
        {compressedSrc && (
          <div
            className="absolute inset-0 overflow-hidden pointer-events-none"
            style={{ clipPath: `inset(0 0 0 ${sliderPos}%)` }}
          >
            <img
              src={compressedSrc}
              alt="Compressed"
              className="absolute inset-0 w-full h-full object-contain"
              draggable={false}
            />
          </div>
        )}
        {/* Slider line */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg pointer-events-none"
          style={{ left: `${sliderPos}%` }}
        >
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white shadow-lg flex items-center justify-center"
            onMouseDown={handleMouseDown}
            onTouchStart={handleMouseDown}
            style={{ pointerEvents: "auto", cursor: "ew-resize" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-800">
              <path d="M8 18l-6-6 6-6M16 6l6 6-6 6" />
            </svg>
          </div>
        </div>
        {/* Labels */}
        <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-white text-xs font-mono pointer-events-none">
          原图 {formatKB(originalSize)}
        </div>
        {compressedSrc && (
          <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/60 text-white text-xs font-mono pointer-events-none">
            {format.toUpperCase()} {formatKB(compressedSize)}
          </div>
        )}
      </div>

      {/* Stats */}
      {compressedSrc && (
        <div className="grid grid-cols-4 gap-2 text-center">
          <div className="rounded-lg bg-neutral-800/50 p-2">
            <div className="text-xs text-neutral-500">原始尺寸</div>
            <div className="text-sm font-mono text-neutral-300">
              {originalWidth}×{originalHeight}
            </div>
          </div>
          <div className="rounded-lg bg-neutral-800/50 p-2">
            <div className="text-xs text-neutral-500">压缩后尺寸</div>
            <div className="text-sm font-mono text-neutral-300">
              {compressedWidth}×{compressedHeight}
            </div>
          </div>
          <div className="rounded-lg bg-neutral-800/50 p-2">
            <div className="text-xs text-neutral-500">原始大小</div>
            <div className="text-sm font-mono text-neutral-300">{formatKB(originalSize)}</div>
          </div>
          <div className="rounded-lg bg-neutral-800/50 p-2">
            <div className="text-xs text-neutral-500">压缩后</div>
            <div className="text-sm font-mono text-green-400">
              {formatKB(compressedSize)}
            </div>
          </div>
        </div>
      )}
      {compressedSrc && (
        <div className="text-center">
          <span className="inline-block px-3 py-1 rounded-full bg-green-950/40 border border-green-800/30 text-green-400 text-sm font-medium">
            节省 {compressionRatio(originalSize, compressedSize)}
          </span>
        </div>
      )}
    </div>
  );
}
