import type { Mechanism } from "../mind/mechanism.js";

/**
 * 查一下的能力（tools.look_up，后台由执行代理办，llm/errand.ts）。要外壳提供执行代理（errand）：外壳关掉它时
 * （index.ts：没有 EXA_API_KEY 或 ALICE_ERRANDS=off）这个机制不激活，她就看不到这个动作——不给她一个办不成的选项。
 * 没有状态：还没查完的事记在会话状态里（ChatState.running）。
 */
export const errands: Mechanism = {
  name: "errands",
  affordances: ["delegate"],
  requires: ["errand"],
};
