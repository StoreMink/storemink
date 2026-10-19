import { describe, expect, it } from "vitest";
import { renderMinkSystemInstruction } from "./system-prompt";
import { applyMinkToolRoute, routeMinkTools } from "./tool-routing";
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

function measure(message: string | null) {
  const permitted = minkReadToolRegistry.declarationsFor(OWNER);
  const route = message === null ? null : routeMinkTools({ message });
  const routed = applyMinkToolRoute(permitted, route);
  const prompt = renderMinkSystemInstruction(
    OWNER,
    routed.declarations,
    routed.narrowed ? route : null,
  ).length;
  const tools = declarationSize(routed.declarations);
  return { prompt, tools, total: prompt + tools };
}

describe("★★ Mink prompt and tool budget (characters per model step)", () => {
  it("an owner with every tool", () => {
    const full = measure(null);
    // 2026-10-19: prompt 55,447, tools 71,234 (60 declarations).
    expect(full.prompt).toBeLessThanOrEqual(57_500);
    expect(full.tools).toBeLessThanOrEqual(74_000);
    expect(full.total).toBeLessThanOrEqual(131_000);
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
});
