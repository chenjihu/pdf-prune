import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  FileText,
  FolderOpen,
  Scissors,
  Loader2,
  CheckCircle2,
  AlertCircle,
  HardDrive,
  Layers,
  Trash2,
  Download,
  RotateCcw,
  ImageMinus,
  Images,
  Plus,
  X,
} from "lucide-react";
import type { PdfAnalysis, PruneOptions, PruneResult, RemoveImagesResult, ImageInfo, ImageSize, ExtractedImageInfo } from "./types";
import { DEFAULT_PRUNE_OPTIONS, PRUNE_OPTION_LABELS } from "./types";
import { formatSize, formatPercent, getComponentColor, formatDuration } from "./utils";
import { CompressImagesTab } from "./components/CompressImagesTab";

type Tab = "prune" | "removeImages" | "compressImages";

export interface ExtractProgress {
  pct: number;
  msg: string;
  completed: number;
  total: number;
  active: number;
  workerThreads: number;
}

interface ExtractProgressEvent {
  pct: number;
  msg: string;
  completed: number;
  total: number;
  active: number;
  worker_threads: number;
}

function parseExtractProgress(pct: number, msg: string, previous: ExtractProgress | null): ExtractProgress {
  const threadsMatch = msg.match(/(\d+)\s*线程/);
  const workerThreads = threadsMatch ? Number(threadsMatch[1]) : previous?.workerThreads ?? 0;
  const decodeMatch = msg.match(/\((\d+)\/(\d+)(?:[,，][^)]+)?\)/);
  if (decodeMatch) {
    return {
      pct,
      msg,
      completed: Number(decodeMatch[1]),
      total: Number(decodeMatch[2]),
      active: Math.min(workerThreads, Math.max(0, Number(decodeMatch[2]) - Number(decodeMatch[1]))),
      workerThreads,
    };
  }

  const totalMatch = msg.match(/共\s*(\d+)\s*张图片|解码\s*(\d+)\s*张图片/);
  const total = totalMatch ? Number(totalMatch[1] ?? totalMatch[2]) : previous?.total ?? 0;
  const completed = pct >= 100 && total > 0 ? total : previous?.completed ?? 0;
  const active = pct >= 100 ? 0 : previous?.active ?? 0;
  return { pct, msg, completed, total, active, workerThreads };
}

