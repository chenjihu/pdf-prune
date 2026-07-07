export interface ComponentInfo {
  name: string;
  count: number;
  size: number;
  description: string;
}

export interface FontInfo {
  name: string;
  subtype: string;
  size: number;
  embedded: boolean;
  object_id: string;
}

export interface PdfAnalysis {
  file_path: string;
  file_size: number;
  page_count: number;
  pdf_version: string;
  components: ComponentInfo[];
  fonts: FontInfo[];
  total_object_count: number;
  unused_object_count: number;
  potential_savings: number;
}

export interface PruneOptions {
  remove_unused_objects: boolean;
  remove_metadata: boolean;
  remove_xmp_metadata: boolean;
  remove_embedded_files: boolean;
  remove_javascript: boolean;
  remove_thumbnails: boolean;
  remove_annotations: boolean;
  remove_structure_tree: boolean;
  compress_streams: boolean;
  remove_page_labels: boolean;
  remove_piece_info: boolean;
  remove_mark_info: boolean;
}

export interface PruneResult {
  output_path: string;
  original_size: number;
  pruned_size: number;
  savings: number;
  savings_percent: number;
  actions: string[];
}

export const DEFAULT_PRUNE_OPTIONS: PruneOptions = {
  remove_unused_objects: true,
  remove_metadata: true,
  remove_xmp_metadata: true,
  remove_embedded_files: true,
  remove_javascript: true,
  remove_thumbnails: true,
  remove_annotations: false,
  remove_structure_tree: false,
  compress_streams: true,
  remove_page_labels: true,
  remove_piece_info: true,
  remove_mark_info: false,
};

export const PRUNE_OPTION_LABELS: { key: keyof PruneOptions; label: string; description: string; safe: boolean }[] = [
  { key: "remove_unused_objects", label: "移除未使用对象", description: "删除孤立的、未被任何页面或目录引用的对象", safe: true },
  { key: "compress_streams", label: "压缩未压缩流", description: "使用FlateDecode压缩未压缩的内容流（不处理图片和字体）", safe: true },
  { key: "remove_metadata", label: "清空文档信息", description: "移除作者、标题、关键词等Info字典字段", safe: true },
  { key: "remove_xmp_metadata", label: "移除XMP元数据", description: "删除XMP元数据流（XML格式的元数据）", safe: true },
  { key: "remove_javascript", label: "移除JavaScript", description: "删除文档中的JavaScript脚本和打开时动作", safe: true },
  { key: "remove_embedded_files", label: "移除嵌入附件", description: "删除PDF中嵌入的文件附件", safe: true },
  { key: "remove_thumbnails", label: "移除页面缩略图", description: "删除页面内嵌的缩略图图像", safe: true },
  { key: "remove_page_labels", label: "移除页面标签", description: "删除自定义页面编号标签", safe: true },
  { key: "remove_piece_info", label: "移除PieceInfo", description: "删除应用程序专有数据", safe: true },
  { key: "remove_annotations", label: "移除注释", description: "删除页面上的注释（高亮、批注等）", safe: false },
  { key: "remove_structure_tree", label: "移除结构树", description: "删除标签化PDF的结构树（影响无障碍访问）", safe: false },
  { key: "remove_mark_info", label: "移除标记信息", description: "删除标记信息（影响无障碍访问）", safe: false },
];

export interface ImageSize {
  width: number;
  height: number;
}

export interface RemoveImagesResult {
  output_path: string;
  original_size: number;
  output_size: number;
  images_removed: number;
  pages_affected: number;
  actions: string[];
}

export interface ImageInfo {
  page: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  object_id: string;
  ctm_a: number;
  ctm_b: number;
  ctm_c: number;
  ctm_d: number;
  ctm_e: number;
  ctm_f: number;
  mediabox: number[];
  raw_ops: string[];
}

export interface ExtractedImageInfo {
  id: string;
  page: number;
  name: string;
  object_id: string;
  width: number;
  height: number;
  file_size: number;
  pdf_size: number;
  format: string;
  color_space: string;
  bits_per_component: number;
  temp_path: string;
  preview_path: string;
  supported: boolean;
}

export interface CompressedImageEntry {
  object_id: string;
  temp_path: string;
  format: string;
  width: number;
  height: number;
  original_size?: number;
}

export interface CompressImagesResult {
  output_path: string;
  original_size: number;
  output_size: number;
  images_compressed: number;
  actions: string[];
}

export interface CompressedImagePreview {
  object_id: string;
  original_size: number;
  compressed_size: number;
  temp_path: string;
  compressed_preview_path: string;
  format: string;
  width: number;
  height: number;
}
