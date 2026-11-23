import { describe, expect, it } from "vitest";
import type { ThemePackageV2 } from "./contracts";
import { createFakeModelClient } from "./fake-provider";
import {
  changedSettings,
  FOLLOW_UP_REPAIR_RULE,
  FOLLOW_UP_REQUEST_LIMIT,
  followUpOf,
  undoneSettings,
} from "./follow-up-guard";
import { runThemeGeneration, type GenerationInput } from "./pipeline";
import { THEME_STUDIO_PROMPT_VERSION } from "./prompt-features";
import {
  ZERO_USAGE,
  type StructuredRequest,
  type ThemeStudioModelClient,
} from "./provider";

// Owner, 23 Nov 2026: "ai theme builder should be capable of understanding
// the follow ups the operator gives". An automatic fix round after an
// operator's change used to see only the review's findings, so it could set
// back the very setting the change made.

const HEADER = "/definition/preset/design/layout/header";
const CART = "/definition/preset/design/layout/cart";
const REQUEST =
  "there is no navigation or shop button in the navbar. add that. rest is ok";

const brief = {
  name: "Muse",
  brief: "An airy, minimal fashion house.",
  industries: ["home" as const],
  catalogSizes: ["small" as const],
  requiredFeatures: [],
  referenceCount: 0,
};

function input(): GenerationInput {
  return {
    facts: {
      name: brief.name,
      themeId: "muse",
      industries: ["home"],
      catalogSizes: ["small"],
      requiredFeatures: [],
      baseThemeName: null,
    },
    compile: {
      themeId: "muse",
      name: brief.name,
      industries: ["home"],
      catalogSizes: ["small"],
      requiredFeatures: [],
      baseEngine: null,
      versionNumber: 1,
      modelKey: "gemini-3.8-flash",
      modelLabel: "Gemini 3.8 Flash",
      referenceDigests: [],
    },
    providerModel: "fake",
    promptVersion: "theme-studio-v1",
    messages: [{ kind: "brief", body: brief.brief }],
    references: [],
  };
}

/** A first build, then the operator's change: the menu out from behind the
 *  menu button (hamburger to centered). */
async function operatorChange() {
  const built = await runThemeGeneration(
    createFakeModelClient(brief),
    input(),
    new AbortController().signal,
  );
  if (built.kind !== "version") throw new Error("fixture failed");
  const before = structuredClone(built.package);
  before.definition.preset.design.layout = {
    ...before.definition.preset.design.layout,
    header: "hamburger",
  };
  const after = structuredClone(before);
  after.definition.preset.design.layout = {
    ...after.definition.preset.design.layout,
    header: "centered",
  };
  return { intent: built.intent, before, after };
}

/** An automatic fix round on the operator's result, answered by `answers`. */
async function fix(
  answers: { path: string; valueJson: string }[][],
  withFollowUp = true,
  promptVersion = THEME_STUDIO_PROMPT_VERSION,
) {
  const change = await operatorChange();
  const requests: StructuredRequest[] = [];
  const client: ThemeStudioModelClient = {
    provider: "fake",
    async generate(request) {
      requests.push(request);
      return {
        kind: "ok",
        usage: ZERO_USAGE,
        value: { edits: answers[requests.length - 1] ?? [], unrepairable: [] },
      };
    },
  };
  const outcome = await runThemeGeneration(
    client,
    {
      ...input(),
      promptVersion,
      compile: { ...input().compile, versionNumber: 3 },
      automaticRepair: true,
      revision: { baseIntent: change.intent, basePackage: change.after },
      messages: [
        {
          kind: "revision",
          body: "Revise this theme to clear its automatic checks.\nVisual: the header feels busy.",
        },
      ],
      ...(withFollowUp
        ? { followUp: followUpOf(REQUEST, change.before, change.after) }
        : {}),
    },
    new AbortController().signal,
  );
  const header = (pkg: ThemePackageV2) =>
    pkg.definition.preset.design.layout?.header;
  return { outcome, requests, header };
}

const context = (request: StructuredRequest) =>
  JSON.parse(
    (request.content[0] as { text: string }).text.split(
      "\nValidation issues:",
    )[0],
  );

