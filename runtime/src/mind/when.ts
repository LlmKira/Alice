/**
 * 她说的时间（"明天""下周三晚上""11月20日""两小时后"）→ 一个确定的时间窗：从什么时候起算"到时候了"（from），
 * 最晚什么时候（due）。纯函数，只用传入的时刻，按东八区算日历（聊天里的人主要在东八区，和 speech/prompt 的
 * 当前时间一致；中国没有夏令时，所以用固定偏移，不依赖 Intl）。认不出来的写法返回 null，表示没有约定时间。
 *
 * 一天里没说具体钟点的，窗是那天 9:00–21:00；说了时段的（早上、下午、晚上）用时段；说了钟点的，窗是钟点前一小时。
 */

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const OFFSET = 8 * H;

export interface When {
  from: number;
  due: number;
}

/** 东八区的日历日（自 1970-01-01 起的天数）与当天的毫秒数。 */
function dayAndMs(at: number): { day: number; ms: number } {
  const local = at + OFFSET;
  const day = Math.floor(local / D);
  return { day, ms: local - day * D };
}

/** 东八区的日历日、钟点、一天里的第几分钟（作息、在线份额、想一想都按这一份算）。 */
export const localDay = (at: number): number => dayAndMs(at).day;
export const localHour = (at: number): number => Math.floor(dayAndMs(at).ms / H);
export const localMinute = (at: number): number => Math.floor(dayAndMs(at).ms / MIN);
/** 当天 0 点起的毫秒数。 */
export const msIntoDay = (at: number): number => dayAndMs(at).ms;

/** 东八区某日某刻 → epoch 毫秒。 */
function epochOf(day: number, ms: number): number {
  return day * D + ms - OFFSET;
}

/** 1970-01-01 是星期四：返回 1（周一）… 7（周日）。 */
function weekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

/** 公历日期 ↔ 天数（Howard Hinnant 的 days_from_civil）。 */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const back = civilFromDays(daysFromCivil(y, m, d));
  return back.m === m && back.d === d;
}

const DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 阿拉伯数字或一到九十九的中文数字；"半" = 0.5。 */
function numberOf(raw: string): number | null {
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === "半") return 0.5;
  const m = raw.match(/^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/);
  if (!m || raw === "") return null;
  const [, tens, ten, ones] = m;
  if (!ten) return tens && !ones ? (DIGITS[tens] ?? null) : null;
  return (tens ? (DIGITS[tens] ?? 0) : 1) * 10 + (ones ? (DIGITS[ones] ?? 0) : 0);
}

/** 时段（一天里的窗，毫秒）。没说时段 = 白天。 */
const PERIODS: Array<[RegExp, number, number]> = [
  [/^(早上|早晨|一早|上午|早)/, 8 * H, 12 * H],
  [/^(中午)/, 11 * H, 14 * H],
  [/^(下午|午后)/, 13 * H, 18 * H],
  [/^(傍晚)/, 17 * H, 19 * H],
  [/^(晚上|晚|夜里|今夜)/, 19 * H, 23 * H],
];
const DAYTIME: [number, number] = [9 * H, 21 * H];

/** 某一天里的窗：可带时段与钟点（"下午3点""晚上8点半""15:30"）。 */
function within(day: number, rest: string): When | null {
  let window = DAYTIME;
  let tail = rest.trim();
  for (const [pattern, start, end] of PERIODS) {
    const m = tail.match(pattern);
    if (m) {
      window = [start, end];
      tail = tail.slice(m[0].length);
      break;
    }
  }
  if (tail === "" || tail === "的时候") {
    return { from: epochOf(day, window[0]), due: epochOf(day, window[1]) };
  }
  const clock = tail.match(
    /^(\d{1,2}|[一二两三四五六七八九十]+)(?:点|:|：|时)(半|\d{2}|[一二三四五]十[一二三四五六七八九]?|一刻)?(?:分)?(?:左右|前)?$/,
  );
  if (!clock) return null;
  let hour = numberOf(clock[1] as string);
  if (hour === null || hour > 24) return null;
  const m = clock[2];
  const minute = !m ? 0 : m === "半" ? 30 : m === "一刻" ? 15 : (numberOf(m) ?? Number.NaN);
  if (!Number.isFinite(minute) || minute >= 60) return null;
  // "下午3点""晚上8点"：12 小时制。
  if (window[0] >= 13 * H && hour < 12) hour += 12;
  const due = epochOf(day, hour * H + minute * MIN);
  return { from: due - H, due };
}

