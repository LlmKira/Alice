/**
 * 群里哪些消息值得她注意（PLAN 第 20 件，纯函数）。
 *
 * 生产的世界 fold（world.ts）对群里每一条消息都记一次未读、加一分注意压力（unread + 1、ewms + 1）：
 * 机器人签到、一整屏没配文的贴纸/图片（图片会由 perceive 写成"图片"，但文字是空的）、别人互相点名的
 * "@某某"，都在把她往这个群里拉。缺口只在消息这一侧能补：拿到 message.received 时就知道它是不是冲着她来的。
 *
 * 只在群里过滤，而且只过滤没冲着她的（directed 为 false：私聊、点名、回复她都不算）。私聊不过滤：
 * 那里每条消息本来就是对她说的话。过滤的是"注意"（unread、ewms、看群里的那一行），不是她的记录：
 * 时间线照旧保留每一条，她翻记录时看得见。
 *
 * 候选在消融里叫什么、门槛是多少，等接进 world.ts 之后按它的 footprint（群里的未读与叫醒）量。
 */
import type { MessageReceived } from "../../mind/events.js";

/** 只发这些、又没有配文时，群里那条不是对她说的（贴纸、图片、视频、语音）。 */
const SILENT_MEDIA: Readonly<Record<string, true>> = {
  sticker: true,
  photo: true,
  video: true,
  voice: true,
};

/**
 * 文字里的 @用户名（Telegram 的用户名是拉丁字母、数字、下划线）。没点名她时，@ 到别人就是别人在说话。
 * 前面的字符不能是词字符或点：邮件地址（bob@example.com）不算 @ 到人，句首、空格、中文标点后面的都算。
 * 不在开头也算：world-adapter 只在 @ 的是她自己时才把消息标成 directed，所以 !directed 时的 @ 一定是别人。
 * 平台给了结构化的 @（QQ 的 at 段，名字常是中文、这条正则认不出）时，适配器直接标 mentionsOther。
 */
const MENTION = /(?<![\w.])@[A-Z]\w{2,}/i;

/**
 * 这条群消息值不值得她注意。false：不是对她说的（机器人的话、没配文的贴纸/图片/视频/语音、@ 别人的话），
 * 世界 fold 可以不当成新的未读，也不加注意压力。真：照旧。
 */
export function isGroupAttentionWorthy(event: MessageReceived): boolean {
  if (event.chatType !== "group" || event.directed) return true;
  if (event.isBot === true) return false;
  const text = event.text?.trim() ?? "";
  if (text === "" && SILENT_MEDIA[event.contentType] === true) return false;
  if (event.mentionsOther === true) return false;
  return !MENTION.test(text);
}
