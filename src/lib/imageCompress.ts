import { decode as jpegDecode, encode as jpegEncode } from "@jsquash/jpeg";
import { decode as pngDecode, encode as pngEncode } from "@jsquash/png";
import { decode as webpDecode, encode as webpEncode } from "@jsquash/webp";
import { optimise as oxipngOptimise } from "@jsquash/oxipng";

export type CompressFormat = "jpeg" | "png" | "webp";

export interface CompressOptions {
  format: CompressFormat;
  quality: number; // 1-100 for jpeg/webp
  scale: number; // 0.1-1.0
}

export interface CompressResult {
  data: ArrayBuffer;
  format: CompressFormat;
  width: number;
  height: number;
  originalSize: number;
  compressedSize: number;
}

async function loadImageDataFromArrayBuffer(
  data: ArrayBuffer,
  format: string,
): Promise<ImageData> {
  switch (format) {
    case "jpeg":
      return jpegDecode(data);
    case "png":
      return pngDecode(data);
    case "webp":
      return webpDecode(data);
    default:
      return pngDecode(data);
  }
}

function scaleImageData(
  imageData: ImageData,
  scale: number,
): ImageData {
  if (scale >= 1.0) return imageData;

  const srcWidth = imageData.width;
  const srcHeight = imageData.height;
  const dstWidth = Math.round(srcWidth * scale);
  const dstHeight = Math.round(srcHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = dstWidth;
  canvas.height = dstHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = srcWidth;
  tempCanvas.height = srcHeight;
  const tempCtx = tempCanvas.getContext("2d")!;
  tempCtx.putImageData(imageData, 0, 0);

  ctx.drawImage(tempCanvas, 0, 0, srcWidth, srcHeight, 0, 0, dstWidth, dstHeight);
  return ctx.getImageData(0, 0, dstWidth, dstHeight);
}

export async function compressImage(
  imageDataBuffer: ArrayBuffer,
  sourceFormat: string,
  options: CompressOptions,
): Promise<CompressResult> {
  const originalSize = imageDataBuffer.byteLength;

  // Decode source image to ImageData
  let imageData = await loadImageDataFromArrayBuffer(imageDataBuffer, sourceFormat);

  // Apply scaling
  if (options.scale < 1.0) {
    imageData = scaleImageData(imageData, options.scale);
  }

  const width = imageData.width;
  const height = imageData.height;

  // Encode to target format
  let compressedData: ArrayBuffer;
  switch (options.format) {
    case "jpeg": {
      // JPEG doesn't support alpha — flatten to RGB
      if (hasAlpha(imageData)) {
        imageData = flattenAlpha(imageData);
      }
      compressedData = await jpegEncode(imageData, { quality: options.quality });
      break;
    }
    case "png": {
      const pngData = await pngEncode(imageData);
      compressedData = await oxipngOptimise(pngData, { level: 3 });
      break;
    }
    case "webp": {
      compressedData = await webpEncode(imageData, { quality: options.quality });
      break;
    }
    default:
      compressedData = await jpegEncode(imageData, { quality: options.quality });
  }

  return {
    data: compressedData,
    format: options.format,
    width,
    height,
    originalSize,
    compressedSize: compressedData.byteLength,
  };
}

function hasAlpha(imageData: ImageData): boolean {
  for (let i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i] < 255) return true;
  }
  return false;
}

function flattenAlpha(imageData: ImageData): ImageData {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    data[i] = Math.round(data[i] * alpha + 255 * (1 - alpha));
    data[i + 1] = Math.round(data[i + 1] * alpha + 255 * (1 - alpha));
    data[i + 2] = Math.round(data[i + 2] * alpha + 255 * (1 - alpha));
    data[i + 3] = 255;
  }
  return imageData;
}

export function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function compressionRatio(original: number, compressed: number): string {
  if (original === 0) return "0%";
  const ratio = ((1 - compressed / original) * 100).toFixed(1);
  return `${ratio}%`;
}
