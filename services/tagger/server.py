"""Alice 的本机看图标注：WD v3 标注器（SmilingWolf/wd-swinv2-tagger-v3，CPU ONNX），只听 127.0.0.1。

    POST /tag   请求体是图片原始字节（JPEG、PNG、WebP）
    → {"rating": {"general": p, "sensitive": p, "questionable": p, "explicit": p},
       "characters": [{"name", "score"}], "tags": [{"name", "score"}]}

characters、tags 只列分数 ≥ 0.35 的，按分数从高到低。怎么取舍（角色要多高的分、怎样算照片）由机器人决定。

图片预处理照模型作者的演示（huggingface.co/spaces/SmilingWolf/wd-tagger app.py）：透明底垫白，补成白边正方形，
双三次缩放到模型的边长，RGB 转 BGR，不归一化。一次只算一张（单线程服务），ONNX 用 TAGGER_THREADS 个线程、不空转，
免得和同一台机器上的机器人抢 CPU。

环境变量：TAGGER_PORT（默认 39100）、TAGGER_THREADS（默认 4）、TAGGER_MODEL（默认 wd-swinv2-tagger-v3）。
模型由 setup.sh 下载到 models/。
"""

import csv
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

HERE = Path(__file__).resolve().parent
MODEL = os.environ.get("TAGGER_MODEL", "wd-swinv2-tagger-v3")
PORT = int(os.environ.get("TAGGER_PORT", "39100"))
THREADS = int(os.environ.get("TAGGER_THREADS", "4"))
FLOOR = 0.35
MAX_BYTES = 20 * 1024 * 1024
# 颜文字标签保留下划线（模型作者的演示同样处理）。
KAOMOJI = {"0_0", "(o)_(o)", "+_+", "+_-", "._.", "<o>_<o>", "<|>_<|>", "=_=", ">_<", "3_3", "6_9", ">_o", "@_@",
           "^_^", "o_o", "u_u", "x_x", "|_|", "||_||"}

with open(HERE / "models" / f"{MODEL}.csv", newline="") as f:
    LABELS = [(r["name"] if r["name"] in KAOMOJI else r["name"].replace("_", " "), r["category"])
              for r in csv.DictReader(f)]
RATING = [i for i, (_, c) in enumerate(LABELS) if c == "9"]
GENERAL = [i for i, (_, c) in enumerate(LABELS) if c == "0"]
CHARACTER = [i for i, (_, c) in enumerate(LABELS) if c == "4"]

options = ort.SessionOptions()
options.intra_op_num_threads = THREADS
options.inter_op_num_threads = 1
options.add_session_config_entry("session.intra_op.allow_spinning", "0")
SESSION = ort.InferenceSession(str(HERE / "models" / f"{MODEL}.onnx"), options, providers=["CPUExecutionProvider"])
INPUT = SESSION.get_inputs()[0]
SIZE = INPUT.shape[1]


def prepare(image: Image.Image) -> np.ndarray:
    image = image.convert("RGBA")
    canvas = Image.new("RGBA", image.size, (255, 255, 255))
    canvas.alpha_composite(image)
    image = canvas.convert("RGB")
    side = max(image.size)
    square = Image.new("RGB", (side, side), (255, 255, 255))
    square.paste(image, ((side - image.size[0]) // 2, (side - image.size[1]) // 2))
    if side != SIZE:
        square = square.resize((SIZE, SIZE), Image.BICUBIC)
    return np.expand_dims(np.asarray(square, dtype=np.float32)[:, :, ::-1], axis=0)


def tag(data: bytes) -> dict:
    probs = SESSION.run(None, {INPUT.name: prepare(Image.open(BytesIO(data)))})[0][0].astype(float)

    def above(indexes):
        found = sorted((i for i in indexes if probs[i] >= FLOOR), key=lambda i: -probs[i])
        return [{"name": LABELS[i][0], "score": round(probs[i], 4)} for i in found]

    return {"rating": {LABELS[i][0]: round(probs[i], 4) for i in RATING},
            "characters": above(CHARACTER), "tags": above(GENERAL)}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not found"})
        self.reply(200, {"ok": True, "model": MODEL})

    def do_POST(self):
        if self.path != "/tag":
            return self.reply(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BYTES:
            return self.reply(413, {"error": "image size"})
        try:
            self.reply(200, tag(self.rfile.read(length)))
        except Exception as e:  # noqa: BLE001 — 认不出的图片：回 422，服务继续跑
            self.reply(422, {"error": f"{type(e).__name__}: {e}"})

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"tagger {MODEL} on 127.0.0.1:{PORT}, {THREADS} threads", file=sys.stderr, flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
