import type { AliceEvent } from "../mind/events.js";
import {
  type Contribution,
  defineMechanism,
  type Mechanism,
  type PersonNote,
} from "../mind/mechanism.js";
import type { ChatState } from "../mind/state.js";
import { localDay } from "../mind/when.js";
import {
  type FamiliarKind,
  familiarKind,
  frequency,
  joinedAt,
  knownFor,
  pooled,
  type Relation,
  type RelationStore,
  rankOf,
  reduceStore,
  watchedAWeek,
  whoSeeks,
} from "./pressure/relation.js";

/** 时间线上说过话的人：id → 名字。 */
function presentPeople(chat: ChatState): Map<string, string> {
  const present = new Map<string, string>();
  for (const t of chat.timeline) if (t.sender) present.set(t.sender.id, t.sender.name);
  return present;
}

/**
 * 熟悉：关系远近的事实只说她真的知道的（closeness 的候选替身，S02；eval-artifacts/familiar/prereg.md）。
 *
 * 为什么：2 月的她对人默认是认识的（图里每个联系人默认"熟人圈"，信念不确定时向熟人圈回归，而不是向陌生人），
 * 再加上几个月、几百人的往来。空库启动切断的是证据，不是事实：她在记录开始之前就在这些群里了。
 * 这里把两个量分开：
 * - 认得谁（同处）：在"记录前就在的群"（这个会话的第一个事件不是她自己的入群）里说过话、在那里没有入群提示的人，
 *   是这个群里的朋友；有入群提示的、或在她记录里才进的群里第一次见到的，是新认识的人；其余（只在私聊里见过）
 *   以前认不认识说不准，就什么也不说，直到看了一周。这是先验的上一层（类别）。
 * - 聊得多不多（往来）：每人"有往来的日子占比"按 Beta–二项的经验贝叶斯收缩来估（Efron & Morris 1975）：
 *   p̂ = (k·μ + d) / (k + D)。μ 是同一类人汇总的占比，d、D 是他有往来的日数和被看见的日数（按 closeness 的半衰期
 *   折扣），k 是一周：频率词说的是一周里的事，看了不满一周就说不出来，所以不满一周也不写频率。
 *   不写"很亲近"：那是全体里的排名，记录不全时第一个和她说话的人就排第一。
 * 只写事实，不写该怎么对谁。第 3 片起，看见的事实（第一次看见、有往来的日子、群里的入群提示、机器人标记）由
 * relation 的 `relations` 折一份（pressure/relation.ts reduceStore），这里只拿同一份几何做卡片；机制之间不读彼此的
 * 状态（mind/mechanism.ts），所以它按同一份 fold 函数 fold 自己的那一份，输出与搬进来之前逐字节相同。
 * 代价（tier）不在这里：生产仍由 ranking 给，候选第 4 片由熟悉度给（pressure/relation.ts familiarityTier）。
 * 纯函数，时间只来自事件。
 */

const DAY_MS = 24 * 60 * 60_000;
/** 说得出频率之前要看几天，也是"刚进群"的窗口：一周（社交节律的周期）。 */
const PRIOR_DAYS = 7;

type Kind = FamiliarKind;

export interface FamiliarState extends RelationStore {
  /** 私聊会话 → 对方（关系靠互惠维持：她的回话延续对方开启的那段往来）。 */
  partners: Readonly<Record<string, string>>;
}

export interface FamiliarOptions {
  /** 先验：记录前就在的群里的人是朋友，有入群提示的是刚进群的人。关掉时谁都说不准认不认识（看满一周才说）。 */
  prior: boolean;
  /** 校准：频率按人估计、向同类收缩，观察不满一周不说。关掉时有往来的人仍按 closeness 的排名分层写。 */
  calibrated: boolean;
}

const empty: FamiliarState = { people: {}, groups: {}, partners: {} };

