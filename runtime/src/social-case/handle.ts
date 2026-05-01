/**
 * Prompt-visible social case handles.
 *
 * The handle is deliberately not the fact authority. It is a short phrase Alice
 * can copy into a command; hidden context maps it back to the stable caseId.
 *
 * @see docs/adr/262-social-case-management/README.md
 */
import { createHash } from "node:crypto";
import { en, Faker } from "@faker-js/faker";

const HANDLE_ADJECTIVES = [
  "bright",
  "careful",
  "clear",
  "direct",
  "firm",
  "fresh",
  "gentle",
  "honest",
  "open",
  "plain",
  "quiet",
  "shared",
  "steady",
  "warm",
] as const;

const HANDLE_NOUNS = [
  "apology",
  "boundary",
  "bridge",
  "context",
  "note",
  "promise",
  "question",
  "record",
  "repair",
  "reply",
  "signal",
  "trace",
] as const;

const HANDLE_SUFFIXES = ["anchor", "mark", "path", "point", "scope", "step"] as const;

function seedNumber(seed: string, salt: number): number {
  const digest = createHash("sha256").update(seed).update(String(salt)).digest();
  return digest.readUInt32BE(0);
}

function seededFaker(seed: string, salt: number): Faker {
  const faker = new Faker({ locale: [en] });
  faker.seed(seedNumber(seed, salt));
  return faker;
}

function buildCandidate(seed: string, salt: number): string {
  const faker = seededFaker(seed, salt);
  const adjective = faker.helpers.arrayElement(HANDLE_ADJECTIVES);
  const noun = faker.helpers.arrayElement(HANDLE_NOUNS);
  if (salt === 0) return `${adjective}-${noun}`;
  const suffix = faker.helpers.arrayElement(HANDLE_SUFFIXES);
  return `${adjective}-${noun}-${suffix}`;
}

export function makeSocialCaseHandle(input: {
  caseId: string;
  about: string;
  usedHandles?: ReadonlySet<string>;
}): string {
  const seed = `${input.caseId}\n${input.about}`;
  for (let salt = 0; salt < 64; salt++) {
    const candidate = buildCandidate(seed, salt);
    if (!input.usedHandles?.has(candidate)) return candidate;
  }

  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `case-${digest}`;
}
