/**
 * ADR-263 Wave 4.5: fixed calibration cases for group reception shadow judge.
 *
 * These cases test whether the Ax judge can explain semantic reception cases
 * that keyword and reply-count heuristics handle poorly. They are not runtime
 * authority and must not be copied into production prompt text dynamically.
 *
 * @see docs/adr/263-ax-llm-program-optimization/README.md
 * @see docs/adr/255-intervention-outcome-truth-model/README.md
 */

export type GroupReceptionOutcome = "warm_reply" | "cold_ignored" | "hostile" | "unknown_timeout";

export type GroupReceptionCalibrationCase = {
  id: string;
  label: string;
  aliceMessage: string;
  followUpMessages: string;
  observation: string;
  expectedOutcome: GroupReceptionOutcome;
  deterministicOutcome: GroupReceptionOutcome | null;
  minConfidence: number;
};

export function groupReceptionCalibrationCases(): readonly GroupReceptionCalibrationCase[] {
  return [
    {
      id: "reception.hostile.keyword",
      label: "Explicit hostile rejection with keyword",
      aliceMessage: [
        "db_id=101",
        "telegram_msg_id=7001",
        "created_at_ms=1770000000000",
        "text=我插一句，这个方案可能要先看日志。",
      ].join("\n"),
      followUpMessages: "db_id=201 not_reply: 谁问你了，闭嘴",
      observation: [
        "afterMessageCount=1",
        "replyToAliceCount=0",
        "hostileMatchCount=1",
        "elapsedMs=60000",
      ].join("\n"),
      expectedOutcome: "hostile",
      deterministicOutcome: "hostile",
      minConfidence: 0.65,
    },
    {
      id: "reception.hostile.no-keyword",
      label: "Hostile rejection without current keyword",
      aliceMessage: [
        "db_id=102",
        "telegram_msg_id=7002",
        "created_at_ms=1770000000000",
        "text=我觉得可以先把需求拆小一点。",
      ].join("\n"),
      followUpMessages: "db_id=202 not_reply: 你别插话，没人想听你说这个",
      observation: [
        "afterMessageCount=1",
        "replyToAliceCount=0",
        "hostileMatchCount=0",
        "elapsedMs=60000",
      ].join("\n"),
      expectedOutcome: "hostile",
      deterministicOutcome: null,
      minConfidence: 0.6,
    },
    {
      id: "reception.warm.semantic-no-reply-marker",
      label: "Semantic warm response without Telegram reply marker",
      aliceMessage: [
        "db_id=103",
        "telegram_msg_id=7003",
        "created_at_ms=1770000000000",
        "text=这个 bug 可能是缓存没失效，我建议先清缓存再测。",
      ].join("\n"),
      followUpMessages: "db_id=203 not_reply: 对，我刚清了缓存就好了，确实是这个",
      observation: [
        "afterMessageCount=1",
        "replyToAliceCount=0",
        "hostileMatchCount=0",
        "elapsedMs=60000",
      ].join("\n"),
      expectedOutcome: "warm_reply",
      deterministicOutcome: null,
      minConfidence: 0.6,
    },
    {
      id: "reception.warm.keyword-false-positive",
      label: "Warm reply that contains a hostile keyword as topic sentiment",
      aliceMessage: [
        "db_id=104",
        "telegram_msg_id=7004",
        "created_at_ms=1770000000000",
        "text=这个报错我也遇到过，可能是依赖版本冲突。",
      ].join("\n"),
      followUpMessages: "db_id=204 not_reply: 这个依赖真的很烦，不过你说得对，锁版本就好了",
      observation: [
        "afterMessageCount=1",
        "replyToAliceCount=0",
        "hostileMatchCount=1",
        "elapsedMs=60000",
      ].join("\n"),
      expectedOutcome: "warm_reply",
      deterministicOutcome: "hostile",
      minConfidence: 0.55,
    },
    {
      id: "reception.cold.topic-continues-around-alice",
      label: "Group continues unrelated discussion after Alice",
      aliceMessage: [
        "db_id=105",
        "telegram_msg_id=7005",
        "created_at_ms=1770000000000",
        "text=我可以帮忙看一下这个部署问题。",
      ].join("\n"),
      followUpMessages: [
        "db_id=205 not_reply: 中午吃什么",
        "db_id=206 not_reply: 我投拉面",
        "db_id=207 not_reply: 下午三点开会吗",
        "db_id=208 not_reply: 开，会议室 B",
        "db_id=209 not_reply: 收到",
      ].join("\n"),
      observation: [
        "afterMessageCount=5",
        "replyToAliceCount=0",
        "hostileMatchCount=0",
        "elapsedMs=120000",
      ].join("\n"),
      expectedOutcome: "cold_ignored",
      deterministicOutcome: "cold_ignored",
      minConfidence: 0.6,
    },
    {
      id: "reception.unknown.too-little-evidence",
      label: "Too little follow-up evidence after timeout",
      aliceMessage: [
        "db_id=106",
        "telegram_msg_id=7006",
        "created_at_ms=1770000000000",
        "text=如果你们需要，我晚点补一个例子。",
      ].join("\n"),
      followUpMessages: "db_id=206 not_reply: 嗯",
      observation: [
        "afterMessageCount=1",
        "replyToAliceCount=0",
        "hostileMatchCount=0",
        "elapsedMs=660000",
      ].join("\n"),
      expectedOutcome: "unknown_timeout",
      deterministicOutcome: "unknown_timeout",
      minConfidence: 0.5,
    },
  ];
}
