import { resolve } from "node:path";
import { wrapSkillExecutable } from "../src/skills/store.js";

const [, , rawPath, rawName] = process.argv;

if (!rawPath || !rawName) {
  console.error("Usage: tsx scripts/wrap-skill-bin.ts <path> <skill-name>");
  process.exit(1);
}

wrapSkillExecutable(resolve(rawPath), rawName);
