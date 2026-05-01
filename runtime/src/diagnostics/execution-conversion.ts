/**
 * A2b execution conversion diagnostic.
 *
 * A2 voice selection health is measured at `tick_log.action`. This diagnostic
 * explains what happens after a selected candidate leaves IAUS.
 *
 * @see docs/adr/258-iaus-health-curve-validation/README.md §Wave 7
 */

import { getSqlite } from "../db/connection.js";

export interface ExecutionConversionReport {
  totalSelected: number;
  planeSummaries: ExecutionConversionPlaneSummary[];
  detailRows: ExecutionConversionDetailRow[];
  outcomeRows: ExecutionConversionOutcomeRow[];
  failureUseCases: ExecutionConversionFailureUseCaseRow[];
  transitionShadows: ExecutionConversionTransitionShadowRow[];
  focusPathProjection: FocusPathProjectionReport;
  attentionPullAudit: AttentionPullAuditReport;
  switchRequestAudit: SwitchRequestAuditReport;
}

export interface ExecutionConversionPlaneSummary {
  gatePlane: string;
  selected: number;
  executed: number;
  acceptedOnly: number;
  dropped: number;
  expired: number;
  missingQueue: number;
  success: number;
  noOp: number;
  typedFailure: number;
  cancelled: number;
  unknownLegacy: number;
  missingResult: number;
  successRate: number;
  noOpRate: number;
  typedFailureRate: number;
  missingResultRate: number;
}

export interface ExecutionConversionDetailRow {
  gatePlane: string;
  actionType: string;
  queueFate: string;
  actionResult: string;
  count: number;
}

export interface ExecutionConversionOutcomeRow {
  gatePlane: string;
  candidateAction: string;
  actionResult: string;
  actionLogType: string;
  tcAfterward: string;
  failureCode: string;
  completedActionKind: string;
  count: number;
}

export interface ExecutionConversionFailureUseCaseRow {
  useCase: string;
  failureCode: string;
  actionLogType: string;
  gatePlane: string;
  candidateAction: string;
  count: number;
  exampleTarget: string;
  exampleReasoning: string;
  exampleCommandLog: string;
}

export interface ExecutionConversionTransitionShadowRow {
  transitionClass: string;
  evidenceStatus: string;
  sourceCommand: string;
  currentChatId: string;
  requestedChatId: string;
  gatePlane: string;
  candidateAction: string;
  tcAfterward: string;
  count: number;
  exampleCurrentTarget: string;
  exampleReasoning: string;
  exampleCommandLog: string;
}

export interface FocusPathProjectionReport {
  pointTargetRows: number;
  transitionRows: FocusPathProjectionRow[];
  summaryRows: FocusPathProjectionSummaryRow[];
}

export interface FocusPathProjectionRow {
  pathId: string;
  tick: number;
  pathLength: number;
  originChatId: string;
  requestedChatId: string;
  transitionClass: string;
  evidenceStrength: "strong" | "medium" | "weak";
  pathOutcome: "completed" | "failed" | "mixed" | "pending";
  contaminationFlags: string;
  sourceCommand: string;
  gatePlane: string;
  candidateAction: string;
  actionResult: string;
  failureCode: string;
  completedActionKind: string;
  tcAfterward: string;
  sourceTarget: string;
  payloadJson: string;
}

export interface FocusPathProjectionSummaryRow {
  pathLength: number;
  transitionClass: string;
  evidenceStrength: string;
  pathOutcome: string;
  count: number;
}

export interface AttentionPullAuditReport {
  total: number;
  distinctSources: number;
  distinctRequested: number;
  topRequestedRate: number;
  sourceRequestedRows: AttentionPullPairRow[];
  staleRows: AttentionPullStaleRow[];
  rawCrossChatAfterRows: AttentionPullRawCrossChatAfterRow[];
  reasonSamples: AttentionPullReasonSample[];
}

export interface AttentionPullPairRow {
  sourceChatId: string;
  requestedChatId: string;
  count: number;
  latestTick: number;
  latestReason: string;
}

export interface AttentionPullStaleRow {
  intentId: string;
  tick: number;
  ageTicks: number;
  sourceChatId: string;
  requestedChatId: string;
  reason: string;
}

export interface AttentionPullRawCrossChatAfterRow {
  intentId: string;
  tick: number;
  sourceChatId: string;
  requestedChatId: string;
  rawCrossChatFailuresWithin50Ticks: number;
}

export interface AttentionPullReasonSample {
  intentId: string;
  tick: number;
  sourceChatId: string;
  requestedChatId: string;
  reason: string;
}

export interface SwitchRequestAuditReport {
  total: number;
  explicitRequests: number;
  blockedRequests: number;
  distinctSources: number;
  distinctRequested: number;
  pairRows: SwitchRequestPairRow[];
  repeatedBlockedRows: SwitchRequestRepeatedBlockedRow[];
  followedRows: SwitchRequestFollowedRow[];
  staleRows: SwitchRequestStaleRow[];
}

export interface SwitchRequestSummaryRow {
  total: number;
  explicitRequests: number;
  blockedRequests: number;
  distinctSources: number;
  distinctRequested: number;
}

export interface SwitchRequestPairRow {
  intentKind: string;
  sourceChatId: string;
  requestedChatId: string;
  count: number;
  latestTick: number;
  latestReason: string;
}

export interface SwitchRequestRepeatedBlockedRow {
  intentId: string;
  tick: number;
  intentKind: string;
  sourceChatId: string;
  requestedChatId: string;
  blockedAgainWithin50Ticks: number;
}

export interface SwitchRequestFollowedRow {
  intentId: string;
  tick: number;
  intentKind: string;
  sourceChatId: string;
  requestedChatId: string;
  localEpisodesWithin200Ticks: number;
  firstEpisodeTick: number;
}

export interface SwitchRequestStaleRow {
  intentId: string;
  tick: number;
  ageTicks: number;
  intentKind: string;
  sourceChatId: string;
  requestedChatId: string;
  reason: string;
}

