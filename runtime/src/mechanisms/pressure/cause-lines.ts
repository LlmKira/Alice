/**
 * 叫醒她的原因（why.ts）写成事实句。句子是 Gemini 按 ADR-194（防收件箱焦虑）、ADR-210（提示词诚实）重写的原文
 * （/home/alice/.local/share/alice-briefs/prompt-gemini/out-feelings-v2.md），占位符换成机制给的内容；
 * 没有可填的内容时去掉那半句。这里不引用意愿层（desire.ts 读它，避免循环引用）。
 */

export type Cause =
  /** 攒了未读；heavy：攒得多（注意力那股劲过半）。 */
  | { kind: "unread"; heavy: boolean }
  /** 好久没冒泡；long：比这个群自己的节奏还久。 */
  | { kind: "absent"; long: boolean }
  /** 手里有想分享的东西；self 表示是她自己刚想到的，不是从频道看到的。 */
  | { kind: "share"; id: string; title: string; body: string; group: boolean; self?: true }
  | { kind: "topic" }
  /** 想起了某个熟人；seen：看见他刚在群里说话。 */
  | { kind: "person"; name: string; about: string | null; seen: boolean }
  /** 刚闲下来。 */
  | { kind: "free" }
  /** 答应过的一件事（memory.ts）；origin：在别处定下、来这里做的，是那个地方的说法（placeOf）。 */
  | { kind: "promise"; what: string; origin: string | null };

const END = /[。！？!?…）)」』]$/;
const ended = (s: string) => (END.test(s) ? s : `${s}。`);

/**
 * 一个原因写成一句没有视角的事实（Gemini 按 ADR-194、210 重写的那一版，out-feelings-v2.md）：不写"攒""冒泡""被忘了"，
 * 不写计数，不写该怎么做。没有可写的内容时是空的。
 */
export function causeLine(c: Cause): string {
  switch (c.kind) {
    case "unread":
      return c.heavy ? "群里这会儿正在聊，刚添了新内容。" : "群里刚才有新消息。";
    case "absent":
      return c.long ? "群里最近在聊，好一阵没在这里开口了。" : "好一阵没在这个群里说过话了。";
    case "share": {
      const what = c.body ? `${c.title} —— ${c.body}` : c.title;
      if (c.self) return ended(`我刚才自己想到：${what}`);
      return ended(c.group ? `刚在频道看到一条内容：${what}` : `频道里刚发了一条：${what}`);
    }
    case "topic":
      return "群里聊到了一件最近留心着的事。";
    case "person":
      if (c.seen) {
        return c.about
          ? `${c.name}这会儿在群里说话；之前${c.about}。`
          : `${c.name}这会儿在群里说话。`;
      }
      return c.about ? `想起了${c.name}。` : "";
    case "free":
      return "手头的事刚忙完，这会儿空着。";
    // 这一句不是 Gemini 的原文（out-cross-intent.md 只写了卡片那一条和参数说明），照同一套规矩写：只说事实，不说该做什么。
    case "promise":
      return c.origin
        ? ended(`${c.origin}答应过要在这里做：${c.what}`)
        : ended(`在这里答应过的事到时候了：${c.what}`);
  }
}