/** fold 一个事件：看见的事实与亲近分数用 relation 的同一份（reduceStore），这里另记私聊的对方。 */
function reduceFamiliar(state: FamiliarState, event: AliceEvent): FamiliarState {
  const partners =
    event.type === "message.received" &&
    event.chatType === "private" &&
    state.partners[event.scope] !== event.senderId
      ? { ...state.partners, [event.scope]: event.senderId }
      : state.partners;
  const store = reduceStore(
    { people: state.people, groups: state.groups },
    event,
    (scope) => partners[scope] ?? null,
  );
  return { ...store, partners };
}

/** 是会话不是人：Telegram 的群和频道是负数 id；会话种类写在 id 里的平台写成 group:… / channel:…。 */
const isChat = (id: string): boolean =>
  id.startsWith("-") || id.startsWith("group:") || id.startsWith("channel:");

/** 什么时候进的群；一周以前进的、没见过入群提示的为 null。 */
function recentlyJoined(store: RelationStore, id: string, now: number): string | null {
  const at = joinedAt(store, id);
  if (at === null || now - at >= PRIOR_DAYS * DAY_MS) return null;
  const n = localDay(now) - localDay(at);
  return n <= 0 ? "今天刚进群" : n === 1 ? "昨天刚进群" : `${n} 天前进的群`;
}

/** 排名分层（Dunbar 5 / 15 / 50 / 150，原 closeness 机制的 LAYERS）：没来往过或排在 150 名以外为 null。 */
const LAYERS: ReadonlyArray<readonly [maxRank: number, fact: string]> = [
  [5, "很亲近，我们几乎天天聊"],
  [15, "常聊"],
  [50, "认识，偶尔聊"],
  [150, "聊过几次"],
];

/** 一个名字那一行（按排名分层），和排名；第 3 片先用亲近分数排名（第 4 片删）。 */
function rankedLine(
  store: RelationStore,
  id: string,
  name: string,
  now: number,
): [number, string] | null {
  const rank = rankOf(store, id, now);
  const layer = rank === null ? undefined : LAYERS.find(([max]) => rank <= max);
  if (rank === null || !layer) return null;
  const more = [knownFor(store, id, now), whoSeeks(store, id)].filter(Boolean).join("，");
  return [rank, `${name}：${layer[1]}${more ? `；${more}` : ""}`];
}

/** 记录开始之前就在一个群里的人（先验）是朋友。 */
const friendOf = (dm: boolean): string => (dm ? "和我在同一个群里的朋友" : "这个群里的朋友");

/** 在场的一个人放进哪一组：排序的那组（按频率或排名）、"群里的朋友"那组、排在最后的那组；不写他为 null。 */
type Placement =
  | { group: "ranked"; key: number; relation: string }
  | { group: "old" | "rest"; relation: string }
  | null;

/** 一次 contribute 里所有人共用的事实。 */
interface Scene {
  store: RelationStore;
  mu: Record<Kind, number>;
  today: number;
  now: number;
  dm: boolean;
}

/** 没有校准：有往来的人按排名分层写，其余只写群里的朋友和刚进群。 */
function placeByRank(
  scene: Scene,
  id: string,
  who: string,
  c: Kind,
  joined: string | null,
): Placement {
  const line = rankedLine(scene.store, id, who, scene.now);
  if (line) {
    const [rank, text] = line;
    return { group: "ranked", key: rank, relation: text.slice(who.length + 1) };
  }
  if (c === "old") return { group: "old", relation: friendOf(scene.dm) };
  if (joined) return { group: "rest", relation: joined };
  return null;
}

function placeByFrequency(
  scene: Scene,
  id: string,
  r: Relation,
  c: Kind,
  joined: string | null,
): Placement {
  const { store, today, now, dm } = scene;
  const f = frequency(r.seen, scene.mu[c], today);
  if (c === "old") {
    return f
      ? { group: "ranked", key: -f.p, relation: `${f.word}，也是${dm ? "" : "这个"}群里的朋友` }
      : { group: "old", relation: friendOf(dm) };
  }
  if (joined) return { group: "rest", relation: joined };
  // 只在私聊里见过的人：以前认不认识说不准，看满一周、说得出频率才说；认识多久也说不准，不说。
  if (c === "unknown" && !f) return null;
  if (r.seen.toHerDays.length === 0) return null;
  if (!f) {
    return { group: "rest", relation: watchedAWeek(r.seen, today) ? "聊过一次" : "刚认识" };
  }
  const since = c === "new" ? knownFor(store, id, now) : null;
  const seeks = whoSeeks(store, id);
  const more = [since, seeks].filter(Boolean).join("，");
  return { group: "ranked", key: -f.p, relation: `${f.word}${more ? `；${more}` : ""}` };
}