describe("followUpOf", () => {
  it("keeps every setting the change moved with its value before the change, and the request", async () => {
    const change = await operatorChange();
    const followUp = followUpOf(REQUEST, change.before, change.after);
    expect(followUp.request).toBe(REQUEST);
    expect(followUp.before).toEqual({ [HEADER]: "hamburger" });
    expect(changedSettings(change.after, change.after)).toEqual({});
  });

  it("records an added setting as null, and bounds the request", async () => {
    const change = await operatorChange();
    const added = structuredClone(change.after);
    added.definition.preset.design.layout = {
      ...added.definition.preset.design.layout,
      cart: "compact",
    };
    const before = changedSettings(change.after, added);
    expect(Object.keys(before)).toEqual([CART]);
    expect(before[CART]).toBeNull();
    expect(
      followUpOf("x".repeat(5_000), change.before, change.after).request,
    ).toHaveLength(FOLLOW_UP_REQUEST_LIMIT);
  });

  it("names a fix that sets a moved setting back, and nothing else", async () => {
    const change = await operatorChange();
    const followUp = followUpOf(REQUEST, change.before, change.after);
    // Setting it back is undoing the request.
    expect(undoneSettings(followUp, [HEADER], change.before)).toEqual([HEADER]);
    // Another value for it is not (a fix may still need to change it).
    const stacked = structuredClone(change.after);
    stacked.definition.preset.design.layout = {
      ...stacked.definition.preset.design.layout,
      header: "stacked",
    };
    expect(undoneSettings(followUp, [HEADER], stacked)).toEqual([]);
    // A setting the change never moved is the fix's to change.
    expect(undoneSettings(followUp, [CART], change.before)).toEqual([]);
  });
});

describe("an automatic fix after an operator's change", () => {
  it("★ is given the request, and asked again when it would set the change back", async () => {
    const { outcome, requests, header } = await fix([
      [{ path: HEADER, valueJson: '"hamburger"' }],
      [{ path: CART, valueJson: '"compact"' }],
    ]);
    expect(requests).toHaveLength(2);
    expect(context(requests[0]).operatorRequest).toBe(REQUEST);
    expect(requests[0].system).toContain(FOLLOW_UP_REPAIR_RULE);
    expect((requests[1].content[0] as { text: string }).text).toContain(
      `${HEADER}: the operator's latest request set this`,
    );
    expect(outcome.kind).toBe("version");
    if (outcome.kind !== "version") return;
    expect(header(outcome.package)).toBe("centered");
    expect(outcome.package.definition.preset.design.layout?.cart).toBe(
      "compact",
    );
    expect(outcome.package.provenance.promptVersion).toMatch(
      /targeted-repair-v2$/,
    );
  });

  it("drops an undo it repeats and keeps the rest of the fix", async () => {
    const undo = { path: HEADER, valueJson: '"hamburger"' };
    const cart = { path: CART, valueJson: '"compact"' };
    const { outcome, requests, header } = await fix([[undo], [undo, cart]]);
    expect(requests).toHaveLength(2);
    expect(outcome.kind).toBe("version");
    if (outcome.kind !== "version") return;
    expect(header(outcome.package)).toBe("centered");
    expect(outcome.package.definition.preset.design.layout?.cart).toBe(
      "compact",
    );
  });

  it("stops, for the operator, when every fix would undo the request", async () => {
    const undo = { path: HEADER, valueJson: '"hamburger"' };
    const { outcome } = await fix([[undo], [undo]]);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.errorCode).toBe("repair_not_supported");
    expect(outcome.detail.findings).toEqual([
      "Every automatic fix would undo the operator's latest request.",
    ]);
  });

  it("a run queued under v34 keeps its request byte for byte, follow-up or not", async () => {
    const { outcome, requests, header } = await fix(
      [[{ path: HEADER, valueJson: '"hamburger"' }]],
      true,
      "theme-studio-v34",
    );
    expect(requests).toHaveLength(1);
    expect(context(requests[0])).not.toHaveProperty("operatorRequest");
    expect(requests[0].system).not.toContain(FOLLOW_UP_REPAIR_RULE);
    expect(outcome.kind).toBe("version");
    if (outcome.kind !== "version") return;
    expect(header(outcome.package)).toBe("hamburger");
  });

  it("without an operator's change, a fix runs exactly as before", async () => {
    const { outcome, requests, header } = await fix(
      [[{ path: HEADER, valueJson: '"hamburger"' }]],
      false,
    );
    expect(requests).toHaveLength(1);
    expect(context(requests[0])).not.toHaveProperty("operatorRequest");
    expect(requests[0].system).not.toContain(FOLLOW_UP_REPAIR_RULE);
    expect(outcome.kind).toBe("version");
    if (outcome.kind !== "version") return;
    expect(header(outcome.package)).toBe("hamburger");
    expect(outcome.package.provenance.promptVersion).toMatch(
      /targeted-repair-v1$/,
    );
  });
});