const WEEKDAYS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/** 认得出就返回时间窗，否则 null（= 没有约定时间）。 */
export function parseWhen(raw: string, at: number): When | null {
  const text = raw
    .trim()
    .replace(/\s+/g, "")
    .replace(/(之前|以前|前后|左右)$/, "");
  if (!text) return null;
  const today = localDay(at);

  // 马上、一会儿、晚点：从现在算起。
  if (/^(马上|立刻|现在)$/.test(text)) return { from: at, due: at + 15 * MIN };
  if (/^(一会儿?|待会儿?|等会儿?|过会儿?|晚点儿?|晚一点|晚些|晚一些|回头)$/.test(text)) {
    return { from: at + 30 * MIN, due: at + 2 * H };
  }

  // N 分钟 / 小时 / 天 / 周 / 个月 后。
  const later = text.match(
    /^(\d+(?:\.\d+)?|[一二两三四五六七八九十]+|半)(个)?(分钟|小时|钟头|天|周|星期|礼拜|月)(后|以后|之后)$/,
  );
  if (later) {
    const n = numberOf(later[1] as string);
    if (n === null || n <= 0) return null;
    const unit = later[3] as string;
    if (unit === "分钟" || unit === "小时" || unit === "钟头") {
      const due = at + n * (unit === "分钟" ? MIN : H);
      return { from: due - Math.min(H, (due - at) / 2), due };
    }
    const days = unit === "天" ? n : unit === "月" ? n * 30 : n * 7;
    return within(today + Math.round(days), "");
  }

  // 今天 / 明天 / 后天 / 大后天，及其简称（今晚、明早……），后面可带时段与钟点。
  const named = text.match(/^(今天|今日|今|明天|明日|明儿|明|后天|大后天)(.*)$/);
  if (named) {
    const word = named[1] as string;
    const offset = word.startsWith("大后")
      ? 3
      : word.startsWith("后")
        ? 2
        : word.startsWith("明")
          ? 1
          : 0;
    const rest = named[2] as string;
    // "今""明"单字只在后面跟着时段时成立（今晚、明早）。
    if ((word === "今" || word === "明") && !PERIODS.some(([p]) => p.test(rest))) return null;
    return within(today + offset, rest);
  }

  // 周末 / 这周末 / 下周末。
  const weekend = text.match(/^(这|本|下)?(个)?(周末|礼拜天?末)$/);
  if (weekend) {
    const wd = weekday(today);
    const saturday = today + (6 - wd) + (weekend[1] === "下" ? 7 : 0);
    const start = Math.max(saturday, today);
    return { from: epochOf(start, DAYTIME[0]), due: epochOf(saturday + 1, DAYTIME[1]) };
  }

  // 周X / 星期X / 这周X / 下周X，可带时段与钟点。
  const week = text.match(/^(这|本|下)?(个)?(周|星期|礼拜)([一二三四五六日天])(.*)$/);
  if (week) {
    const target = WEEKDAYS[week[4] as string] as number;
    const wd = weekday(today);
    const monday = today - (wd - 1);
    let day = monday + (target - 1) + (week[1] === "下" ? 7 : 0);
    // 没说"这周"、"下周"，而那天已经过了：指下一个。
    if (!week[1] && day < today) day += 7;
    return within(day, week[5] as string);
  }

  // 这周 / 下周：一整周。
  const wholeWeek = text.match(/^(这|本|下)(个)?(周|星期|礼拜)$/);
  if (wholeWeek) {
    const monday = today - (weekday(today) - 1) + (wholeWeek[1] === "下" ? 7 : 0);
    const start = Math.max(monday, today);
    return { from: epochOf(start, DAYTIME[0]), due: epochOf(monday + 6, DAYTIME[1]) };
  }

  // 下个月 / 月底。
  const { y, m } = civilFromDays(today);
  if (/^下(个)?月$/.test(text)) {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const first = daysFromCivil(ny, nm, 1);
    const last = daysFromCivil(nm === 12 ? ny + 1 : ny, nm === 12 ? 1 : nm + 1, 1) - 1;
    return { from: epochOf(first, DAYTIME[0]), due: epochOf(last, DAYTIME[1]) };
  }
  if (/^(这个?月)?月底$/.test(text)) {
    const last = daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - 1;
    return { from: epochOf(Math.max(today, last - 3), DAYTIME[0]), due: epochOf(last, DAYTIME[1]) };
  }

  // 日期：2026-11-20、2026年11月20日、11月20日、11/20、20号。可带时段与钟点。
  const full = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?(.*)$/);
  if (full) {
    const [yy, mm, dd] = [Number(full[1]), Number(full[2]), Number(full[3])];
    return validDate(yy, mm, dd) ? within(daysFromCivil(yy, mm, dd), full[4] as string) : null;
  }
  const monthDay = text.match(/^(\d{1,2})(?:月|\/|-)(\d{1,2})[日号]?(.*)$/);
  if (monthDay) {
    const [mm, dd] = [Number(monthDay[1]), Number(monthDay[2])];
    let yy = y;
    if (!validDate(yy, mm, dd)) return null;
    // 今年的这一天已经过了：指明年。
    if (daysFromCivil(yy, mm, dd) < today) yy++;
    return validDate(yy, mm, dd) ? within(daysFromCivil(yy, mm, dd), monthDay[3] as string) : null;
  }
  const dayOnly = text.match(/^(\d{1,2})[日号](.*)$/);
  if (dayOnly) {
    const dd = Number(dayOnly[1]);
    const { d } = civilFromDays(today);
    const [yy, mm] = dd >= d ? [y, m] : m === 12 ? [y + 1, 1] : [y, m + 1];
    return validDate(yy, mm, dd) ? within(daysFromCivil(yy, mm, dd), dayOnly[2] as string) : null;
  }
  return nextClock(text, today, at);
}

