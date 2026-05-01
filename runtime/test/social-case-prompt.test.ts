import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import { writeSocialEvent } from "../src/db/social-case.js";
import { WorldModel } from "../src/graph/world-model.js";
import { renderGroup } from "../src/prompt/renderers/group.js";
import { renderPrivate } from "../src/prompt/renderers/private.js";
import { buildUserPromptSnapshot } from "../src/prompt/snapshot.js";
import {
  buildSocialCasePromptLines,
  buildSocialCasePromptSurface,
} from "../src/social-case/prompt.js";
import type { SocialEvent } from "../src/social-case/types.js";

const NOW_MS = Date.UTC(2026, 3, 29, 0, 0, 0);
const ALICE = "alice";
const A = "contact:42";
const GROUP = "channel:-1001";
const SECOND_GROUP = "channel:-1002";
const UNRELATED_GROUP = "channel:-1003";
const PRIVATE_A = "channel:42";

function event(
  overrides: Partial<SocialEvent> & Pick<SocialEvent, "id" | "kind" | "occurredAtMs">,
): SocialEvent {
  return {
    actorId: A,
    targetId: ALICE,
    affectedRelation: [ALICE, A],
    venueId: GROUP,
    visibility: "public",
    witnesses: [],
    severity: 0.8,
    confidence: 0.95,
    evidenceMsgIds: [1001],
    ...overrides,
  };
}

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent("self");
  G.addContact(A, { display_name: "A", tier: 50 });
  G.addChannel(PRIVATE_A, { chat_type: "private", display_name: "A" });
  G.addChannel(GROUP, { chat_type: "supergroup", display_name: "技术群" });
  G.addChannel(SECOND_GROUP, { chat_type: "supergroup", display_name: "另一个群" });
  G.addChannel(UNRELATED_GROUP, { chat_type: "supergroup", display_name: "路人群" });
  G.addRelation(GROUP, "joined", A);
  G.addRelation(SECOND_GROUP, "joined", A);
  G.addRelation(A, "joined", PRIVATE_A);
  return G;
}

function addOpenCaseFacts(): void {
  writeSocialEvent(
    event({
      id: "e1",
      kind: "insult",
      occurredAtMs: 1,
      text: "Alice 你真的很蠢，别装懂了.",
      causes: [
        {
          kind: "social_meaning",
          text: "This was public, named Alice directly, and attacked ability rather than the topic.",
          visibility: "public",
        },
      ],
    }),
  );
  writeSocialEvent(
    event({
      id: "e2",
      kind: "repair_attempt",
      actorId: ALICE,
      targetId: A,
      venueId: PRIVATE_A,
      visibility: "private",
      witnesses: [],
      occurredAtMs: 2,
      severity: 0.3,
      confidence: 0.8,
      evidenceMsgIds: [],
      causes: [
        {
          kind: "actor_explanation",
          text: "A said privately that they were angry and spoke too harshly.",
          visibility: "private",
          venueId: PRIVATE_A,
        },
      ],
    }),
  );
}

function snapshotInput(
  G: WorldModel,
  target: string,
  chatType: "private" | "supergroup",
  socialCaseLines: string[],
): Parameters<typeof buildUserPromptSnapshot>[0] {
  return {
    G,
    messages: [],
    observations: [],
    item: { action: "conversation", target, facetId: "core" } as never,
    round: 0,
    board: { maxSteps: 3, contextVars: {} },
    nowMs: NOW_MS,
    timezoneOffset: 9,
    chatType,
    isGroup: chatType === "supergroup",
    isChannel: false,
    socialCaseLines,
  };
}

