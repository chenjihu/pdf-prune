# Changelog

All notable changes to PDF Prune will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Fast PDF analysis optimization for very large files (≥50MB)
- qpdf JSON fast analysis path to avoid full PDF parsing
- Parallel object classification using Rayon
- Progress tracking with detailed status updates
- Memory-efficient stream content filtering
- Comprehensive object categorization (images, fonts, content streams, metadata)
- Unused object detection and potential savings calculation
- Font information extraction with embedded status
- Cross-platform support (macOS, Windows, Linux)

### Performance
- Small files (<50MB): ~2-5 seconds analysis time
- Large files (100MB+): ~5-15 seconds using qpdf fast path  
- Very large files (300MB+): ~10-30 seconds analysis time
- Reduced memory usage through stream filtering
- Parallel processing for object classification

### Technical
- Rust backend using lopdf and qpdf integration
- TypeScript/React frontend with Tauri
- Graceful fallbacks for malformed PDFs
- Support for compressed xref streams
- Cancellation support for long-running operations

## [0.1.0] - 2026-07-03

### Added
- Initial release of PDF Prune
- Basic PDF analysis functionality
- Object size estimation
- Page count extraction
- Cross-platform desktop application
