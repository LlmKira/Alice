/**
 * Engine API — 命令目录端点。
 *
 * GET /meta/commands → 返回所有 LLM 可见指令和查询的元数据。
 * 供 `self --help` 和未来的 prompt catalog 生成使用。
 *
 * @see docs/adr/217-cli-unification.md
 */

import type { ServerResponse } from "node:http";
import type { EngineApiDeps } from "../server.js";

interface CommandMeta {
  name: string;
  kind: "instruction" | "query";
  description: string;
  params: Array<{ name: string; optional: boolean; description: string }>;
  affordance?: { whenToUse: string; whenNotToUse?: string; priority: string };
}

export function handleMetaCommands(res: ServerResponse, deps: EngineApiDeps): void {
  const mods = deps.getMods?.() ?? [];
  const commands: CommandMeta[] = [];

  for (const mod of mods) {
    // 收集有 affordance 的指令
    for (const [name, def] of Object.entries(mod.instructions ?? {})) {
      if (!def.affordance) continue;
      const derivedKeys = def.deriveParams ? new Set(Object.keys(def.deriveParams)) : new Set();
      const params = Object.entries(def.params)
        .filter(([pName]) => !derivedKeys.has(pName))
        .map(([pName, pDef]) => ({
          name: pName,
          optional: pDef.schema.isOptional(),
          description: pDef.description,
        }));
      commands.push({
        name,
        kind: "instruction",
        description: def.description,
        params,
        affordance: def.affordance
          ? {
              whenToUse: def.affordance.whenToUse,
              whenNotToUse: def.affordance.whenNotToUse,
              priority: def.affordance.priority,
            }
          : undefined,
      });
    }

    // 收集有 affordance 的查询
    for (const [name, def] of Object.entries(mod.queries ?? {})) {
      if (!def.affordance) continue;
      const derivedKeys = def.deriveParams ? new Set(Object.keys(def.deriveParams)) : new Set();
      const params = Object.entries(def.params)
        .filter(([pName]) => !derivedKeys.has(pName))
        .map(([pName, pDef]) => ({
          name: pName,
          optional: pDef.schema.isOptional(),
          description: pDef.description,
        }));
      commands.push({
        name,
        kind: "query",
        description: def.description ?? "",
        params,
        affordance: def.affordance
          ? {
              whenToUse: def.affordance.whenToUse,
              whenNotToUse: def.affordance.whenNotToUse,
              priority: def.affordance.priority,
            }
          : undefined,
      });
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ commands }));
}
