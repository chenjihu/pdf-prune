# PDF Prune

PDF Prune 是一个基于 Tauri + Rust + React 的 PDF 分析与瘦身工具，面向大体积 PDF 的组成分析、无用对象清理、图片移除和图片压缩回写。

## 功能特性

- **PDF 组成分析**：统计文件大小、页数、PDF 版本、对象数量、图片/字体/内容流/元数据等组成。
- **PDF 瘦身**：支持移除未使用对象、元数据、XMP、附件、JavaScript、缩略图、页面标签、PieceInfo、结构树等内容。
- **指定图片移除**：按图片尺寸和页面坐标范围扫描并移除匹配图片。
- **图片提取与压缩**：
  - 从 PDF 中提取图片并生成预览。
  - 支持多线程并行提取，线程数可配置。
  - 支持 JPEG、PNG、WebP 输出。
  - 支持质量、缩放、目标最大宽度、颜色简化、黑白阈值等压缩选项。
  - 支持撤销单张、撤销选中、撤销全部图片压缩。
- **动态压缩反馈**：
  - 批量压缩时逐张更新图片列表状态。
  - 实时显示每张图片压缩后尺寸、体积、压缩比例和节省体积。
  - 动态估算 PDF 体积变化。
- **筛选与分页**：
  - 支持按原图宽高/体积、压缩后宽高/体积、页码、格式、已压缩/未压缩筛选。
  - 图片列表支持 50、100、200、500 张分页显示。
- **缓存管理**：可指定缓存目录，并清理本工具创建的缓存会话。

## 性能优化

### 大 PDF 分析

- 小文件优先使用 `lopdf` 解析。
- 大文件使用 `qpdf` JSON 快速分析，避免完整解析所有 stream。
- 使用 Rayon 并行处理对象分类。

### 图片提取

- 优先使用 Poppler 的 `pdfimages` 快速列出并导出图片。
- 如果 `pdfimages` 不可用或失败，自动回退到 Rust 兼容解析路径。
- 提取阶段支持点阵进度动画：每个小方格代表一张图片，完成后点亮。
- 预览生成按指定线程数并行执行。

### 图片回写

- 优先使用 `qpdf --update-from-json` 快速替换图片 stream，跳过 Rust 全量 PDF 解析。
- 回写失败时自动回退到 `lopdf` 兼容回写模式。
- 保存后会尝试生成对象流，降低 PDF 结构开销。
- 仅替换压缩后实际变小的图片，避免无意义地放大输出 PDF。

## 安装依赖

### 基础环境

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) stable
- npm 或 pnpm

### 外部工具

建议安装：

- `qpdf`：用于快速分析、对象流优化、图片快速回写。
- `poppler`：提供 `pdfimages`、`pdfinfo` 等工具，用于图片快速提取和 PDF 信息读取。

macOS:

```bash
brew install qpdf poppler
```

Ubuntu/Debian:

```bash
sudo apt-get install qpdf poppler-utils
```

Windows:

- 安装 qpdf：https://qpdf.sourceforge.io/download.html
- 安装 Poppler，并将 `qpdf`、`pdfimages`、`pdfinfo` 加入 `PATH`

## 开发

安装依赖：

```bash
npm install
```

启动开发模式：

```bash
npm run tauri dev
```

前端构建：

```bash
npm run build
```

Rust 检查：

```bash
cd src-tauri
cargo check
```

打包应用：

```bash
npm run tauri build
```

## 使用说明

### PDF 组成分析

1. 打开应用后进入「PDF 组成分析」。
2. 选择 PDF 文件。
3. 查看对象分类、字体、潜在节省空间等信息。
4. 根据需要选择瘦身项并导出处理后的 PDF。

### 移除 PDF 中指定图片

1. 进入「移除 PDF 中的特定图片」。
2. 扫描 PDF 中所有图片。
3. 按图片尺寸和页面 Y 坐标范围设置条件。
4. 导出移除匹配图片后的 PDF。

