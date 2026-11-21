/**
 * 发文字之前"正在输入"显示多久（capabilities A17）：按字数，像真人用手机打字，稍快一点。外壳执行，不进决策。
 *
 * 真人的速度：手机拼音输入约 39 字/分钟，英文约 53 词/分钟（Ruan et al. 2016，"Speech Is 3x Faster than
 * Typing"，含改错）；大样本的手机英文输入平均 36 词/分钟（Palin et al. 2019，3.7 万人）。这里取
 * 汉字（含假名、谚文）每秒 1 个、其余字符每秒 5 个（约 60 词/分钟），比真人快一点；最长 15 秒，最短 1 秒。
 *
 * 和回复延迟的关系：什么时候拿起手机来回，是她自己的生活状态的事（作息、忙不忙，另由意愿层和生活状态决定）；
 * 这里只是决定了要说之后，把这句话打出来的那几秒。没有另设的延迟参数：时长只由要发的字决定。
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;
const CJK_PER_SECOND = 1;
const OTHER_PER_SECOND = 5;
const MIN_MS = 1_000;
const MAX_MS = 15_000;

export function typingMs(text: string): number {
  let seconds = 0;
  for (const ch of text.trim()) seconds += 1 / (CJK.test(ch) ? CJK_PER_SECOND : OTHER_PER_SECOND);
  return Math.round(Math.min(MAX_MS, Math.max(MIN_MS, seconds * 1000)));
}
