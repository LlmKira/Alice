/**
 * 零成本模型分级审计工具（PLAN 第 50 件）：读取 bench-loop 的 prompts.jsonl，
 * 对每一轮渲染出的提示上下文做 selectSpeechModel 判定（不调真模型，0 花费），
 * 输出 routine vs peak 分布与触发原因，供离线核对成本与峰值命中率。
 */
import { readFileSync } from "node:fs";
import { selectSpeechModel } from "../llm/model-tier.js";
import type { Contribution } from "../mind/mechanism.js";

interface LoggedPrompt {
  scope: string;
  at: number;
  system: string;
  user: string;
}

function contributionsFromUser(user: string): Contribution[] {
  const out: Contribution[] = [];
  const card = user.split("\n---\n")[0] ?? user;
  for (const line of card.split("\n")) {
    if (line.startsWith("· 心情：")) {
      out.push({ mechanism: "audit", kind: "mood", text: line.slice("· 心情：".length) });
    } else if (line.startsWith("· 我这边：")) {
      out.push({ mechanism: "audit", kind: "state", text: line.slice("· 我这边：".length) });
    }
  }
  const peopleIdx = card.indexOf("· 在场的人与记忆：");
  if (peopleIdx >= 0) {
    const rest = card.slice(peopleIdx).split("\n· ")[0] ?? "";
    out.push({ mechanism: "audit", kind: "people", text: rest });
  }
  const selfIdx = card.indexOf("· 心里还记着");
  if (selfIdx >= 0) {
    const rest = card.slice(selfIdx).split("\n· ")[0] ?? "";
    out.push({ mechanism: "audit", kind: "self", text: rest });
  }
  return out;
}

function timelineFromUser(user: string, at: number) {
  const parts = user.split("\n\n");
  const log = parts[1] ?? "";
  return log
    .split("\n")
    .filter((l) => /^\d{2}:\d{2}\s+\[/.test(l))
    .slice(-5)
    .map((l) => ({
      at,
      sender: l.includes("<") ? { id: "peer", name: "peer" } : null,
      text: l,
    }));
}

function main(): void {
  const file = process.argv[2];
  if (!file) throw new Error("usage: model-tier-audit.ts <prompts.jsonl>");
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LoggedPrompt);
  const results = rows.map((r) => {
    const chatType = r.scope.startsWith("telegram:-") ? "group" : "private";
    const d = selectSpeechModel({
      chatType,
      at: r.at,
      timeline: timelineFromUser(r.user, r.at) as never,
      contributions: contributionsFromUser(r.user),
    });
    return { scope: r.scope, at: r.at, tier: d.tier, model: d.model, reasons: d.reasons };
  });
  console.log(JSON.stringify(results));
}

main();
