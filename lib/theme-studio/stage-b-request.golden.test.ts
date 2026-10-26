import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ThemeIntent, ThemePackageV2 } from "./contracts";
import {
  THEME_STUDIO_PROMPT_VERSION,
  themePromptFeatures,
} from "./prompt-features";
import {
  currentThemeForRevision,
  heroContrastPrompt,
  stageBInitialSystemPrompt,
  stageBSystemPrompt,
  stageBUserText,
  stageBVarietySystemPrompt,
} from "./prompts";
import {
  STAGE_B_DRAFT_SCHEMA,
  STAGE_B_INITIAL_DRAFT_SCHEMA,
  STAGE_B_VARIETY_DRAFT_SCHEMA,
  STAGE_B_VARIETY_INITIAL_SCHEMA,
  stageBSchemaFor,
} from "./schemas";

// ---------------------------------------------------------------------------
// Every Stage B request part that prompt revisions v19 to the current one
// send, pinned.
//
// A persisted paid request is keyed on its exact schema and prompt bytes
// (generation-recovery.ts checkpoints), so a request recorded under an older
// prompt revision has to be rebuilt byte for byte after any later change.
// stage-b-request.golden.json holds the sha256 of each schema twin, system
// prompt, revision context and revision user text those revisions send. The
// v19 to v32 pins were recorded on 25 Oct 2026 from the code before v33 moved
// the templates into a JSON string; v33's were recorded with that change. It
// is rebuilt here exactly as it was recorded, with the flags the pipeline
// passes for each revision (pipeline.test.ts proves it passes them).
//
// A failing pin means an older request changed. Put the new behaviour behind
// a prompt feature (prompt-features.ts) and keep the old bytes for the old
// revisions; never record new pins to make this pass. Each revision records
// its own pins once, with the change that introduces it, and they never
// change after it ships.
//
// The inputs are frozen beside this test (__fixtures__/stage-b-request-
// inputs.json.gz): the offline provider's intent, the first exemplar
// (luxury-minimal) and basket as packages, copied on 26 Oct 2026 from the
// live values the 25 Oct pins were recorded with. A persisted revision carries
// its base theme's stored bytes, not today's definitions, so editing the
// offline provider, an exemplar or basket must not move a pin. If this test
// fails, the request code changed; fix the change, never the copies.
// ---------------------------------------------------------------------------

interface Golden {
  construction: { exemplar: string; basket: string };
  schemas: Record<string, string>;
  prompts: Record<string, string>;
}

interface FrozenInputs {
  intent: ThemeIntent;
  variety: Partial<ThemeIntent>;
  exemplarPackage: ThemePackageV2;
  basketPackage: ThemePackageV2;
}

const GOLDEN = JSON.parse(
  readFileSync(join(__dirname, "stage-b-request.golden.json"), "utf8"),
) as Golden;

const INPUTS = JSON.parse(
  gunzipSync(
    readFileSync(
      join(__dirname, "__fixtures__", "stage-b-request-inputs.json.gz"),
    ),
  ).toString("utf8"),
) as FrozenInputs;

/** The prompt revision every run records now. */
const CURRENT = Number(
  /^theme-studio-v(\d+)$/.exec(THEME_STUDIO_PROMPT_VERSION)![1],
);

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const facts = {
  name: "Pin Shop",
  themeId: "pin-shop",
  industries: ["home" as const],
  catalogSizes: ["small" as const],
  requiredFeatures: [],
  baseThemeName: null,
};

/** Every pinned value, rebuilt by the construction the pins were recorded
 * with (see `construction` in the golden file), for v19 to `last`. */
