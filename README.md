# PDF Prune

A fast PDF analysis and optimization tool built with Tauri and Rust. Designed to analyze large PDF files efficiently and identify unused objects for size reduction.

## Features

- **Fast PDF Analysis**: Optimized for very large PDF files (100MB+)
- **Object Classification**: Categorizes PDF objects (images, fonts, content streams, metadata)
- **Unused Object Detection**: Identifies potentially unused objects for size optimization
- **Progress Tracking**: Real-time progress updates during analysis
- **Cross-platform**: Works on macOS, Windows, and Linux

## Performance Optimizations

### Large PDF Handling
- **< 50MB**: Uses lopdf library with filtered loading
- **≥ 50MB**: Uses qpdf JSON fast analysis to avoid full PDF parsing
- **Parallel Processing**: Rayon for concurrent object classification
- **Memory Efficient**: Stream content filtering to reduce memory usage

### Analysis Speed
- Small files (< 50MB): ~2-5 seconds
- Large files (100MB+): ~5-15 seconds using qpdf fast path
- Very large files (300MB+): ~10-30 seconds

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (latest stable)
- [qpdf](https://qpdf.sourceforge.io/) (required for large file optimization)
- [pdfinfo](https://poppler.freedesktop.org/) (for reliable page count extraction)

#### Install qpdf
```bash
# macOS
brew install qpdf poppler

# Ubuntu/Debian
sudo apt-get install qpdf poppler-utils

# Windows
# Download from https://qpdf.sourceforge.io/download.html
# Add to PATH
```

### Build from Source
```bash
# Clone the repository
git clone <repository-url>
cd pdf-prune

# Install dependencies
npm install

# Build the application
npm run tauri build

# Run in development mode
npm run tauri dev
```

## Usage

1. Launch the application
2. Select a PDF file using the file picker or drag & drop
3. Wait for the analysis to complete
4. Review the analysis results:
   - File size and page count
   - Object categories and sizes
   - Unused objects and potential savings
   - Font information

## Analysis Details

### Object Categories
- **Images**: Embedded bitmap images (JPEG, PNG, etc.)
- **Fonts**: Embedded font files (Type1, TrueType, OpenType)
- **Content Streams**: Page drawing instructions (text, vector graphics)
- **Form Objects**: Form XObjects
- **Metadata**: Document information and metadata
- **Other Objects**: Dictionaries, arrays, references, etc.
- **Unused Objects**: Objects not reachable from the document root

### Font Information
- Font name and subtype
- Embedded status and size
- Object ID for reference

## Architecture

### Backend (Rust)
- `src-tauri/src/analysis.rs`: Core PDF analysis logic
- `src-tauri/src/prune.rs`: PDF pruning functionality
- `src-tauri/src/remove_images.rs`: Image removal operations
- `src-tauri/src/lib.rs`: Tauri command handlers

### Frontend (TypeScript/React)
- `src/`: React components and UI
- `src/utils.ts`: Utility functions
- Tauri APIs for backend communication

### Key Libraries
- **lopdf**: PDF parsing and manipulation
- **qpdf**: External tool for large PDF optimization
- **rayon**: Parallel processing
- **serde**: JSON serialization
- **tauri**: Cross-platform desktop framework

## Technical Notes

### Large File Optimization
For files ≥ 50MB, the application uses qpdf's JSON output to:
1. Extract object metadata without full parsing
2. Build object reference graphs
3. Perform BFS traversal for reachability analysis
4. Categorize objects based on type and usage

### Memory Management
- Stream content filtering to avoid loading large binary data
- Parallel processing with controlled memory usage
- Temporary file cleanup for qpdf operations

### Error Handling
- Graceful fallbacks for malformed PDFs
- Progress cancellation support
- Comprehensive error reporting

## Troubleshooting

### Common Issues

**"qpdf 执行失败"**
- Install qpdf and ensure it's in your PATH
- Check file permissions

**"无法获取页数"**
- Ensure pdfinfo is installed
- Some PDFs with compressed xref streams may need qpdf fallback

**Analysis takes too long**
- For very large files, ensure qpdf is installed
- Check available memory and disk space

### Debug Mode
Enable debug logging by setting environment variable:
```bash
export RUST_LOG=debug
npm run tauri dev
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- [lopdf](https://github.com/J-F-Liu/lopdf) for PDF parsing
- [qpdf](https://qpdf.sourceforge.io/) for PDF optimization
- [Tauri](https://tauri.app/) for the desktop framework
- [Rayon](https://github.com/rayon-rs/rayon) for parallel processing
