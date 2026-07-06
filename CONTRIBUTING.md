# Contributing to PDF Prune

Thank you for your interest in contributing to PDF Prune! This document provides guidelines and information for contributors.

## Development Setup

### Prerequisites
- Node.js (v18+)
- Rust (latest stable)
- qpdf (for large file optimization)
- pdfinfo (for page count extraction)

### Setup Steps
1. Fork the repository
2. Clone your fork locally
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run in development mode:
   ```bash
   npm run tauri dev
   ```

## Project Structure

```
pdf-prune/
├── src/                    # Frontend (React/TypeScript)
│   ├── components/         # React components
│   ├── utils.ts           # Utility functions
│   └── App.tsx            # Main application
├── src-tauri/             # Backend (Rust)
│   ├── src/
│   │   ├── analysis.rs    # Core PDF analysis logic
│   │   ├── prune.rs       # PDF pruning functionality
│   │   ├── remove_images.rs # Image removal operations
│   │   └── lib.rs         # Tauri command handlers
│   └── Cargo.toml         # Rust dependencies
├── README.md
├── LICENSE
└── CHANGELOG.md
```

## Code Style

### Rust
- Use `rustfmt` for formatting
- Follow Rust naming conventions
- Add comments for complex algorithms
- Use `Result<T, String>` for error handling

### TypeScript/React
- Use Prettier for formatting
- Follow TypeScript best practices
- Use functional components with hooks
- Add JSDoc comments for public functions

## Testing

### Running Tests
```bash
# Rust tests
cd src-tauri && cargo test

# Frontend tests (if added)
npm test
```

### Test Files
- Add unit tests for new Rust functions
- Test edge cases for PDF parsing
- Verify performance with large files

## Submitting Changes

### Branch Naming
- Use descriptive branch names: `feature/your-feature-name`
- For bug fixes: `fix/description-of-issue`
- For performance: `perf/optimization-description`

### Commit Messages
Follow conventional commits format:
- `feat:` for new features
- `fix:` for bug fixes
- `perf:` for performance improvements
- `docs:` for documentation changes
- `refactor:` for code refactoring

Example:
```
feat: add PDF metadata extraction
fix: handle compressed xref streams correctly
perf: optimize large file analysis with qpdf
```

### Pull Request Process
1. Update documentation if needed
2. Add tests for new functionality
3. Ensure all tests pass
4. Update CHANGELOG.md
5. Create pull request with clear description

## Areas for Contribution

### Performance
- Optimize memory usage for very large PDFs
- Improve parallel processing efficiency
- Add caching for repeated analyses

### Features
- PDF compression options
- Batch processing for multiple files
- Export analysis results to JSON/CSV
- Visual PDF structure viewer

### UI/UX
- Progress visualization improvements
- Dark mode support
- Keyboard shortcuts
- Drag-and-drop enhancements

### Bug Fixes
- Edge cases for malformed PDFs
- Better error messages
- Memory leak fixes
- Cross-platform compatibility

## Development Guidelines

### PDF Processing
- Always validate PDF structure before processing
- Handle both compressed and uncompressed xref streams
- Provide meaningful error messages
- Consider memory usage for large files

### Performance Considerations
- Use streaming for large file operations
- Implement proper cleanup for temporary files
- Consider parallel processing for CPU-intensive tasks
- Profile with large PDF files (100MB+)

### Error Handling
- Use Result types for recoverable errors
- Provide user-friendly error messages
- Log technical details for debugging
- Graceful degradation for unsupported features

## Code Review Process

### What Reviewers Look For
- Code follows project style guidelines
- Tests are included and passing
- Documentation is updated
- Performance impact is considered
- Error handling is robust

### Reviewer Guidelines
- Provide constructive feedback
- Explain reasoning for suggested changes
- Approve once all concerns are addressed
- Be responsive to author questions

## Getting Help

### Questions
- Open an issue with the `question` label
- Check existing issues and discussions
- Review documentation and code comments

### Bug Reports
- Use the bug report template
- Include sample files if possible
- Provide system information
- Describe steps to reproduce

### Feature Requests
- Open an issue with the `enhancement` label
- Describe the use case
- Consider implementation approach
- Discuss potential trade-offs

## Release Process

### Version Management
- Follow semantic versioning
- Update CHANGELOG.md for each release
- Tag releases in Git
- Update version numbers in package.json and Cargo.toml

### Release Checklist
- [ ] All tests pass
- [ ] Documentation is updated
- [ ] CHANGELOG.md is current
- [ ] Version numbers are updated
- [ ] Build and test release artifacts

## Community

### Code of Conduct
- Be respectful and inclusive
- Welcome contributors of all experience levels
- Provide helpful and constructive feedback
- Focus on what is best for the community

### Communication
- Use GitHub issues for bug reports and features
- Join discussions in existing issues
- Ask questions in issues rather than email
- Share knowledge and help others

Thank you for contributing to PDF Prune!