export function createFamiliar(name: string, options: FamiliarOptions): Mechanism {
  const kind = (store: RelationStore, id: string): Kind =>
    options.prior ? familiarKind(store, id) : "unknown";
  return defineMechanism<FamiliarState>({
    name,
    initial: empty,
    reduce: reduceFamiliar,
    contribute(chat, now, state): Contribution[] {
      const today = localDay(now);
      // 平台标着的机器人不算人；以频道（或匿名管理员）身份发的消息，发言人是一个会话，也不是人：
      // 只留在记录里说过话的人（和 relation 的 relations 同一份几何）。
      const people = Object.fromEntries(
        Object.entries(state.people).filter(([id, r]) => r.seen.count > 0 && !r.bot && !isChat(id)),
      );
      const store: RelationStore = { people, groups: state.groups };
      const mu = pooled(people, today, (id) => kind(store, id));
      const dm = chat.chatType === "private";
      const scene: Scene = { store, mu, today, now, dm };
      // 每一行同时按人记下（PersonNote：关系就是冒号后面那段），发言层可以把记得的事并到他名下。
      const ranked: Array<[number, PersonNote]> = [];
      const old: PersonNote[] = [];
      const rest: PersonNote[] = [];
      for (const [id, who] of presentPeople(chat)) {
        const r = people[id];
        if (!r) continue;
        const c = kind(store, id);
        const joined = c === "new" ? recentlyJoined(store, id, now) : null;
        const place = options.calibrated
          ? placeByFrequency(scene, id, r, c, joined)
          : placeByRank(scene, id, who, c, joined);
        if (!place) continue;
        const note: PersonNote = { id, name: who, relation: place.relation };
        if (place.group === "ranked") ranked.push([place.key, note]);
        else if (place.group === "old") old.push(note);
        else rest.push(note);
      }
      ranked.sort((a, b) => a[0] - b[0]);
      const notes = [...ranked.map(([, n]) => n), ...old, ...rest];
      const lines = ranked.map(([, n]) => `${n.name}：${n.relation}`);
      // 先验的等级是朋友（研究员 2026-11-12："默认人类不应该是陌生人，应该是朋友，好客"），只说这一个关系，
      // 不带频率、不说"很亲近"。以前写的"老面孔，早就认识了，只是以前的具体的事你想不起来了"会让她冷：
      // 老面孔是"见过的人"，人格里那一档是先保持距离；"想不起来"把对方定成本该记得却记不得的人，认人失败是丢脸的事
      // （Goffman 的面子），人对这种处境的反应是尴尬和防御——少说，免得露馅。开发集里只差这一行的配对（s28 两次）
      // 就是生产开口、它不开口（eval-artifacts/familiar/prereg.md 修订 4）。
      if (old.length > 0) lines.push(`${old.map((n) => n.name).join("、")}：${friendOf(dm)}`);
      lines.push(...rest.map((n) => `${n.name}：${n.relation}`));
      if (lines.length === 0) return [];
      return [
        {
          mechanism: name,
          kind: "people",
          text: `我和在场的人：\n${lines.join("\n")}`,
          people: notes,
        },
      ];
    },
  });
}

/**
 * 消融 calibrated-only：只有校准（没有先验）。它取代过 closeness 的排名分层：第一次往来的人不再是"很亲近，
 * 你们几乎天天聊"（依据见 registry.ts）。
 */
export const closenessCalibrated = createFamiliar("closeness-calibrated", {
  prior: false,
  calibrated: true,
});

/** 生产：先验（这个群里的朋友）加校准，机器人账号不算在场的人。 */
export const familiar = createFamiliar("familiar", { prior: true, calibrated: true });
