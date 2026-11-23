// A centred-logo theme's menu through the real pipeline (owner, 23 Nov 2026:
// "in the planning it should judge, if the logo is in the center, how much
// space is to the left, and according to that design the number of
// buttons"). Offline provider: no network, no model call.
import { describe, expect, it } from "vitest";
import { DIRECTION_SIGNATURES } from "./commitments";
import type { ThemePackageV2 } from "./contracts";
import { createFakeModelClient, FAKE_DESIGN_PLAN } from "./fake-provider";
import { headerMenuFit, menuRoomPrompt } from "./menu-fit";
import { runThemeGeneration, type GenerationInput } from "./pipeline";
import { THEME_STUDIO_PROMPT_VERSION } from "./prompt-features";
import type {
  StructuredRequest,
  StructuredResult,
  ThemeStudioModelClient,
} from "./provider";

const facts = {
  name: "Muse",
  themeId: "muse",
  industries: ["home" as const],
  catalogSizes: ["small" as const],
  requiredFeatures: [],
};
const BRIEF = "An airy, minimal shop for considered home goods.";
const CAPITALS = {
  hook: "header.nav-link",
  declarations: {
    fontFamily: "display",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  },
};
const TITLES = [
  "Our Story",
  "The Journal",
  "Lookbook",
  "Visit The Studio",
  "Contact Us",
];

/** A plan layout with the centred header, from a direction that allows it. */
function centredLayout() {
  const signature = Object.values(DIRECTION_SIGNATURES).find((s) =>
    (s.headers as readonly string[]).includes("centered"),
  )!;
  return {
    header: "centered",
    card: signature.cards[0],
    productDetail: signature.productDetails[0],
    footer: signature.footers[0],
    pageWidth: "standard",
    gridColumnsDesktop: signature.columns[0],
    cardHoverImage: false,
  };
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
    promptVersion: THEME_STUDIO_PROMPT_VERSION,
    messages: [{ kind: "brief", body: BRIEF }],
    // A screenshot, so the plan's layout is the one the planning stage read.
    references: [{ base64: "AAAA", sha256: "a".repeat(64) }],
    ...over,
  };
}

type Value = Record<string, unknown>;

/** The offline provider: the plan reads a centred header, and a new theme's
 *  draft has five pages and its menu in Bodoni-style capitals. */
function scripted(
  brief: string,
  rewriteDraft?: (draft: Value, seen: StructuredRequest[]) => void,
) {
  const fake = createFakeModelClient({ ...facts, brief, referenceCount: 1 });
  const seen: StructuredRequest[] = [];
  const client: ThemeStudioModelClient = {
    provider: "fake",
    async generate(request, signal) {
      seen.push(request);
      const response: StructuredResult = await fake.generate(request, signal);
      if (response.kind !== "ok") return response;
      const value = response.value as Value;
      // Only where the planning stage is asked for a plan (a new theme).
      if (
        request.stage === "intent" &&
        value.intent &&
        Object.hasOwn(value.intent as Value, "designPlanJson")
      ) {
        (value.intent as Value).designPlanJson = JSON.stringify({
          ...FAKE_DESIGN_PLAN,
          layout: centredLayout(),
        });
      }
      if (request.stage === "draft") rewriteDraft?.(value, seen);
      return response;
    },
  };
  return { client, seen };
}

/** Five pages beside the home page, each a copy of the About page. */
function morePages(draft: Value) {
  const pages = draft.pages as Value[];
  const about = pages.find((p) => p.slug === "about");
  if (!about || pages.length > 2) return;
  pages.splice(
    pages.indexOf(about),
    1,
    ...TITLES.map((title) => ({
      ...structuredClone(about),
      slug: title.toLowerCase().replace(/\s+/g, "-"),
      title,
      seoTitle: null,
    })),
  );
  draft.stylesheetJson = JSON.stringify([
    ...JSON.parse(String(draft.stylesheetJson ?? "[]")),
    CAPITALS,
  ]);
}

const run = (client: ThemeStudioModelClient, data: GenerationInput) =>
  runThemeGeneration(client, data, new AbortController().signal);
