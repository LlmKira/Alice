/** 等宽排版：中日韩文字和表情占两格（终端里的显示宽度），用来缩进续行。 */

const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

export function width(text: string): number {
  let w = 0;
  for (const ch of text) w += WIDE.test(ch) ? 2 : 1;
  return w;
}
