import { describe, expect, it, vi } from "vitest";
import {
  applyOperatorEdit,
  isExplicitRecreateRequest,
  operatorEditTargets,
  parseChangeDecision,
  redrawableImages,
  CHANGE_SCOPE_PROMPT_MARKER,
} from "./change-scope";
import { createFakeModelClient } from "./fake-provider";
import { runThemeGeneration, type GenerationInput } from "./pipeline";
import { THEME_STUDIO_PROMPT_VERSION } from "./prompt-features";
import {
  ZERO_USAGE,
  type StructuredRequest,
  type ThemeStudioModelClient,
} from "./provider";

const facts = {
  name: "Clay & Co",
  industries: ["home" as const],
  catalogSizes: ["small" as const],
  requiredFeatures: [],
};

function input(
  body: string,
  promptVersion = THEME_STUDIO_PROMPT_VERSION,
): GenerationInput {
  return {
    facts: { ...facts, themeId: "clay-co", baseThemeName: null },
    compile: {
      ...facts,
      themeId: "clay-co",
      baseEngine: null,
      versionNumber: 1,
      modelKey: "gemini-3.8-flash",
      modelLabel: "Gemini 3.8 Flash",
      referenceDigests: [],
    },
    providerModel: "fake",
    promptVersion,
    messages: [{ kind: "brief", body }],
    references: [],
  };
}

/** A fake client that records every request it is sent. */
function recording(brief: string) {
  const fake = createFakeModelClient({ ...facts, brief, referenceCount: 0 });
  const requests: StructuredRequest[] = [];
  const client: ThemeStudioModelClient = {
    provider: "fake",
    generate(request, signal) {
      requests.push(request);
      return fake.generate(request, signal);
    },
  };
  return { client, requests };
}

const isScopeRequest = (r: StructuredRequest) =>
  Boolean(r.system?.startsWith(CHANGE_SCOPE_PROMPT_MARKER));

async function baseVersion() {
  const { client } = recording("A calm ceramics shop.");
  const outcome = await runThemeGeneration(
    client,
    input("A calm ceramics shop."),
    new AbortController().signal,
  );
  if (outcome.kind !== "version") throw new Error(JSON.stringify(outcome));
  return outcome;
}

async function revise(
  body: string,
  options: {
    promptVersion?: string;
    client?: ThemeStudioModelClient;
    recreate?: GenerationInput["operatorChange"];
  } = {},
) {
  const base = await baseVersion();
  const rec = recording(body);
  const recreateContext = vi.fn(async () => ({
    messages: [{ kind: "brief" as const, body: "A calm ceramics shop." }],
    references: [],
  }));
  const outcome = await runThemeGeneration(
    options.client ?? rec.client,
    {
      ...input(body, options.promptVersion),
      compile: { ...input(body).compile, versionNumber: 2 },
      messages: [{ kind: "revision", body }],
      revision: { baseIntent: base.intent, basePackage: base.package },
      operatorChange: options.recreate ?? { recreateContext },
    },
    new AbortController().signal,
  );
  return { base, outcome, requests: rec.requests, recreateContext };
}

describe("isExplicitRecreateRequest", () => {
  it.each([
    "Start over",
    "please recreate the whole theme",
    "Rebuild the entire design, I don't like it",
    "build it from scratch",
    "I want a completely new theme",
    "scrap this design and try again",
    "regenerate the theme completely",
  ])("treats %j as a recreate", (text) => {
    expect(isExplicitRecreateRequest(text)).toBe(true);
  });

  it.each([
    "redo the hero image",
    "make the colours darker",
    "change the heading to Spring Sale",
    "add a new testimonials section",
    "make the whole page feel warmer",
    "start the hero with a bigger heading",
  ])("does not treat %j as a recreate", (text) => {
    expect(isExplicitRecreateRequest(text)).toBe(false);
  });
});

