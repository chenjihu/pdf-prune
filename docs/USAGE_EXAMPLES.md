# Usage Examples

This document provides practical examples of using PDF Prune for different scenarios.

## Basic Usage

### Analyzing a Small PDF File
```
File: document.pdf (15MB, 120 pages)
Expected Analysis Time: 2-5 seconds

Steps:
1. Launch PDF Prune
2. Click "Select PDF File" or drag & drop document.pdf
3. Wait for analysis to complete
4. Review results:
   - Images: 45 objects, 8.2MB
   - Fonts: 12 objects, 2.1MB  
   - Content Streams: 120 objects, 4.5MB
   - Unused Objects: 3 objects, 0.3MB
```

### Analyzing a Large PDF File
```
File: large_report.pdf (250MB, 1500 pages)
Expected Analysis Time: 15-25 seconds

Steps:
1. Launch PDF Prune
2. Select large_report.pdf
3. Notice "Using qpdf fast analysis" in progress
4. Review comprehensive analysis:
   - Images: 850 objects, 180MB
   - Fonts: 45 objects, 15MB
   - Content Streams: 1500 objects, 45MB
   - Unused Objects: 120 objects, 10MB
   - Potential Savings: 10MB (4% reduction)
```

## Advanced Scenarios

### Scenario 1: PDF with Many Unused Images
**Problem**: PDF contains high-resolution images that were replaced but not removed

**Symptoms**:
- Large file size
- High "Unused Objects" count
- Images category shows significant unused portion

**Example Results**:
```
File Size: 85MB
Pages: 340
Images: 120 objects, 65MB (45 objects unused, 25MB)
Unused Objects: 50 objects, 28MB
Potential Savings: 28MB (33% reduction)
```

**Recommendation**: Use pruning functionality to remove unused images

### Scenario 2: PDF with Embedded Fonts
**Problem**: PDF contains many embedded fonts increasing file size

**Symptoms**:
- Large "Fonts" category
- Many font objects listed

**Example Results**:
```
File Size: 25MB
Pages: 180
Fonts: 38 objects, 12MB
- Arial-Bold: 450KB, embedded
- Times-Roman: 380KB, embedded
- CustomFont1: 2.1MB, embedded
- ...
```

**Recommendation**: Consider using system fonts instead of embedding where possible

### Scenario 3: Compressed PDF with Complex Structure
**Problem**: PDF uses compressed xref streams, causing analysis issues

**Symptoms**:
- Analysis takes longer than expected
- Page count initially shows 0, then corrects

**Example Process**:
```
1. Select compressed_document.pdf
2. Progress: "正在解析页面结构..." (longer pause)
3. Progress: "使用 pdfinfo 获取页数..." (fallback activated)
4. Analysis completes successfully
```

**Technical Note**: PDF Prune automatically falls back to pdfinfo for compressed xref streams

## Performance Examples

### File Size vs Analysis Time
```
5MB file:    1-2 seconds
25MB file:   3-6 seconds  
100MB file:  8-15 seconds
500MB file:  25-40 seconds
1GB file:    45-60 seconds
```

### Memory Usage Examples
```
Small PDF (<50MB):     50-200MB peak memory
Medium PDF (50-200MB): 200-500MB peak memory
Large PDF (>200MB):    500MB-1GB peak memory
```

## Error Handling Examples

### Common Error Messages and Solutions

#### "qpdf 执行失败 (请确认已安装 qpdf)"
**Cause**: qpdf not installed or not in PATH
**Solution**: 
```bash
# macOS
brew install qpdf

# Ubuntu/Debian  
sudo apt-get install qpdf

# Windows
# Download from https://qpdf.sourceforge.io/
# Add to PATH
```

#### "无法加载PDF文件: Parse error"
**Cause**: Corrupted or malformed PDF
**Solution**: 
- Try opening PDF in other viewers to verify corruption
- Use qpdf to attempt repair: `qpdf --repair file.pdf repaired.pdf`

#### "无法获取页数"
**Cause**: PDF with compressed xref streams, pdfinfo not available
**Solution**:
```bash
# Install poppler utilities
# macOS
brew install poppler

# Ubuntu/Debian
sudo apt-get install poppler-utils
```

## Batch Processing Workflow

While PDF Prune doesn't have built-in batch processing, you can automate analysis:

### Shell Script Example
```bash
#!/bin/bash
# Analyze all PDFs in a directory

for file in *.pdf; do
    echo "Analyzing $file..."
    # This would require PDF Prune to have CLI interface
    # pdf-prune analyze "$file" --output "$file.analysis.json"
done
```

### Integration with Other Tools

#### Using with PDF Optimization Tools
```bash
# 1. Analyze with PDF Prune
# 2. Identify optimization opportunities
# 3. Apply targeted optimizations:
#    - Remove unused images
#    - Optimize fonts
#    - Compress content streams
```

## Troubleshooting Examples

### Slow Analysis on Large Files
**Problem**: 300MB file taking 10+ minutes

**Diagnosis**:
1. Check if qpdf is installed: `qpdf --version`
2. Verify file is accessible: `ls -la large_file.pdf`
3. Check available memory: `free -h` or Activity Monitor

**Solution**: Ensure qpdf is installed for fast analysis path

### Inconsistent Results
**Problem**: Same file shows different unused object counts

**Possible Causes**:
- File being modified during analysis
- Temporary file cleanup issues
- Different analysis paths (lopdf vs qpdf)

**Solution**: Close other applications that might modify the file, re-analyze

### Memory Issues on Very Large Files
**Problem**: Out of memory errors on 1GB+ files

**Workarounds**:
1. Close other applications to free memory
2. Use qpdf fast path (ensure qpdf installed)
3. Consider splitting large PDFs if possible

## Real-World Use Cases

### Use Case 1: Document Archive Optimization
**Scenario**: Company needs to reduce storage for 10,000+ PDF documents

**Workflow**:
1. Use PDF Prune to analyze sample documents
2. Identify common optimization opportunities
3. Apply automated optimizations based on patterns
4. Achieve 20-40% storage reduction

### Use Case 2: PDF Pre-Processing
**Scenario**: Web application needs to optimize user-uploaded PDFs

**Integration**:
1. Upload PDF to server
2. Run PDF Prune analysis via command line
3. Apply optimizations based on analysis
4. Serve optimized PDF to users

### Use Case 3: Quality Assurance
**Scenario**: Publishing house needs to verify PDF structure

**Process**:
1. Analyze PDF with PDF Prune
2. Check for unused objects indicating editing issues
3. Verify font embedding consistency
4. Ensure no unexpected metadata

## Tips and Best Practices

### Before Analysis
- Close PDF in other applications
- Ensure sufficient disk space for temporary files
- Verify file permissions

### During Analysis  
- Let analysis complete without interruption
- Monitor progress for unusual delays
- Note any error messages for troubleshooting

### After Analysis
- Review "Unused Objects" category first
- Check font information for embedding issues
- Consider total file size vs component sizes

### Performance Tips
- Install qpdf for large file optimization
- Use SSD storage for better I/O performance
- Ensure sufficient RAM for very large files

These examples should help you get the most out of PDF Prune for various PDF analysis and optimization needs.
