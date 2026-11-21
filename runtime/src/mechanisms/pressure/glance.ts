/**
 * 看一眼（候选 glance，eval-artifacts/glance/prereg.md；capabilities M25）：群里一有未读，意愿层就为一个表情叫醒模型
 * 让她想一次（线上 2026-11-12：47 次唤醒里 32 次是节律到点、31 次排第一的是"点个表情缓解未读"，醒来 27 次没说话）。
 *
 * 为什么：对进来的东西，人先由快、省力的过程给默认反应，只在被线索提起时才斟酌（默认—干预式双过程，Evans &
 * Stanovich 2013）；手机上相当一部分使用就是不到 30 秒的查看——看一眼、放下（Oulasvirta 等 2012）。未读的拉力由
 * "看了"本身缓解；值得斟酌的是看之外还剩下的：有人在等她、她在这段对话里、她想在群里有存在感或想找某人、
 * 她答应过的事、想离开。2 月的 System 1 digest（标已读 + 浅层更新）是同一件事，它上面的概率泄漏是补丁，不移植。
 *
 * 落在意愿层里（不加规则、不加常数）：
 * - 看一眼就是登记表里的 mark-read（缓解 attention、deliberate: false）。节律到点时它也参加跨会话排序；排第一时
 *   压力场的理由是 glance，核心不叫醒模型，写 chat.glanced，世界里未读清零、习惯化 +1（world.ts），Telegram 标已读。
 * - 要斟酌的动作只有 NSV 比看一眼高才排在前面：多出来的缓解（冷却、义务、线程……）要盖过侵入度之差和饱和代价。
 *   看一眼不消耗群聊存在感，所以存在感长到说一句比看一眼更值时，她才被叫醒想要不要插话。
 * - 节律路径上只有会留下她一条消息（posts）或改变她在不在这里（退群、加群）的动作叫醒她：表情是醒着时的事。
 *   消融 glance-react 让表情照旧能叫醒她（它的缓解总不小于看一眼、侵入度相同，预测调用回到 production）。
 * - 有人在等她、她在这段对话里时不看一眼（index.ts willWake）；被点名、在对话里的两条路径不变。
 */
import { memberAfter } from "../../mind/affordances.js";
import { feature, type PressureFeature } from "./feature.js";

export interface GlanceOptions {
  /** 表情照旧能在节律路径上叫醒她（消融 glance-react）。 */
  reactions: boolean;
}

export function glance(o: GlanceOptions = { reactions: false }): PressureFeature {
  return feature({
    name: o.reactions ? "glance-react" : "glance",
    requires: [],
    glance: {
      wakes: (row) => o.reactions || row.posts !== undefined || memberAfter(row) !== undefined,
    },
  });
}
