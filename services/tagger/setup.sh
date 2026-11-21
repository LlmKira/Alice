#!/usr/bin/env bash
# 装好看图标注服务：Python 环境（.venv）和模型（models/，约 470 MB）。可以重复跑，已经对的不再下载。
# 用法：bash services/tagger/setup.sh
set -euo pipefail
cd "$(dirname "$0")"

# 模型固定在 Hugging Face 的一个提交上；sha256 取自同一提交的 LFS 记录。
MODEL=wd-swinv2-tagger-v3
REVISION=627aef95638667ddcaa3ac8ae625e88ea5b02f51
ONNX_SHA256=e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1
CSV_SHA256=298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217

uv venv --allow-existing --python 3.14 .venv
uv pip install --python .venv/bin/python -r pyproject.toml

fetch() { # <文件名> <存成> <sha256>
  local out="models/$2"
  if [[ -f "$out" ]] && echo "$3  $out" | sha256sum --check --status; then return; fi
  # 大文件经代理时常断：断点续传，最多重来 30 次。
  for _ in $(seq 1 30); do
    curl -fsSL --http1.1 -C - --retry 5 --retry-all-errors -o "$out" \
      "https://huggingface.co/SmilingWolf/$MODEL/resolve/$REVISION/$1" && break
  done
  echo "$3  $out" | sha256sum --check
}
mkdir -p models
fetch selected_tags.csv "$MODEL.csv" "$CSV_SHA256"
fetch model.onnx "$MODEL.onnx" "$ONNX_SHA256"
echo "ready: pm2 start ecosystem.config.cjs --only alice-tagger"
