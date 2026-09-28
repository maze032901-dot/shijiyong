#!/bin/zsh
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Mac 处理器首版只支持 macOS。" >&2
  exit 1
fi
command -v ffmpeg >/dev/null || { echo "请先安装 ffmpeg。" >&2; exit 1; }

python_command="${HERMES_SETUP_PYTHON:-}"
if [[ -z "$python_command" ]]; then
  for candidate in python3.11 python3.12 python3.13 python3.10; do
    if command -v "$candidate" >/dev/null; then python_command="$candidate"; break; fi
  done
fi
if [[ -z "$python_command" ]] || ! command -v "$python_command" >/dev/null; then
  echo "请安装 Python 3.10–3.13；当前 F2 依赖不支持 Python 3.14。也可设置 HERMES_SETUP_PYTHON。" >&2
  exit 1
fi
if ! "$python_command" -c 'import sys; assert (3,10) <= sys.version_info[:2] <= (3,13)' 2>/dev/null; then
  echo "当前 F2 依赖只支持 Python 3.10–3.13。" >&2
  exit 1
fi

f2_env="$project_root/runtime/f2-capture-spike/.venv"
ocr_env="$project_root/runtime/ocr-compare/.venv"
mkdir -p "$(dirname "$f2_env")" "$(dirname "$ocr_env")"
"$python_command" -m venv "$f2_env"
"$f2_env/bin/python" -m pip install --upgrade pip
"$f2_env/bin/python" -m pip install "$project_root/runtime/f2-capture-spike/_vendor/f2"
"$python_command" -m venv "$ocr_env"
"$ocr_env/bin/python" -m pip install --upgrade pip
"$ocr_env/bin/python" -m pip install 'rapidocr==3.9.2' 'onnxruntime==1.30.0' 'Pillow==12.3.0'
echo "F2 与 RapidOCR 已安装到本仓库 runtime/ 下。whisper.cpp 与 large-v3-turbo 模型需按文档单独安装。"