### 压缩 PDF 中的图片

1. 进入「压缩 PDF 中的图片」。
2. 设置图片提取线程数。
3. 选择 PDF 并提取图片。
4. 使用顶部筛选条件定位图片。
5. 选择图片并设置压缩参数。
6. 批量压缩时观察每张图片和 PDF 预估体积的动态变化。
7. 导出压缩后的 PDF。

## 图片格式说明

- `jpeg`：PDF 内部使用 DCTDecode，通常适合照片。
- `png`：提取或压缩后的 PNG 文件，适合截图、线稿、少色图片。
- `webp`：可作为压缩输出格式，但 PDF 不原生支持 WebP；回写时会转为 JPEG。
- `raw`：PDF 内部原始像素流或特殊编码，不是可直接保存的图片格式。它通常需要结合宽高、颜色空间、位深和 DecodeParms 才能还原。

## PDF 大小说明

界面中的「PDF 大小」表示图片在 PDF 内部原始 stream 中占用的空间。它可能远小于提取出来的 PNG/JPEG 临时文件。

导出时，工具会按 PDF 内部 stream 大小判断是否值得替换图片；如果压缩后的图片没有更小，会跳过替换。

## 项目结构

```text
src/
  App.tsx                         # 主界面和功能入口
  components/
    CompressImagesTab.tsx         # 图片提取、筛选、压缩、导出
    ImageDetailModal.tsx          # 单张图片预览和压缩
    ImageCompare.tsx              # 图片压缩前后对比
  lib/
    imageCompress.ts              # 前端 WASM 图片压缩逻辑
  types.ts                        # 前后端共享类型
  utils.ts                        # 格式化工具

src-tauri/
  src/
    analysis.rs                   # PDF 组成分析
    prune.rs                      # PDF 瘦身
    remove_images.rs              # 指定图片移除
    compress_images.rs            # 图片提取、缓存、回写
    lib.rs                        # Tauri command handler
  icons/                          # 应用图标资源
```

## 关键依赖

- [Tauri](https://tauri.app/)：桌面应用框架。
- [React](https://react.dev/)：前端 UI。
- [lopdf](https://github.com/J-F-Liu/lopdf)：PDF 解析和兼容回写。
- [qpdf](https://qpdf.sourceforge.io/)：快速分析、对象流优化、快速回写。
- [Poppler](https://poppler.freedesktop.org/)：图片快速提取。
- [Rayon](https://github.com/rayon-rs/rayon)：Rust 并行处理。
- [jsquash](https://github.com/jamsinclair/jSquash)：前端 JPEG/PNG/WebP WASM 编解码。

## 常见问题

### 开发模式图标没有变化

macOS 会缓存应用图标，`npm run tauri dev` 看到的 Dock 图标可能仍是旧缓存。请用正式打包结果验证：

```bash
npm run tauri build
```

然后查看：

```text
src-tauri/target/release/bundle/macos/
```

### 图片提取很慢

请确认已安装 Poppler，并且 `pdfimages` 在 `PATH` 中：

```bash
pdfimages -v
```

如果不可用，程序会回退到 Rust 兼容解析路径，速度会慢很多。

### 图片回写很慢

请确认已安装 qpdf：

```bash
qpdf --version
```

如果 qpdf 不可用或快速回写失败，程序会回退到 `lopdf` 全量解析回写，处理大 PDF 时可能耗时较长。

### 导出的 PDF 比预估体积大

界面中的 PDF 体积是按图片 stream 节省量估算。最终文件大小还会受到 PDF 对象流、交叉引用表、对象重写方式等结构开销影响，以导出后的真实大小为准。

### raw 图片是什么

`raw` 表示该图片不是 JPEG/PNG/WebP 这类可直接保存的编码，而是 PDF 内部原始图像数据或特殊编码流。部分 raw 图片可能无法压缩或只能以兼容方式处理。

## License

MIT. See [LICENSE](./LICENSE).
