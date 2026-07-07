export function formatSize(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  const absBytes = Math.abs(bytes);
  if (absBytes < 1024) return `${sign}${absBytes} B`;
  if (absBytes < 1024 * 1024) return `${sign}${(absBytes / 1024).toFixed(1)} KB`;
  if (absBytes < 1024 * 1024 * 1024) return `${sign}${(absBytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${sign}${(absBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatPercent(value: number, total: number): string {
  if (total === 0) return "0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

const COMPONENT_COLORS: Record<string, string> = {
  "图片": "#ef4444",
  "嵌入字体": "#f59e0b",
  "内容流": "#3b82f6",
  "表单X对象": "#8b5cf6",
  "元数据": "#6b7280",
  "其他流对象": "#ec4899",
  "结构对象": "#10b981",
  "未使用对象": "#f97316",
};

export function getComponentColor(name: string): string {
  return COMPONENT_COLORS[name] || "#6b7280";
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) {
    return `${m}分${s.toString().padStart(2, "0")}秒`;
  }
  return `${s}秒`;
}
