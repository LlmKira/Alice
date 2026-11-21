/**
 * 多语言重排（Cohere rerank-v5.0-pro，经同一网关）：给一句想找的话和一批描述，按相关程度排好。
 * 相册搜索用它代替字词匹配：她用任何语言想找，都能对上任何语言写的描述。
 * 探针（2026-11-11）：中、俄、英、日 7 个查询首位全对；对得上的 0.015–0.33，完全无关的都 ≤ 0.005。
 */
import type { Gateway } from "./gateway.js";

const MODEL = "cohere/rerank-v5.0-pro";
const MAX_DOCUMENTS = 1000;

interface Body {
  results?: Array<{ index: number }>;
  meta?: { billed_units?: { input_tokens?: number } };
}

/** 返回按相关程度从高到低的下标（最多 top 个）。 */
export async function rerank(
  gateway: Gateway,
  query: string,
  documents: readonly string[],
  top: number,
): Promise<number[]> {
  if (documents.length === 0) return [];
  const { body } = await gateway.post<Body>({
    kind: "rerank",
    model: MODEL,
    path: "/rerank",
    timeoutMs: 20_000,
    tokens: (b) => ({
      promptTokens: b.meta?.billed_units?.input_tokens ?? 0,
      completionTokens: 0,
      reasoningTokens: 0,
    }),
    body: { model: MODEL, query, documents: documents.slice(0, MAX_DOCUMENTS), top_n: top },
  });
  return (body.results ?? []).map((r) => r.index);
}
