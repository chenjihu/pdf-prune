use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Clone, Serialize)]
pub struct RuntimeDependency {
    pub key: String,
    pub name: String,
    pub command: String,
    pub present: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub purpose: String,
    pub install_hint: String,
}

#[derive(Clone, Serialize)]
pub struct RuntimeDependencyCheck {
    pub platform: String,
    pub has_missing_required: bool,
    pub install_command: String,
    pub dependencies: Vec<RuntimeDependency>,
}

struct DependencySpec {
    key: &'static str,
    name: &'static str,
    command: &'static str,
    version_args: &'static [&'static str],
    candidates: &'static [&'static str],
    purpose: &'static str,
    install_hint: &'static str,
}

const QPDF_CANDIDATES: &[&str] = &[
    "qpdf",
    "/opt/homebrew/bin/qpdf",
    "/usr/local/bin/qpdf",
    "/usr/bin/qpdf",
    r"C:\Program Files\qpdf\bin\qpdf.exe",
];

const PDFIMAGES_CANDIDATES: &[&str] = &[
    "pdfimages",
    "/opt/homebrew/bin/pdfimages",
    "/usr/local/bin/pdfimages",
    "/usr/bin/pdfimages",
];

const PDFINFO_CANDIDATES: &[&str] = &[
    "pdfinfo",
    "/opt/homebrew/bin/pdfinfo",
    "/usr/local/bin/pdfinfo",
    "/usr/bin/pdfinfo",
];

const DEPENDENCIES: &[DependencySpec] = &[
    DependencySpec {
        key: "qpdf",
        name: "qpdf",
        command: "qpdf",
        version_args: &["--version"],
        candidates: QPDF_CANDIDATES,
        purpose: "快速分析 PDF、优化对象流、快速回写压缩后的图片",
        install_hint: "macOS: brew install qpdf；Ubuntu/Debian: sudo apt-get install qpdf；Windows: 安装 qpdf 并加入 PATH",
    },
    DependencySpec {
        key: "pdfimages",
        name: "Poppler pdfimages",
        command: "pdfimages",
        version_args: &["-v"],
        candidates: PDFIMAGES_CANDIDATES,
        purpose: "快速列出并提取 PDF 中的图片",
        install_hint: "macOS: brew install poppler；Ubuntu/Debian: sudo apt-get install poppler-utils；Windows: 安装 Poppler 并加入 PATH",
    },
    DependencySpec {
        key: "pdfinfo",
        name: "Poppler pdfinfo",
        command: "pdfinfo",
        version_args: &["-v"],
        candidates: PDFINFO_CANDIDATES,
        purpose: "读取页数和基础 PDF 信息",
        install_hint: "macOS: brew install poppler；Ubuntu/Debian: sudo apt-get install poppler-utils；Windows: 安装 Poppler 并加入 PATH",
    },
];

fn platform_install_command() -> String {
    if cfg!(target_os = "macos") {
        "brew install qpdf poppler".to_string()
    } else if cfg!(target_os = "linux") {
        "sudo apt-get install qpdf poppler-utils".to_string()
    } else if cfg!(target_os = "windows") {
        "安装 qpdf 和 Poppler，并将 qpdf、pdfimages、pdfinfo 加入 PATH".to_string()
    } else {
        "请安装 qpdf 和 Poppler，并将 qpdf、pdfimages、pdfinfo 加入 PATH".to_string()
    }
}

fn normalize_version_output(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn check_dependency(spec: &DependencySpec) -> RuntimeDependency {
    for candidate in spec.candidates {
        let output = Command::new(candidate).args(spec.version_args).output();
        let Ok(output) = output else {
            continue;
        };

        let version = normalize_version_output(&output.stdout)
            .or_else(|| normalize_version_output(&output.stderr));
        let path = if candidate.contains(std::path::MAIN_SEPARATOR) || candidate.contains('\\') {
            Some(candidate.to_string())
        } else {
            resolve_from_path(candidate)
        };

        return RuntimeDependency {
            key: spec.key.to_string(),
            name: spec.name.to_string(),
            command: spec.command.to_string(),
            present: true,
            path,
            version,
            purpose: spec.purpose.to_string(),
            install_hint: spec.install_hint.to_string(),
        };
    }

    RuntimeDependency {
        key: spec.key.to_string(),
        name: spec.name.to_string(),
        command: spec.command.to_string(),
        present: false,
        path: None,
        version: None,
        purpose: spec.purpose.to_string(),
        install_hint: spec.install_hint.to_string(),
    }
}

fn resolve_from_path(command: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(path_to_string(candidate));
        }

        #[cfg(target_os = "windows")]
        {
            let candidate = dir.join(format!("{}.exe", command));
            if candidate.is_file() {
                return Some(path_to_string(candidate));
            }
        }
    }
    None
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

pub fn check_runtime_dependencies() -> RuntimeDependencyCheck {
    let dependencies: Vec<RuntimeDependency> = DEPENDENCIES.iter().map(check_dependency).collect();
    let has_missing_required = dependencies.iter().any(|dependency| !dependency.present);

    RuntimeDependencyCheck {
        platform: std::env::consts::OS.to_string(),
        has_missing_required,
        install_command: platform_install_command(),
        dependencies,
    }
}
