import type { Dispatcher } from "@mtcute/dispatcher";
import type { Message, TelegramClient } from "@mtcute/node";

/**
 * 测试里假的 mtcute 对象：只实现被测代码碰到的那几个成员。mtcute 的这几样是整个类（成员里还套着类），
 * 普通对象在结构上对不上，所以只在这一处断言。
 */
export function mtcuteFake<T extends Dispatcher | TelegramClient | Message>(members: object): T {
  return members as T;
}
