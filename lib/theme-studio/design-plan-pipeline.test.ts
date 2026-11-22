// The design plan through the real pipeline (owner, 22 Nov 2026): the design
// is planned before anything is built, the build is held to it and sees the
// screenshots, and a theme that could not be published is corrected or
// stopped BEFORE any photograph is drawn.
import { describe, expect, it } from "vitest";
import { THEME_STUDIO_LIMITS } from "./contracts";
import { layoutCommitments } from "./commitments";
import { createFakeModelClient, FAKE_DESIGN_PLAN } from "./fake-provider";
import {
  PUBLICATION_DISTINCTNESS_THRESHOLD,
  themeFingerprint,
  type ExistingThemeFingerprint,
} from "./fingerprint";
import {
  FLOOR_CORRECTIONS,
  runThemeGeneration,
  type GenerationInput,
} from "./pipeline";
import {
  ZERO_USAGE,
  type StructuredRequest,
  type StructuredResult,
  type ThemeStudioModelClient,
} from "./provider";

const facts = {
  name: "Clay & Co",
  themeId: "clay-co",
  industries: ["home" as const],
  catalogSizes: ["small" as const],
  requiredFeatures: [],
};
const BRIEF = "A calm ceramics shop. It should feel handmade.";

/** A real picture: a cream page with a terracotta block. */
async function screenshot(): Promise<string> {
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({
    create: { width: 320, height: 200, channels: 3, background: "#f5f1ea" },
  })
    .composite([
      {
        input: {
          create: {
            width: 90,
            height: 40,
            channels: 3,
            background: "#c2562e",
          },
        },
        left: 20,
        top: 20,
      },
    ])
    // Lossless, so the test can name the exact colours it drew.
    .webp({ lossless: true })
    .toBuffer();
  return bytes.toString("base64");
}

function input(over: Partial<GenerationInput> = {}): GenerationInput {
  return {
    facts: { ...facts, baseThemeName: null },
    compile: {
      ...facts,
      baseEngine: null,
      versionNumber: 1,
      modelKey: "gemini-3.8-flash",
      modelLabel: "Gemini 3.8 Flash",
      referenceDigests: [],
    },
    providerModel: "fake",
    promptVersion: "theme-studio-v34",
    messages: [{ kind: "brief", body: BRIEF }],
    references: [],
    ...over,
  };
}

type Rewrite = (
  request: StructuredRequest,
  answer: () => Promise<StructuredResult>,
  seen: StructuredRequest[],
) => Promise<StructuredResult> | StructuredResult | undefined;

/** The offline provider, with every request recorded and one hook. */
function scripted(referenceCount: number, rewrite?: Rewrite) {
  const fake = createFakeModelClient({
    ...facts,
    brief: BRIEF,
    referenceCount,
  });
  const seen: StructuredRequest[] = [];
  const client: ThemeStudioModelClient = {
    provider: "fake",
    async generate(request, signal) {
      seen.push(request);
      const answer = () => fake.generate(request, signal);
      return (await rewrite?.(request, answer, seen)) ?? answer();
    },
  };
  return { client, seen };
}
const run = (client: ThemeStudioModelClient, data: GenerationInput) =>
  runThemeGeneration(client, data, new AbortController().signal);
const text = (request: StructuredRequest) =>
  request.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
const stage = (seen: StructuredRequest[], name: string) =>
  seen.filter((request) => request.stage === name);
const isCorrection = (request: StructuredRequest) =>
  !!request.system?.includes("design-variety correction");

/** Stage A's answer with its plan replaced. */
async function withPlan(
  answer: () => Promise<StructuredResult>,
  plan: unknown,
): Promise<StructuredResult> {
  const response = await answer();
  if (response.kind !== "ok") return response;
  const value = response.value as { intent: Record<string, unknown> };
  value.intent.designPlanJson =
    typeof plan === "string" ? plan : JSON.stringify(plan);
  return response;
}