const labels = (pkg: ThemePackageV2) =>
  pkg.definition.preset.menus.header.map((link) => link.label);

describe("★★ a new centred theme's menu is planned to fit beside the logo (v35)", () => {
  it("tells the build its menu's room, and keeps in the header Shop and the pages that fit; the footer keeps them all", async () => {
    const { client, seen } = scripted(BRIEF, morePages);
    const result = await run(client, input());
    if (result.kind !== "version") throw new Error(JSON.stringify(result));
    const plan = result.intent.designPlan!;
    expect(plan.layout?.header).toBe("centered");

    const [build] = seen.filter((r) => r.stage === "draft");
    const room = menuRoomPrompt(plan, facts.name);
    expect(room).toContain("Header menu: the planned header is centred");
    expect(build.system.endsWith(room)).toBe(true);

    const pkg = result.package;
    expect(pkg.definition.preset.design.layout?.header).toBe("centered");
    const kept = labels(pkg);
    expect(kept[0]).toBe("Shop");
    expect(kept.length).toBeLessThan(1 + TITLES.length);
    expect(kept.slice(1)).toEqual(TITLES.slice(0, kept.length - 1));
    expect(headerMenuFit(pkg, facts.name)?.fits).toBe(true);
    const footer = pkg.definition.preset.menus.footerGroups.flatMap((g) =>
      g.links.map((l) => l.label),
    );
    for (const title of TITLES) expect(footer).toContain(title);
  });

  it("an earlier prompt version keeps every derived link and is told nothing", async () => {
    const { client, seen } = scripted(BRIEF, morePages);
    const result = await run(
      client,
      input({ promptVersion: "theme-studio-v34" }),
    );
    if (result.kind !== "version") throw new Error(JSON.stringify(result));
    const [build] = seen.filter((r) => r.stage === "draft");
    expect(build.system).not.toContain("Header menu: the planned header");
    expect(labels(result.package)).toEqual(["Shop", ...TITLES]);
  });

  it("★ a change that makes the menu too wide is sent back once with the numbers, and what comes back is accepted", async () => {
    const first = await run(scripted(BRIEF).client, input());
    if (first.kind !== "version") throw new Error(JSON.stringify(first));
    expect(headerMenuFit(first.package, facts.name)?.fits).toBe(true);

    const body = "Add navigation buttons for every collection and our story.";
    const long = [
      { label: "Shop", href: "/shop" },
      { label: "Everyday", href: "/collections/everyday" },
      { label: "Home", href: "/collections/home" },
      { label: "Travel", href: "/collections/travel" },
      { label: "Gifts", href: "/collections/gifts" },
      { label: "Our Story", href: "/about" },
    ].map((link) => ({ ...link, image_url: "", children: [] }));
    const { client, seen } = scripted(BRIEF, (draft) => {
      (draft.menus as Value).header = structuredClone(long);
      draft.stylesheetJson = JSON.stringify([CAPITALS]);
    });
    const current = input();
    const revised = await run(client, {
      ...current,
      compile: { ...current.compile, versionNumber: 2 },
      messages: [{ kind: "revision", body }],
      revision: { baseIntent: first.intent, basePackage: first.package },
      operatorChange: {
        recreateContext: async () => ({
          messages: [{ kind: "brief", body: BRIEF }],
          references: [],
        }),
      },
    });
    if (revised.kind !== "version") throw new Error(JSON.stringify(revised));
    const drafts = seen.filter((r) => r.stage === "draft");
    expect(drafts).toHaveLength(2);
    const repair = drafts[1].content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    const fit = headerMenuFit(revised.package, facts.name)!;
    expect(fit.fits).toBe(false);
    expect(repair).toContain(
      `Header menu: the centred header sets the menu in the space left of the logo, about ${fit.room}px`,
    );
    expect(repair).toContain('set design.layout.header to "stacked"');
    // The model kept its menu: accepted, and the storefront stacks it.
    expect(labels(revised.package)).toEqual(long.map((l) => l.label));
  });
});
