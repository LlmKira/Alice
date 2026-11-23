/**
 * PlatformHub：让一个 Alice 运行时同时挂一个或多个聊天平台（例如 Telegram 和 QQ）。
 * 设计参考 Satori：多适配器路由，能力按会话声明。PlatformHub 按会话前缀（platform.prefix）把事件、
 * 对外动作、查询和能力查询分给对应的平台，并统一管理各平台的启停；外壳、step 和意愿层都不知道具体是哪个平台。
 */
import type { QueryKind } from "./llm/ptc.js";
import type { Act, PlatformCapabilities } from "./mind/affordances.js";
import type { AliceEvent } from "./mind/events.js";
import { Failed } from "./mind/failure.js";
import type { ActOutcome } from "./mind/outcome.js";
import type { AliceState } from "./mind/state.js";
import type { Platform, PlatformHost, QueryResult } from "./platform.js";

export class PlatformHub {
  readonly platforms: readonly Platform[];

  constructor(platforms: readonly Platform[]) {
    if (platforms.length === 0) throw new Error("PlatformHub requires at least one platform");
    const names = new Set<string>();
    const prefixes: string[] = [];
    for (const p of platforms) {
      if (names.has(p.name)) throw new Error(`Duplicate platform: ${p.name}`);
      if (!p.prefix) throw new Error(`Platform ${p.name} must declare a non-empty prefix`);
      for (const seen of prefixes) {
        if (seen.startsWith(p.prefix) || p.prefix.startsWith(seen)) {
          throw new Error(`Overlapping platform prefixes: "${seen}" and "${p.prefix}"`);
        }
      }
      names.add(p.name);
      prefixes.push(p.prefix);
    }
    this.platforms = platforms;
  }

  get names(): readonly string[] {
    return this.platforms.map((p) => p.name);
  }

  /** 按会话前缀找到负责它的平台（例如 "qq:group:300" → QQPlatform）。 */
  ownerOf(scope: string): Platform | undefined {
    return this.platforms.find((p) => scope.startsWith(p.prefix));
  }

  /** 某个会话所在平台声明的能力；不属于任何平台的会话（如 hn:top）返回 undefined。 */
  capabilitiesFor(scope: string): PlatformCapabilities | undefined {
    return this.ownerOf(scope)?.capabilities;
  }

  /**
   * 把日志事件分给各平台更新投影：带 scope 的事件只交给负责它的平台（hn:top、self 这类不属于任何平台的跳过）；
   * 不带 scope 的全局事件（clock.tick 等）发给所有平台。
   */
  observe(event: AliceEvent, state: AliceState, phase: "fold" | "live"): void {
    if ("scope" in event && typeof event.scope === "string") {
      this.ownerOf(event.scope)?.observe(event, state, phase);
      return;
    }
    for (const p of this.platforms) p.observe(event, state, phase);
  }

  startupInfo(): Record<string, unknown> {
    if (this.platforms.length === 1) {
      const only = this.platforms[0] as Platform;
      return {
        platform: only.name,
        supportedActs: [...only.capabilities.acts],
        ...only.startupInfo(),
      };
    }
    return {
      platforms: Object.fromEntries(
        this.platforms.map((p) => [
          p.name,
          { supportedActs: [...p.capabilities.acts], ...p.startupInfo() },
        ]),
      ),
    };
  }

  async start(
    host: PlatformHost,
  ): Promise<{ selfIds: Record<string, string>; selfNames: Record<string, string> }> {
    const selfIds: Record<string, string> = {};
    const selfNames: Record<string, string> = {};
    const states = new Map<string, string>();
    const reportConnection = (name: string, state: string) => {
      states.set(name, state);
      if (this.platforms.length === 1) {
        host.connection(state);
        return;
      }
      const allConnected = [...states.values()].every((s) => s === "connected");
      host.connection(allConnected ? "connected" : `${name}:${state}`);
    };
    // 各平台并行启动：一个平台连得慢，不会拖住别的平台。
    await Promise.all(
      this.platforms.map(async (p) => {
        const { selfId, selfName } = await p.start({
          ...host,
          connection: (state) => reportConnection(p.name, state),
        });
        selfIds[p.name] = selfId;
        if (selfName?.trim()) selfNames[p.name] = selfName.trim();
      }),
    );
    return { selfIds, selfNames };
  }

  async act(scope: string, act: Act, signal: AbortSignal): Promise<ActOutcome> {
    const owner = this.ownerOf(scope);
    if (!owner) {
      throw new Failed({ reason: "peer_unreachable" }, `no platform owns scope: ${scope}`);
    }
    return owner.act(scope, act, signal);
  }

  async query(
    scope: string,
    kind: Exclude<QueryKind, "delegate">,
    act: Act,
    signal: AbortSignal,
  ): Promise<QueryResult> {
    const owner = this.ownerOf(scope);
    if (!owner) {
      throw new Failed({ reason: "unavailable" }, `no platform owns scope: ${scope}`);
    }
    return owner.query(scope, kind, act, signal);
  }

  stickers(scope?: string): readonly string[] {
    if (scope !== undefined) return this.ownerOf(scope)?.stickers() ?? [];
    if (this.platforms.length === 1) return (this.platforms[0] as Platform).stickers();
    return this.platforms.flatMap((p) => p.stickers());
  }

  /** 给操作员的通知只经第一个（主）平台发。 */
  async sendToOperator(text: string): Promise<void> {
    await (this.platforms[0] as Platform).sendToOperator(text);
  }

  async selftest(): Promise<string> {
    if (this.platforms.length === 1) return (this.platforms[0] as Platform).selftest();
    const parts = await Promise.all(
      this.platforms.map(async (p) => `[${p.name}]\n${await p.selftest()}`),
    );
    return parts.join("\n\n");
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.platforms.map((p) => p.stop()));
  }
}
