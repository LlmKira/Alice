/**
 * Mod 加载器 — 注册所有 Alice Mods。
 *
 * 按依赖顺序加载，确保 depends 在前。
 * 未来可扩展为动态发现（扫描 mods/ 文件夹）。
 *
 * 参考: narrative-engine/core/engine.ts (mod registration)
 */
import { channelMod } from "../mods/channel.mod.js";
import { consciousnessMod } from "../mods/consciousness.mod.js";
import { consolidationMod } from "../mods/consolidation.mod.js";
import { diaryMod } from "../mods/diary.mod.js";
import { episodeMod } from "../mods/episode.mod.js";
import { feedsMod } from "../mods/feeds.mod.js";
import { learningMod } from "../mods/learning.mod.js";
import { memoryMod } from "../mods/memory.mod.js";
import { observerMod } from "../mods/observer.mod.js";
import { pressureMod } from "../mods/pressure.mod.js";
import { relationshipsMod } from "../mods/relationships.mod.js";
import { schedulerMod } from "../mods/scheduler.mod.js";
import { socialCaseMod } from "../mods/social-case.mod.js";
import { soulMod } from "../mods/soul.mod.js";
import { strategyMod } from "../mods/strategy.mod.js";
import { threadsMod } from "../mods/threads.mod.js";
import type { ModDefinition } from "./types.js";

/**
 * 加载所有 Mod，按依赖顺序排列。
 * 无依赖的 core mod 在前，有依赖的 mechanic mod 在后。
 *
 * director.mod 已冻结（M1 阶段）：
 * - NTI 计算与压力场 P1-P6 概念重叠（§17 差距 7）
 * - 压力感知由 pressure.mod 接管
 * - beat echo 和 whisper 如有需要将迁移到 threads.mod
 */
export function loadAllMods(): ModDefinition[] {
  return [
    soulMod,
    pressureMod,
    memoryMod,
    threadsMod,
    socialCaseMod,
    relationshipsMod,
    observerMod,
    consolidationMod,
    learningMod,
    consciousnessMod,
    strategyMod,
    schedulerMod,
    feedsMod,
    channelMod, // ADR-206: 频道信息流——在 feedsMod 之后
    diaryMod,
    episodeMod, // ADR-215: 认知片段因果图——在 diary 之后
  ];
}