interface JoinedCandidateRow {
  gatePlane: string;
  actionType: string;
  queueFate: string;
  actionResult: string;
}

const SELECTED_CANDIDATE_CONVERSION_SQL = `
WITH selected AS (
  SELECT candidate_id, action_type, gate_plane
  FROM candidate_trace
  WHERE selected = 1
),
queue_by_candidate AS (
  SELECT
    candidate_id,
    max(CASE WHEN fate = 'executed' THEN 1 ELSE 0 END) AS has_executed,
    max(CASE WHEN fate = 'accepted' THEN 1 ELSE 0 END) AS has_accepted,
    max(CASE WHEN fate = 'dropped' THEN 1 ELSE 0 END) AS has_dropped,
    max(CASE WHEN fate = 'expired' THEN 1 ELSE 0 END) AS has_expired
  FROM queue_trace
  GROUP BY candidate_id
),
result_by_candidate AS (
  SELECT
    candidate_id,
    count(DISTINCT result) AS distinct_results,
    max(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS has_success,
    max(CASE WHEN result = 'no_op' THEN 1 ELSE 0 END) AS has_no_op,
    max(CASE WHEN result = 'typed_failure' THEN 1 ELSE 0 END) AS has_typed_failure,
    max(CASE WHEN result = 'cancelled' THEN 1 ELSE 0 END) AS has_cancelled,
    max(CASE WHEN result = 'unknown_legacy' THEN 1 ELSE 0 END) AS has_unknown_legacy
  FROM action_result
  WHERE candidate_id IS NOT NULL
  GROUP BY candidate_id
)
SELECT
  s.gate_plane AS gatePlane,
  s.action_type AS actionType,
  CASE
    WHEN q.candidate_id IS NULL THEN 'missing'
    WHEN q.has_executed = 1 THEN 'executed'
    WHEN q.has_dropped = 1 THEN 'dropped'
    WHEN q.has_expired = 1 THEN 'expired'
    WHEN q.has_accepted = 1 THEN 'accepted_only'
    ELSE 'other'
  END AS queueFate,
  CASE
    WHEN r.candidate_id IS NULL THEN 'missing'
    WHEN r.distinct_results > 1 THEN 'mixed'
    WHEN r.has_success = 1 THEN 'success'
    WHEN r.has_no_op = 1 THEN 'no_op'
    WHEN r.has_typed_failure = 1 THEN 'typed_failure'
    WHEN r.has_cancelled = 1 THEN 'cancelled'
    WHEN r.has_unknown_legacy = 1 THEN 'unknown_legacy'
    ELSE 'other'
  END AS actionResult
FROM selected s
LEFT JOIN queue_by_candidate q ON q.candidate_id = s.candidate_id
LEFT JOIN result_by_candidate r ON r.candidate_id = s.candidate_id
`;

const SELECTED_CANDIDATE_OUTCOME_SQL = `
SELECT
  ct.gate_plane AS gatePlane,
  ct.action_type AS candidateAction,
  ar.result AS actionResult,
  coalesce(al.action_type, 'missing') AS actionLogType,
  coalesce(al.tc_afterward, 'none') AS tcAfterward,
  ar.failure_code AS failureCode,
  CASE
    WHEN ar.completed_action_refs_json = '[]' THEN 'empty'
    WHEN ar.completed_action_refs_json LIKE '%sent:%' THEN 'sent'
    WHEN ar.completed_action_refs_json LIKE '%forwarded:%' THEN 'forwarded'
    WHEN ar.completed_action_refs_json LIKE '%sticker:%' THEN 'sticker'
    WHEN ar.completed_action_refs_json LIKE '%reacted:%' THEN 'reacted'
    ELSE 'other'
  END AS completedActionKind,
  count(*) AS count
FROM candidate_trace ct
JOIN action_result ar ON ar.candidate_id = ct.candidate_id
LEFT JOIN action_log al ON al.id = ar.action_log_id
WHERE ct.selected = 1
GROUP BY
  ct.gate_plane,
  ct.action_type,
  ar.result,
  actionLogType,
  tcAfterward,
  ar.failure_code,
  completedActionKind
ORDER BY count(*) DESC
`;

const SELECTED_CANDIDATE_FAILURE_USE_CASE_SQL = `
SELECT
  CASE ar.failure_code
    WHEN 'command_cross_chat_send' THEN 'safety_boundary_cross_chat'
    WHEN 'command_invalid_target' THEN 'target_resolution_contract'
    WHEN 'invalid_reaction' THEN 'telegram_affordance_boundary'
    WHEN 'validation_failed' THEN 'script_schema_contract'
    WHEN 'script_failed' THEN 'mixed_script_runtime'
    ELSE 'other_failure'
  END AS useCase,
  ar.failure_code AS failureCode,
  coalesce(al.action_type, 'missing') AS actionLogType,
  ct.gate_plane AS gatePlane,
  ct.action_type AS candidateAction,
  count(*) AS count,
  coalesce(max(al.target), '') AS exampleTarget,
  coalesce(max(substr(al.reasoning, 1, 180)), '') AS exampleReasoning,
  coalesce(max(substr(al.tc_command_log, 1, 420)), '') AS exampleCommandLog
FROM candidate_trace ct
JOIN action_result ar ON ar.candidate_id = ct.candidate_id
LEFT JOIN action_log al ON al.id = ar.action_log_id
WHERE ct.selected = 1
  AND ar.result = 'typed_failure'
GROUP BY
  useCase,
  ar.failure_code,
  actionLogType,
  ct.gate_plane,
  ct.action_type
ORDER BY count(*) DESC
`;