describe("operator edit targets", () => {
  it("reaches visibility and catalogue text but never links, ids or images", async () => {
    const { package: pkg } = await baseVersion();
    const paths = operatorEditTargets(pkg).map((t) => t.path);
    expect(paths).toContain("/definition/preset/pages/0/sections/0/enabled");
    expect(paths).toContain("/definition/preset/sampleData/products/0/name");
    expect(paths).toContain(
      "/definition/preset/sampleData/products/0/selling_price",
    );
    expect(paths.some((p) => /(_url|href|\/id|\/slug|image)$/.test(p))).toBe(
      false,
    );
  });

  it("refuses a path that is not an edit target", async () => {
    const { package: pkg, intent } = await baseVersion();
    const decision = parseChangeDecision({
      scope: "edit",
      summary: "",
      edits: [
        {
          path: "/definition/preset/sampleData/products/0/image_url",
          valueJson: JSON.stringify("https://evil.example/x.jpg"),
        },
      ],
      imageChanges: [],
    });
    if (!decision.ok) throw new Error("parse");
    expect(applyOperatorEdit(pkg, intent, decision).ok).toBe(false);
  });

  it("refuses to redraw a picture that is not redrawable", async () => {
    const { package: pkg, intent } = await baseVersion();
    const decision = parseChangeDecision({
      scope: "edit",
      summary: "",
      edits: [],
      imageChanges: [{ slotId: "preview", direction: "A new card" }],
    });
    if (!decision.ok) throw new Error("parse");
    const applied = applyOperatorEdit(pkg, intent, decision);
    expect(applied.ok).toBe(false);
  });

  it("will not hide a section the theme's content floors still need", async () => {
    const { package: pkg, intent } = await baseVersion();
    const decision = parseChangeDecision({
      scope: "edit",
      summary: "Hid a section.",
      edits: [
        {
          path: "/definition/preset/pages/0/sections/1/enabled",
          valueJson: "false",
        },
      ],
      imageChanges: [],
    });
    if (!decision.ok) throw new Error("parse");
    const applied = applyOperatorEdit(pkg, intent, decision);
    expect(applied.ok).toBe(false);
    if (!applied.ok)
      expect(applied.issues.join(" ")).toMatch(/homepage needs/i);
  });
});

