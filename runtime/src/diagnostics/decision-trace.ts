/**
 * ADR-248 W1: decision_trace 读取诊断。
 *
 * 只读审计事实，帮助人类解释某个 tick/action 为什么发生。
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import { listDecisionTraces, summarizeDecisionTrace } from "../db/decision-trace.js";

export interface DecisionTraceDiagnosticOptions {
  tick?: number;
  actionLogId?: number;
  limit?: number;
  json?: boolean;
}

export function renderDecisionTraceDiagnostic(options: DecisionTraceDiagnosticOptions): string {
  const records = listDecisionTraces({
    tick: options.tick,
    actionLogId: options.actionLogId,
    limit: options.limit ?? 20,
  });

  if (options.json) return JSON.stringify(records, null, 2);

  const title = options.tick !== undefined
    ? `Decision Trace — tick ${options.tick}`
    : options.actionLogId !== undefined
      ? `Decision Trace — action_log ${options.actionLogId}`
      : "Decision Trace — latest";

  const lines = [title, ""];
  if (records.length === 0) {
    lines.push("No decision_trace rows found.");
    return lines.join("\n");
  }

  for (const record of records) {
    lines.push(summarizeDecisionTrace(record));
    const payloadKeys = Object.keys(record.payload);
    if (payloadKeys.length > 0) lines.push(`  payload keys: ${payloadKeys.join(", ")}`);
  }
  return lines.join("\n");
}