const SELECTED_CANDIDATE_TRANSITION_SHADOW_SQL = `
SELECT
  *
FROM (
  SELECT
    fts.transition_class AS transitionClass,
    fts.evidence_status AS evidenceStatus,
    fts.source_command AS sourceCommand,
    fts.current_chat_id AS currentChatId,
    fts.requested_chat_id AS requestedChatId,
    coalesce(ct.gate_plane, 'missing') AS gatePlane,
    coalesce(ct.action_type, 'missing') AS candidateAction,
    coalesce(al.tc_afterward, 'none') AS tcAfterward,
    count(*) AS count,
    coalesce(max(al.target), '') AS exampleCurrentTarget,
    coalesce(max(substr(al.reasoning, 1, 180)), '') AS exampleReasoning,
    coalesce(max(substr(al.tc_command_log, 1, 420)), '') AS exampleCommandLog
  FROM focus_transition_shadow fts
  LEFT JOIN action_result ar ON ar.action_id = fts.action_id
  LEFT JOIN candidate_trace ct ON ct.candidate_id = coalesce(fts.candidate_id, ar.candidate_id)
  LEFT JOIN action_log al ON al.id = fts.action_log_id
  WHERE coalesce(ct.selected, 1) = 1
  GROUP BY
    fts.transition_class,
    fts.evidence_status,
    fts.source_command,
    fts.current_chat_id,
    fts.requested_chat_id,
    gatePlane,
    candidateAction,
    tcAfterward

  UNION ALL

  SELECT
    CASE
      WHEN fti.intent_kind = 'observe' THEN 'observe_intent'
      ELSE fti.intent_kind || '_intent'
    END AS transitionClass,
    'structured_transition_intent' AS evidenceStatus,
    fti.source_command AS sourceCommand,
    fti.source_chat_id AS currentChatId,
    fti.requested_chat_id AS requestedChatId,
    'intent_only' AS gatePlane,
    'attention_pull' AS candidateAction,
    'none' AS tcAfterward,
    count(*) AS count,
    '' AS exampleCurrentTarget,
    coalesce(max(substr(fti.reason, 1, 180)), '') AS exampleReasoning,
    '' AS exampleCommandLog
  FROM focus_transition_intent fti
  GROUP BY
    transitionClass,
    evidenceStatus,
    sourceCommand,
    currentChatId,
    requestedChatId,
    gatePlane,
    candidateAction,
    tcAfterward

  UNION ALL

  SELECT
    CASE
      WHEN coalesce(al.tc_afterward, 'none') IN ('waiting_reply', 'watching')
      THEN 'switch_or_answer_other_chat'
      ELSE 'cross_chat_send_attempt'
    END AS transitionClass,
    'requested_target_not_structured' AS evidenceStatus,
    '' AS sourceCommand,
    '' AS currentChatId,
    '' AS requestedChatId,
    ct.gate_plane AS gatePlane,
    ct.action_type AS candidateAction,
    coalesce(al.tc_afterward, 'none') AS tcAfterward,
    count(*) AS count,
    coalesce(max(al.target), '') AS exampleCurrentTarget,
    coalesce(max(substr(al.reasoning, 1, 180)), '') AS exampleReasoning,
    coalesce(max(substr(al.tc_command_log, 1, 420)), '') AS exampleCommandLog
  FROM candidate_trace ct
  JOIN action_result ar ON ar.candidate_id = ct.candidate_id
  LEFT JOIN action_log al ON al.id = ar.action_log_id
  LEFT JOIN focus_transition_shadow fts ON fts.action_id = ar.action_id
  WHERE ct.selected = 1
    AND ar.result = 'typed_failure'
    AND ar.failure_code = 'command_cross_chat_send'
    AND fts.action_id IS NULL
  GROUP BY
    transitionClass,
    evidenceStatus,
    sourceCommand,
    currentChatId,
    requestedChatId,
    ct.gate_plane,
    ct.action_type,
    tcAfterward
)
ORDER BY
  CASE WHEN evidenceStatus LIKE 'structured_%' THEN 0 ELSE 1 END,
  count DESC
`;

const POINT_TARGET_COMPAT_SQL = `
SELECT count(*) AS count
FROM candidate_trace ct
LEFT JOIN action_result ar ON ar.candidate_id = ct.candidate_id
LEFT JOIN focus_transition_shadow fts ON fts.action_id = ar.action_id
WHERE ct.selected = 1
  AND fts.id IS NULL
`;

