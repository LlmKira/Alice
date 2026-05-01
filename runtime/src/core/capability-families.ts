import type { ToolCategory } from "../engine/tick/types.js";

export interface CapabilityFamily {
  /** shell manual / legacy category summary 中显示的「何时使用」描述 */
  whenToUse: string;
  /** Activated Tools 段头部的简短描述 */
  label: string;
  /** 展开态教程示例 */
  tutorials?: readonly string[];
}

/**
 * Category-level metadata for capability families (discoverable via `<command> --help`).
 * @see docs/adr/216-cli-help-unification.md
 */
export const CAPABILITY_FAMILIES: Partial<Record<ToolCategory, CapabilityFamily>> = {
  mood: {
    whenToUse: "深度情绪分析/反馈",
    label: "环境/状态感知",
    tutorials: [
      "# self --help -> rate-outcome, flag-risk...",
      'self rate-outcome --target self --action_ms 1777550000000 --quality good --reason "她笑了"',
    ],
  },
  social: {
    whenToUse: "关系档案管理",
    label: "人际认知",
    tutorials: [
      "# self --help -> note-active-hour, tag-interest...",
      "self note-active-hour --contactId @1000000001 --hour 14",
    ],
  },
  threads: {
    whenToUse: "线程生命周期管理",
    label: "线程管理",
    tutorials: [
      "# self --help -> intend, resolve-topic...",
      'self intend --description "下次见面时问问结果" --priority minor',
    ],
  },
  memory: {
    whenToUse: "知识维护与反思",
    label: "知识持久化",
    tutorials: [
      "# self --help -> diary, recall-fact...",
      'self diary --content "今天聊了很多 感觉关系更近了"',
    ],
  },
  scheduler: {
    whenToUse: "任务调度",
    label: "任务调度",
    tutorials: [
      "# self --help -> schedule-task, cancel-task...",
      'self schedule-task --type at --delay 5 --action "remind about meeting"',
    ],
  },
  skills: {
    whenToUse:
      "Discover and install new capabilities - search the Skill Store when you need a tool you don't have",
    label: "Skill 管理",
    tutorials: [
      'alice-pkg search "天气"     # 搜索可用 Skill',
      "alice-pkg search            # 列出全部 Skill",
      "alice-pkg install weather   # 安装指定 Skill",
      "alice-pkg list              # 查看已安装 Skill",
      "alice-pkg info weather      # 查看 Skill 详情",
    ],
  },
  chat_history: {
    whenToUse: "搜索聊天记录/日记/线程",
    label: "聊天记录搜索",
    tutorials: [
      "irc tail --count 10",
      "irc whois",
      "irc threads",
      "# results appear in command output or the next round",
    ],
  },
  contact_info: {
    whenToUse: "Bot 交互/联系人查询",
    label: "联系人与 Bot",
    tutorials: ["irc whois --target @1000000001", "irc whois"],
  },
  sticker: {
    whenToUse: "浏览/管理贴纸集",
    label: "贴纸",
    tutorials: ["irc sticker --keyword happy", "irc sticker --help"],
  },
  media: {
    whenToUse: "发送图片/文件/媒体",
    label: "媒体",
    tutorials: [
      'irc send-file --path ./file.png --caption "给你看这个"',
      "# download + process + send-file: irc download -> convert -> irc send-file",
    ],
  },
  group_admin: {
    whenToUse: "群组发现/加入/管理",
    label: "群组管理",
    tutorials: ['irc join --target "@channel_name"', "irc leave"],
  },
};

export function registerCapabilityFamily(category: string, family: CapabilityFamily): void {
  (CAPABILITY_FAMILIES as Record<string, CapabilityFamily>)[category] = family;
}

export function unregisterCapabilityFamily(category: string): void {
  delete (CAPABILITY_FAMILIES as Record<string, CapabilityFamily>)[category];
}
