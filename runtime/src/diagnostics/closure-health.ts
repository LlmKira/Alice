/**
 * ADR-199 W4: 闭环健康度诊断。
 *
 * 定期审计闭环反馈结构的各项指标：
 * - closure_depth≥1 占比（Action→State 闭环）
 * - feel() 覆盖率（含 auto-inject）
 * - 延迟评估覆盖率（Decision→Outcome 闭环）
 * - 外部反馈覆盖率
 *
 * @see docs/adr/199-closure-feedback-structural-upgrade.md
 */
import { sql } from "drizzle-orm";

export interface ClosureHealthReport {
  /** closure_depth>0 的 message 行动占比 [0,1]。 */
  actionStateRatio: number;
  /** feel() 覆盖率（含 auto-inject）[0,1]。 */
  feelCoverage: number;
  /** 延迟评估执行数量。 */
  deferredEvalCount: number;
  /** 有外部反馈的行动占比 [0,1]。 */
  externalFeedbackCoverage: number;
  /** auto_writeback 非 null 的占比 [0,1]。 */
  autoWritebackRatio: number;
  /** 总体健康度。 */
  overallHealth: "healthy" | "degraded" | "broken";
  /** 具体问题列表。 */
  issues: string[];
  /** 统计窗口内 message 行动总数。 */
  totalMessages: number;
}

/**
 * 计算闭环健康度报告。
 *
 * 从 action_log 和 deferred_outcome_log 中统计最近 windowTicks 内的指标。
 */
export function computeClosureHealth(
  db: { all: <T>(query: ReturnType<typeof sql>) => T[] },
  windowTicks = 100,
): ClosureHealthReport {
  const issues: string[] = [];

  // 查询最近 windowTicks 的 message 行动
  const stats = db.all<{
    total: number;
    closed: number;
    feel_closed: number;
    has_auto: number;
  }>(sql`
    SELECT
      count(*) as total,
      sum(case when closure_depth > 0 then 1 else 0 end) as closed,
      sum(case
        when observation_gap = 0 or observation_gap is null then 1
        when json_valid(auto_writeback)
          and json_extract(auto_writeback, '$.feel') is not null then 1
        else 0
      end) as feel_closed,
      sum(case when auto_writeback is not null then 1 else 0 end) as has_auto
    FROM action_log
    WHERE action_type = 'message'
      AND tick > (SELECT coalesce(max(tick), 0) - ${windowTicks} FROM action_log)
  `);

  const row = stats[0] ?? { total: 0, closed: 0, feel_closed: 0, has_auto: 0 };
  const total = Number(row.total);

  if (total === 0) {
    return {
      actionStateRatio: 1,
      feelCoverage: 1,
      deferredEvalCount: 0,
      externalFeedbackCoverage: 0,
      autoWritebackRatio: 0,
      overallHealth: "healthy",
      issues: [],
      totalMessages: 0,
    };
  }

  const actionStateRatio = Number(row.closed) / total;
  const feelCoverage = Number(row.feel_closed) / total;
  const autoWritebackRatio = Number(row.has_auto) / total;

  // 延迟评估统计
  const deferredStats = db.all<{ cnt: number }>(sql`
    SELECT count(*) as cnt
    FROM deferred_outcome_log
    WHERE tick > (SELECT coalesce(max(tick), 0) - ${windowTicks} FROM action_log)
  `);
  const deferredEvalCount = Number(deferredStats[0]?.cnt ?? 0);

  // 外部反馈覆盖率：有 last_outcome_ms > last_alice_action_ms 的 message 行动比例
  // 使用 deferred_outcome_log 计数 / total 作为近似
  const externalFeedbackCoverage = Math.min(1, deferredEvalCount / total);

  // 健康度判定
  if (actionStateRatio < 0.5)
    issues.push(`closure_depth≥1 ratio critically low: ${(actionStateRatio * 100).toFixed(0)}%`);
  else if (actionStateRatio < 0.9)
    issues.push(
      `closure_depth≥1 ratio below target: ${(actionStateRatio * 100).toFixed(0)}% (target: 90%)`,
    );

  if (feelCoverage < 0.7)
    issues.push(`feel coverage critically low: ${(feelCoverage * 100).toFixed(0)}%`);
  else if (feelCoverage < 0.95)
    issues.push(`feel coverage below target: ${(feelCoverage * 100).toFixed(0)}% (target: 95%)`);

  const overallHealth: ClosureHealthReport["overallHealth"] =
    issues.length === 0
      ? "healthy"
      : issues.some((i) => i.includes("critically"))
        ? "broken"
        : "degraded";

  return {
    actionStateRatio,
    feelCoverage,
    deferredEvalCount,
    externalFeedbackCoverage,
    autoWritebackRatio,
    overallHealth,
    issues,
    totalMessages: total,
  };
}