const FOCUS_PATH_PROJECTION_SQL = `
WITH base AS (
  SELECT
    fts.transition_shadow_id AS pathId,
    fts.tick AS tick,
    fts.current_chat_id AS originChatId,
    fts.requested_chat_id AS requestedChatId,
    fts.transition_class AS transitionClass,
    fts.evidence_status AS evidenceStatus,
    fts.source_command AS sourceCommand,
    fts.source_target AS sourceTarget,
    fts.payload_json AS payloadJson,
    coalesce(ct.gate_plane, 'missing') AS gatePlane,
    coalesce(ct.action_type, 'missing') AS candidateAction,
    coalesce(ar.result, 'missing') AS actionResult,
    coalesce(ar.failure_code, 'missing') AS failureCode,
    coalesce(al.action_type, 'missing') AS actionLogType,
    coalesce(al.tc_afterward, 'none') AS tcAfterward,
    CASE
      WHEN ar.completed_action_refs_json IS NULL OR ar.completed_action_refs_json = '[]' THEN 'empty'
      WHEN ar.completed_action_refs_json LIKE '%forwarded:%' THEN 'forwarded'
      WHEN ar.completed_action_refs_json LIKE '%sent:%' THEN 'sent'
      WHEN ar.completed_action_refs_json LIKE '%sticker:%' THEN 'sticker'
      WHEN ar.completed_action_refs_json LIKE '%voice:%' THEN 'voice'
      WHEN ar.completed_action_refs_json LIKE '%sent-file:%' THEN 'sent-file'
      ELSE 'other'
    END AS completedActionKind,
    CASE
      WHEN al.tc_host_continuation_trace IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM json_each(al.tc_host_continuation_trace)
          WHERE value IN ('local_observation_followup', 'error_recovery')
        )
      THEN 1 ELSE 0
    END AS hasContinuationMerge,
    CASE
      WHEN fts.transition_class = 'switch_then_send_shadow'
        AND coalesce(ar.result, 'missing') = 'success'
      THEN 1 ELSE 0
    END AS hasMixedAction,
    CASE
      WHEN fts.evidence_status NOT LIKE 'structured_%'
      THEN 1 ELSE 0
    END AS hasUnstructuredFallback
  FROM focus_transition_shadow fts
  LEFT JOIN action_result ar ON ar.action_id = fts.action_id
  LEFT JOIN candidate_trace ct ON ct.candidate_id = coalesce(fts.candidate_id, ar.candidate_id)
  LEFT JOIN action_log al ON al.id = fts.action_log_id

  UNION ALL

  SELECT
    fti.intent_id AS pathId,
    fti.tick AS tick,
    fti.source_chat_id AS originChatId,
    fti.requested_chat_id AS requestedChatId,
    CASE
      WHEN fti.intent_kind = 'observe' THEN 'observe_intent'
      ELSE fti.intent_kind || '_intent'
    END AS transitionClass,
    'structured_transition_intent' AS evidenceStatus,
    fti.source_command AS sourceCommand,
    '' AS sourceTarget,
    fti.payload_json AS payloadJson,
    'intent_only' AS gatePlane,
    'attention_pull' AS candidateAction,
    'intent_recorded' AS actionResult,
    'N/A' AS failureCode,
    'attention_pull' AS actionLogType,
    'none' AS tcAfterward,
    'empty' AS completedActionKind,
    0 AS hasContinuationMerge,
    0 AS hasMixedAction,
    0 AS hasUnstructuredFallback
  FROM focus_transition_intent fti
)
SELECT
  pathId,
  tick,
  2 AS pathLength,
  originChatId,
  requestedChatId,
  transitionClass,
  CASE
    WHEN hasUnstructuredFallback = 1 THEN 'weak'
    WHEN hasContinuationMerge = 1 OR hasMixedAction = 1 THEN 'medium'
    ELSE 'strong'
  END AS evidenceStrength,
  CASE
    WHEN actionResult = 'missing' THEN 'pending'
    WHEN actionResult = 'intent_recorded' THEN 'pending'
    WHEN hasMixedAction = 1 THEN 'mixed'
    WHEN actionResult IN ('success', 'no_op') THEN 'completed'
    WHEN actionResult = 'typed_failure' THEN 'failed'
    ELSE 'mixed'
  END AS pathOutcome,
  trim(
    (CASE WHEN hasMixedAction = 1 THEN 'mixed_action ' ELSE '' END) ||
    (CASE WHEN hasContinuationMerge = 1 THEN 'continuation_merge ' ELSE '' END) ||
    (CASE WHEN hasUnstructuredFallback = 1 THEN 'unstructured_fallback ' ELSE '' END)
  ) AS contaminationFlags,
  sourceCommand,
  gatePlane,
  candidateAction,
  actionResult,
  failureCode,
  completedActionKind,
  tcAfterward,
  coalesce(sourceTarget, '') AS sourceTarget,
  coalesce(payloadJson, '{}') AS payloadJson
FROM base
ORDER BY tick DESC, pathId DESC
`;

const ATTENTION_PULL_PAIR_SQL = `
SELECT
  fti.source_chat_id AS sourceChatId,
  fti.requested_chat_id AS requestedChatId,
  count(*) AS count,
  max(fti.tick) AS latestTick,
  coalesce(
    (
      SELECT latest.reason
      FROM focus_transition_intent latest
      WHERE latest.source_command = 'self.attention-pull'
        AND latest.source_chat_id = fti.source_chat_id
        AND latest.requested_chat_id = fti.requested_chat_id
      ORDER BY latest.tick DESC, latest.id DESC
      LIMIT 1
    ),
    ''
  ) AS latestReason
FROM focus_transition_intent fti
WHERE fti.source_command = 'self.attention-pull'
GROUP BY fti.source_chat_id, fti.requested_chat_id
ORDER BY count DESC, latestTick DESC
`;

const ATTENTION_PULL_STALE_SQL = `
WITH latest_tick AS (
  SELECT coalesce(max(tick), 0) AS tick FROM tick_log
),
followup AS (
  SELECT
    fti.intent_id AS intentId,
    count(DISTINCT fts.id) + count(DISTINCT al.id) AS followupCount
  FROM focus_transition_intent fti
  LEFT JOIN focus_transition_shadow fts
    ON fts.tick > fti.tick
   AND fts.tick <= fti.tick + 200
   AND fts.current_chat_id = fti.source_chat_id
   AND fts.requested_chat_id = fti.requested_chat_id
  LEFT JOIN action_log al
    ON al.tick > fti.tick
   AND al.tick <= fti.tick + 200
   AND al.target = 'channel:' || fti.requested_chat_id
  WHERE fti.source_command = 'self.attention-pull'
  GROUP BY fti.intent_id
)
SELECT
  fti.intent_id AS intentId,
  fti.tick AS tick,
  latest_tick.tick - fti.tick AS ageTicks,
  fti.source_chat_id AS sourceChatId,
  fti.requested_chat_id AS requestedChatId,
  fti.reason AS reason
FROM focus_transition_intent fti
CROSS JOIN latest_tick
LEFT JOIN followup ON followup.intentId = fti.intent_id
WHERE fti.source_command = 'self.attention-pull'
  AND latest_tick.tick - fti.tick > 200
  AND coalesce(followup.followupCount, 0) = 0
ORDER BY ageTicks DESC, fti.tick ASC
LIMIT 12
`;

const ATTENTION_PULL_RAW_CROSS_CHAT_AFTER_SQL = `
SELECT
  fti.intent_id AS intentId,
  fti.tick AS tick,
  fti.source_chat_id AS sourceChatId,
  fti.requested_chat_id AS requestedChatId,
  count(ar.action_id) AS rawCrossChatFailuresWithin50Ticks
FROM focus_transition_intent fti
LEFT JOIN action_result ar
  ON ar.tick > fti.tick
 AND ar.tick <= fti.tick + 50
 AND ar.result = 'typed_failure'
 AND ar.failure_code = 'command_cross_chat_send'
 AND ar.target_id = fti.requested_chat_id
WHERE fti.source_command = 'self.attention-pull'
GROUP BY
  fti.intent_id,
  fti.tick,
  fti.source_chat_id,
  fti.requested_chat_id
HAVING rawCrossChatFailuresWithin50Ticks > 0
ORDER BY rawCrossChatFailuresWithin50Ticks DESC, fti.tick DESC
LIMIT 12
`;

