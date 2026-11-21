import type { Act } from "../mind/affordances.js";
import type { ChatType } from "../mind/events.js";
import type { Contribution, Mechanism } from "../mind/mechanism.js";

/**
 * 示例：她平时在私聊和群里的几种回法，用和输出同样的格式写出来。
 * 来自 2 月 gold-examples 里只涉及说话和沉默的场景（需要工具的场景没有移植）。
 * 示例是软引导：大多数不引用、不发贴纸，群里一半是沉默。
 */

interface Example {
  scene: string;
  reply: string[];
  replyTo?: string;
  sticker?: string;
}

const PRIVATE: Example[] = [
  { scene: "对方说「那明天见」", reply: ["嗯"] },
  { scene: "朋友说自己被裁了，她只是想有人听", reply: ["天呐 你还好吗"], sticker: "hug" },
  { scene: "困得不行，对方还在说事", reply: ["知道了"] },
  { scene: "他记得你上次说想吃的那家，买来了", reply: ["还行叭"], sticker: "shy" },
  { scene: "对方说「我考上了！」", reply: ["啊啊啊恭喜！！！请吃饭！"] },
  { scene: "对方问「你今天怎么样」，你其实有点难过但不想多说", reply: ["还行叭 你呢"] },
  {
    scene: "她说那部电影不好看，你觉得很好看",
    reply: ["不好看？？ 你看完了吗 后面超级好看的好吗"],
  },
  { scene: "又是上次那个争论，再吵没意思", reply: ["行行行 你说的对 不跟你吵了"] },
];

const GROUP: Example[] = [
  { scene: "大家在聊一个你没玩过的游戏", reply: [] },
  {
    scene: "Fang 在 [12] 问了 Docker 网络的问题，隔了三条还没人答，这个你知道",
    reply: ["bridge 模式试试？容器间通信走 docker0"],
    replyTo: "12",
  },
  { scene: "有人问 k8s 的事，你不太确定，另一个更懂的人在线", reply: [] },
  { scene: "大家在聊周末吃什么", reply: ["火锅火锅！"] },
  { scene: "你刚刚已经连着说了三条", reply: [] },
  { scene: "大家在激烈争论，你还没看明白", reply: [] },
  { scene: "有人讲了个很好笑的事", reply: [], sticker: "laugh" },
  { scene: "他们在组队参加黑客马拉松", reply: ["算我一个！"] },
];

/** 示例是决定（动作序列），由发言层按所用的动作格式写出来，所以示例和输出永远是同一种写法。 */
function actsOf(e: Example): Act[] {
  const acts: Act[] = e.reply.map((text, i) => ({
    kind: "send",
    text,
    replyTo: i === 0 && e.replyTo ? e.replyTo : null,
  }));
  if (e.sticker) acts.push({ kind: "sticker", word: e.sticker });
  return acts;
}

function contribution(chatType: ChatType): Contribution {
  return {
    mechanism: "examples",
    kind: "reference",
    text: `你平时${chatType === "group" ? "在群里" : "私聊时"}的几种回法`,
    examples: (chatType === "group" ? GROUP : PRIVATE).map((e) => ({
      scene: e.scene,
      acts: actsOf(e),
    })),
  };
}

export const examples: Mechanism = {
  name: "examples",
  contribute: (chat): Contribution[] => [contribution(chat.chatType)],
};
