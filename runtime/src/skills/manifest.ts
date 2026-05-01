/**
 * Skill 包 manifest.yaml Zod Schema — 声明式 Skill 包的单一真相来源。
 *
 * 心智模型：Skill ≈ CLI 命令，LLM ≈ IRC 终端用户。
 * manifest 声明了"命令名 + 参数 + 执行方式 + stdout 格式"。
 *
 * @see docs/adr/200-skill-package-format.md
 * @see docs/adr/201-os-for-llm.md
 */

import { z } from "zod";
import { DockerIsolationSchema } from "./backends/docker.js";

// ═══════════════════════════════════════════════════════════════════════════
// Param Schema
// ═══════════════════════════════════════════════════════════════════════════

export const ManifestParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "array"]).default("string"),
  required: z.boolean().default(true),
  description: z.string(),
});

export type ManifestParam = z.infer<typeof ManifestParamSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Env Schema（Skill 需要的环境变量声明）
// ═══════════════════════════════════════════════════════════════════════════

export const EnvDeclSchema = z.object({
  name: z.string(),
  /** 映射到 ActionImplContext 的字段名。 */
  contextKey: z.string().optional(),
  description: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Shell Backend — L2: stdin/stdout 子进程（LLM = 终端用户）
// ═══════════════════════════════════════════════════════════════════════════

export const ShellBackendSchema = z.object({
  /** 要执行的命令模板（支持 {{param}} 变量替换）。 */
  command: z.string(),
  /** 工作目录（相对于 Skill 安装目录）。 */
  cwd: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime Schema
// ═══════════════════════════════════════════════════════════════════════════

export const RuntimeSchema = z.object({
  backend: z.enum(["shell", "mcp"]).default("shell"),
  timeout: z.number().default(30),
  network: z.boolean().default(true),
  /** 隔离档位：`container` 为历史别名，解析到默认 container profile。 */
  isolation: z.enum(DockerIsolationSchema).default("container"),
  /** 容器内存限制。 */
  memory: z.string().default("512m"),
  env: z.array(EnvDeclSchema).optional(),
  shell: ShellBackendSchema.optional(),
});

export type SkillRuntime = z.infer<typeof RuntimeSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Family Schema（对应 CAPABILITY_FAMILIES 条目）
// ═══════════════════════════════════════════════════════════════════════════

export const FamilySchema = z.object({
  label: z.string(),
  whenToUse: z.string(),
  tutorials: z.array(z.string()).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Capability Schema（Skill 可申请的 Engine API 能力）
// ═══════════════════════════════════════════════════════════════════════════

export const CapabilitySchema = z.enum([
  "chat.read",
  "config.read",
  "config.secrets",
  "graph.read",
  "graph.write",
  "engine.selfcheck",
  "transport.send",
  "transport.read",
  "transport.react",
  "telegram.send",
  "telegram.read",
  "telegram.react",
  "telegram.join",
  "telegram.leave",
  "telegram.forward",
  "llm.synthesize",
  "llm.summarize",
  "dispatch",
  "query",
]);
export type SkillCapability = z.infer<typeof CapabilitySchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Action Schema（一个包可导出多个动作）
// ═══════════════════════════════════════════════════════════════════════════

export const ActionSchema = z.object({
  name: z.string(),
  category: z.string().default("app"),
  description: z.array(z.string()).min(1),
  usageHint: z.string().optional(),
  whenToUse: z.string(),
  whenNotToUse: z.string().optional(),
  params: z.array(ManifestParamSchema).default([]),
  returns: z.string().optional(),
  examples: z.array(z.string()).optional(),
  /** 覆盖包级 runtime（罕见，大多数包只有一个 backend）。 */
  runtime: RuntimeSchema.optional(),
});

export type ManifestAction = z.infer<typeof ActionSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Manifest Schema（顶层）
// ═══════════════════════════════════════════════════════════════════════════

export const ManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "名称只允许小写字母、数字和连字符"),
  version: z.string(),
  author: z.string().optional(),
  license: z.string().optional(),
  description: z.string(),
  actions: z.array(ActionSchema).min(1),
  runtime: RuntimeSchema.optional(),
  family: FamilySchema.optional(),
  /** 注册 CAPABILITY_FAMILIES 时使用的 category key（默认 = manifest.name）。
   *  多个 Skill 可共享同一 familyCategory（如 hitokoto/luck/fabing/kfc 共享 "fun"）。 */
  familyCategory: z.string().optional(),
  capabilities: z.array(CapabilitySchema).default([]),
  /** 完整帮助文本（纯文本）。提供时优先使用，否则从 manifest 自动生成。 */
  manPage: z.string().optional(),
});

export type SkillManifest = z.infer<typeof ManifestSchema>;