const ATTENTION_PULL_REASON_SAMPLE_SQL = `
SELECT
  intent_id AS intentId,
  tick,
  source_chat_id AS sourceChatId,
  requested_chat_id AS requestedChatId,
  reason
FROM focus_transition_intent
WHERE source_command = 'self.attention-pull'
ORDER BY tick DESC, id DESC
LIMIT 8
`;

const SWITCH_REQUEST_SUMMARY_SQL = `
SELECT
  count(*) AS total,
  sum(CASE WHEN intent_kind = 'switch_request' THEN 1 ELSE 0 END) AS explicitRequests,
  sum(CASE WHEN intent_kind = 'switch_request_blocked' THEN 1 ELSE 0 END) AS blockedRequests,
  count(DISTINCT source_chat_id) AS distinctSources,
  count(DISTINCT requested_chat_id) AS distinctRequested
FROM focus_transition_intent
WHERE intent_kind IN ('switch_request', 'switch_request_blocked')
`;

const SWITCH_REQUEST_PAIR_SQL = `
SELECT
  fti.intent_kind AS intentKind,
  fti.source_chat_id AS sourceChatId,
  fti.requested_chat_id AS requestedChatId,
  count(*) AS count,
  max(fti.tick) AS latestTick,
  coalesce(
    (
      SELECT latest.reason
      FROM focus_transition_intent latest
      WHERE latest.intent_kind = fti.intent_kind
        AND latest.source_chat_id = fti.source_chat_id
        AND latest.requested_chat_id = fti.requested_chat_id
      ORDER BY latest.tick DESC, latest.id DESC
      LIMIT 1
    ),
    ''
  ) AS latestReason
FROM focus_transition_intent fti
WHERE fti.intent_kind IN ('switch_request', 'switch_request_blocked')
GROUP BY fti.intent_kind, fti.source_chat_id, fti.requested_chat_id
ORDER BY count DESC, latestTick DESC
LIMIT 16
`;

const SWITCH_REQUEST_REPEATED_BLOCKED_SQL = `
SELECT
  fti.intent_id AS intentId,
  fti.tick AS tick,
  fti.intent_kind AS intentKind,
  fti.source_chat_id AS sourceChatId,
  fti.requested_chat_id AS requestedChatId,
  count(later.id) AS blockedAgainWithin50Ticks
FROM focus_transition_intent fti
LEFT JOIN focus_transition_intent later
  ON later.tick > fti.tick
 AND later.tick <= fti.tick + 50
 AND later.intent_kind = 'switch_request_blocked'
 AND later.source_chat_id = fti.source_chat_id
 AND later.requested_chat_id = fti.requested_chat_id
WHERE fti.intent_kind IN ('switch_request', 'switch_request_blocked')
GROUP BY
  fti.intent_id,
  fti.tick,
  fti.intent_kind,
  fti.source_chat_id,
  fti.requested_chat_id
HAVING blockedAgainWithin50Ticks > 0
ORDER BY blockedAgainWithin50Ticks DESC, fti.tick DESC
LIMIT 12
`;

const SWITCH_REQUEST_FOLLOWED_SQL = `
SELECT
  fti.intent_id AS intentId,
  fti.tick AS tick,
  fti.intent_kind AS intentKind,
  fti.source_chat_id AS sourceChatId,
  fti.requested_chat_id AS requestedChatId,
  count(DISTINCT al.id) AS localEpisodesWithin200Ticks,
  min(al.tick) AS firstEpisodeTick
FROM focus_transition_intent fti
JOIN action_log al
  ON al.tick > fti.tick
 AND al.tick <= fti.tick + 200
 AND al.target = 'channel:' || fti.requested_chat_id
WHERE fti.intent_kind IN ('switch_request', 'switch_request_blocked')
GROUP BY
  fti.intent_id,
  fti.tick,
  fti.intent_kind,
  fti.source_chat_id,
  fti.requested_chat_id
ORDER BY fti.tick DESC
LIMIT 12
`;

const SWITCH_REQUEST_STALE_SQL = `
WITH latest_tick AS (
  SELECT coalesce(max(tick), 0) AS tick FROM tick_log
),
followup AS (
  SELECT
    fti.intent_id AS intentId,
    count(DISTINCT al.id) AS followupCount
  FROM focus_transition_intent fti
  LEFT JOIN action_log al
    ON al.tick > fti.tick
   AND al.tick <= fti.tick + 200
   AND al.target = 'channel:' || fti.requested_chat_id
  WHERE fti.intent_kind IN ('switch_request', 'switch_request_blocked')
  GROUP BY fti.intent_id
)
SELECT
  fti.intent_id AS intentId,
  fti.tick AS tick,
  latest_tick.tick - fti.tick AS ageTicks,
  fti.intent_kind AS intentKind,
  fti.source_chat_id AS sourceChatId,
  fti.requested_chat_id AS requestedChatId,
  fti.reason AS reason
FROM focus_transition_intent fti
CROSS JOIN latest_tick
LEFT JOIN followup ON followup.intentId = fti.intent_id
WHERE fti.intent_kind IN ('switch_request', 'switch_request_blocked')
  AND latest_tick.tick - fti.tick > 200
  AND coalesce(followup.followupCount, 0) = 0
ORDER BY ageTicks DESC, fti.tick ASC
LIMIT 12
`;