describe("ADR-262 social case prompt replay", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("does not render a social case section when no open case is relevant", () => {
    const G = makeGraph();
    const lines = buildSocialCasePromptLines({ G, target: GROUP, chatType: "supergroup" });
    const rendered = renderGroup(
      buildUserPromptSnapshot(snapshotInput(G, GROUP, "supergroup", lines)),
    );

    expect(lines).toEqual([]);
    expect(rendered).not.toContain("## Social cases");
  });

  it("renders a group prompt case brief without leaking private cause text or internals", () => {
    const G = makeGraph();
    addOpenCaseFacts();

    const lines = buildSocialCasePromptLines({ G, target: GROUP, chatType: "supergroup" });
    const rendered = renderGroup(
      buildUserPromptSnapshot(snapshotInput(G, GROUP, "supergroup", lines)),
    );

    expect(rendered).toContain("## Social cases");
    expect(rendered).toContain("Social case with A");
    expect(rendered).toContain("Case brief:");
    expect(rendered).toMatch(/Case handle: [a-z]+-[a-z]+/);
    expect(rendered).toContain("发生了什么:");
    expect(rendered).toContain("Action runbook:");
    expect(rendered).toContain("self social-case-note");
    expect(rendered).toMatch(/--case "[a-z]+-[a-z]+"/);
    expect(rendered).not.toContain("--about");
    expect(rendered).not.toContain("caseId");
    expect(rendered).not.toContain("--caseId");
    expect(rendered).not.toContain("social-case:");
    expect(rendered).not.toContain("repair attempt in A");
    expect(rendered).toContain("private detail(s) exist");
    expect(rendered).not.toContain("angry and spoke too harshly");
    expect(rendered).not.toMatch(
      /repairState|venueDebt|boundaryStatus|social_events|projection|IAUS/,
    );
    expect(rendered).not.toContain("contact:42");
    expect(rendered).not.toContain("channel:-1001");
  });

  it("returns hidden context vars for visible case writeback", () => {
    const G = makeGraph();
    addOpenCaseFacts();

    const surface = buildSocialCasePromptSurface({ G, target: GROUP, chatType: "supergroup" });

    expect(surface.lines.join("\n")).not.toContain("caseId");
    expect(surface.lines.join("\n")).toMatch(/Case handle: [a-z]+-[a-z]+/);
    const handle = surface.contextVars.CURRENT_SOCIAL_CASE_HANDLE;
    expect(handle).toMatch(/^[a-z]+-[a-z]+/);
    expect(surface.contextVars).toMatchObject({
      CURRENT_SOCIAL_CASE_ABOUT: "A / insult in 技术群",
      CURRENT_SOCIAL_CASE_HANDLE: handle,
      CURRENT_SOCIAL_CASE_ID: expect.stringMatching(/^social-case:/),
      SOCIAL_CASE_0_ABOUT: "A / insult in 技术群",
      SOCIAL_CASE_0_HANDLE: handle,
      SOCIAL_CASE_0_ID: expect.stringMatching(/^social-case:/),
    });
  });

  it("allows private prompt replay to use private cause text", () => {
    const G = makeGraph();
    addOpenCaseFacts();

    const lines = buildSocialCasePromptLines({ G, target: PRIVATE_A, chatType: "private" });
    const rendered = renderPrivate(
      buildUserPromptSnapshot(snapshotInput(G, PRIVATE_A, "private", lines)),
    );

    expect(rendered).toContain("## Social cases");
    expect(rendered).toContain("angry and spoke too harshly");
  });

  it("matches private prompts through graph membership even when channel/contact IDs are not mirrored", () => {
    const G = new WorldModel();
    const contact = "contact:clear-falcon";
    const privateChannel = "channel:quiet-room";
    G.addAgent("self");
    G.addContact(contact, { display_name: "A", tier: 50 });
    G.addChannel(privateChannel, { chat_type: "private", display_name: "A 私聊" });
    G.addRelation(contact, "joined", privateChannel);
    writeSocialEvent(
      event({
        id: "phrase-private-id",
        caseId: "case:phrase-private-id",
        kind: "insult",
        actorId: contact,
        affectedRelation: [ALICE, contact],
        venueId: privateChannel,
        visibility: "private",
        occurredAtMs: 10,
        causes: [
          {
            kind: "actor_explanation",
            text: "A privately explained the phrase-id case.",
            visibility: "private",
            venueId: privateChannel,
          },
        ],
      }),
    );

    const lines = buildSocialCasePromptLines({
      G,
      target: privateChannel,
      chatType: "private",
    });

    expect(lines.join("\n")).toContain("A privately explained the phrase-id case.");
  });

  it("shows an open case in another group when the affected person is present here", () => {
    const G = makeGraph();
    addOpenCaseFacts();

    const lines = buildSocialCasePromptLines({
      G,
      target: SECOND_GROUP,
      chatType: "supergroup",
    });
    const rendered = renderGroup(
      buildUserPromptSnapshot(snapshotInput(G, SECOND_GROUP, "supergroup", lines)),
    );

    expect(rendered).toContain("## Social cases");
    expect(rendered).toContain("Social case with A");
    expect(rendered).toContain("In 技术群");
    expect(rendered).not.toContain("angry and spoke too harshly");
  });

  it("does not show an open case in an unrelated group", () => {
    const G = makeGraph();
    addOpenCaseFacts();

    const lines = buildSocialCasePromptLines({
      G,
      target: UNRELATED_GROUP,
      chatType: "supergroup",
    });

    expect(lines).toEqual([]);
  });

  it("keeps low-confidence social cases out of ordinary prompt replay", () => {
    const G = makeGraph();
    writeSocialEvent(
      event({
        id: "low-confidence-harm",
        kind: "exclusion",
        occurredAtMs: 1,
        confidence: 0.35,
        text: "没人接 Alice 的话，但证据还不够.",
      }),
    );

    const lines = buildSocialCasePromptLines({ G, target: GROUP, chatType: "supergroup" });

    expect(lines).toEqual([]);
  });
});