describe("scoped operator revisions", () => {
  it("applies a small edit with one request and keeps every other byte", async () => {
    const { base, outcome, requests } = await revise(
      "[[fake:edit]] Change the hero heading.",
    );
    expect(requests).toHaveLength(1);
    expect(isScopeRequest(requests[0])).toBe(true);
    if (outcome.kind !== "version") throw new Error(JSON.stringify(outcome));
    expect(outcome.change).toMatchObject({ scope: "edit" });
    expect(outcome.change?.changed).toHaveLength(1);
    expect(outcome.imageRedraws).toBeUndefined();
    // Same artwork, same intent: nothing is redrawn or re-planned.
    expect(outcome.package.assets).toEqual(base.package.assets);
    expect(outcome.intent).toEqual(base.intent);
    expect(outcome.placeholders.size).toBe(0);
    const [path] = outcome.change!.changed;
    const at = (root: unknown) =>
      path
        .slice(1)
        .split("/")
        .reduce((v, k) => (v as Record<string, unknown>)[k], root);
    expect(at(outcome.package)).toBe("Edited by the offline provider");
    // Release metadata is StoreMink's: only that changes besides the edit.
    const normalized = structuredClone(outcome.package);
    normalized.definition.release = base.package.definition.release;
    normalized.provenance = base.package.provenance;
    const parts = path.slice(1).split("/");
    let parent = normalized as unknown as Record<string, unknown>;
    for (const key of parts.slice(0, -1))
      parent = parent[key] as Record<string, unknown>;
    parent[parts.at(-1)!] = at(base.package);
    expect(normalized).toEqual(base.package);
  });

  it("asks to redraw only the named picture for an image edit", async () => {
    const { base, outcome } = await revise(
      "[[fake:edit-image]] Make the hero picture brighter.",
    );
    if (outcome.kind !== "version") throw new Error(JSON.stringify(outcome));
    const first = redrawableImages(base.package, base.intent)[0].slotId;
    expect(outcome.change).toMatchObject({
      scope: "edit",
      changed: [],
      redraws: [first],
    });
    expect(Object.keys(outcome.imageRedraws ?? {})).toEqual([first]);
    expect(outcome.package.assets).toEqual(base.package.assets);
  });

  it("runs the full revision when the request needs structure", async () => {
    const { outcome, requests } = await revise("Add a lookbook page.");
    expect(isScopeRequest(requests[0])).toBe(true);
    // Stage A then Stage B follow the scope request.
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(
      requests.some((r) =>
        r.content.some(
          (b) => b.type === "text" && b.text.includes("This is a REVISION"),
        ),
      ),
    ).toBe(true);
    if (outcome.kind !== "version") throw new Error(JSON.stringify(outcome));
    expect(outcome.change).toMatchObject({ scope: "revise" });
    expect(outcome.change?.fellBackFrom).toBeUndefined();
  });

  it("falls back to a revision when an edit cannot be validated", async () => {
    const base = await baseVersion();
    const rec = recording("Change the heading.");
    let scopeCalls = 0;
    const client: ThemeStudioModelClient = {
      provider: "fake",
      async generate(request, signal) {
        if (isScopeRequest(request)) {
          scopeCalls++;
          return {
            kind: "ok",
            usage: ZERO_USAGE,
            value: {
              scope: "edit",
              summary: "Edited.",
              edits: [{ path: "/not/a/target", valueJson: "1" }],
              imageChanges: [],
            },
          };
        }
        return rec.client.generate(request, signal);
      },
    };
    const outcome = await runThemeGeneration(
      client,
      {
        ...input("Change the heading."),
        compile: { ...input("x").compile, versionNumber: 2 },
        messages: [{ kind: "revision", body: "Change the heading." }],
        revision: { baseIntent: base.intent, basePackage: base.package },
        operatorChange: {
          recreateContext: async () => ({ messages: [], references: [] }),
        },
      },
      new AbortController().signal,
    );
    expect(scopeCalls).toBe(2);
    if (outcome.kind !== "version") throw new Error(JSON.stringify(outcome));
    expect(outcome.change).toMatchObject({
      scope: "revise",
      fellBackFrom: "edit",
    });
  });

  it("starts from scratch on an explicit request without asking the model", async () => {
    const { outcome, requests, recreateContext } = await revise(
      "I don't like it. Start over from scratch with a bolder look.",
    );
    expect(requests.some(isScopeRequest)).toBe(false);
    expect(recreateContext).toHaveBeenCalledOnce();
    // An initial generation: never the revision prompt, with the original
    // brief and the request both present.
    const text = requests
      .flatMap((r) => r.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(text).not.toContain("This is a REVISION");
    expect(text).toContain("A calm ceramics shop.");
    expect(text).toContain("bolder look");
    if (outcome.kind !== "version") throw new Error(JSON.stringify(outcome));
    expect(outcome.change).toMatchObject({ scope: "recreate", explicit: true });
    // Fresh artwork: every picture is a new placeholder to draw.
    expect(outcome.placeholders.size).toBeGreaterThan(0);
  });

  it("recreates when the model decides the operator asked to", async () => {
    const { outcome, requests, recreateContext } = await revise(
      "[[fake:recreate]] Let's go a different way entirely.",
    );
    expect(isScopeRequest(requests[0])).toBe(true);
    expect(recreateContext).toHaveBeenCalledOnce();
    if (outcome.kind !== "version") throw new Error(JSON.stringify(outcome));
    expect(outcome.change?.scope).toBe("recreate");
  });

  it("leaves revisions queued under an older prompt version unscoped", async () => {
    const { outcome, requests } = await revise("[[fake:edit]] Change it.", {
      promptVersion: "theme-studio-v23",
    });
    expect(requests.some(isScopeRequest)).toBe(false);
    if (outcome.kind !== "version") throw new Error(JSON.stringify(outcome));
    expect(outcome.change).toBeUndefined();
  });
});