export function analyzeExecutionConversion(): ExecutionConversionReport {
  const rows = getSqlite().prepare(SELECTED_CANDIDATE_CONVERSION_SQL).all() as JoinedCandidateRow[];
  const outcomeRows = getSqlite()
    .prepare(SELECTED_CANDIDATE_OUTCOME_SQL)
    .all() as ExecutionConversionOutcomeRow[];
  const failureUseCases = getSqlite()
    .prepare(SELECTED_CANDIDATE_FAILURE_USE_CASE_SQL)
    .all() as ExecutionConversionFailureUseCaseRow[];
  const transitionShadows = getSqlite()
    .prepare(SELECTED_CANDIDATE_TRANSITION_SHADOW_SQL)
    .all() as ExecutionConversionTransitionShadowRow[];
  const pointTargetRows = Number(
    (getSqlite().prepare(POINT_TARGET_COMPAT_SQL).get() as { count?: number } | undefined)?.count ??
      0,
  );
  const transitionRows = getSqlite()
    .prepare(FOCUS_PATH_PROJECTION_SQL)
    .all() as FocusPathProjectionRow[];
  const attentionPairRows = getSqlite()
    .prepare(ATTENTION_PULL_PAIR_SQL)
    .all() as AttentionPullPairRow[];
  const attentionStaleRows = getSqlite()
    .prepare(ATTENTION_PULL_STALE_SQL)
    .all() as AttentionPullStaleRow[];
  const attentionRawCrossChatAfterRows = getSqlite()
    .prepare(ATTENTION_PULL_RAW_CROSS_CHAT_AFTER_SQL)
    .all() as AttentionPullRawCrossChatAfterRow[];
  const attentionReasonSamples = getSqlite()
    .prepare(ATTENTION_PULL_REASON_SAMPLE_SQL)
    .all() as AttentionPullReasonSample[];
  const switchSummary = getSqlite().prepare(SWITCH_REQUEST_SUMMARY_SQL).get() as
    | SwitchRequestSummaryRow
    | undefined;
  const switchPairRows = getSqlite()
    .prepare(SWITCH_REQUEST_PAIR_SQL)
    .all() as SwitchRequestPairRow[];
  const switchRepeatedBlockedRows = getSqlite()
    .prepare(SWITCH_REQUEST_REPEATED_BLOCKED_SQL)
    .all() as SwitchRequestRepeatedBlockedRow[];
  const switchFollowedRows = getSqlite()
    .prepare(SWITCH_REQUEST_FOLLOWED_SQL)
    .all() as SwitchRequestFollowedRow[];
  const switchStaleRows = getSqlite()
    .prepare(SWITCH_REQUEST_STALE_SQL)
    .all() as SwitchRequestStaleRow[];
  const planeMap = new Map<string, ExecutionConversionPlaneSummary>();
  const detailMap = new Map<string, ExecutionConversionDetailRow>();

  for (const row of rows) {
    const summary = getOrCreatePlaneSummary(planeMap, row.gatePlane);
    summary.selected++;
    incrementQueue(summary, row.queueFate);
    incrementResult(summary, row.actionResult);

    const detailKey = [row.gatePlane, row.actionType, row.queueFate, row.actionResult].join(
      "\u0000",
    );
    const detail =
      detailMap.get(detailKey) ??
      ({
        gatePlane: row.gatePlane,
        actionType: row.actionType,
        queueFate: row.queueFate,
        actionResult: row.actionResult,
        count: 0,
      } satisfies ExecutionConversionDetailRow);
    detail.count++;
    detailMap.set(detailKey, detail);
  }

  const planeSummaries = [...planeMap.values()]
    .map((summary) => ({
      ...summary,
      successRate: rate(summary.success, summary.selected),
      noOpRate: rate(summary.noOp, summary.selected),
      typedFailureRate: rate(summary.typedFailure, summary.selected),
      missingResultRate: rate(summary.missingResult, summary.selected),
    }))
    .sort((a, b) => b.selected - a.selected);

  const detailRows = [...detailMap.values()].sort((a, b) => b.count - a.count);
  const summaryRows = summarizeFocusPathProjection(pointTargetRows, transitionRows);
  const attentionTotal = attentionPairRows.reduce((sum, row) => sum + row.count, 0);
  const topRequestedCount = maxRequestedCount(attentionPairRows);

  return {
    totalSelected: rows.length,
    planeSummaries,
    detailRows,
    outcomeRows,
    failureUseCases,
    transitionShadows,
    focusPathProjection: {
      pointTargetRows,
      transitionRows,
      summaryRows,
    },
    attentionPullAudit: {
      total: attentionTotal,
      distinctSources: new Set(attentionPairRows.map((row) => row.sourceChatId)).size,
      distinctRequested: new Set(attentionPairRows.map((row) => row.requestedChatId)).size,
      topRequestedRate: rate(topRequestedCount, attentionTotal),
      sourceRequestedRows: attentionPairRows,
      staleRows: attentionStaleRows,
      rawCrossChatAfterRows: attentionRawCrossChatAfterRows,
      reasonSamples: attentionReasonSamples,
    },
    switchRequestAudit: {
      total: switchSummary?.total ?? 0,
      explicitRequests: switchSummary?.explicitRequests ?? 0,
      blockedRequests: switchSummary?.blockedRequests ?? 0,
      distinctSources: switchSummary?.distinctSources ?? 0,
      distinctRequested: switchSummary?.distinctRequested ?? 0,
      pairRows: switchPairRows,
      repeatedBlockedRows: switchRepeatedBlockedRows,
      followedRows: switchFollowedRows,
      staleRows: switchStaleRows,
    },
  };
}