/**
 * 没说哪天、只说了时段或钟点（"晚上8点""下午三点""8点半""20:30""晚上"）：接下来最近的那一个——今天的
 * 已经过了就是明天。没说上下午的 1–11 点按口语两种都可能（下午两点说"3点"是 15:00），取接下来最近的
 * （答应"8点提醒你"的承诺以前认不出来，就没有约定时间，到点不会想起）。
 */
function nextClock(text: string, today: number, at: number): When | null {
  if (
    !/^(?:\d|[一二两三四五六七八九十]|早|一早|上午|中午|下午|午后|傍晚|晚|夜里|今夜)/.test(text)
  ) {
    return null;
  }
  const first = within(today, text);
  if (!first) return null;
  const shift = (w: When, ms: number): When => ({ from: w.from + ms, due: w.due + ms });
  const hour = localHour(first.due);
  const ambiguous = !PERIODS.some(([p]) => p.test(text)) && hour >= 1 && hour < 12;
  const candidates = ambiguous
    ? [first, shift(first, 12 * H), shift(first, D), shift(first, D + 12 * H)]
    : [first, shift(first, D)];
  return candidates.find((w) => w.due > at) ?? null;
}

/** 东八区的"今天、明天、N 天后、N 天前"（提示词里说约定的时间）。 */
export function dayDistance(at: number, now: number): number {
  return localDay(at) - localDay(now);
}

/**
 * 过了多久，写给她看："5 分钟""3 小时""4 天""3 周"：一小时内按分钟（至少 1 分钟），两天内按小时，两周内按天，
 * 再往后按周。提示词里的"多久之前""多久没……"都用它，同一份提示词里不会一处"5 天"、一处"120 小时"。
 */
export function elapsed(ms: number): string {
  if (ms < H) return `${Math.max(1, Math.round(ms / MIN))} 分钟`;
  if (ms < 2 * D) return `${Math.round(ms / H)} 小时`;
  if (ms < 14 * D) return `${Math.round(ms / D)} 天`;
  return `${Math.round(ms / (7 * D))} 周`;
}

/** 东八区的钟点 "15:30"。 */
export function localClock(at: number): string {
  const minutes = localMinute(at);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
