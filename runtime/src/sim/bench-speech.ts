/**
 * 发言层基准：在 bench-l2 的 243 个真实时刻上，用核心 step() 按时间顺序 fold 数据集，
 * 取每个时刻的状态（会话时间线 + 各机制状态），走生产发言层（带缓存），写出结果供打分。
 *
 * 用法：tsx --env-file=.env src/sim/bench-speech.ts <输出目录> [--arm 名字] [--mechanisms a,b,c]
 *       [--moments 时刻列表.jsonl]
 * 不给 --mechanisms 时用生产注册表；不给 --moments 时用 bench-l2 的 243 个时刻。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGateway } from "../llm/gateway.js";
import { callSpeechModel } from "../llm/speech-model.js";
import { byName, mechanisms as production } from "../mechanisms/registry.js";
import type { SpeechRequest } from "../mind/effects.js";
import type { AliceEvent, SpeechDecision } from "../mind/events.js";
import type { Mechanism } from "../mind/mechanism.js";
import { settleDecision } from "../mind/settle.js";
import { type AliceState, type ChatState, emptyChat, emptyState } from "../mind/state.js";
import { speechRequest, step } from "../mind/step.js";
import { spokenOf } from "../speech/decision.js";
import { scopeOf } from "./import-message-log.js";
import { cachedSpeechOracle } from "./speech-cache.js";

const ARTIFACTS = "eval-artifacts";
const CONCURRENCY = 6;
const DATASET_BY_DB: Record<string, string> = {
  "alice.db.bak-20260223-152255": "feb-a",
  "alice.db.bak-pre-anomaly-cleanup": "feb-b",
  "alice.db": "jul",
};

function jsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export interface Moment {
  key: string;
  scope: string;
  at: number;
}

/** 按时间顺序 fold 一次事件流，在每个时刻取出会话状态和发言请求。 */
export function momentsIn(
  events: readonly AliceEvent[],
  moments: readonly Moment[],
  active: readonly Mechanism[],
): Map<string, { chat: ChatState; request: SpeechRequest }> {
  const ordered = [...moments].sort((a, b) => a.at - b.at);
  const out = new Map<string, { chat: ChatState; request: SpeechRequest }>();
  let state: AliceState = emptyState;
  let i = 0;
  for (const m of ordered) {
    while (i < events.length && (events[i] as AliceEvent).at < m.at) {
      state = step(state, events[i] as AliceEvent, active).state;
      i++;
    }
    // 会话在此之前没有任何事件：她是在一个安静的会话里主动开口。
    const chat: ChatState =
      state.chats[m.scope] ??
      emptyChat(m.scope, m.scope.startsWith("telegram:-") ? "group" : "private", true);
    const trigger = [...chat.timeline].reverse().find((t) => t.sender !== null)?.messageId ?? null;
    out.set(m.key, { chat, request: speechRequest(state, chat, m.at, trigger, active) });
  }
  return out;
}

/** 记录她真正会发出去的内容，同时保留模型原本想要的贴纸和引用。 */
function benchRow(
  gid: string,
  chat: ChatState,
  at: number,
  request: SpeechRequest,
  decision: SpeechDecision | null,
) {
  const settled = decision ? settleDecision(chat, decision, at) : null;
  const spoken = spokenOf(settled?.acts ?? []);
  const firstSend = settled?.acts.find((a) => a.kind === "send");
  return JSON.stringify({
    gid,
    contributed: request.contributions.map((c) => c.mechanism),
    // 空时间线的时刻提示词彼此相同，模型只做了一次决定；分析时要去重或剔除。
    timelineSize: request.timeline.length,
    failed: decision === null,
    silent: settled !== null && spoken.lines.length === 0 && spoken.stickers.length === 0,
    text: spoken.lines.join(" / "),
    sticker: spoken.stickers[0] ?? null,
    replyTo: firstSend?.kind === "send" ? firstSend.replyTo : null,
    acts: settled?.acts.map((a) => a.kind) ?? [],
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const outDir = process.argv[2];
  const apiKey = process.env.LLM_API_KEY;
  if (!outDir || outDir.startsWith("--") || !apiKey) {
    console.error(
      "usage: LLM_API_KEY=… bench-speech.ts <out-dir> [--arm name] [--mechanisms a,b] [--moments file] [--persona file]",
    );
    process.exit(1);
  }
  const arm = arg("--arm") ?? "baseline";
  const names = arg("--mechanisms");
  const active = names ? byName(names.split(",").filter(Boolean)) : production;
  mkdirSync(outDir, { recursive: true });
  const persona = readFileSync(arg("--persona") ?? "SOUL.md", "utf8");
  const items = new Map(
    jsonl<{ id: string; chat_id: string; ts: number }>(join(ARTIFACTS, "bench-l1/items.jsonl")).map(
      (it) => [it.id, it],
    ),
  );
  const contexts = jsonl<{ gid: string; id: string }>(
    arg("--moments") ?? join(ARTIFACTS, "bench-l2/contexts.jsonl"),
  );
  const oracle = cachedSpeechOracle({
    persona,
    cacheFile: join(outDir, "speech-cache.jsonl"),
    // 基准不受日上限约束，不记账。
    call: (prompt) =>
      callSpeechModel(createGateway({ apiKey, charge: () => {} }), prompt, { kind: "speech" }),
  });

  const byDataset = new Map<string, Moment[]>();
  for (const ctx of contexts) {
    const item = items.get(ctx.id);
    const name = DATASET_BY_DB[ctx.id.split(":")[1] ?? ""];
    if (!item || !name) throw new Error(`no dataset for ${ctx.id}`);
    const list = byDataset.get(name) ?? [];
    list.push({ key: ctx.gid, scope: scopeOf(item.chat_id), at: item.ts * 1000 });
    byDataset.set(name, list);
  }
  const prepared = new Map<string, { at: number; chat: ChatState; request: SpeechRequest }>();
  for (const [name, list] of byDataset) {
    const events = jsonl<AliceEvent>(join(ARTIFACTS, "datasets", `${name}.jsonl`));
    const snapshot = momentsIn(events, list, active);
    for (const m of list) {
      const s = snapshot.get(m.key);
      if (s) prepared.set(m.key, { at: m.at, ...s });
    }
  }

  const gids = contexts.map((c) => c.gid);
  const rows = Array.from<string>({ length: gids.length }).fill("");
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < gids.length) {
        const index = next++;
        const gid = gids[index] as string;
        const job = prepared.get(gid);
        if (!job) continue;
        const decision = await oracle(job.request, `${gid}#bench`);
        rows[index] = benchRow(gid, job.chat, job.at, job.request, decision);
      }
    }),
  );
  writeFileSync(join(outDir, `gens-${arm}.jsonl`), `${rows.filter(Boolean).join("\n")}\n`);
  console.log(
    `arm=${arm} mechanisms=${active.map((m) => m.name).join(",")} written=${rows.filter(Boolean).length} model_calls=${oracle.misses()} failures=${oracle.failures()}`,
  );
}

if (process.argv[1]?.endsWith("bench-speech.ts")) void main();