export function renderExecutionConversionReport(report: ExecutionConversionReport): string {
  const lines = ["── A2b: 执行转化面 ──"];
  lines.push(`selected candidates: ${report.totalSelected}`);
  lines.push("按 gate plane:");
  for (const row of report.planeSummaries) {
    lines.push(
      `  ${row.gatePlane.padEnd(24)} n=${String(row.selected).padStart(4)} executed=${row.executed} accepted_only=${row.acceptedOnly} dropped=${row.dropped} expired=${row.expired} q_missing=${row.missingQueue} success=${formatRate(row.success, row.successRate)} no_op=${formatRate(row.noOp, row.noOpRate)} typed_failure=${formatRate(row.typedFailure, row.typedFailureRate)} result_missing=${formatRate(row.missingResult, row.missingResultRate)}`,
    );
  }
  lines.push("主要转化路径:");
  for (const row of report.detailRows.slice(0, 12)) {
    lines.push(
      `  ${row.gatePlane.padEnd(18)} ${row.actionType.padEnd(12)} queue=${row.queueFate.padEnd(13)} result=${row.actionResult.padEnd(13)} ${row.count}`,
    );
  }
  lines.push("no_op 来源:");
  for (const row of report.outcomeRows.filter((row) => row.actionResult === "no_op").slice(0, 10)) {
    lines.push(
      `  ${row.gatePlane.padEnd(18)} ${row.candidateAction.padEnd(12)} act=${row.actionLogType.padEnd(8)} afterward=${row.tcAfterward.padEnd(13)} completed=${row.completedActionKind.padEnd(8)} ${row.count}`,
    );
  }
  lines.push("typed_failure 来源:");
  for (const row of report.outcomeRows
    .filter((row) => row.actionResult === "typed_failure")
    .slice(0, 12)) {
    lines.push(
      `  ${row.gatePlane.padEnd(18)} ${row.candidateAction.padEnd(12)} code=${row.failureCode.padEnd(24)} afterward=${row.tcAfterward.padEnd(13)} ${row.count}`,
    );
  }
  lines.push("typed_failure 用例分类:");
  for (const row of report.failureUseCases.slice(0, 10)) {
    lines.push(
      `  ${row.useCase.padEnd(28)} code=${row.failureCode.padEnd(24)} plane=${row.gatePlane.padEnd(18)} action=${row.candidateAction.padEnd(12)} n=${row.count}`,
    );
    if (row.exampleReasoning) lines.push(`    why: ${oneLine(row.exampleReasoning)}`);
    if (row.exampleCommandLog) lines.push(`    ex: ${oneLine(row.exampleCommandLog)}`);
  }
  lines.push("cross-chat transition shadow:");
  const structuredShadows = report.transitionShadows.filter((row) =>
    row.evidenceStatus.startsWith("structured_"),
  );
  if (structuredShadows.length > 0) {
    lines.push("  structured transition evidence:");
    for (const row of structuredShadows.slice(0, 8)) {
      lines.push(
        `    ${row.transitionClass.padEnd(26)} source=${(row.sourceCommand || "unknown").padEnd(12)} current=@${(row.currentChatId || "unknown").padEnd(16)} requested=@${(row.requestedChatId || "unknown").padEnd(16)} plane=${row.gatePlane.padEnd(18)} action=${row.candidateAction.padEnd(12)} n=${row.count}`,
      );
    }
  }
  for (const row of report.transitionShadows
    .filter((row) => !row.evidenceStatus.startsWith("structured_"))
    .slice(0, 8)) {
    lines.push(
      `  ${row.transitionClass.padEnd(28)} evidence=${row.evidenceStatus.padEnd(31)} plane=${row.gatePlane.padEnd(18)} action=${row.candidateAction.padEnd(12)} afterward=${row.tcAfterward.padEnd(13)} n=${row.count}`,
    );
    if (row.sourceCommand || row.requestedChatId) {
      lines.push(
        `    structured: source=${row.sourceCommand || "unknown"} current=@${row.currentChatId || "unknown"} requested=@${row.requestedChatId || "unknown"}`,
      );
    }
    if (row.exampleCurrentTarget) lines.push(`    current: ${oneLine(row.exampleCurrentTarget)}`);
    if (row.exampleReasoning) lines.push(`    why: ${oneLine(row.exampleReasoning)}`);
    if (row.exampleCommandLog) lines.push(`    ex: ${oneLine(row.exampleCommandLog)}`);
  }
  lines.push("focus path projection:");
  lines.push(`  length=1 point-target rows: ${report.focusPathProjection.pointTargetRows}`);
  lines.push("  length>=2 transition rows:");
  for (const row of report.focusPathProjection.summaryRows.slice(0, 10)) {
    lines.push(
      `    len=${row.pathLength} ${row.transitionClass.padEnd(24)} evidence=${row.evidenceStrength.padEnd(6)} outcome=${row.pathOutcome.padEnd(9)} n=${row.count}`,
    );
  }
  lines.push("  recent paths:");
  for (const row of report.focusPathProjection.transitionRows.slice(0, 8)) {
    const flags = row.contaminationFlags || "clean";
    lines.push(
      `    ${row.pathId} tick=${row.tick} ${row.originChatId}->${row.requestedChatId} ${row.transitionClass} evidence=${row.evidenceStrength} outcome=${row.pathOutcome} flags=${flags}`,
    );
  }
  lines.push("attention-pull audit:");
  lines.push(
    `  total=${report.attentionPullAudit.total} sources=${report.attentionPullAudit.distinctSources} requested=${report.attentionPullAudit.distinctRequested} top_requested_rate=${formatPercent(report.attentionPullAudit.topRequestedRate)}`,
  );
  if (report.attentionPullAudit.sourceRequestedRows.length > 0) {
    lines.push("  source -> requested:");
    for (const row of report.attentionPullAudit.sourceRequestedRows.slice(0, 8)) {
      lines.push(
        `    ${row.sourceChatId}->${row.requestedChatId} n=${row.count} latest_tick=${row.latestTick} reason=${oneLine(row.latestReason)}`,
      );
    }
  }
  if (report.attentionPullAudit.rawCrossChatAfterRows.length > 0) {
    lines.push("  raw cross-chat send after attention-pull:");
    for (const row of report.attentionPullAudit.rawCrossChatAfterRows.slice(0, 8)) {
      lines.push(
        `    ${row.intentId} tick=${row.tick} ${row.sourceChatId}->${row.requestedChatId} failures_50t=${row.rawCrossChatFailuresWithin50Ticks}`,
      );
    }
  }
  if (report.attentionPullAudit.staleRows.length > 0) {
    lines.push("  stale pulls without structured follow-up within 200 ticks:");
    for (const row of report.attentionPullAudit.staleRows.slice(0, 8)) {
      lines.push(
        `    ${row.intentId} age=${row.ageTicks}t ${row.sourceChatId}->${row.requestedChatId} reason=${oneLine(row.reason)}`,
      );
    }
  }
  if (report.attentionPullAudit.reasonSamples.length > 0) {
    lines.push("  recent reasons for human review:");
    for (const row of report.attentionPullAudit.reasonSamples.slice(0, 5)) {
      lines.push(
        `    tick=${row.tick} ${row.sourceChatId}->${row.requestedChatId} reason=${oneLine(row.reason)}`,
      );
    }
  }
  lines.push("switch request audit:");
  lines.push(
    `  total=${report.switchRequestAudit.total} explicit=${report.switchRequestAudit.explicitRequests} blocked=${report.switchRequestAudit.blockedRequests} sources=${report.switchRequestAudit.distinctSources} requested=${report.switchRequestAudit.distinctRequested}`,
  );
  if (report.switchRequestAudit.pairRows.length > 0) {
    lines.push("  source -> requested:");
    for (const row of report.switchRequestAudit.pairRows.slice(0, 8)) {
      lines.push(
        `    ${row.intentKind} ${row.sourceChatId}->${row.requestedChatId} n=${row.count} latest_tick=${row.latestTick} reason=${oneLine(row.latestReason)}`,
      );
    }
  }
  if (report.switchRequestAudit.repeatedBlockedRows.length > 0) {
    lines.push("  repeated blocked send after request within 50 ticks:");
    for (const row of report.switchRequestAudit.repeatedBlockedRows.slice(0, 8)) {
      lines.push(
        `    ${row.intentId} tick=${row.tick} ${row.intentKind} ${row.sourceChatId}->${row.requestedChatId} blocked_again=${row.blockedAgainWithin50Ticks}`,
      );
    }
  }
  if (report.switchRequestAudit.followedRows.length > 0) {
    lines.push("  followed by requested-chat local episode within 200 ticks:");
    for (const row of report.switchRequestAudit.followedRows.slice(0, 8)) {
      lines.push(
        `    ${row.intentId} tick=${row.tick} ${row.intentKind} ${row.sourceChatId}->${row.requestedChatId} episodes=${row.localEpisodesWithin200Ticks} first_tick=${row.firstEpisodeTick}`,
      );
    }
  }
  if (report.switchRequestAudit.staleRows.length > 0) {
    lines.push("  stale switch requests without local episode within 200 ticks:");
    for (const row of report.switchRequestAudit.staleRows.slice(0, 8)) {
      lines.push(
        `    ${row.intentId} age=${row.ageTicks}t ${row.intentKind} ${row.sourceChatId}->${row.requestedChatId} reason=${oneLine(row.reason)}`,
      );
    }
  }
  return lines.join("\n");
}

