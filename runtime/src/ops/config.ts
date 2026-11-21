import { DEFAULT_DAILY_CAP_USD } from "./operator.js";

/**
 * 操作员控制面的环境变量（真实 id 不进仓库）：
 * - ALICE_OPERATOR_ID：操作员的 Telegram 用户 id（数字）。必填：没有它就没人能停她、收不到告警，上线不放行。
 * - ALICE_DAILY_USD_CAP：每天（东八区）模型花费的上限，美元，默认 3。到了自动暂停。
 */
export interface OpsConfig {
  operatorId: string;
  capUsd: number;
}

export function loadOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const operatorId = env.ALICE_OPERATOR_ID?.trim() ?? "";
  if (!/^\d+$/.test(operatorId)) {
    throw new Error("ALICE_OPERATOR_ID must be set to the operator's numeric Telegram user id");
  }
  const raw = env.ALICE_DAILY_USD_CAP?.trim();
  const capUsd = raw ? Number(raw) : DEFAULT_DAILY_CAP_USD;
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error("ALICE_DAILY_USD_CAP must be a positive number of US dollars");
  }
  return { operatorId, capUsd };
}
