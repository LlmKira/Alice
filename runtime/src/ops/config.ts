import { DEFAULT_DAILY_CAP_USD } from "./operator.js";

/**
 * 操作员控制面的环境变量（真实 id 不进仓库）：
 * - ALICE_OPERATOR_ID：操作员的 Telegram 用户 id（数字）。必填：没有它就没人能停她、收不到告警，上线不放行。
 * - QQ_OPERATOR_ID：操作员的 QQ 号，可不设。Telegram 和 QQ 的数字 id 是两套号码，同一个数字可能是两个人，
 *   所以 ALICE_OPERATOR_ID 不拿来认 QQ 上的人；只挂 QQ 时才把它当 QQ 号（config.ts loadRuntimeConfig）。
 * - ALICE_DAILY_USD_CAP：每天（东八区）模型花费的上限，美元，默认 3。到了自动暂停。
 */
export interface OpsConfig {
  operatorId: string;
  /** QQ 上的操作员；null 表示 QQ 上没有操作员（不收 /ops 命令、不往 QQ 发通知和自检）。 */
  qqOperatorId: string | null;
  capUsd: number;
}

export function loadOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const operatorId = env.ALICE_OPERATOR_ID?.trim() ?? "";
  if (!/^\d+$/.test(operatorId)) {
    throw new Error("ALICE_OPERATOR_ID must be set to the operator's numeric Telegram user id");
  }
  const qqOperatorId = env.QQ_OPERATOR_ID?.trim() || null;
  if (qqOperatorId !== null && !/^\d+$/.test(qqOperatorId)) {
    throw new Error("QQ_OPERATOR_ID must be a QQ number");
  }
  const raw = env.ALICE_DAILY_USD_CAP?.trim();
  const capUsd = raw ? Number(raw) : DEFAULT_DAILY_CAP_USD;
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error("ALICE_DAILY_USD_CAP must be a positive number of US dollars");
  }
  return { operatorId, qqOperatorId, capUsd };
}
