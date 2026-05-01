import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSkill, removeSkill, rollbackSkill, upgradeSkill } from "../src/skills/pkg.js";
import { getEntry } from "../src/skills/registry.js";

interface TestRoots {
  root: string;
  storeRoot: string;
  binDir: string;
  registryPath: string;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeRoots(): TestRoots {
  const root = mkdtempSync(join(tmpdir(), "alice-skill-pkg-"));
  tempRoots.push(root);
  return {
    root,
    storeRoot: join(root, "store"),
    binDir: join(root, "bin"),
    registryPath: join(root, "registry.json"),
  };
}

function writeSkillVersion(root: string, version: string, description: string): string {
  const skillDir = join(root, `skill-${version}`);
  const name = "luck";
  mkdirSync(skillDir, { recursive: true });

  writeFileSync(
    join(skillDir, "manifest.yaml"),
    [
      `name: ${name}`,
      `version: "${version}"`,
      `description: "${description}"`,
      "runtime:",
      "  backend: shell",
      "  timeout: 30",
      "  network: false",
      "  isolation: container",
      "  shell:",
      `    command: "printf '{\\"version\\":\\"${version}\\"}\\\\n'"`,
      "actions:",
      "  - name: use_demo_skill",
      '    category: "app"',
      '    description: ["demo action"]',
      '    whenToUse: "when testing package lifecycle"',
    ].join("\n"),
  );

  return join(skillDir, "manifest.yaml");
}

function expectExportedWrapper(binDir: string, name: string): void {
  const commandPath = join(binDir, name);
  expect(existsSync(commandPath)).toBe(true);
  expect(readFileSync(commandPath, "utf-8")).toContain(`export ALICE_SKILL="${name}"`);
  expect(readFileSync(commandPath, "utf-8")).toContain(`exec "$self_dir/.${name}.real" "$@"`);
  expect(existsSync(join(binDir, `.${name}.real`))).toBe(true);
}

describe("skill package lifecycle", () => {
  it("installs, upgrades, and rolls back through the exported system prefix", async () => {
    const roots = makeRoots();
    const v1Manifest = writeSkillVersion(roots.root, "1.0.0", "demo skill v1");
    const v2Manifest = writeSkillVersion(roots.root, "2.0.0", "demo skill v2");

    await installSkill(v1Manifest, roots);

    const v1Entry = getEntry("luck", roots.registryPath);
    expect(v1Entry).toBeDefined();
    expect(v1Entry?.commandPath).toBe(join(roots.binDir, "luck"));
    expectExportedWrapper(roots.binDir, "luck");

    await upgradeSkill("luck", v2Manifest, roots);

    const v2Entry = getEntry("luck", roots.registryPath);
    expect(v2Entry?.version).toBe("2.0.0");
    expect(v2Entry?.previousHash).toBe(v1Entry?.hash);
    expectExportedWrapper(roots.binDir, "luck");

    await rollbackSkill("luck", roots);

    const rolledBack = getEntry("luck", roots.registryPath);
    expect(rolledBack?.version).toBe("1.0.0");
    expect(rolledBack?.hash).toBe(v1Entry?.hash);
    expect(rolledBack?.previousHash).toBe(v2Entry?.hash);
    expectExportedWrapper(roots.binDir, "luck");
  });

  it("removes exported artifacts from the system prefix on uninstall", async () => {
    const roots = makeRoots();
    const manifestPath = writeSkillVersion(roots.root, "1.0.0", "demo skill v1");

    await installSkill(manifestPath, roots);
    expect(existsSync(join(roots.binDir, "luck"))).toBe(true);

    await removeSkill("luck", roots);

    expect(existsSync(join(roots.binDir, "luck"))).toBe(false);
    expect(getEntry("luck", roots.registryPath)).toBeUndefined();
  });
});