function summarizeFocusPathProjection(
  pointTargetRows: number,
  transitionRows: readonly FocusPathProjectionRow[],
): FocusPathProjectionSummaryRow[] {
  const rows = new Map<string, FocusPathProjectionSummaryRow>();
  if (pointTargetRows > 0) {
    rows.set("1\u0000point_target\u0000strong\u0000completed", {
      pathLength: 1,
      transitionClass: "point_target",
      evidenceStrength: "strong",
      pathOutcome: "completed",
      count: pointTargetRows,
    });
  }
  for (const row of transitionRows) {
    const key = [row.pathLength, row.transitionClass, row.evidenceStrength, row.pathOutcome].join(
      "\u0000",
    );
    const existing =
      rows.get(key) ??
      ({
        pathLength: row.pathLength,
        transitionClass: row.transitionClass,
        evidenceStrength: row.evidenceStrength,
        pathOutcome: row.pathOutcome,
        count: 0,
      } satisfies FocusPathProjectionSummaryRow);
    existing.count++;
    rows.set(key, existing);
  }
  return [...rows.values()].sort((a, b) => {
    if (a.pathLength !== b.pathLength) return a.pathLength - b.pathLength;
    return b.count - a.count;
  });
}

function getOrCreatePlaneSummary(
  map: Map<string, ExecutionConversionPlaneSummary>,
  gatePlane: string,
): ExecutionConversionPlaneSummary {
  const existing = map.get(gatePlane);
  if (existing) return existing;
  const created: ExecutionConversionPlaneSummary = {
    gatePlane,
    selected: 0,
    executed: 0,
    acceptedOnly: 0,
    dropped: 0,
    expired: 0,
    missingQueue: 0,
    success: 0,
    noOp: 0,
    typedFailure: 0,
    cancelled: 0,
    unknownLegacy: 0,
    missingResult: 0,
    successRate: 0,
    noOpRate: 0,
    typedFailureRate: 0,
    missingResultRate: 0,
  };
  map.set(gatePlane, created);
  return created;
}

function incrementQueue(summary: ExecutionConversionPlaneSummary, queueFate: string): void {
  if (queueFate === "executed") summary.executed++;
  else if (queueFate === "accepted_only") summary.acceptedOnly++;
  else if (queueFate === "dropped") summary.dropped++;
  else if (queueFate === "expired") summary.expired++;
  else if (queueFate === "missing") summary.missingQueue++;
}

function incrementResult(summary: ExecutionConversionPlaneSummary, actionResult: string): void {
  if (actionResult === "success") summary.success++;
  else if (actionResult === "no_op") summary.noOp++;
  else if (actionResult === "typed_failure") summary.typedFailure++;
  else if (actionResult === "cancelled") summary.cancelled++;
  else if (actionResult === "unknown_legacy") summary.unknownLegacy++;
  else if (actionResult === "missing") summary.missingResult++;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function maxRequestedCount(rows: readonly AttentionPullPairRow[]): number {
  const byRequested = new Map<string, number>();
  for (const row of rows) {
    byRequested.set(row.requestedChatId, (byRequested.get(row.requestedChatId) ?? 0) + row.count);
  }
  return Math.max(0, ...byRequested.values());
}

function formatRate(count: number, value: number): string {
  return `${count}(${formatPercent(value)})`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 240);
}
