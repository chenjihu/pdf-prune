# PDF Prune Architecture

This document describes the architecture and design decisions of PDF Prune.

## Overview

PDF Prune is a cross-platform desktop application built with Tauri (Rust backend + web frontend) designed to analyze PDF files efficiently, especially very large files that would be slow to process with traditional PDF libraries.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (TypeScript/React)              │
├─────────────────────────────────────────────────────────────┤
│  • File selection UI                                        │
│  • Progress visualization                                   │
│  • Results display                                          │
│  • Tauri API calls                                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ Tauri IPC
┌─────────────────────────────────────────────────────────────┐
│                     Backend (Rust)                          │
├─────────────────────────────────────────────────────────────┤
│  • PDF analysis engine                                      │
│  • External tool integration (qpdf, pdfinfo)               │
│  • Parallel processing                                      │
│  • Memory management                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   External Tools                             │
├─────────────────────────────────────────────────────────────┤
│  • qpdf: Large PDF optimization                             │
│  • pdfinfo: Page count extraction                           │
│  • lopdf: PDF parsing (small files)                         │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### Backend Modules

#### `analysis.rs` - Core PDF Analysis
- **`analyze_pdf()`**: Main entry point, routes to appropriate analysis method
- **`analyze_with_qpdf()`**: Fast analysis for large files (≥50MB)
- **`analyze_with_lopdf()`**: Traditional analysis for smaller files
- **Object classification and size estimation**
- **Reference graph traversal for unused object detection**

#### `prune.rs` - PDF Optimization
- **Unused object removal**
- **PDF restructuring**
- **Size optimization**

#### `remove_images.rs` - Image Processing
- **Image extraction and analysis**
- **Image compression options**
- **Format conversion**

#### `lib.rs` - Tauri Command Handlers
- **IPC interface between frontend and backend**
- **Command registration and error handling**
- **Progress reporting coordination**

### Frontend Components

#### Main Application Flow
1. **File Selection**: Drag & drop or file picker
2. **Analysis Initiation**: Send file path to backend
3. **Progress Tracking**: Real-time updates via Tauri events
4. **Results Display**: Object categories, sizes, recommendations

#### UI Components
- File selector component
- Progress bar with detailed status
- Results table with sorting/filtering
- Font information viewer

## Performance Optimization Strategy

### Dual-Path Analysis

#### Small Files (< 50MB) - lopdf Path
```rust
Document::load_filtered() → Object traversal → Classification
```
- Uses lopdf library with stream filtering
- Full PDF parsing with reduced memory usage
- Traditional reference graph traversal

#### Large Files (≥ 50MB) - qpdf Fast Path
```rust
qpdf --json → Object metadata extraction → BFS traversal → Classification
```
- Avoids full PDF parsing
- Uses qpdf JSON output for object metadata
- Faster processing with slightly less precision

### Memory Management

#### Stream Content Filtering
```rust
let filter_func = |obj: &Object| {
    match obj {
        Object::Stream(stream) => {
            // Clear content to avoid holding large binary data
            stream.content.clear();
            Some((id, Object::Null))
        }
        _ => None
    }
};
```

#### Parallel Processing
- Rayon for concurrent object classification
- Chunked processing (500 objects per chunk)
- Progress reporting every 2000 objects

### Temporary File Management
- Automatic cleanup with `tempfile::NamedTempFile`
- qpdf normalization for problematic PDFs
- JSON output caching for repeated analyses

## Data Flow

### Analysis Pipeline
```
PDF File → Size Check → Analysis Path Selection → Object Extraction → 
Reference Graph → BFS Traversal → Classification → Size Estimation → 
Results Generation → Frontend Display
```

### Object Classification Logic
```rust
match object_type {
    Image => Images category,
    Font => Fonts category,
    ContentStream => Content Streams category,
    FormXObject => Form Objects category,
    Metadata => Metadata category,
    _ => Other Objects category
}
```

## Error Handling Strategy

### Graceful Degradation
1. **Primary method fails** → Try alternative method
2. **lopdf parsing fails** → Use qpdf normalization
3. **qpdf fails** → Fall back to pdfinfo for basic info
4. **All methods fail** → Provide meaningful error message

### Error Types
- **File I/O errors**: Permission issues, missing files
- **PDF parsing errors**: Malformed PDFs, encryption
- **External tool errors**: qpdf/pdfinfo not installed
- **Memory errors**: Insufficient memory for large files

## External Dependencies

### qpdf Integration
- **Purpose**: Large PDF optimization and normalization
- **Usage**: `qpdf --json --decode-level=none --json-object=*`
- **Fallback**: Handle exit code 3 (warnings) gracefully

### pdfinfo Integration
- **Purpose**: Reliable page count extraction
- **Usage**: Parse "Pages:" line from output
- **Fallback**: Essential for compressed xref streams

### lopdf Library
- **Purpose**: PDF parsing and manipulation
- **Features**: Stream filtering, object traversal
- **Limitations**: Slow for very large files with complex xref streams

## Performance Characteristics

### Benchmarks
- **Small files (< 10MB)**: 1-3 seconds
- **Medium files (10-50MB)**: 3-8 seconds  
- **Large files (50-200MB)**: 8-20 seconds
- **Very large files (200MB+)**: 20-45 seconds

### Memory Usage
- **Small files**: 50-200MB peak
- **Large files**: 200-500MB peak
- **Very large files**: 500MB-1GB peak (with qpdf fast path)

## Future Architecture Considerations

### Potential Improvements
1. **Streaming Analysis**: Process PDFs in chunks without full loading
2. **Caching Layer**: Cache analysis results for repeated files
3. **Batch Processing**: Handle multiple files concurrently
4. **Cloud Processing**: Offload very large files to cloud service

### Scalability
- **Multi-threading**: Already implemented with Rayon
- **Memory Optimization**: Stream filtering and temporary files
- **I/O Optimization**: Async file operations where beneficial

## Security Considerations

### File Handling
- **Temporary files**: Secure creation and cleanup
- **Path validation**: Prevent path traversal attacks
- **Memory limits**: Prevent DoS via malformed files

### External Tools
- **Input validation**: Sanitize file paths before passing to tools
- **Output parsing**: Validate tool outputs before processing
- **Error handling**: Prevent information leakage via error messages

## Testing Strategy

### Unit Tests
- Object classification logic
- Size estimation algorithms
- Reference parsing utilities

### Integration Tests
- End-to-end analysis pipeline
- External tool integration
- Error handling scenarios

### Performance Tests
- Large file processing benchmarks
- Memory usage profiling
- Concurrent operation testing

This architecture enables PDF Prune to handle very large PDF files efficiently while maintaining accuracy and providing a responsive user experience.