describe("★★ a new theme is planned before anything is built (v34)", () => {
  it("asks the planning stage for the design, with the screenshots' measured colours, and shows the build stage the screenshots", async () => {
    const reference = { base64: await screenshot(), sha256: "a".repeat(64) };
    const { client, seen } = scripted(1);
    const result = await run(client, input({ references: [reference] }));
    if (result.kind !== "version") throw new Error(JSON.stringify(result));

    const [planning] = stage(seen, "intent");
    expect(planning.system).toContain(
      "Design plan: decide this theme's design",
    );
    expect(JSON.stringify(planning.schema)).toContain('"designPlanJson"');
    // Measured from the picture's own pixels, beside the brief.
    expect(text(planning)).toContain("Reference 1: #f5f1ea");
    expect(text(planning)).toContain("(a candidate accent): #c2562e.");
    expect(text(planning)).toContain("the design to follow");
    expect(text(planning)).not.toContain("Extract design structure only");

    // The stage that builds the theme sees the screenshot it is following.
    const [build] = stage(seen, "draft");
    expect(build.content.filter((b) => b.type === "image")).toHaveLength(1);
    expect(text(build)).toContain("the design to follow");
    expect(build.system).toContain(
      "Design plan: this theme's design was decided",
    );

    // The plan is kept with the version; no layout was read (the offline
    // provider reads no picture), so none is claimed.
    expect(result.intent.designPlan).toMatchObject({
      version: 1,
      colours: FAKE_DESIGN_PLAN.colours,
      fontPairing: FAKE_DESIGN_PLAN.fontPairing,
      layout: null,
      layoutSource: "none",
    });
    expect(result.intent).not.toHaveProperty("designPlanJson");
  });

  it("gives a theme with no screenshots the catalogue's least-used layout as its plan's layout", async () => {
    const { client, seen } = scripted(0);
    const result = await run(client, input());
    if (result.kind !== "version") throw new Error(JSON.stringify(result));
    const plan = result.intent.designPlan!;
    expect(plan.layoutSource).toBe("catalogue");
    expect(plan.layout).toEqual(
      layoutCommitments(result.intent.designDirection, facts.themeId, []),
    );
    const [build] = stage(seen, "draft");
    expect(build.content.filter((b) => b.type === "image")).toHaveLength(0);
    expect(build.system).toContain(
      `design.layout.header = ${JSON.stringify(plan.layout!.header)}`,
    );
  });

  it("leaves every earlier prompt version, and every revision, exactly as it was", async () => {
    const reference = { base64: await screenshot(), sha256: "a".repeat(64) };
    const older = scripted(1);
    const before = await run(
      older.client,
      input({ references: [reference], promptVersion: "theme-studio-v33" }),
    );
    if (before.kind !== "version") throw new Error(JSON.stringify(before));
    const [planning] = stage(older.seen, "intent");
    expect(planning.system).not.toContain("Design plan:");
    expect(JSON.stringify(planning.schema)).not.toContain("designPlanJson");
    expect(text(planning)).toContain("Extract design structure only");
    expect(text(planning)).not.toContain("Colours measured");
    const [build] = stage(older.seen, "draft");
    expect(build.content.filter((b) => b.type === "image")).toHaveLength(0);
    expect(build.system).not.toContain("Design plan:");
    expect(before.intent.designPlan).toBeUndefined();

    // A change to a v34 theme plans nothing new: it keeps the design it has.
    const first = await run(scripted(0).client, input());
    if (first.kind !== "version") throw new Error(JSON.stringify(first));
    const change = scripted(0);
    const revised = await run(
      change.client,
      input({
        messages: [{ kind: "revision", body: "Make the footer simpler." }],
        revision: { baseIntent: first.intent, basePackage: first.package },
      }),
    );
    expect(revised.kind).toBe("version");
    for (const request of stage(change.seen, "intent")) {
      expect(request.system).not.toContain("Design plan: decide");
      expect(JSON.stringify(request.schema)).not.toContain("designPlanJson");
    }
    for (const request of stage(change.seen, "draft"))
      expect(request.system).not.toContain("Design plan: this theme's design");
  });

  it("sends an unusable plan back to the planning stage with what is wrong", async () => {
    let plans = 0;
    const { client, seen } = scripted(0, (request, answer) =>
      request.stage === "intent" && plans++ === 0
        ? withPlan(answer, {
            ...FAKE_DESIGN_PLAN,
            colours: { ...FAKE_DESIGN_PLAN.colours, ink: "#c8c8c8" },
          })
        : undefined,
    );
    const result = await run(client, input());
    if (result.kind !== "version") throw new Error(JSON.stringify(result));
    const planning = stage(seen, "intent");
    expect(planning).toHaveLength(2);
    expect(text(planning[1])).toMatch(
      /designPlan\.colours\.ink reads \d\.\d\d:1/,
    );
    expect(result.telemetry.repairs.intent).toBe(1);
    expect(result.intent.designPlan?.colours.ink).toBe(
      FAKE_DESIGN_PLAN.colours.ink,
    );
  });

  it("★ never fails a theme for its plan: without one it is built on its layout commitments", async () => {
    const { client, seen } = scripted(0, (request, answer) =>
      request.stage === "intent" ? withPlan(answer, "{not json") : undefined,
    );
    const result = await run(client, input());
    if (result.kind !== "version") throw new Error(JSON.stringify(result));
    expect(stage(seen, "intent")).toHaveLength(
      THEME_STUDIO_LIMITS.repairAttempts + 1,
    );
    expect(result.intent.designPlan).toBeUndefined();
    const [build] = stage(seen, "draft");
    expect(build.system).toContain("Layout commitments:");
    expect(build.system).not.toContain("Design plan: this theme's design");
  });
});

