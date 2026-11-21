/**
 * L4 自洽回放：按时间顺序回放多天数据集，在她当年真实开口的每一轮，由新系统生成她的话。
 *   closed — 她过去的话换成新系统之前生成的话（能看见"自己"说过什么，重复、矛盾会累积）
 *   open   — 她过去的话保持原样，只在当下这一轮生成（对照：没有累积）
 * 别人的消息保持真实；开口时机用她当年的真实时机，所以这里只评"说什么"，不评"何时说"。
 * 各会话互不依赖（所用机制只看本会话），按会话并行。
 *
 * 用法：tsx --env-file=.env src/sim/self-replay.ts <dataset.jsonl> <输出目录> <closed|open> [额外机制,逗号分隔|-] [人格文件]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createGateway } from "../llm/gateway.js";
import { callSpeechModel } from "../llm/speech-model.js";
import { TURN_GAP } from "../mechanisms/pressure/params.js";
import { byName, mechanisms } from "../mechanisms/registry.js";
import { postedMessage } from "../mind/affordances.js";
import type { AliceEvent, MessageSent } from "../mind/events.js";
import type { Mechanism } from "../mind/mechanism.js";
import { settleDecision } from "../mind/settle.js";
import { type AliceState, type ChatState, emptyState } from "../mind/state.js";
import { speechRequest, step } from "../mind/step.js";
import type { SpeechOracle } from "./replay.js";
import { cachedSpeechOracle } from "./speech-cache.js";

const CONCURRENCY = 6;

export interface TranscriptLine {
  at: number;
  messageId: string;
  speaker: string;
  text: string | null;
  contentType: string;
  /** 是否是新系统生成的她的话。 */
  generated: boolean;
  /** 她的话属于第几轮（会话内从 1 开始）。 */
  turn?: number;
}

/** 回放一个会话，返回改写后的记录。 */
export async function replayChat(
  events: readonly AliceEvent[],
  mode: "closed" | "open",
  speech: SpeechOracle,
  active: readonly Mechanism[] = mechanisms,
): Promise<TranscriptLine[]> {
  let state: AliceState = emptyState;
  const out: TranscriptLine[] = [];
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let turn = 0;
  let simId = 0;
  const feed = (e: AliceEvent) => {
    state = step(state, e, active).state;
  };
  for (const e of events) {
    if (e.type === "message.received") {
      feed(e);
      out.push({
        at: e.at,
        messageId: e.messageId,
        speaker: e.senderName,
        text: e.text,
        contentType: e.contentType,
        generated: false,
      });
      continue;
    }
    if (e.type !== "message.sent") continue;
    const startsTurn = e.at - lastSentAt > TURN_GAP;
    lastSentAt = e.at;
    if (mode === "open") {
      feed(e);
      out.push({
        at: e.at,
        messageId: e.messageId,
        speaker: "Alice",
        text: e.text,
        contentType: e.kind,
        generated: false,
      });
    }
    if (!startsTurn) continue;
    turn++;
    const chat: ChatState | undefined = state.chats[e.scope];
    if (!chat) continue;
    const trigger = [...chat.timeline].reverse().find((t) => t.sender !== null)?.messageId ?? null;
    const request = speechRequest(state, chat, e.at, trigger, active);
    const decision = await speech(request, `${e.scope}#self-${turn}`);
    if (!decision) continue;
    const settled = settleDecision(chat, decision, e.at);
    // 只回放会留下消息的动作；表情、已读不进时间线。
    const sends: Array<{ text: string; kind: MessageSent["kind"] }> = settled.acts.flatMap(
      (act) => postedMessage(act) ?? [],
    );
    for (const s of sends) {
      simId++;
      const sent: MessageSent = {
        type: "message.sent",
        at: e.at,
        scope: e.scope,
        messageId: `sim:${simId}`,
        text: s.text,
        kind: s.kind,
      };
      if (mode === "closed") feed(sent);
      out.push({
        at: e.at,
        messageId: sent.messageId,
        speaker: "Alice",
        text: s.kind === "sticker" ? `[贴纸:${s.text}]` : s.text,
        contentType: s.kind,
        generated: true,
        turn,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [datasetPath, outDir, mode, extraArg, personaPath] = process.argv.slice(2);
  const extra = extraArg === "-" ? undefined : extraArg;
  const active = extra ? [...mechanisms, ...byName(extra.split(","))] : mechanisms;
  const suffix = `${extra ? `-${extra.replaceAll(",", "+")}` : ""}${personaPath ? `-${basename(personaPath, ".md")}` : ""}`;
  const apiKey = process.env.LLM_API_KEY;
  if (!datasetPath || !outDir || (mode !== "closed" && mode !== "open") || !apiKey) {
    console.error("usage: LLM_API_KEY=… self-replay.ts <dataset.jsonl> <out-dir> <closed|open>");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const speech = cachedSpeechOracle({
    persona: readFileSync(personaPath ?? "SOUL.md", "utf8"),
    cacheFile: join(outDir, "speech-cache.jsonl"),
    // 回放不受日上限约束，不记账。
    call: (prompt) =>
      callSpeechModel(createGateway({ apiKey, charge: () => {} }), prompt, { kind: "speech" }),
  });
  const byScope = new Map<string, AliceEvent[]>();
  for (const line of readFileSync(datasetPath, "utf8").split("\n")) {
    if (!line) continue;
    const e = JSON.parse(line) as AliceEvent;
    if ("scope" in e) byScope.set(e.scope, [...(byScope.get(e.scope) ?? []), e]);
  }
  const scopes = [...byScope.keys()].filter((s) =>
    byScope.get(s)?.some((e) => e.type === "message.sent"),
  );
  const results = new Map<string, TranscriptLine[]>();
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < scopes.length) {
        const scope = scopes[next++] as string;
        results.set(scope, await replayChat(byScope.get(scope) ?? [], mode, speech, active));
      }
    }),
  );
  const rows = [...results].map(([scope, lines]) => JSON.stringify({ scope, lines }));
  writeFileSync(join(outDir, `transcripts-${mode}${suffix}.jsonl`), `${rows.join("\n")}\n`);
  const generated = [...results.values()].flat().filter((l) => l.generated).length;
  console.log(
    `mode=${mode} scopes=${scopes.length} generated_lines=${generated} model_calls=${speech.misses()} failures=${speech.failures()}`,
  );
}

if (process.argv[1]?.endsWith("self-replay.ts")) void main();