function App() {
  const [tab, setTab] = useState<Tab>("prune");
  const [analysis, setAnalysis] = useState<PdfAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<PruneOptions>(DEFAULT_PRUNE_OPTIONS);
  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState<PruneResult | null>(null);
  const [progress, setProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [endTime, setEndTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);

  // Convert state
  const [removingImages, setRemovingImages] = useState(false);
  const [removeImagesResult, setRemoveImagesResult] = useState<RemoveImagesResult | null>(null);
  const [removeImagesError, setRemoveImagesError] = useState<string | null>(null);
  const [removeImagesProgress, setRemoveImagesProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [targetSizes, setTargetSizes] = useState<ImageSize[]>([{ width: 0, height: 0 }]);
  const [yMin, setYMin] = useState(0);
  const [yMax, setYMax] = useState(9999);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<ImageInfo[] | null>(null);

  // Compress images state
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractedImages, setExtractedImages] = useState<ExtractedImageInfo[] | null>(null);
  const [compressInputPath, setCompressInputPath] = useState<string | null>(null);
  const [extractProgress, setExtractProgress] = useState<ExtractProgress | null>(null);
  const [cacheDir, setCacheDir] = useState<string | null>(() => localStorage.getItem("pdf-prune-cache-dir"));
  const [defaultCacheDir, setDefaultCacheDir] = useState<string | null>(null);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  const openPdf = useCallback(async () => {
    try {
      const selected = await open({
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      if (!selected) return;
      const filePath = selected;

      setLoading(true);
      setError(null);
      setPruneResult(null);
      setAnalysis(null);
      setProgress({ pct: 0, msg: "准备中..." });
      setStartTime(Date.now());
      setEndTime(null);

      const result = await invoke<PdfAnalysis>("analyze_pdf", { filePath });
      setAnalysis(result);
      setEndTime(Date.now());
    } catch (e) {
      setError(String(e));
      setEndTime(Date.now());
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, []);

  const handlePrune = useCallback(async () => {
    if (!analysis) return;

    try {
      const outputPath = await save({
        defaultPath: analysis.file_path.replace(/\.pdf$/i, "_pruned.pdf"),
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      if (!outputPath) return;

      setPruning(true);
      setError(null);
      setProgress({ pct: 0, msg: "准备中..." });
      setStartTime(Date.now());
      setEndTime(null);

      const result = await invoke<PruneResult>("prune_pdf", {
        inputPath: analysis.file_path,
        outputPath,
        options,
      });
      setPruneResult(result);
      setEndTime(Date.now());
    } catch (e) {
      setError(String(e));
      setEndTime(Date.now());
    } finally {
      setPruning(false);
      setProgress(null);
    }
  }, [analysis, options]);

  const handleRemoveImages = useCallback(async () => {
    try {
      const selected = await open({
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      if (!selected) return;
      const inputPath = selected;

      const outputPath = await save({
        defaultPath: inputPath.replace(/\.pdf$/i, "_noimg.pdf"),
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      if (!outputPath) return;

      setRemovingImages(true);
      setRemoveImagesError(null);
      setRemoveImagesResult(null);
      setRemoveImagesProgress({ pct: 0, msg: "准备中..." });
      setStartTime(Date.now());
      setEndTime(null);

      const result = await invoke<RemoveImagesResult>("remove_images", {
        inputPath,
        outputPath,
        targetSizes: targetSizes.filter(s => s.width > 0 && s.height > 0),
        yMin,
        yMax,
      });
      setRemoveImagesResult(result);
      setEndTime(Date.now());
    } catch (e) {
      setRemoveImagesError(String(e));
      setEndTime(Date.now());
    } finally {
      setRemovingImages(false);
      setRemoveImagesProgress(null);
    }
  }, [targetSizes, yMin, yMax]);

  const resetRemoveImages = useCallback(() => {
    setRemoveImagesResult(null);
    setRemoveImagesError(null);
    setScanResults(null);
  }, []);

  const handleExtractImages = useCallback(async (workerThreads: number) => {
    try {
      const selected = await open({
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      if (!selected) return;

      setExtracting(true);
      setExtractError(null);
      setExtractedImages(null);
      setCompressInputPath(selected);
      setExtractProgress({ pct: 0, msg: "准备中...", completed: 0, total: 0, active: 0, workerThreads });
      setStartTime(Date.now());
      setEndTime(null);

      const result = await invoke<ExtractedImageInfo[]>("extract_images", {
        inputPath: selected,
        workerThreads,
        cacheDir: cacheDir || null,
      });
      setExtractedImages(result);
      setEndTime(Date.now());
    } catch (e) {
      setExtractError(String(e));
      setEndTime(Date.now());
    } finally {
      setExtracting(false);
      setExtractProgress(null);
    }
  }, [cacheDir]);

  const chooseCacheDir = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) return;
      setCacheDir(selected);
      localStorage.setItem("pdf-prune-cache-dir", selected);
      setCacheMessage("缓存目录已更新");
      setCacheError(null);
    } catch (e) {
      setCacheError(String(e));
      setCacheMessage(null);
    }
  }, []);

  const resetCacheDir = useCallback(() => {
    localStorage.removeItem("pdf-prune-cache-dir");
    setCacheDir(null);
    setCacheMessage("已恢复默认缓存目录");
    setCacheError(null);
  }, []);

  const clearCache = useCallback(async () => {
    try {
      setClearingCache(true);
      setCacheError(null);
      setCacheMessage(null);
      const removed = await invoke<number>("clear_cache_dir", { cacheDir: cacheDir || null });
      setCacheMessage(`已清空 ${removed} 个缓存会话目录`);
    } catch (e) {
      setCacheError(String(e));
    } finally {
      setClearingCache(false);
    }
  }, [cacheDir]);

  const resetCompressImages = useCallback(() => {
    setExtractedImages(null);
    setExtractError(null);
    setCompressInputPath(null);
    setExtractProgress(null);
    setStartTime(null);
    setEndTime(null);
    setElapsedTime(0);
  }, []);

  const handleScanImages = useCallback(async () => {
    try {
      const selected = await open({
        filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
      });
      if (!selected) return;

      setScanning(true);
      setScanResults(null);
      setStartTime(Date.now());
      setEndTime(null);

      const result = await invoke<ImageInfo[]>("list_images", {
        inputPath: selected,
      });
      setScanResults(result);
      setEndTime(Date.now());
    } catch (e) {
      setRemoveImagesError(String(e));
      setEndTime(Date.now());
    } finally {
      setScanning(false);
    }
  }, []);

  // Timer effect: updates elapsed time every second while a task is running
  useEffect(() => {
    const isRunning = loading || pruning || removingImages || scanning || extracting;
    if (!isRunning) {
      return;
    }
    const interval = setInterval(() => {
      if (startTime) {
        setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [loading, pruning, removingImages, scanning, extracting, startTime]);

  useEffect(() => {
    invoke<string>("get_default_cache_dir")
      .then(setDefaultCacheDir)
      .catch((e) => setCacheError(String(e)));
  }, []);

  // Listen for progress events
  useEffect(() => {
    let unlistenAnalyze: UnlistenFn | null = null;
    let unlistenPrune: UnlistenFn | null = null;

    listen<[number, string]>("analyze-progress", (event) => {
      const [pct, msg] = event.payload;
      setProgress({ pct, msg });
    }).then((fn) => { unlistenAnalyze = fn; });

    listen<[number, string]>("prune-progress", (event) => {
      const [pct, msg] = event.payload;
      setProgress({ pct, msg });
    }).then((fn) => { unlistenPrune = fn; });

    let unlistenRemoveImages: UnlistenFn | null = null;
    listen<[number, string]>("remove-images-progress", (event) => {
      const [pct, msg] = event.payload;
      setRemoveImagesProgress({ pct, msg });
    }).then((fn) => { unlistenRemoveImages = fn; });

    let unlistenExtractImages: UnlistenFn | null = null;
    listen<[number, string]>("extract-images-progress", (event) => {
      const [pct, msg] = event.payload;
      setExtractProgress((prev) => parseExtractProgress(pct, msg, prev));
    }).then((fn) => { unlistenExtractImages = fn; });

    let unlistenExtractImagesDetail: UnlistenFn | null = null;
    listen<ExtractProgressEvent>("extract-images-detail-progress", (event) => {
      const payload = event.payload;
      setExtractProgress({
        pct: payload.pct,
        msg: payload.msg,
        completed: payload.completed,
        total: payload.total,
        active: payload.active,
        workerThreads: payload.worker_threads,
      });
    }).then((fn) => { unlistenExtractImagesDetail = fn; });

    return () => {
      unlistenAnalyze?.();
      unlistenPrune?.();
      unlistenRemoveImages?.();
      unlistenExtractImages?.();
      unlistenExtractImagesDetail?.();
    };
  }, []);

  const reset = useCallback(() => {
    setAnalysis(null);
    setPruneResult(null);
    setError(null);
    setStartTime(null);
    setEndTime(null);
    setElapsedTime(0);
  }, []);

  const toggleOption = (key: keyof PruneOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const totalComponentSize = analysis
    ? analysis.components.reduce((sum, c) => sum + c.size, 0)
    : 0;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-neutral-800 bg-neutral-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Scissors className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">PDF Prune</h1>
              <p className="text-xs text-neutral-400">PDF 组成分析、瘦身与转换工具</p>
            </div>
          </div>
          {/* Tab switcher */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-neutral-800/50">
            <button
              onClick={() => setTab("prune")}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                tab === "prune" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <Scissors className="w-4 h-4" />
              PDF组成分析
            </button>
            <button
              onClick={() => setTab("removeImages")}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                tab === "removeImages" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200"}
              `}
            >
              <ImageMinus className="w-4 h-4" />
              移除PDF中的特定图片
            </button>
            <button
              onClick={() => setTab("compressImages")}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                tab === "compressImages" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <Images className="w-4 h-4" />
              压缩PDF中的图片
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8">
        {/* ===== Tab: PDF Prune ===== */}
        {tab === "prune" && (
          <>
        {error && (
          <div className="mb-6 flex items-start gap-3 p-4 rounded-xl bg-red-950/40 border border-red-800/50 text-red-200">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-sm">出错了</p>
              <p className="text-xs mt-1 text-red-300/80">{error}</p>
            </div>
          </div>
        )}

        {/* Empty state - file picker */}
        {tab === "prune" && !analysis && !loading && (
          <div className="flex flex-col items-center justify-center min-h-[60vh]">
            <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-blue-500/20 to-purple-600/20 border border-neutral-800 flex items-center justify-center mb-6">
              <FileText className="w-12 h-12 text-neutral-400" />
            </div>
            <h2 className="text-xl font-bold mb-2">选择 PDF 文件开始分析</h2>
            <p className="text-neutral-400 text-sm mb-8 text-center max-w-md">
              打开 PDF 文件，查看其组成元素的详细分析，并进行瘦身修剪以减小文件体积
            </p>
            <button
              onClick={openPdf}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 transition-colors font-medium text-white shadow-lg shadow-blue-600/20"
            >
              <FolderOpen className="w-5 h-5" />
              打开 PDF 文件
            </button>
          </div>
        )}

        {/* Loading state with progress bar */}
        {tab === "prune" && loading && (
          <div className="flex flex-col items-center justify-center min-h-[60vh]">
            <div className="w-full max-w-md space-y-6">
              <div className="flex flex-col items-center">
                <Loader2 className="w-10 h-10 text-blue-500 animate-spin mb-4" />
                <p className="text-neutral-300 text-sm font-medium">
                  {progress?.msg || "正在分析 PDF 文件..."}
                </p>
                <p className="text-neutral-500 text-xs mt-1">
                  已用时 {formatDuration(elapsedTime)}
                </p>
              </div>
              <div className="w-full">
                <div className="flex items-center justify-between text-xs text-neutral-400 mb-2">
                  <span>进度</span>
                  <span className="font-mono">{progress?.pct || 0}%</span>
                </div>
                <div className="h-2 rounded-full bg-neutral-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300 ease-out"
                    style={{ width: `${progress?.pct || 0}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Analysis results */}
        {tab === "prune" && analysis && !loading && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="text-xs text-neutral-500 truncate flex-1 mr-4">
                {analysis.file_path}
              </div>
              <button
                onClick={reset}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 transition-colors text-xs font-medium"
              >
                <RotateCcw className="w-4 h-4" />
                重新分析
              </button>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <SummaryCard
                icon={<HardDrive className="w-5 h-5" />}
                label="文件大小"
                value={formatSize(analysis.file_size)}
                color="text-blue-400"
              />
              <SummaryCard
                icon={<Layers className="w-5 h-5" />}
                label="页数"
                value={`${analysis.page_count}`}
                color="text-purple-400"
              />
              <SummaryCard
                icon={<FileText className="w-5 h-5" />}
                label="对象总数"
                value={`${analysis.total_object_count}`}
                color="text-green-400"
              />
              <SummaryCard
                icon={<Trash2 className="w-5 h-5" />}
                label="未使用对象"
                value={`${analysis.unused_object_count}`}
                color="text-orange-400"
              />
            </div>

            {/* Component breakdown */}
            <div className="rounded-2xl bg-neutral-900/50 border border-neutral-800 p-6">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-bold text-base">组成元素分析</h3>
                <span className="text-xs text-neutral-400">
                  PDF 版本: {analysis.pdf_version}
                </span>
              </div>

              {/* Stacked bar */}
              <div className="mb-6">
                <div className="flex h-8 rounded-lg overflow-hidden bg-neutral-800">
                  {analysis.components.map((comp) => {
                    const pct = (comp.size / totalComponentSize) * 100;
                    if (pct < 0.1) return null;
                    return (
                      <div
                        key={comp.name}
                        style={{
                          width: `${pct}%`,
                          backgroundColor: getComponentColor(comp.name),
                        }}
                        title={`${comp.name}: ${formatSize(comp.size)} (${formatPercent(comp.size, totalComponentSize)})`}
                      />
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-neutral-400">
                  <span>0</span>
                  <span className="flex-1 text-center">元素占比可视化</span>
                  <span>{formatSize(totalComponentSize)}</span>
                </div>
              </div>

              {/* Component list */}
              <div className="space-y-3">
                {analysis.components.map((comp) => {
                  return (
                    <div
                      key={comp.name}
                      className="flex items-center gap-4 p-3 rounded-xl bg-neutral-800/30 hover:bg-neutral-800/50 transition-colors"
                    >
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: getComponentColor(comp.name) }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{comp.name}</span>
                          {comp.count > 0 && (
                            <span className="text-xs text-neutral-500">
                              ×{comp.count}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-neutral-500 mt-0.5 truncate">
                          {comp.description}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-mono text-sm font-medium">
                          {formatSize(comp.size)}
                        </div>
                        <div className="text-xs text-neutral-500">
                          {formatPercent(comp.size, totalComponentSize)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Font details section */}
            {analysis.fonts.length > 0 && (
              <div className="rounded-2xl bg-neutral-900/50 border border-neutral-800 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-base">字体明细</h3>
                  <span className="text-xs text-neutral-500">
                    共 {analysis.fonts.length} 种字体
                  </span>
                </div>
                <div className="max-h-64 overflow-auto space-y-2 pr-1">
                  {analysis.fonts
                    .sort((a, b) => b.size - a.size)
                    .map((font, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 p-3 rounded-xl bg-neutral-800/30 text-sm"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{font.name}</span>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-700 text-neutral-300">
                              {font.subtype}
                            </span>
                            {font.embedded && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-green-950/50 text-green-400 border border-green-800/30">
                                已嵌入
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-neutral-500 mt-0.5">
                            对象 ID: {font.object_id}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0 font-mono">
                          {formatSize(font.size)}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Pruning section */}
            {!pruneResult && (
              <div className="rounded-2xl bg-neutral-900/50 border border-neutral-800 p-6">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h3 className="font-bold text-base">瘦身选项</h3>
                    <p className="text-xs text-neutral-400 mt-1">
                      选择要执行的优化操作（不会处理图片）
                    </p>
                  </div>
                  {analysis.potential_savings > 0 && (
                    <div className="text-right">
                      <div className="text-xs text-neutral-500">预计可节省</div>
                      <div className="text-lg font-bold text-green-400">
                        ~{formatSize(analysis.potential_savings)}
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid md:grid-cols-2 gap-3">
                  {PRUNE_OPTION_LABELS.map((opt) => (
                    <label
                      key={opt.key}
                      className="flex items-start gap-3 p-3 rounded-xl bg-neutral-800/30 hover:bg-neutral-800/50 transition-colors cursor-pointer border border-transparent has-[:checked]:border-blue-600/50 has-[:checked]:bg-blue-950/20"
                    >
                      <input
                        type="checkbox"
                        checked={options[opt.key]}
                        onChange={() => toggleOption(opt.key)}
                        className="mt-0.5 w-4 h-4 rounded accent-blue-600"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{opt.label}</span>
                          {!opt.safe && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-950/50 text-orange-400 border border-orange-800/30">
                              谨慎
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-neutral-500 mt-0.5">
                          {opt.description}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>

                <button
                  onClick={handlePrune}
                  disabled={pruning}
                  className="mt-5 w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 transition-all font-medium text-white shadow-lg shadow-blue-600/20 disabled:opacity-50"
                >
                  {pruning ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      {progress?.msg || "正在修剪..."}
                    </>
                  ) : (
                    <>
                      <Scissors className="w-5 h-5" />
                      执行瘦身修剪
                    </>
                  )}
                </button>

                {pruning && progress && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-xs text-neutral-400 mb-2">
                      <span>进度</span>
                      <span className="font-mono">{progress.pct}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-neutral-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300 ease-out"
                        style={{ width: `${progress.pct}%` }}
                      />
                    </div>
                    <div className="text-xs text-neutral-500 mt-2 text-right">
                      已用时 {formatDuration(elapsedTime)}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Prune result */}
            {pruneResult && (
              <div className="rounded-2xl bg-gradient-to-br from-green-950/30 to-neutral-900/50 border border-green-800/30 p-6">
                <div className="flex items-center gap-3 mb-5">
                  <CheckCircle2 className="w-6 h-6 text-green-400" />
                  <h3 className="font-bold text-base">修剪完成</h3>
                </div>

                <div className="grid grid-cols-3 gap-4 mb-5">
                  <div className="text-center p-4 rounded-xl bg-neutral-800/30">
                    <div className="text-xs text-neutral-500 mb-1">原始大小</div>
                    <div className="text-lg font-bold font-mono">
                      {formatSize(pruneResult.original_size)}
                    </div>
                  </div>
                  <div className="text-center p-4 rounded-xl bg-neutral-800/30">
                    <div className="text-xs text-neutral-500 mb-1">修剪后</div>
                    <div className="text-lg font-bold font-mono text-green-400">
                      {formatSize(pruneResult.pruned_size)}
                    </div>
                  </div>
                  <div className={`text-center p-4 rounded-xl border ${
                    pruneResult.savings >= 0
                      ? "bg-green-950/30 border-green-800/30"
                      : "bg-amber-950/30 border-amber-800/30"
                  }`}>
                    <div className="text-xs text-neutral-500 mb-1">
                      {pruneResult.savings >= 0 ? "节省" : "增加"}
                    </div>
                    <div className={`text-lg font-bold font-mono ${
                      pruneResult.savings >= 0 ? "text-green-400" : "text-amber-400"
                    }`}>
                      {formatSize(Math.abs(pruneResult.savings))}
                    </div>
                    <div className={`text-xs ${
                      pruneResult.savings >= 0 ? "text-green-500" : "text-amber-500"
                    }`}>
                      {Math.abs(pruneResult.savings_percent).toFixed(1)}%
                    </div>
                  </div>
                </div>

                {endTime && startTime && (
                  <div className="text-xs text-neutral-500 mb-4 text-right">
                    总用时 {formatDuration(Math.floor((endTime - startTime) / 1000))}
                  </div>
                )}

                <div className="mb-5">
                  <h4 className="text-sm font-medium mb-3 text-neutral-300">执行的操作：</h4>
                  <div className="space-y-2">
                    {pruneResult.actions.map((action, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-sm text-neutral-300"
                      >
                        <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                        {action}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 p-3 rounded-xl bg-neutral-800/30">
                  <Download className="w-4 h-4 text-neutral-400 flex-shrink-0" />
                  <span className="text-sm text-neutral-300 truncate flex-1">
                    {pruneResult.output_path}
                  </span>
                </div>

                <button
                  onClick={reset}
                  className="mt-5 w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 transition-colors font-medium"
                >
                  <RotateCcw className="w-5 h-5" />
                  分析另一个文件
                </button>
              </div>
            )}
          </div>
        )}
          </>
        )}

        {/* ===== Tab: Compress Images ===== */}
        {tab === "compressImages" && (
          <CompressImagesTab
            extracting={extracting}
            extractError={extractError}
            extractedImages={extractedImages}
            inputPath={compressInputPath}
            extractProgress={extractProgress}
            onExtract={handleExtractImages}
            onReset={resetCompressImages}
            elapsedTime={elapsedTime}
            startTime={startTime}
            endTime={endTime}
            cacheDir={cacheDir || defaultCacheDir}
            usingDefaultCacheDir={!cacheDir}
            cacheMessage={cacheMessage}
            cacheError={cacheError}
            clearingCache={clearingCache}
            onChooseCacheDir={chooseCacheDir}
            onResetCacheDir={resetCacheDir}
            onClearCache={clearCache}
          />
        )}

        {/* ===== Tab: Remove Images ===== */}
        {tab === "removeImages" && (
          <RemoveImagesTab
            removingImages={removingImages}
            result={removeImagesResult}
            error={removeImagesError}
            progress={removeImagesProgress}
            targetSizes={targetSizes}
            setTargetSizes={setTargetSizes}
            yMin={yMin}
            yMax={yMax}
            setYMin={setYMin}
            setYMax={setYMax}
            onProcess={handleRemoveImages}
            onReset={resetRemoveImages}
            scanning={scanning}
            scanResults={scanResults}
            onScan={handleScanImages}
            elapsedTime={elapsedTime}
            endTime={endTime}
            startTime={startTime}
          />
        )}
      </main>

      <footer className="border-t border-neutral-800 py-4">
        <p className="text-center text-xs text-neutral-600">
          PDF Prune — 基于 Tauri + Rust + React 构建
        </p>
      </footer>
    </div>
  );
}

function RemoveImagesTab({
  removingImages,
  result,
  error,
  progress,
  targetSizes,
  setTargetSizes,
  yMin,
  yMax,
  setYMin,
  setYMax,
  onProcess,
  onReset,
  scanning,
  scanResults,
  onScan,
  elapsedTime,
  endTime,
  startTime,
}: {
  removingImages: boolean;
  result: RemoveImagesResult | null;
  error: string | null;
  progress: { pct: number; msg: string } | null;
  targetSizes: ImageSize[];
  setTargetSizes: (v: ImageSize[]) => void;
  yMin: number;
  yMax: number;
  setYMin: (v: number) => void;
  setYMax: (v: number) => void;
  onProcess: () => void;
  onReset: () => void;
  scanning: boolean;
  scanResults: ImageInfo[] | null;
  onScan: () => void;
  elapsedTime: number;
  endTime: number | null;
  startTime: number | null;
}) {
  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-red-950/40 border border-red-800/50 text-red-200">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-sm">处理失败</p>
            <p className="text-xs mt-1 text-red-300/80">{error}</p>
          </div>
        </div>
      )}

      {/* Empty state / input form */}
      {!result && !removingImages && (
        <div className="flex flex-col items-center justify-center min-h-[60vh]">
          <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-orange-500/20 to-red-600/20 border border-neutral-800 flex items-center justify-center mb-6">
            <ImageMinus className="w-12 h-12 text-neutral-400" />
          </div>
          <h2 className="text-xl font-bold mb-2">移除PDF中指定尺寸的图片</h2>
          <p className="text-neutral-400 text-sm mb-8 text-center max-w-lg">
            根据图片的像素尺寸和纵向坐标范围，移除 PDF 每页中匹配的图片
          </p>

          <div className="w-full max-w-2xl space-y-5">
            {/* Scan button */}
            <button
              onClick={onScan}
              disabled={scanning}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 transition-colors text-sm font-medium disabled:opacity-50"
            >
              {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageMinus className="w-4 h-4" />}
              {scanning ? `正在扫描... (${formatDuration(elapsedTime)})` : "扫描 PDF 中所有图片"}
            </button>

            {/* Scan results */}
            {scanResults && !scanning && (
              <div className="rounded-xl bg-neutral-800/30 border border-neutral-700/50 p-4 max-h-80 overflow-y-auto">
                <div className="text-xs text-neutral-400 mb-2">
                  共找到 {scanResults.length} 张图片
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-neutral-500 border-b border-neutral-700">
                      <th className="text-left py-1.5 pr-3">页码</th>
                      <th className="text-left py-1.5 pr-3">名称</th>
                      <th className="text-right py-1.5 pr-3">尺寸 (px)</th>
                      <th className="text-right py-1.5 pr-3">X</th>
                      <th className="text-right py-1.5">Y</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanResults.map((img, i) => (
                      <tr key={i} className="border-b border-neutral-800/50 hover:bg-neutral-800/30 cursor-pointer"
                        onClick={() => {
                          const existing = targetSizes.find(s => s.width === img.width && s.height === img.height);
                          if (!existing) {
                            setTargetSizes([...targetSizes, { width: img.width, height: img.height }]);
                          }
                        }}
                      >
                        <td className="py-1.5 pr-3 text-neutral-400">{img.page}</td>
                        <td className="py-1.5 pr-3 text-neutral-300 font-mono">/{img.name}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-neutral-300">{img.width}×{img.height}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-neutral-400">{img.x.toFixed(1)}</td>
                        <td className="py-1.5 text-right font-mono text-neutral-400">{img.y.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-neutral-600 mt-2">
                  点击行可将该尺寸添加到下方列表
                </p>
              </div>
            )}

            {/* Target dimensions */}
            <div>
              <label className="block text-sm text-neutral-300 mb-2">
                目标图片像素尺寸（可添加多组）
              </label>
              <div className="space-y-2">
                {targetSizes.map((size, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <div className="flex-1">
                      <input
                        type="number"
                        min={0}
                        value={size.width || ""}
                        onChange={(e) => {
                          const next = [...targetSizes];
                          next[idx] = { ...next[idx], width: Number(e.target.value) };
                          setTargetSizes(next);
                        }}
                        placeholder="宽 (px)"
                        className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    <div className="text-neutral-500">×</div>
                    <div className="flex-1">
                      <input
                        type="number"
                        min={0}
                        value={size.height || ""}
                        onChange={(e) => {
                          const next = [...targetSizes];
                          next[idx] = { ...next[idx], height: Number(e.target.value) };
                          setTargetSizes(next);
                        }}
                        placeholder="高 (px)"
                        className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    {targetSizes.length > 1 && (
                      <button
                        onClick={() => setTargetSizes(targetSizes.filter((_, i) => i !== idx))}
                        className="p-2 rounded-lg bg-neutral-800 hover:bg-red-900/50 text-neutral-400 hover:text-red-400 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={() => setTargetSizes([...targetSizes, { width: 0, height: 0 }])}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-400 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  添加尺寸
                </button>
              </div>
            </div>

            {/* Y coordinate range */}
            <div>
              <label className="block text-sm text-neutral-300 mb-2">
                纵向坐标范围 (Y)
              </label>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-xs text-neutral-500 mb-1">Y 最小值</div>
                  <input
                    type="number"
                    value={yMin}
                    onChange={(e) => setYMin(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="text-neutral-500 pt-5">~</div>
                <div className="flex-1">
                  <div className="text-xs text-neutral-500 mb-1">Y 最大值</div>
                  <input
                    type="number"
                    value={yMax}
                    onChange={(e) => setYMax(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
              <p className="text-xs text-neutral-600 mt-2">
                PDF 坐标系原点在左下角，Y 轴向上递增
              </p>
            </div>

            <button
              onClick={onProcess}
              disabled={!targetSizes.some(s => s.width > 0 && s.height > 0)}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-orange-600 hover:bg-orange-500 transition-colors font-medium text-white shadow-lg shadow-orange-600/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FolderOpen className="w-5 h-5" />
              选择 PDF 文件并处理
            </button>
          </div>
        </div>
      )}

      {/* Processing state */}
      {removingImages && (
        <div className="flex flex-col items-center justify-center min-h-[60vh]">
          <div className="w-full max-w-md space-y-6">
            <div className="flex flex-col items-center">
              <Loader2 className="w-10 h-10 text-orange-500 animate-spin mb-4" />
              <p className="text-neutral-300 text-sm font-medium">
                {progress?.msg || "正在处理..."}
              </p>
              <p className="text-neutral-500 text-xs mt-1">
                正在扫描每页内容流，移除匹配的图片
              </p>
              <p className="text-neutral-500 text-xs mt-1">
                已用时 {formatDuration(elapsedTime)}
              </p>
            </div>
            <div className="w-full">
              <div className="flex items-center justify-between text-xs text-neutral-400 mb-2">
                <span>进度</span>
                <span className="font-mono">{progress?.pct || 0}%</span>
              </div>
              <div className="h-2 rounded-full bg-neutral-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-orange-500 to-red-500 transition-all duration-300 ease-out"
                  style={{ width: `${progress?.pct || 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Result */}
      {result && !removingImages && (
        <div className="rounded-2xl bg-gradient-to-br from-green-950/30 to-neutral-900/50 border border-green-800/30 p-6">
          <div className="flex items-center gap-3 mb-5">
            <CheckCircle2 className="w-6 h-6 text-green-400" />
            <h3 className="font-bold text-base">移除完成</h3>
          </div>

          <div className="grid grid-cols-4 gap-4 mb-5">
            <div className="text-center p-4 rounded-xl bg-neutral-800/30">
              <div className="text-xs text-neutral-500 mb-1">原始大小</div>
              <div className="text-lg font-bold font-mono">
                {formatSize(result.original_size)}
              </div>
            </div>
            <div className="text-center p-4 rounded-xl bg-neutral-800/30">
              <div className="text-xs text-neutral-500 mb-1">输出大小</div>
              <div className="text-lg font-bold font-mono text-green-400">
                {formatSize(result.output_size)}
              </div>
            </div>
            <div className="text-center p-4 rounded-xl bg-orange-950/30 border border-orange-800/30">
              <div className="text-xs text-neutral-500 mb-1">移除图片</div>
              <div className="text-lg font-bold font-mono text-orange-400">
                {result.images_removed}
              </div>
            </div>
            <div className="text-center p-4 rounded-xl bg-neutral-800/30">
              <div className="text-xs text-neutral-500 mb-1">影响页数</div>
              <div className="text-lg font-bold font-mono">
                {result.pages_affected}
              </div>
            </div>
          </div>

          {result.actions.length > 0 && (
            <div className="mb-5">
              <h4 className="text-sm font-medium mb-3 text-neutral-300">操作详情：</h4>
              <div className="max-h-48 overflow-y-auto space-y-2">
                {result.actions.map((action, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-sm text-neutral-300"
                  >
                    <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                    {action}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 p-3 rounded-xl bg-neutral-800/30 mb-5">
            <Download className="w-4 h-4 text-neutral-400 flex-shrink-0" />
            <span className="text-sm text-neutral-300 truncate flex-1">
              {result.output_path}
            </span>
          </div>

          {endTime && startTime && (
            <div className="text-xs text-neutral-500 mb-4 text-right">
              总用时 {formatDuration(Math.floor((endTime - startTime) / 1000))}
            </div>
          )}

          <button
            onClick={onReset}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 transition-colors font-medium"
          >
            <RotateCcw className="w-5 h-5" />
            处理另一个文件
          </button>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="rounded-xl bg-neutral-900/50 border border-neutral-800 p-4">
      <div className={`mb-2 ${color}`}>{icon}</div>
      <div className="text-xs text-neutral-500 mb-1">{label}</div>
      <div className="text-lg font-bold font-mono">{value}</div>
    </div>
  );
}

export default App;
