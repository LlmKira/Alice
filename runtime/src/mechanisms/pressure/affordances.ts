/**
 * 意愿层读的 affordance：就是 mind/affordances.ts 的登记表。意愿只读下面这些字段，不为任何具体动作写分支，
 * 新增一种能力只需在登记表加一行。
 */
import type { Affordance } from "../../mind/affordances.js";

export type { ChatView } from "../../mind/affordances.js";

export type WillAffordance = Pick<
  Affordance,
  | "kind"
  | "appliesTo"
  | "available"
  | "wakes"
  | "relieves"
  | "intrusiveness"
  | "posts"
  | "deliberate"
  | "after"
  | "gated"
>;