function rebuild(last: number) {
  const intent1 = INPUTS.intent;
  const intent2 = { ...intent1, ...INPUTS.variety } as ThemeIntent;
  const bases = [
    ["draft", STAGE_B_DRAFT_SCHEMA],
    ["initial", STAGE_B_INITIAL_DRAFT_SCHEMA],
    ["varietyDraft", STAGE_B_VARIETY_DRAFT_SCHEMA],
    ["varietyInitial", STAGE_B_VARIETY_INITIAL_SCHEMA],
  ] as const;
  const schemas: Record<string, string> = {};
  const prompts: Record<string, string> = {};
  for (let v = 19; v <= last; v++) {
    const f = themePromptFeatures(`theme-studio-v${v}`);
    for (const [name, base] of bases)
      schemas[`${name}@v${v}`] = sha(
        JSON.stringify(
          stageBSchemaFor(
            base,
            f.fontPairings,
            f.nestedBlocks,
            f.moreSections,
            f.moreVariants,
            f.templates,
            f.templatesJson,
          ),
        ),
      );
    const flags = [
      f.fontPairings,
      f.fullBleedOpening,
      f.carouselOpening,
      f.nestedBlocks,
      f.moreSections,
      f.moreVariants,
      f.templates,
      f.templatesJson,
    ] as const;
    prompts[`stageB@v${v}`] = sha(
      stageBSystemPrompt(f.nativeFraming, ...flags),
    );
    prompts[`stageBNative@v${v}`] = sha(stageBSystemPrompt(true, ...flags));
    prompts[`stageBInitial@v${v}`] = sha(
      stageBInitialSystemPrompt(intent1, ...flags),
    );
    prompts[`stageBVarietyInitial@v${v}`] = sha(
      stageBVarietySystemPrompt(intent2, true, ...flags),
    );
    prompts[`stageBVarietyRevise@v${v}`] = sha(
      stageBVarietySystemPrompt(intent2, false, ...flags),
    );
    prompts[`heroContrast@v${v}`] = sha(heroContrastPrompt(f.fullBleedOpening));
    const ctxExemplar = currentThemeForRevision(
      INPUTS.exemplarPackage,
      intent2,
      f.fontPairings,
      f.templatesJson,
    );
    const ctxBasket = currentThemeForRevision(
      INPUTS.basketPackage,
      intent1,
      f.fontPairings,
      f.templatesJson,
    );
    prompts[`currentThemeExemplar@v${v}`] = sha(ctxExemplar);
    prompts[`currentThemeBasket@v${v}`] = sha(ctxBasket);
    prompts[`userTextRevise@v${v}`] = sha(
      stageBUserText(
        facts,
        intent2,
        ctxExemplar,
        undefined,
        f.variety,
        f.templatesJson,
      ),
    );
  }
  return { schemas, prompts };
}

describe(`Stage B requests of prompt revisions v19 to v${CURRENT}`, () => {
  const rebuilt = rebuild(CURRENT);

  it("reads the frozen inputs the pins were recorded from", () => {
    expect(INPUTS.exemplarPackage.definition.id).toBe(
      GOLDEN.construction.exemplar,
    );
    expect(INPUTS.basketPackage.definition.id).toBe(GOLDEN.construction.basket);
    // The exemplar exercises the v33 context's templates and announcement
    // bar; basket, which has neither, its defaults.
    expect(INPUTS.exemplarPackage.definition.preset.templates).toBeDefined();
    expect(INPUTS.exemplarPackage.definition.preset.announcement).toBeDefined();
    expect(INPUTS.basketPackage.definition.preset.templates).toBeUndefined();
  });

  it("pins every revision from v19 to the current one, and no other", () => {
    // Four schemas and nine request texts for each revision. A revision
    // without pins fails here with the values to record for it (see the
    // header: once, with the change that introduces it).
    const missing = (kind: "schemas" | "prompts") =>
      Object.fromEntries(
        Object.entries(rebuilt[kind]).filter(([key]) => !(key in GOLDEN[kind])),
      );
    expect(missing("schemas")).toEqual({});
    expect(missing("prompts")).toEqual({});
    expect(Object.keys(GOLDEN.schemas).sort()).toEqual(
      Object.keys(rebuilt.schemas).sort(),
    );
    expect(Object.keys(GOLDEN.prompts).sort()).toEqual(
      Object.keys(rebuilt.prompts).sort(),
    );
    expect(Object.keys(GOLDEN.schemas)).toHaveLength(4 * (CURRENT - 18));
    expect(Object.keys(GOLDEN.prompts)).toHaveLength(9 * (CURRENT - 18));
  });

  it.each(Object.keys(GOLDEN.schemas))("schema %s is byte for byte", (key) => {
    expect(rebuilt.schemas[key]).toBe(GOLDEN.schemas[key]);
  });

  it.each(Object.keys(GOLDEN.prompts))("%s is byte for byte", (key) => {
    expect(rebuilt.prompts[key]).toBe(GOLDEN.prompts[key]);
  });
});