describe("★★ alikeness is settled before anything is drawn (v34)", () => {
  /** The theme the offline provider builds, as a published neighbour. */
  async function built() {
    const result = await run(scripted(0).client, input());
    if (result.kind !== "version") throw new Error(JSON.stringify(result));
    return result;
  }
  const published = (
    fingerprint: ExistingThemeFingerprint["fingerprint"],
    name = "Twin",
  ): ExistingThemeFingerprint => ({
    themeId: name.toLowerCase(),
    direction: null,
    fingerprint,
    published: true,
    name,
  });

  it("sends a plan too close to a published theme back to the planning stage, naming it", async () => {
    const own = await built();
    const twin = published(
      themeFingerprint(own.package.definition, { styling: true }),
    );
    // The neighbour shares everything the plan decides.
    const plan = own.intent.designPlan!;
    twin.fingerprint = {
      ...twin.fingerprint,
      composition: `${plan.layout!.header}/${plan.layout!.productDetail}/classic/${plan.layout!.footer}/classic`,
      card: plan.layout!.card,
      width: plan.layout!.pageWidth,
      buttons: `${plan.buttons.shape}/${plan.buttons.primary}/outline`,
    };
    const { client, seen } = scripted(0);
    const result = await run(
      client,
      // The offline drill is exempt from the floor; a real run is not.
      input({ existingThemes: [twin], skipCatalogueFloor: false }),
    );
    const planning = stage(seen, "intent");
    expect(planning.length).toBeGreaterThan(1);
    expect(text(planning[1])).toContain('too close to "Twin"');
    expect(text(planning[1])).toContain("which is already published");
    // The offline provider cannot change its plan, so the run reaches the
    // exact measure and stops there (below); what matters here is that the
    // planning stage was asked first, before anything was built.
    expect(seen.indexOf(planning[1])).toBeLessThan(
      seen.indexOf(stage(seen, "draft")[0]),
    );
    expect(result.kind).toBe("failed");
  });

  it("★★ stops a theme that could not be published, before any photograph, naming the theme it resembles", async () => {
    const own = await built();
    const twin = published(
      themeFingerprint(own.package.definition, { styling: true }),
      "Vitrine",
    );
    const { client, seen } = scripted(0);
    const result = await run(client, input({ existingThemes: [twin] }));
    if (result.kind !== "failed") throw new Error(result.kind);
    expect(result.errorCode).toBe("too_similar");
    expect(result.detail).toMatchObject({
      stage: "draft",
      nearestThemeId: "vitrine",
      nearestName: "Vitrine",
      alikePercent: 100,
    });
    expect(result.detail.shared).toContain("the product card");
    // It was given its corrections first, each told what it is too close to.
    const corrections = seen.filter(isCorrection);
    expect(corrections).toHaveLength(FLOOR_CORRECTIONS);
    for (const request of corrections) {
      expect(request.system).toContain("publishFloor names a PUBLISHED theme");
      expect(JSON.parse(text(request)).publishFloor).toMatchObject({
        minimum: PUBLICATION_DISTINCTNESS_THRESHOLD,
        nearest: "Vitrine",
        distance: 0,
      });
    }
    // Nothing after the build stage ran: no version, so nothing to draw.
    expect(result).not.toHaveProperty("package");
  });

  it("keeps a correction that clears the floor, and records what it was measured against", async () => {
    const own = await built();
    const fp = themeFingerprint(own.package.definition, { styling: true });
    // A published theme 33% away: another homepage, page colour and opening.
    const near = published(
      {
        ...fp,
        sections: ["rich_text", "testimonials", "newsletter"],
        pageColour: "near-black",
        hero: "hero:split:medium",
        styling: undefined,
      },
      "Basket",
    );
    const { client, seen } = scripted(0, (request) => {
      if (!isCorrection(request)) return undefined;
      const settings = JSON.parse(text(request)).settings as {
        path: string;
        current: unknown;
        choices?: unknown[];
      }[];
      const move = (suffix: string, prefer: string[]) => {
        const setting = settings.find((s) => s.path.endsWith(suffix))!;
        const value = prefer.find(
          (v) => v !== setting.current && setting.choices?.includes(v),
        )!;
        return { path: setting.path, valueJson: JSON.stringify(value) };
      };
      return {
        kind: "ok" as const,
        usage: ZERO_USAGE,
        value: {
          edits: [
            move("/design/layout/header", ["minimal", "centered", "classic"]),
            move("/design/layout/card", ["framed", "soft", "classic"]),
            move("/design/layout/footer", ["minimal", "compact", "rich"]),
          ],
          unrepairable: [],
        },
      };
    });
    const result = await run(client, input({ existingThemes: [near] }));
    if (result.kind !== "version") throw new Error(JSON.stringify(result));
    // One correction was enough; the second was never asked for.
    expect(seen.filter(isCorrection)).toHaveLength(1);
    expect(result.distinctness?.repairAttempted).toBe(true);
    expect(result.distinctness?.publishFloor).toMatchObject({
      threshold: PUBLICATION_DISTINCTNESS_THRESHOLD,
      nearestThemeId: "basket",
      nearestName: "Basket",
    });
    expect(result.distinctness!.publishFloor!.score).toBeGreaterThanOrEqual(
      PUBLICATION_DISTINCTNESS_THRESHOLD,
    );
  });

  it("holds a theme built from screenshots to the same floor", async () => {
    const reference = { base64: await screenshot(), sha256: "a".repeat(64) };
    const first = await run(
      scripted(1).client,
      input({ references: [reference] }),
    );
    if (first.kind !== "version") throw new Error(JSON.stringify(first));
    const twin = published(
      themeFingerprint(first.package.definition, { styling: true }),
    );
    const { client, seen } = scripted(1);
    const result = await run(
      client,
      input({ references: [reference], existingThemes: [twin] }),
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorCode).toBe("too_similar");
    expect(seen.filter(isCorrection)[0].system).toContain(
      "This theme follows reference screenshots: keep what they show most clearly",
    );
  });

  it("measures only against published themes, never a draft, and never for an earlier version or the offline drill", async () => {
    const own = await built();
    const fingerprint = themeFingerprint(own.package.definition, {
      styling: true,
    });
    const twin = published(fingerprint);
    // The same look-alike, unpublished: an operator's own draft.
    const draft = await run(
      scripted(0).client,
      input({ existingThemes: [{ ...twin, published: undefined }] }),
    );
    expect(draft.kind).toBe("version");
    if (draft.kind === "version")
      expect(draft.distinctness?.publishFloor).toBeUndefined();
    // v33 keeps its behaviour: built, with the alikeness only reported.
    const older = await run(
      scripted(0).client,
      input({ existingThemes: [twin], promptVersion: "theme-studio-v33" }),
    );
    expect(older.kind).toBe("version");
    // The offline drill rebuilds a bundled theme by construction.
    const drill = scripted(0);
    const drilled = await run(
      drill.client,
      input({ existingThemes: [twin], skipCatalogueFloor: true }),
    );
    expect(drilled.kind).toBe("version");
    expect(stage(drill.seen, "intent")).toHaveLength(1);
  });
});
