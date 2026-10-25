import { describe, expect, it } from "vitest";
import { renderMinkSystemInstruction } from "./system-prompt";
import {
  applyMinkToolRoute,
  routeMinkTools,
  type MinkToolRouteInput,
} from "./tool-routing";
import { minkReadToolRegistry } from "./tools/read-tools";
import type { MinkActorContext, MinkToolDeclaration } from "./types";

// ---------------------------------------------------------------------------
// ★★ THE PROMPT AND THE TOOL DECLARATIONS ARE RE-SENT ON EVERY MODEL STEP, so
// their size is a cost every merchant pays on every question, for good. They
// grew from ~7,000 tokens a step (draft-beta-v9) to ~27,000 (draft-beta-v42)
// with nothing deciding it, one useful sentence at a time. These budgets make
// growth a decision: a change that crosses one fails here, and raising the
// number is a line in the diff that a reviewer sees.
//
// Characters, not tokens: no tokenizer runs in CI, and for this English prose
// and JSON Gemini averages about 4.7 characters a token (measured with the
// free countTokens call on 2026-10-19).
//
// ⚠ IF THIS FAILS: first try to make the new text shorter, or tag a rule to
// its tool (`[[when: ...]]`, docs/mink-ai-system-prompt.md §3a) so it is sent
// only with that tool. Raise a budget only when the extra size is worth paying
// on every step of every run, and say so in the commit.
// ---------------------------------------------------------------------------

const OWNER: MinkActorContext = {
  storeId: "store",
  adminId: "owner",
  email: null,
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request",
  draftingEnabled: true,
};

/** What a declaration costs on the wire: name, description and schema. */
function declarationSize(declarations: MinkToolDeclaration[]): number {
  return declarations.reduce(
    (total, tool) =>
      total +
      tool.name.length +
      tool.description.length +
      JSON.stringify(tool.parametersJsonSchema).length,
    0,
  );
}

function measure(
  message: string | null,
  extra: Partial<MinkToolRouteInput> = {},
) {
  const permitted = minkReadToolRegistry.declarationsFor(OWNER);
  const route = message === null ? null : routeMinkTools({ message, ...extra });
  const routed = applyMinkToolRoute(permitted, route);
  const prompt = renderMinkSystemInstruction(
    OWNER,
    routed.declarations,
    routed.narrowed ? route : null,
  ).length;
  const tools = declarationSize(routed.declarations);
  const names = new Set(routed.declarations.map((tool) => tool.name));
  return { prompt, tools, total: prompt + tools, names };
}

describe("★★ Mink prompt and tool budget (characters per model step)", () => {
  it("an owner with every tool", () => {
    const full = measure(null);
    // 2026-10-19: prompt 55,447, tools 71,234 (60 declarations).
    // 2026-10-20: raised for storefront personalisation, two tools (5,851
    // characters of declarations) and one interview rule (1,532). Paid only
    // by a run routed to them or one that falls back to every tool, which is
    // why it is worth it: measured prompt 58,276, tools 75,722.
    expect(full.prompt).toBeLessThanOrEqual(59_000);
    expect(full.tools).toBeLessThanOrEqual(76_500);
    expect(full.total).toBeLessThanOrEqual(135_000);
  });

  it("the rules every run carries, with no tool at all", () => {
    // 2026-10-19: 8,243. Untagged rules belong here only if EVERY run needs them.
    expect(
      renderMinkSystemInstruction(OWNER, [], {
        mode: "narrow",
        groups: ["core"],
      }).length,
    ).toBeLessThanOrEqual(9_000);
  });

  it("no single tool declaration over 6,000 characters", () => {
    for (const tool of minkReadToolRegistry.declarationsFor({
      ...OWNER,
      selectedResource: { type: "product", id: "product" },
    }))
      expect(declarationSize([tool]), tool.name).toBeLessThanOrEqual(6_000);
  });

  // 2026-10-19 measured totals: help 19,074; sales 15,537; stock 15,355;
  // orders 11,585; smalltalk 10,642 (against 126,681 for every tool).
  it.each([
    ["a help question", "How can I upload a photo?", 20_000],
    ["a sales question", "How much did I sell today?", 16_500],
    ["a stock question", "Which products are running low?", 16_500],
    ["an orders question", "Show my pending orders", 12_500],
    ["smalltalk", "thanks!", 11_500],
  ])("★ %s stays a small fraction of the whole", (_label, message, budget) => {
    const routed = measure(message);
    expect(routed.total).toBeLessThanOrEqual(budget);
    expect(routed.total / measure(null).total).toBeLessThan(0.2);
  });

  // ★ The storefront redesign replaced the personalisation proposal on
  //   2026-10-21. Its interview measured 30,241 on 2026-10-20 (the Builder
  //   reads come along with "website"); the redesign keeps that ceiling, and
  //   its tagged rule is shorter than the one it replaced (1,323 characters
  //   against 1,532), so nothing here was raised for it.
  it.each([
    ["a redesign request", "Customise my store for my business", {}, "start"],
    [
      "a redesign that names the website",
      "redesign my website for my mustard oil business",
      {},
      "start",
    ],
    [
      "a refinement of a finished redesign",
      "make it warmer",
      { revamp: { hasReady: true, hasActive: false } },
      "refine",
    ],
  ])(
    "★ %s carries the redesign tools, not every tool",
    (_label, message, extra, next) => {
      const routed = measure(message, extra);
      expect(routed.names.has("get_storefront_revamp_context")).toBe(true);
      expect(
        routed.names.has(
          next === "start"
            ? "start_storefront_revamp"
            : "refine_storefront_revamp",
        ),
      ).toBe(true);
      expect(routed.total).toBeLessThanOrEqual(32_000);
      expect(routed.total / measure(null).total).toBeLessThan(0.25);
    },
  );
});
