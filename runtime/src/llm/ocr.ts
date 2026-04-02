/**
 * 本地 OCR 模块 — PaddleOCR PP-OCRv4 via @gutenye/ocr-node。
 *
 * 作为 VLM 的**附加层**（非 fallback）：VLM 提供自然语言描述，
 * OCR 精确提取图片中的文字内容。两者互补——VLM 擅长场景/情感/构图，
 * OCR 擅长截图/梗图中的精确文字复述。
 *
 * @see docs/adr/88-multimodal-proactive-behavior.md
 */

import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ocr");

// ═══════════════════════════════════════════════════════════════════════════
// 类型（从 @gutenye/ocr-common 镜像，避免 deep import）
// ═══════════════════════════════════════════════════════════════════════════

/** OCR 检测结果行。与 @gutenye/ocr-common 的 Line 类型对齐。 */
export interface OcrLine {
  text: string;
  /** 置信度均值（0-1）。 */
  mean: number;
  /** 四点边框 [[x,y], [x,y], [x,y], [x,y]]。 */
  box?: number[][];
}

/** @gutenye/ocr-node 的 Ocr 实例接口（duck typing，避免 import 路径耦合）。
 * 注意：@gutenye/ocr-node@1.4.8 的 detect() 只接受文件路径，不接受 ImageRawData。
 * 内部 Detection.run() → ImageRaw.open(path) → sharp(path)，必须传字符串路径。 */
interface OcrEngine {
  detect(imagePath: string): Promise<OcrLine[]>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Lazy singleton — Ocr.create() 冷启动 1-3s，只在首次调用时初始化
// ═══════════════════════════════════════════════════════════════════════════

let _initPromise: Promise<OcrEngine> | null = null;

/**
 * 获取或初始化 OCR 引擎单例。
 * 并发调用共享同一个 Promise，不会重复初始化。
 */
async function getEngine(): Promise<OcrEngine> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const { default: Ocr } = await import("@gutenye/ocr-node");
      const engine = (await Ocr.create()) as OcrEngine;
      log.info("OCR engine initialized");
      return engine;
    })();
  }
  return _initPromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// 通用工具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Promise 超时包装器。
 *
 * try/finally 确保 timer 无论成功/失败都被清理，
 * 消除 Promise.race 裸 setTimeout 的 timer 泄漏。
 * timer.unref() 防止 timer 阻止进程优雅退出。
 *
 * @see .claude/sessions/ocr-research.md §Q4
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════════════════════

/** OCR 是否已启用。 */
export function isOcrEnabled(config: Config): boolean {
  return config.ocrEnabled;
}

/** 单次 OCR 推理超时（毫秒）。正常推理 100-500ms，5s 足够宽裕。 */
const OCR_TIMEOUT_MS = 5_000;

/** Buffer 上限（字节）。超大图片跳过，避免 ONNX 内存溢出。 */
const MAX_BUFFER_SIZE = 5 * 1024 * 1024; // 5 MB

/** OCR 提取文字最大字符数。避免 context 膨胀。 */
const MAX_TEXT_LENGTH = 500;

/**
 * 从 OCR 原始行结果中过滤、排序、拼接出可读文本。
 *
 * 纯函数，无副作用——方便单元测试。
 *
 * 1. 置信度过滤：低于 minConfidence 的行丢弃
 * 2. 阅读顺序排序：top→bottom，同行内 left→right
 * 3. 拼接 + 截断：空格分隔，超过 MAX_TEXT_LENGTH 截断并加省略号
 */
export function processOcrLines(lines: OcrLine[], minConfidence: number): string | undefined {
  if (!lines || lines.length === 0) return undefined;

  const filtered = lines.filter((line) => line.mean >= minConfidence);
  if (filtered.length === 0) return undefined;

  // 阅读顺序排序：按 top（上→下），同行内按 left（左→右）
  filtered.sort((a, b) => {
    const aTop = minY(a.box);
    const bTop = minY(b.box);
    // 同一行判定：top 差值 < 行高一半（粗略启发式）
    const rowThreshold = 15;
    if (Math.abs(aTop - bTop) < rowThreshold) {
      return minX(a.box) - minX(b.box);
    }
    return aTop - bTop;
  });

  const joined = filtered
    .map((l) => l.text.trim())
    .filter(Boolean)
    .join(" ");
  if (!joined) return undefined;
  return joined.length > MAX_TEXT_LENGTH ? `${joined.slice(0, MAX_TEXT_LENGTH)}…` : joined;
}

/**
 * 从图片 Buffer 提取文字。
 *
 * 流程：Buffer → 临时文件 → ocr.detect(path) → processOcrLines → 清理临时文件。
 * @gutenye/ocr-node@1.4.8 的 detect() 只接受文件路径（内部 ImageRaw.open(path)
 * 会自行调用 sharp 解码），故使用临时文件桥接。
 *
 * @param imageBuffer 原始图片 Buffer（JPEG/PNG/WebP 等 sharp 可解码格式）
 * @param config 全局配置（ocrMinConfidence）
 * @returns 提取的文字，或 undefined（禁用/无文字/失败）
 */
export async function extractText(
  imageBuffer: Buffer,
  config: Config,
): Promise<string | undefined> {
  if (!config.ocrEnabled) return undefined;

  // 守卫：空/过大 buffer
  if (imageBuffer.byteLength === 0 || imageBuffer.byteLength > MAX_BUFFER_SIZE) {
    return undefined;
  }

  const tmpPath = join(tmpdir(), `alice-ocr-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmpPath, imageBuffer);

    const engine = await getEngine();
    const lines = await withTimeout(engine.detect(tmpPath), OCR_TIMEOUT_MS, "OCR timeout");

    const result = processOcrLines(lines, config.ocrMinConfidence);
    if (result) {
      log.info("OCR extracted", {
        lines: lines.filter((l) => l.mean >= config.ocrMinConfidence).length,
        totalChars: result.length,
        preview: result.slice(0, 60),
      });
    }
    return result;
  } catch (e) {
    log.warn("OCR failed", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 内部工具
// ═══════════════════════════════════════════════════════════════════════════

/** 从 box 四点中取最小 Y（top）。无 box 时返回 0。 */
function minY(box: number[][] | undefined): number {
  if (!box || box.length === 0) return 0;
  return Math.min(...box.map((p) => p[1]));
}

/** 从 box 四点中取最小 X（left）。无 box 时返回 0。 */
function minX(box: number[][] | undefined): number {
  if (!box || box.length === 0) return 0;
  return Math.min(...box.map((p) => p[0]));
}
