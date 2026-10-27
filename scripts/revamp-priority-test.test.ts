import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PartMediaResolutionLevel,
  ThinkingLevel,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { describe, expect, it } from "vitest";
import { ratesFor } from "../lib/theme-studio/cost";
import { peopleRule } from "../lib/theme-studio/image-prompt";
import {
  THEME_IMAGE_REVIEW_PROMPT_VERSION,
  THEME_IMAGE_REVIEW_SCHEMA,
  themeImageReviewContent,
  themeImageReviewSystem,
} from "../lib/theme-studio/image-review";
import {
  themeImageConfig,
  themeImageParts,
} from "../lib/theme-studio/image-vertex";
import {
  CALL_TIMEOUT_MS,
  CHECK_BRIEF,
  CHECK_CLIENT_TIMEOUT_MS,
  CHECK_PROMPT_VERSION,
  CHECK_SCHEMA,
  DEFAULT_MAX_USD,
  DEFAULT_PROBE_LANES,
  executionStages,
  nextStartMs,
  stageReadyAtMs,
  requestProfiles,
  redesignPhotoRequest,
  ERROR_BODY_MAX,
  LADDER_CALLS_PER_GAP,
  LADDER_GAPS_SECONDS,
  LANES,
  MAX_IN_FLIGHT,
  PEOPLE_NONE_RULE,
  PHOTO_MODEL,
  PHOTO_SUBJECTS,
  PRIORITY_HEADERS,
  SERVED_AS_PRIORITY,
  Slots,
  TEST_IMAGE_WEBP_BASE64,
  answeredRecord,
  billedTier,
  buildPlan,
  callCeilingUsd,
  callExpectedUsd,
  callLine,
  checkConfig,
  checkParts,
  checkSystemInstruction,
  clientOptions,
  endpointHost,
  environmentProblems,
  errorFacts,
  estimatePlan,
  failedRecord,
  imageDimensions,
  ladderGapFor,
  ladderRungs,
  ladderStartsSeconds,
  laneSpacingMs,
  laneStage,
  mayStart,
  mostStartsWithin,
  pendingRecord,
  percentile,
  photoConfig,
  photoLabel,
  photoPrompt,
  planText,
  quotaNamedIn,
  readCheck,
  readOptions,
  readPhoto,
  requestFor,
  sizeClass,
  summarize,
  summaryMarkdown,
  targetProject,
  usageCostUsd,
  type CallRecord,
  type PassResults,
  type PlannedCall,
} from "./revamp-priority-test";

const LONG_DASHES = /[\u2013\u2014]/;
const STAGING = { GCP_PROJECT_ID: "storemink-staging" };

function response(value: object): GenerateContentResponse {
  return value as unknown as GenerateContentResponse;
}

/** A PNG header for a picture of the given size: enough for a dimension read. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A JPEG with an APP0 segment ahead of its start-of-frame marker. */
function jpegHeader(width: number, height: number, sof = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    // APP0, 16 bytes long including its length.
    0xff,
    0xe0,
    0x00,
    0x10,
    ...new Array(14).fill(0),
    // The frame: length, precision, height, width, components.
    0xff,
    sof,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
  ]);
}

function riff(chunk: string, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(30 + payload.length);
  bytes.set(Buffer.from("RIFF"), 0);
  bytes.set(Buffer.from("WEBP"), 8);
  bytes.set(Buffer.from(chunk), 12);
  bytes.set(payload, 20);
  return bytes;
}

function call(overrides: Partial<PlannedCall> = {}): PlannedCall {
  return {
    seq: 1,
    lane: "studio-photo@global",
    stage: "pass",
    kind: "photo",
    model: "gemini-nano-banana-2.1",
    location: "global",
    arm: "standard",
    index: 0,
    subject: 0,
    plannedAtMs: 0,
    ladderGapSeconds: null,
    ...overrides,
  };
}

function record(overrides: Partial<CallRecord> = {}): CallRecord {
  return { ...pendingRecord(call()), ...overrides };
}

describe("the requests are production's, copied", () => {
  it("★★ sends a photo exactly as the image client configures one for Nano Banana 2.1 with no people: Theme Studio's at HIGH, Mink's at MINIMAL", () => {
    expect(PHOTO_MODEL).toBe("gemini-nano-banana-2.1");
    for (const aspectRatio of ["4:5", "3:4"] as const) {
      for (const thinkingLevel of [ThinkingLevel.HIGH, ThinkingLevel.MINIMAL]) {
        expect(photoConfig(aspectRatio, thinkingLevel)).toEqual(
          themeImageConfig(
            {
              purpose: "product",
              briefId: "test",
              aspectRatio,
              prompt: "test",
              references: [],
            },
            { model: PHOTO_MODEL, imageSize: "2K", thinkingLevel },
          ),
        );
      }
    }
  });

  it("asks the photo model for 2K, no people and a JPEG", () => {
    expect(photoConfig("4:5", ThinkingLevel.HIGH).imageConfig).toMatchObject({
      imageSize: "2K",
      personGeneration: "ALLOW_NONE",
      outputMimeType: "image/jpeg",
      outputCompressionQuality: 95,
    });
  });

  it("carries the people-free rule word for word", () => {
    expect(PEOPLE_NONE_RULE).toBe(peopleRule("none"));
    expect(photoPrompt(PHOTO_SUBJECTS[0])).toContain(PEOPLE_NONE_RULE);
  });

  it("sends the photo reviewer's own system prompt, schema and prompt version", () => {
    expect(checkSystemInstruction()).toBe(themeImageReviewSystem());
    expect(CHECK_SCHEMA).toEqual(THEME_IMAGE_REVIEW_SCHEMA);
    expect(CHECK_PROMPT_VERSION).toBe(THEME_IMAGE_REVIEW_PROMPT_VERSION);
  });

  it("builds the check's parts as production maps a category check with its anchor", () => {
    const image = TEST_IMAGE_WEBP_BASE64;
    const blocks = themeImageReviewContent({
      purpose: CHECK_BRIEF.purpose,
      brief: {
        subject: CHECK_BRIEF.subject,
        artDirection: CHECK_BRIEF.artDirection,
        aspectRatio: CHECK_BRIEF.aspectRatio,
        people: "none",
      },
      candidate: image,
      anchor: image,
      set: null,
      attempt: 1,
    });
    // gemini-vertex.ts toParts: every image at ULTRA_HIGH media resolution.
    const parts: Part[] = blocks.map((block) =>
      block.type === "text"
        ? { text: block.text }
        : {
            inlineData: { mimeType: block.mediaType, data: block.base64 },
            mediaResolution: {
              level: PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH,
            },
          },
    );
    expect(checkParts(image)).toEqual(parts);
  });

  it("keeps the parts of gemini-vertex.ts that cannot be imported: ULTRA_HIGH images, JSON, HIGH thinking", () => {
    const source = readFileSync(
      path.join(__dirname, "../lib/theme-studio/gemini-vertex.ts"),
      "utf8",
    );
    expect(source).toContain(
      "level: PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH",
    );
    expect(source).toContain('responseMimeType: "application/json"');
    expect(source).toContain("responseJsonSchema: request.schema");
    expect(source).toMatch(
      /request\.effort === "high"\s*\?\s*ThinkingLevel\.HIGH/,
    );
    const review = readFileSync(
      path.join(__dirname, "../lib/theme-studio/image-review.ts"),
      "utf8",
    );
    expect(review).toContain('effort: "high"');
    expect(checkConfig()).toEqual({
      systemInstruction: themeImageReviewSystem(),
      responseMimeType: "application/json",
      responseJsonSchema: THEME_IMAGE_REVIEW_SCHEMA,
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
    });
  });

  it("holds no long dash in its own source, while the prompt it sends keeps production's one", () => {
    const source = readFileSync(
      path.join(__dirname, "revamp-priority-test.ts"),
      "utf8",
    );
    expect(source).not.toMatch(LONG_DASHES);
    expect(checkSystemInstruction().match(/\u2014/g)).toHaveLength(1);
  });
});

describe("the Priority arm", () => {
  it("adds Google's two Priority PayGo headers, and Standard adds none", () => {
    expect(PRIORITY_HEADERS).toEqual({
      "X-Vertex-AI-LLM-Request-Type": "shared",
      "X-Vertex-AI-LLM-Shared-Request-Type": "priority",
    });
    expect(clientOptions("storemink-staging", "global", "priority")).toEqual({
      enterprise: true,
      project: "storemink-staging",
      location: "global",
      apiVersion: "v1",
      httpOptions: {
        timeout: CALL_TIMEOUT_MS,
        retryOptions: { attempts: 1 },
        headers: PRIORITY_HEADERS,
      },
    });
    const standard = clientOptions("storemink-staging", "us", "standard");
    expect(standard.httpOptions).toEqual({
      timeout: CALL_TIMEOUT_MS,
      retryOptions: { attempts: 1 },
    });
    expect(standard.location).toBe("us");
    // ★ A check client sends production's 600 s server timeout
    //   (gemini-vertex.ts:71), a photo client the image client's 180 s.
    expect(CHECK_CLIENT_TIMEOUT_MS).toBe(600_000);
    expect(
      clientOptions("storemink-staging", "global", "priority", "check")
        .httpOptions,
    ).toEqual({
      timeout: CHECK_CLIENT_TIMEOUT_MS,
      retryOptions: { attempts: 1 },
      headers: PRIORITY_HEADERS,
    });
    expect(
      clientOptions("storemink-staging", "eu", "standard", "photo").httpOptions
        ?.timeout,
    ).toBe(CALL_TIMEOUT_MS);
  });

  it("names the endpoint each location reaches", () => {
    expect(endpointHost("global")).toBe("aiplatform.googleapis.com");
    expect(endpointHost("us")).toBe("aiplatform.us.rep.googleapis.com");
    expect(endpointHost("eu")).toBe("aiplatform.eu.rep.googleapis.com");
  });

  it("bills what Google says served the call, else what was asked", () => {
    expect(billedTier("priority", SERVED_AS_PRIORITY)).toBe("priority");
    expect(billedTier("priority", "ON_DEMAND")).toBe("standard");
    expect(billedTier("standard", null)).toBe("standard");
    expect(billedTier("priority", null)).toBe("priority");
  });
});

describe("the plan", () => {
  const plan = buildPlan();

  it("retains 174 selectable calls including historical lanes", () => {
    expect(plan).toHaveLength(174);
    const counted = (lane: string, arm: string) =>
      plan.filter((c) => c.lane === lane && c.arm === arm).length;
    expect(counted("photo-ladder@global", "standard")).toBe(12);
    expect(counted("photo-ladder@global", "priority")).toBe(0);
    expect(counted("studio-photo@global", "standard")).toBe(10);
    expect(counted("studio-photo@global", "priority")).toBe(10);
    expect(counted("mink-photo@global", "standard")).toBe(10);
    expect(counted("mink-photo@global", "priority")).toBe(10);
    expect(counted("mink-photo@us", "standard")).toBe(10);
    expect(counted("mink-photo@eu", "standard")).toBe(10);
    expect(counted("check@global", "standard")).toBe(20);
    expect(counted("check@global", "priority")).toBe(20);
    expect(counted("check@us", "standard")).toBe(10);
    expect(counted("check@eu", "standard")).toBe(20);
    expect(
      plan.filter((c) => c.location !== "global" && c.arm === "priority"),
    ).toHaveLength(0);
    // ★★ One image model (owner, 25 Oct 2026): every photo is 2.1's.
    expect(
      plan.filter((c) => c.kind === "photo" && c.model !== PHOTO_MODEL),
    ).toHaveLength(0);
    // Theme Studio's photo thinks HIGH, Mink's MINIMAL, as production asks.
    expect(
      LANES.filter((lane) => lane.kind === "photo").map((lane) => [
        lane.id,
        lane.thinking,
      ]),
    ).toEqual([
      ["priority-ladder@global", ThinkingLevel.MEDIUM],
      ["redesign-photo@global", ThinkingLevel.MEDIUM],
      ["photo-ladder@global", ThinkingLevel.MEDIUM],
      ["studio-photo@global", ThinkingLevel.HIGH],
      ["mink-photo@global", ThinkingLevel.MINIMAL],
      ["mink-photo@us", ThinkingLevel.MINIMAL],
      ["mink-photo@eu", ThinkingLevel.MINIMAL],
    ]);
  });

  it("numbers the ladder first, then the pass, each in the order it is due", () => {
    expect(plan.map((c) => c.seq)).toEqual(plan.map((_, i) => i + 1));
    const ladder = plan.filter((c) => c.stage === "ladder");
    expect(ladder.map((c) => c.seq)).toEqual(ladder.map((_, i) => i + 1));
    for (const lanes of executionStages(plan)) {
      const calls = plan.filter((c) =>
        lanes.some((lane) => lane.id === c.lane),
      );
      for (let i = 1; i < calls.length; i++)
        expect(calls[i].plannedAtMs).toBeGreaterThanOrEqual(
          calls[i - 1].plannedAtMs,
        );
    }
    for (const c of plan)
      expect(c.stage).toBe(laneStage(LANES.find((l) => l.id === c.lane)!));
  });

  it("spaces the ladder 60, 40, 30 and 15 s apart, three photos each, widest first", () => {
    expect([...LADDER_GAPS_SECONDS]).toEqual([60, 40, 30, 15]);
    expect(LADDER_CALLS_PER_GAP).toBe(3);
    expect(ladderStartsSeconds()).toEqual([
      0, 60, 120, 160, 200, 240, 270, 300, 330, 345, 360, 375,
    ]);
    const ladder = plan.filter((c) => c.lane === "photo-ladder@global");
    expect(ladder).toHaveLength(12);
    expect(ladder.map((c) => c.ladderGapSeconds)).toEqual([
      60, 60, 60, 40, 40, 40, 30, 30, 30, 15, 15, 15,
    ]);
    ladder.forEach((c, i) => {
      expect(c).toMatchObject({
        lane: "photo-ladder@global",
        model: "gemini-nano-banana-2.1",
        location: "global",
        arm: "standard",
        kind: "photo",
      });
      // Each call follows the one before by its own rung's gap.
      if (i > 0)
        expect((c.plannedAtMs - ladder[i - 1].plannedAtMs) / 1000).toBe(
          c.ladderGapSeconds,
        );
    });
    // The 15 s rung puts four admissions inside 45 s, past any 2-a-minute cap.
    expect(ladderGapFor(11)).toBe(15);
    expect(ladderGapFor(99)).toBe(15);
    expect(
      plan
        .filter((c) => c.stage === "pass")
        .every((c) => c.ladderGapSeconds === null),
    ).toBe(true);
    expect(requestFor(ladder[0]).config).toEqual(
      photoConfig("4:5", ThinkingLevel.MEDIUM),
    );
    // ★ A live run keeps each lane this far from its own last start, so any
    //   spacing but 0 here would quietly widen the 15 s rung to 30 s.
    const ladderLane = LANES.find((lane) => lane.id === "photo-ladder@global")!;
    expect(laneSpacingMs(ladderLane, 15)).toBe(0);
    expect(laneSpacingMs(ladderLane, 60)).toBe(0);
  });

  it("preserves each rung after a slow response or budget wait without catch-up bursts", () => {
    const ladder = plan.filter(
      (call) => call.lane === "priority-ladder@global",
    );
    const t0 = 1_000_000;
    expect(nextStartMs(ladder[0], t0, -Infinity, 40)).toBe(t0);
    // The second start waited until 118 s for budget; the third still needs 60 s.
    expect(nextStartMs(ladder[2], t0, t0 + 118_000, 40)).toBe(t0 + 178_000);
    // Moving to the 40 s rung after another delay still leaves the full 40 s.
    expect(nextStartMs(ladder[3], t0, t0 + 300_000, 40)).toBe(t0 + 340_000);
    expect(nextStartMs(ladder[9], t0, t0 + 600_000, 40)).toBe(t0 + 615_000);
    const paired = plan.find((call) => call.lane === "redesign-photo@global")!;
    const control = plan.find((call) => call.lane === "check@us")!;
    expect(nextStartMs(paired, t0, t0 + 600_000, 40)).toBe(t0 + 640_000);
    expect(nextStartMs(control, t0, t0 + 600_000, 40)).toBe(t0 + 680_000);
  });

  it("isolates the paired stage from the last ladder start, including immediate refusals", () => {
    expect(stageReadyAtMs(1_000_000, [])).toBe(1_003_000);
    expect(stageReadyAtMs(1_000_000, [999_500, 950_000])).toBe(1_059_500);
    expect(stageReadyAtMs(1_000_000, [800_000])).toBe(1_003_000);
  });

  it("alternates the arms within a lane, a pair sharing one subject, one start per gap", () => {
    for (const lane of LANES) {
      if (lane.startsSeconds) continue; // the ladder has its own test
      const calls = plan.filter((c) => c.lane === lane.id);
      const spacing = laneSpacingMs(lane, 15);
      calls.forEach((c, i) => {
        expect(c.index).toBe(i);
        if (i > 0)
          expect(c.plannedAtMs - calls[i - 1].plannedAtMs).toBe(spacing);
      });
      if (lane.arms.length === 2) {
        expect(spacing).toBe(15_000);
        calls.forEach((c, i) => {
          expect(c.arm).toBe(i % 2 === 0 ? "standard" : "priority");
          expect(c.subject).toBe(Math.floor(i / 2));
        });
      } else {
        // Each arm on each endpoint starts once per 30 s, the global ones too.
        expect(spacing).toBe(30_000);
      }
    }
  });

  it("lets the second pass lead with Priority", () => {
    const flipped = buildPlan(15, "priority");
    const first = (lane: string) => flipped.find((c) => c.lane === lane)?.arm;
    expect(first("studio-photo@global")).toBe("priority");
    expect(first("check@global")).toBe("priority");
    expect(first("check@us")).toBe("standard");
    expect(first("mink-photo@eu")).toBe("standard");
    // The ladder is Standard only, so the lead does not touch it.
    expect(first("photo-ladder@global")).toBe("standard");
    expect(flipped.slice(0, 12).every((c) => c.stage === "ladder")).toBe(true);
  });

  it("estimates every selected lane within the tool budget", () => {
    const estimate = estimatePlan(plan, new Date("2026-10-23T12:00:00Z"));
    expect(estimate.calls).toBe(174);
    expect(estimate.expectedUsd).toBeGreaterThan(8);
    expect(estimate.expectedUsd).toBeLessThan(10);
    expect(estimate.expectedUsd).toBeLessThan(DEFAULT_MAX_USD);
    // The owner approved about $24 for the evening and the night pass.
    expect(2 * estimate.expectedUsd).toBeLessThan(24);
    expect(estimate.standardUsd + estimate.priorityUsd).toBeCloseTo(
      estimate.expectedUsd,
      9,
    );
    // The pass's last call is due 6 + 39 x 15 = 591 s after the pass starts;
    // the ladder's at 375 s after it starts.
    expect(estimate.lastStartSeconds).toBe(591);
    expect(estimate.ladderLastStartSeconds).toBe(750);
  });

  it("prints the plan with both headers and no long dash", () => {
    const text = planText(
      plan,
      estimatePlan(plan),
      {
        gapSeconds: 15,
        maxInFlight: MAX_IN_FLIGHT,
        maxUsd: DEFAULT_MAX_USD,
        lead: "standard",
      },
      "storemink-staging",
    );
    expect(text).toContain("X-Vertex-AI-LLM-Shared-Request-Type: priority");
    expect(text).toContain("aiplatform.eu.rep.googleapis.com");
    expect(text).toContain(
      "at 0, 60, 120, 160, 200, 240, 270, 300, 330, 345, 360, 375 s",
    );
    expect(text).toContain(
      "The spacing ladders run first, separately and alone",
    );
    expect(text).toContain("174 calls");
    expect(text).not.toMatch(LONG_DASHES);
  });
});

describe("one call's request", () => {
  it("uses the real MEDIUM redesign prompt, anchor parts and config for both arms", () => {
    const calls = buildPlan(40, "standard", {
      lanes: ["redesign-photo@global"],
      ladders: ["standard", "priority"],
    });
    for (const call of calls) {
      const real = redesignPhotoRequest(call.subject);
      expect(requestFor(call).contents).toEqual([
        { role: "user", parts: themeImageParts(real) },
      ]);
      expect(requestFor(call).config).toEqual(
        themeImageConfig(real, {
          model: PHOTO_MODEL,
          imageSize: "2K",
          thinkingLevel: ThinkingLevel.MEDIUM,
        }),
      );
    }
    const pairs = calls.filter((call) => call.stage === "pass");
    for (let i = 0; i < pairs.length; i += 2)
      expect(requestFor(pairs[i])).toEqual(requestFor(pairs[i + 1]));
    const profiles = requestProfiles(calls);
    expect(profiles["redesign-photo@global"].thinking).toBe(
      ThinkingLevel.MEDIUM,
    );
    expect(profiles["redesign-photo@global"].anchorSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(profiles["photo-ladder@global"]).toEqual(
      profiles["priority-ladder@global"],
    );
    const source = readFileSync(
      path.join(process.cwd(), "lib/mink/revamp/photos.ts"),
      "utf8",
    );
    expect(source).toContain("thinkingLevel: ThinkingLevel.MEDIUM");
  });

  it("draws a pair's subject in its lane's frame, at its lane's thinking", () => {
    const studio = requestFor(call({ subject: 3 }));
    expect(studio.model).toBe("gemini-nano-banana-2.1");
    expect(JSON.stringify(studio.contents)).toContain(PHOTO_SUBJECTS[3]);
    expect(studio.config).toEqual(photoConfig("4:5", ThinkingLevel.HIGH));
    const mink = requestFor(call({ lane: "mink-photo@global" }));
    expect(mink.config).toEqual(photoConfig("3:4", ThinkingLevel.MINIMAL));
    // The us and eu photos are the same request; only the endpoint differs.
    for (const lane of ["mink-photo@us", "mink-photo@eu"]) {
      const regional = requestFor(call({ lane, subject: 2 }));
      expect(regional.config).toEqual(
        photoConfig("3:4", ThinkingLevel.MINIMAL),
      );
      expect(JSON.stringify(regional.contents)).toContain(PHOTO_SUBJECTS[2]);
    }
  });

  it("sends a check with its image parts at ULTRA_HIGH, and passes the abort signal", () => {
    const signal = new AbortController().signal;
    const check = requestFor(
      call({ lane: "check@eu", kind: "check", model: "gemini-3.8-flash" }),
      signal,
    );
    expect(check.model).toBe("gemini-3.8-flash");
    expect(check.contents).toEqual([{ role: "user", parts: checkParts() }]);
    expect(check.config).toEqual({ ...checkConfig(), abortSignal: signal });
    const images = checkParts().filter((part) => part.inlineData);
    expect(images).toHaveLength(2);
    for (const part of images)
      expect(part.mediaResolution?.level).toBe(
        PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH,
      );
  });
});

describe("prices", () => {
  const at = new Date("2026-10-23T12:00:00Z");
  const zero = { input: 0, output: 0, thinking: 0, cached: 0 };

  it("prices a 2K Pro photo at $0.134 and Priority at 1.8 times that", () => {
    const usage = { ...zero, output: 1_120 };
    expect(
      usageCostUsd("gemini-3-pro-image", "global", "standard", usage, at),
    ).toBeCloseTo(0.1344, 6);
    expect(
      usageCostUsd("gemini-3-pro-image", "global", "priority", usage, at),
    ).toBeCloseTo(0.24192, 6);
  });

  it("★★ prices a 2K Nano Banana 2.1 photo at $0.0504, its thinking at $7.50 a million, and Priority at 1.8 times", () => {
    const usage = { ...zero, output: 1_680, imageOutput: 1_680 };
    expect(
      usageCostUsd("gemini-nano-banana-2.1", "global", "standard", usage, at),
    ).toBeCloseTo(0.0504, 6);
    expect(
      usageCostUsd("gemini-nano-banana-2.1", "global", "priority", usage, at),
    ).toBeCloseTo(0.09072, 6);
    expect(
      usageCostUsd(
        "gemini-nano-banana-2.1",
        "global",
        "standard",
        { ...usage, input: 1_000, thinking: 1_000 },
        at,
      ),
    ).toBeCloseTo((1_000 * 1.5 + 1_680 * 30 + 1_000 * 7.5) / 1e6, 9);
  });

  it("prices a 2K 3.1 Flash photo at $0.101", () => {
    expect(
      usageCostUsd(
        "gemini-3.1-flash-image",
        "global",
        "standard",
        { ...zero, output: 1_680 },
        at,
      ),
    ).toBeCloseTo(0.1008, 6);
  });

  it("takes 3.8 Flash from Theme Studio's table, 10% more off global, thinking as output", () => {
    const million = { ...zero, input: 1_000_000 };
    expect(
      usageCostUsd("gemini-3.8-flash", "global", "standard", million, at),
    ).toBeCloseTo(0.75, 6);
    expect(
      usageCostUsd("gemini-3.8-flash", "us", "standard", million, at),
    ).toBeCloseTo(0.825, 6);
    expect(
      usageCostUsd("gemini-3.8-flash", "global", "priority", million, at),
    ).toBeCloseTo(1.35, 6);
    expect(
      usageCostUsd(
        "gemini-3.8-flash",
        "global",
        "standard",
        million,
        new Date("2027-01-02T00:00:00Z"),
      ),
    ).toBeCloseTo(1.5, 6);
    expect(
      usageCostUsd(
        "gemini-3.8-flash",
        "global",
        "standard",
        { ...zero, thinking: 1_000_000 },
        at,
      ),
    ).toBeCloseTo(3.75, 6);
    expect(
      usageCostUsd(
        "gemini-3.8-flash",
        "global",
        "standard",
        { ...zero, input: 1_000_000, cached: 1_000_000 },
        at,
      ),
    ).toBeCloseTo(0.075, 6);
  });

  it("puts every call's ceiling above its estimate", () => {
    for (const lane of LANES)
      for (const arm of lane.arms) {
        const priced = { model: lane.model, location: lane.location, arm };
        expect(callCeilingUsd(priced, at)).toBeGreaterThan(
          callExpectedUsd(priced, at),
        );
      }
  });

  it("starts a call only while spend, the calls in flight and its own ceiling fit", () => {
    expect(mayStart(0, 0, 15, 15)).toBe(true);
    expect(mayStart(10, 4, 0.9, 15)).toBe(true);
    expect(mayStart(10, 4.9, 0.2, 15)).toBe(false);
    expect(mayStart(15.01, 0, 0, 15)).toBe(false);
  });

  it("bills a photo's image tokens at the image rate and its text and thinking at the text rate", () => {
    const usage = {
      input: 1_000,
      output: 1_150,
      imageOutput: 1_120,
      thinking: 300,
      cached: 0,
    };
    // Pro: $2 in, $120 an image token, $12 a text or thinking token.
    expect(
      usageCostUsd("gemini-3-pro-image", "global", "standard", usage, at),
    ).toBeCloseTo((1_000 * 2 + 1_120 * 120 + 330 * 12) / 1e6, 9);
    expect(
      usageCostUsd("gemini-3-pro-image", "global", "priority", usage, at),
    ).toBeCloseTo((1.8 * (1_000 * 2 + 1_120 * 120 + 330 * 12)) / 1e6, 9);
    // Flash at us: $0.50, $60 and $3, 10% more off global.
    expect(
      usageCostUsd("gemini-3.1-flash-image", "us", "standard", usage, at),
    ).toBeCloseTo((1.1 * (1_000 * 0.5 + 1_120 * 60 + 330 * 3)) / 1e6, 9);
    // No breakdown: every candidate token at the image rate, the safe
    // direction; thinking is text whatever the answer says.
    const { imageOutput: _dropped, ...bare } = usage;
    void _dropped;
    expect(
      usageCostUsd("gemini-3-pro-image", "global", "standard", bare, at),
    ).toBeCloseTo((1_000 * 2 + 1_150 * 120 + 300 * 12) / 1e6, 9);
    // A refused photo that reports only text tokens pays the text rate.
    expect(
      usageCostUsd(
        "gemini-3-pro-image",
        "global",
        "standard",
        { input: 0, output: 50, imageOutput: 0, thinking: 0, cached: 0 },
        at,
      ),
    ).toBeCloseTo((50 * 12) / 1e6, 9);
    // A text model ignores the breakdown.
    const rate = ratesFor("gemini-3.8-flash", 0, at);
    expect(
      usageCostUsd("gemini-3.8-flash", "global", "standard", usage, at),
    ).toBeCloseTo((1_000 * rate.input + (1_150 + 300) * rate.output) / 1e6, 9);
  });
});

describe("reading an answer", () => {
  it("reads the size of a JPEG, a PNG and every kind of WebP", () => {
    expect(imageDimensions(jpegHeader(1856, 2304))).toEqual({
      format: "jpeg",
      width: 1856,
      height: 2304,
    });
    expect(imageDimensions(jpegHeader(928, 1152, 0xc2))).toEqual({
      format: "jpeg",
      width: 928,
      height: 1152,
    });
    expect(imageDimensions(pngHeader(2048, 2048))).toEqual({
      format: "png",
      width: 2048,
      height: 2048,
    });
    expect(
      imageDimensions(
        new Uint8Array(Buffer.from(TEST_IMAGE_WEBP_BASE64, "base64")),
      ),
    ).toEqual({ format: "webp", width: 128, height: 128 });
    expect(
      imageDimensions(
        riff("VP8X", [0, 0, 0, 0, 0xff, 0x07, 0x00, 0xff, 0x03, 0x00]),
      ),
    ).toEqual({ format: "webp", width: 2048, height: 1024 });
    const bits = (2047 | (1023 << 14)) >>> 0;
    expect(
      imageDimensions(
        riff("VP8L", [
          0x2f,
          bits & 0xff,
          (bits >>> 8) & 0xff,
          (bits >>> 16) & 0xff,
          (bits >>> 24) & 0xff,
        ]),
      ),
    ).toEqual({ format: "webp", width: 2048, height: 1024 });
  });

  it("refuses bytes it cannot read rather than guessing", () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(imageDimensions(jpegHeader(100, 100).subarray(0, 24))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });

  it("names 1K, 2K and 4K by megapixels, whatever the frame", () => {
    expect(sizeClass(1856, 2304)).toBe("2K");
    expect(sizeClass(3168, 1344)).toBe("2K");
    expect(sizeClass(928, 1152)).toBe("1K");
    expect(sizeClass(1568, 672)).toBe("1K");
    expect(sizeClass(4096, 4096)).toBe("4K");
    expect(sizeClass(500, 500)).toBe("below 1K");
  });

  it("records a photo served as Priority: its size, its tier and its price", () => {
    const bytes = pngHeader(1856, 2304);
    const { record: done, image } = answeredRecord(
      record({ arm: "priority" }),
      response({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: "Here it is." },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from(bytes).toString("base64"),
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 400,
          candidatesTokenCount: 1_680,
          trafficType: SERVED_AS_PRIORITY,
        },
        modelVersion: "gemini-nano-banana-2.1",
        responseId: "r-1",
        sdkHttpResponse: {
          headers: {
            "content-type": "application/json",
            "server-timing": "gfet4t7; dur=31000",
          },
        },
      }),
      new Date("2026-10-23T12:00:00Z"),
    );
    expect(done.outcome).toBe("ok");
    expect(done.httpStatus).toBe(200);
    expect(done.trafficType).toBe(SERVED_AS_PRIORITY);
    expect(done.photo).toMatchObject({
      width: 1856,
      height: 2304,
      sizeClass: "2K",
      mediaType: "image/png",
    });
    expect(image).toEqual(bytes);
    expect(done.responseHeaders).toEqual({
      "server-timing": "gfet4t7; dur=31000",
    });
    expect(done.responseId).toBe("r-1");
    // 2.1 at Priority: $2.70 in and $54 an image token, a million.
    expect(done.costUsd).toBeCloseTo((400 * 2.7 + 1_680 * 54) / 1_000_000, 9);
  });

  it("bills a downgraded Priority photo at the Standard price", () => {
    const { record: done } = answeredRecord(
      record({ arm: "priority" }),
      response({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: Buffer.from(jpegHeader(928, 1152)).toString("base64"),
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: {
          candidatesTokenCount: 1_120,
          trafficType: "ON_DEMAND",
        },
      }),
      new Date("2026-10-23T12:00:00Z"),
    );
    expect(done.trafficType).toBe("ON_DEMAND");
    expect(done.photo?.sizeClass).toBe("1K");
    // 1,120 image tokens at 2.1's Standard $30 a million.
    expect(done.costUsd).toBeCloseTo(0.0336, 9);
  });

  it("reads the image tokens from the answer's breakdown and prices the rest as text", () => {
    const answer = (details?: object[]) =>
      answeredRecord(
        record({ arm: "priority" }),
        response({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/jpeg",
                      data: Buffer.from(jpegHeader(1856, 2304)).toString(
                        "base64",
                      ),
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            candidatesTokenCount: 1_150,
            thoughtsTokenCount: 300,
            trafficType: SERVED_AS_PRIORITY,
            ...(details ? { candidatesTokensDetails: details } : {}),
          },
        }),
        new Date("2026-10-23T12:00:00Z"),
      ).record;
    const split = answer([
      { modality: "IMAGE", tokenCount: 1_120 },
      { modality: "TEXT", tokenCount: 30 },
    ]);
    expect(split.usage).toMatchObject({ output: 1_150, imageOutput: 1_120 });
    expect(split.costUsd).toBeCloseTo(
      (1.8 * (1_120 * 30 + (30 + 300) * 7.5)) / 1e6,
      9,
    );
    // No breakdown: no imageOutput key, every candidate at the image rate.
    const bare = answer();
    expect(bare.usage).not.toHaveProperty("imageOutput");
    expect(bare.costUsd).toBeCloseTo((1.8 * (1_150 * 30 + 300 * 7.5)) / 1e6, 9);
  });

  it("tells a refused photo from an empty one", () => {
    expect(
      readPhoto(response({ promptFeedback: { blockReason: "SAFETY" } })),
    ).toEqual({ kind: "refused", reason: "SAFETY" });
    expect(
      readPhoto(
        response({
          candidates: [
            { finishReason: "IMAGE_SAFETY", content: { parts: [] } },
          ],
        }),
      ),
    ).toEqual({ kind: "refused", reason: "IMAGE_SAFETY" });
    expect(
      readPhoto(response({ candidates: [{ finishReason: "STOP" }] })),
    ).toEqual({ kind: "empty" });
    const { record: refused } = answeredRecord(
      record(),
      response({ promptFeedback: { blockReason: "OTHER" } }),
    );
    expect(refused.outcome).toBe("refused");
    expect(refused.refusal).toBe("OTHER");
  });

  it("keeps the final image, not the thought draft gemini-3-pro-image sends first", () => {
    // Measured on storemink-staging 2026-10-23: a 21:9 2K request answered
    // thought text, a 1584x672 thought image, thought text, then the
    // 3168x1344 final image. Keeping the first inline part kept the draft.
    const jpeg = (width: number, height: number) =>
      Buffer.from(jpegHeader(width, height)).toString("base64");
    const draftThenFinal = response({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "Planning the shot", thought: true },
              {
                thought: true,
                inlineData: { mimeType: "image/jpeg", data: jpeg(1584, 672) },
              },
              { text: "Checking it", thought: true },
              {
                thoughtSignature: "sig",
                inlineData: { mimeType: "image/jpeg", data: jpeg(3168, 1344) },
              },
            ],
          },
        },
      ],
      usageMetadata: { candidatesTokenCount: 1_120, trafficType: "ON_DEMAND" },
    });
    const photo = readPhoto(draftThenFinal);
    expect(photo).toMatchObject({
      kind: "image",
      imageParts: 2,
      thoughtImages: 1,
      fromThought: false,
    });
    const { record: done } = answeredRecord(
      record(),
      draftThenFinal,
      new Date("2026-10-23T12:00:00Z"),
    );
    expect(done.photo).toMatchObject({
      width: 3168,
      height: 1344,
      imageParts: 2,
      thoughtImages: 1,
      fromThought: false,
    });
    expect(photoLabel(done.photo!)).toBe(
      `3168x1344 ${sizeClass(3168, 1344)} +1 draft`,
    );

    const draftOnly = readPhoto(
      response({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  thought: true,
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: jpeg(1024, 1024),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    expect(draftOnly).toMatchObject({
      kind: "image",
      imageParts: 1,
      thoughtImages: 1,
      fromThought: true,
    });
  });

  it("reads a check's answer, dropping thoughts, and marks an answer it cannot use", () => {
    const answer = (text: string, finishReason = "STOP") =>
      response({
        candidates: [
          {
            finishReason,
            content: {
              parts: [{ text: "thinking...", thought: true }, { text }],
            },
          },
        ],
      });
    expect(readCheck(answer('{"problems":[],"note":""}'))).toEqual({
      kind: "answer",
      valid: true,
      problems: [],
    });
    expect(
      readCheck(answer('{"problems":["off_style"],"note":"Too dark."}')),
    ).toEqual({ kind: "answer", valid: true, problems: ["off_style"] });
    expect(readCheck(answer('{"problems":["sparkles"],"note":""}'))).toEqual({
      kind: "answer",
      valid: false,
      problems: ["sparkles"],
    });
    expect(readCheck(answer("not json"))).toEqual({
      kind: "answer",
      valid: false,
      problems: [],
    });
    expect(
      readCheck(answer('{"problems":[],"note":""}', "MAX_TOKENS")),
    ).toEqual({ kind: "answer", valid: false, problems: [] });
    expect(readCheck(answer("", "SAFETY"))).toEqual({
      kind: "refused",
      reason: "SAFETY",
    });
    const { record: done } = answeredRecord(
      record({
        kind: "check",
        model: "gemini-3.8-flash",
        lane: "check@us",
        location: "us",
      }),
      answer('{"problems":[],"note":""}'),
    );
    expect(done.outcome).toBe("ok");
    expect(done.check).toEqual({ valid: true, problems: [] });
  });
});

describe("a failed call", () => {
  // ★ Word for word what the shared pool sent the 23 Oct paid probe: no
  //   details, no quota named.
  const body = JSON.stringify({
    error: {
      code: 429,
      message: "Resource has been exhausted (e.g. check quota).",
      status: "RESOURCE_EXHAUSTED",
    },
  });
  const refusal = Object.assign(new Error(body), { status: 429 });
  const quotaRefusal = (error: object) =>
    Object.assign(new Error(JSON.stringify({ error })), { status: 429 });

  it("records a 429 with Google's own status and words, and its whole body", () => {
    expect(errorFacts(refusal, false, false)).toEqual({
      outcome: "429",
      httpStatus: 429,
      errorStatus: "RESOURCE_EXHAUSTED",
      errorMessage: "Resource has been exhausted (e.g. check quota).",
      errorBody: body,
      errorDetails: null,
      quotaNamed: null,
    });
  });

  it("names the quota a project quota's refusal carries, in each form Google uses", () => {
    const errorInfo = errorFacts(
      quotaRefusal({
        code: 429,
        message: "Quota exceeded.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            domain: "googleapis.com",
            metadata: {
              quota_metric:
                "aiplatform.googleapis.com/generate_content_image_gen_per_project_per_base_model_global",
              quota_limit:
                "GenerateContentImageGenPerMinutePerProjectPerBaseModel",
              quota_limit_value: "2",
              service: "aiplatform.googleapis.com",
            },
          },
        ],
      }),
      false,
      false,
    );
    expect(errorInfo.quotaNamed).toBe(
      "aiplatform.googleapis.com/generate_content_image_gen_per_project_per_base_model_global, limit GenerateContentImageGenPerMinutePerProjectPerBaseModel, value 2",
    );
    expect(errorInfo.errorDetails).toContain("google.rpc.ErrorInfo");
    expect(errorInfo.errorDetails).toContain("RATE_LIMIT_EXCEEDED");

    expect(
      quotaNamedIn(
        [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              { quotaMetric: "metric/a", quotaId: "IdA", quotaValue: "5" },
              { quotaId: "IdB", quotaValue: 7 },
              { description: "Quota exceeded for metric/c with base model x." },
            ],
          },
        ],
        "",
      ),
    ).toBe("metric/a, value 5; IdB, value 7; metric/c");

    // A violation's subject says WHO was limited, not which quota: a
    // QuotaFailure carrying only a subject and the shared pool's generic
    // words names no quota, exactly as production reads it.
    expect(
      quotaNamedIn(
        [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                subject: "project:123456",
                description: "Resource has been exhausted.",
              },
            ],
          },
        ],
        "Resource has been exhausted (e.g. check quota).",
      ),
    ).toBeNull();

    // Vertex's message form, and Google's older quoted form.
    expect(
      errorFacts(
        quotaRefusal({
          code: 429,
          message:
            "Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model with base model: gemini-3-pro-image. Please submit a quota increase request.",
          status: "RESOURCE_EXHAUSTED",
        }),
        false,
        false,
      ).quotaNamed,
    ).toBe(
      "aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model",
    );
    expect(
      quotaNamedIn(
        undefined,
        "Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'per minute per region'.",
      ),
    ).toBe("Generate Content API requests per minute");
    // The shared pool's words mention a quota and name none.
    expect(
      quotaNamedIn(
        undefined,
        "Resource has been exhausted (e.g. check quota).",
      ),
    ).toBeNull();
    expect(quotaNamedIn([null, "x", { metadata: {} }], "")).toBeNull();
  });

  it("keeps a long body to its limit and an error with no body in its own words", () => {
    const long = errorFacts(
      Object.assign(new Error("x".repeat(ERROR_BODY_MAX + 500)), {
        status: 500,
      }),
      false,
      false,
    );
    expect(long.errorBody).toHaveLength(ERROR_BODY_MAX);
    expect(long.errorMessage).toHaveLength(300);
    expect(
      errorFacts(new Error("socket hang up"), false, false).errorBody,
    ).toBe("socket hang up");
    expect(errorFacts(new Error("aborted"), true, false)).toMatchObject({
      errorBody: null,
      errorDetails: null,
      quotaNamed: null,
    });
  });

  it("names any other status, an error with none, a timeout and an abandoned call", () => {
    expect(
      errorFacts(
        Object.assign(new Error("Service Unavailable"), { status: 503 }),
        false,
        false,
      ).outcome,
    ).toBe("http_503");
    expect(errorFacts(new Error("socket hang up"), false, false)).toMatchObject(
      {
        outcome: "error",
        httpStatus: null,
        errorMessage: "socket hang up",
      },
    );
    expect(errorFacts(new Error("aborted"), true, false).outcome).toBe(
      "timeout",
    );
    expect(errorFacts(new Error("aborted"), true, true).outcome).toBe(
      "cancelled",
    );
  });

  it("keeps the cause of a network failure, which fetch hides behind 'fetch failed'", () => {
    const failed = Object.assign(new TypeError("fetch failed"), {
      cause: {
        code: "ENOTFOUND",
        message: "getaddrinfo ENOTFOUND aiplatform.eu.rep.googleapis.com",
      },
    });
    const facts = errorFacts(failed, false, false);
    expect(facts.outcome).toBe("error");
    expect(facts.errorMessage).toBe(
      "fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND aiplatform.eu.rep.googleapis.com)",
    );
    expect(facts.errorBody).toBe(
      "fetch failed (cause: ENOTFOUND: getaddrinfo ENOTFOUND aiplatform.eu.rep.googleapis.com)",
    );
    // An HTTP answer keeps Google's own body untouched.
    const withStatus = Object.assign(new Error('{"error":{"code":503}}'), {
      status: 503,
      cause: { code: "X" },
    });
    expect(errorFacts(withStatus, false, false).errorBody).toBe(
      '{"error":{"code":503}}',
    );
  });

  it("counts a timed-out call at its ceiling, since it may have been billed, and a 429 at nothing", () => {
    const base = record({ arm: "priority" });
    const timedOut = failedRecord(base, new Error("x"), true, false);
    expect(timedOut.outcome).toBe("timeout");
    expect(timedOut.possiblyBilledUsd).toBeCloseTo(callCeilingUsd(base), 9);
    expect(failedRecord(base, refusal, false, false).possiblyBilledUsd).toBe(0);
  });
  it("reserves unknown HTTP 499 cancellation costs rather than counting them as free", () => {
    const base = record({ arm: "priority" });
    for (const status of [408, 409, 499, 500, 503, 504]) {
      expect(
        failedRecord(
          base,
          Object.assign(new Error("usage unknown"), { status }),
          false,
          false,
        ).possiblyBilledUsd,
      ).toBe(callCeilingUsd(base));
    }
    for (const status of [400, 401, 403, 404, 429]) {
      expect(
        failedRecord(
          base,
          Object.assign(new Error("not admitted"), { status }),
          false,
          false,
        ).possiblyBilledUsd,
      ).toBe(0);
    }
  });

  it("keeps a reservation when a response cannot establish usage", () => {
    const base = record({ arm: "priority" });
    const ceiling = callCeilingUsd(base);
    expect(
      failedRecord(base, new Error("connection reset"), false, false)
        .possiblyBilledUsd,
    ).toBe(ceiling);
    expect(
      failedRecord(
        base,
        Object.assign(new Error("unavailable"), { status: 503 }),
        false,
        false,
      ).possiblyBilledUsd,
    ).toBe(ceiling);
    for (const usageMetadata of [undefined, {}]) {
      expect(
        answeredRecord(base, response({ usageMetadata })).record
          .possiblyBilledUsd,
      ).toBe(ceiling);
    }
    expect(
      answeredRecord(
        base,
        response({
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 },
        }),
      ).record.possiblyBilledUsd,
    ).toBe(0);
  });
});

describe("the summary", () => {
  it("takes nearest-rank percentiles", () => {
    const values = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it("counts refusals, Priority service and photo sizes per model, endpoint and arm", () => {
    const photo = (width: number, height: number) => ({
      width,
      height,
      sizeClass: sizeClass(width, height),
      bytes: 1,
      mediaType: "image/jpeg",
      file: null,
      imageParts: 1,
      thoughtImages: 0,
      fromThought: false,
    });
    const rows: CallRecord[] = [
      record({
        seq: 1,
        outcome: "ok",
        latencyMs: 30_000,
        trafficType: "ON_DEMAND",
        photo: photo(928, 1152),
        costUsd: 0.13,
      }),
      record({ seq: 2, outcome: "429", latencyMs: 400 }),
      record({
        seq: 3,
        outcome: "timeout",
        latencyMs: 180_000,
        possiblyBilledUsd: 0.38,
      }),
      record({
        seq: 4,
        arm: "priority",
        outcome: "ok",
        latencyMs: 20_000,
        trafficType: SERVED_AS_PRIORITY,
        photo: photo(1856, 2304),
        costUsd: 0.24,
      }),
      record({
        seq: 5,
        arm: "priority",
        outcome: "ok",
        latencyMs: 40_000,
        trafficType: "ON_DEMAND",
        photo: photo(928, 1152),
        costUsd: 0.13,
      }),
      record({
        seq: 6,
        arm: "priority",
        outcome: "cancelled",
        latencyMs: 5_000,
      }),
      record({
        seq: 7,
        arm: "priority",
        outcome: "skipped",
        skippedReason: "budget",
      }),
      record({
        seq: 8,
        arm: "priority",
        outcome: "http_503",
        latencyMs: 1_000,
      }),
    ];
    const [standard, priority] = summarize(rows);
    expect(standard).toMatchObject({
      lane: "studio-photo@global",
      stage: "pass",
      arm: "standard",
      planned: 3,
      started: 3,
      answered: 1,
      rateLimited: 1,
      timeouts: 1,
      share429: 1 / 3,
      answeredP50Ms: 30_000,
      refusedP50Ms: 400,
      servedAsPriority: 0,
      photoSizes: { "928x1152 1K": 1 },
    });
    expect(standard.costUsd + standard.possiblyBilledUsd).toBeCloseTo(0.51, 9);
    expect(priority).toMatchObject({
      arm: "priority",
      planned: 5,
      started: 4,
      skipped: 1,
      answered: 2,
      cancelled: 1,
      // The abandoned call is not a finished one: 0 refusals over 3.
      share429: 0,
      servedAsPriority: 1,
      servedAsPriorityShare: 0.5,
      otherErrors: { http_503: 1 },
      trafficTypes: { [SERVED_AS_PRIORITY]: 1, ON_DEMAND: 1 },
      photoSizes: { "1856x2304 2K": 1, "928x1152 1K": 1 },
    });
  });

  it("keeps the ladder's photos apart from the pass's, though both are 2.1, global and Standard", () => {
    const rows = [
      record({
        seq: 1,
        lane: "photo-ladder@global",
        stage: "ladder",
        ladderGapSeconds: 60,
        outcome: "ok",
      }),
      record({ seq: 2, lane: "studio-photo@global", outcome: "429" }),
    ];
    const groups = summarize(rows);
    expect(groups.map((g) => [g.lane, g.stage, g.arm, g.started])).toEqual([
      ["photo-ladder@global", "ladder", "standard", 1],
      ["studio-photo@global", "pass", "standard", 1],
    ]);
  });

  it("counts the most starts inside any minute, from each start", () => {
    const at = (s: number) => ({
      startedAt: new Date(Date.UTC(2026, 9, 23, 13) + s * 1000).toISOString(),
    });
    // 0, 30 and 59.9 s fit one minute; 60 s starts the next one.
    expect(mostStartsWithin([at(0), at(30), at(59.9), at(60), at(200)])).toBe(
      3,
    );
    // Unordered input, and a call that never started.
    expect(
      mostStartsWithin([
        at(375),
        at(330),
        { startedAt: null },
        at(345),
        at(360),
      ]),
    ).toBe(4);
    expect(mostStartsWithin([at(0), at(60), at(120)])).toBe(1);
    expect(mostStartsWithin([])).toBe(0);
    // A group's figure counts only its 200s.
    const [group] = summarize([
      record({ ...at(0), outcome: "ok" }),
      record({ seq: 2, ...at(10), outcome: "429" }),
      record({ seq: 3, ...at(20), outcome: "ok" }),
    ]);
    expect(group.maxOkPer60s).toBe(2);
  });

  it("reads the ladder rung by rung: admissions, refusals, the spacing it got and any quota named", () => {
    const rung = (
      seq: number,
      gap: number,
      outcome: CallRecord["outcome"],
      gapMs: number | null,
      quotaNamed: string | null = null,
    ) =>
      record({
        seq,
        lane: "photo-ladder@global",
        stage: "ladder",
        ladderGapSeconds: gap,
        outcome,
        gapSincePrevStartMs: gapMs,
        quotaNamed,
      });
    const rows = [
      rung(1, 60, "ok", null),
      rung(2, 60, "ok", 60_010),
      rung(3, 60, "ok", 60_020),
      rung(4, 30, "ok", 30_000),
      rung(5, 30, "429", 30_005),
      rung(6, 30, "429", 30_010, "metric/x"),
      rung(7, 15, "skipped", null),
      record({ seq: 8, outcome: "ok" }), // the pass, not the ladder
    ];
    expect(ladderRungs(rows)).toEqual([
      {
        gapSeconds: 60,
        planned: 3,
        started: 3,
        ok: 3,
        rateLimited: 0,
        measuredGapP50Ms: 60_010,
        quotasNamed: [],
      },
      {
        gapSeconds: 30,
        planned: 3,
        started: 3,
        ok: 1,
        rateLimited: 2,
        measuredGapP50Ms: 30_005,
        quotasNamed: ["metric/x"],
      },
      {
        gapSeconds: 15,
        planned: 1,
        started: 0,
        ok: 0,
        rateLimited: 0,
        measuredGapP50Ms: null,
        quotasNamed: [],
      },
    ]);
    const line = callLine(rows[5]);
    expect(line).toContain("rung 30 s");
    expect(line).toContain("after 30.0 s");
    expect(line).toContain("quota metric/x");
  });

  it("writes a short markdown table with no long dash", () => {
    const calls = [
      record({
        outcome: "ok",
        latencyMs: 30_000,
        trafficType: "ON_DEMAND",
        costUsd: 0.13,
      }),
      record({ seq: 2, arm: "priority", outcome: "429", latencyMs: 300 }),
    ];
    const results: PassResults = {
      tool: "revamp-priority-test",
      version: 2,
      label: "evening",
      project: "storemink-staging",
      startedAt: "2026-10-23T13:00:00.000Z",
      endedAt: "2026-10-23T13:12:30.000Z",
      stoppedBy: null,
      options: {
        gapSeconds: 15,
        maxInFlight: 6,
        maxUsd: 15,
        lead: "standard",
        timeoutMs: CALL_TIMEOUT_MS,
      },
      priorityHeaders: PRIORITY_HEADERS,
      quotaProject: "storemink-staging",
      estimate: estimatePlan(buildPlan()),
      spentUsd: 0.13,
      possiblyBilledUsd: 0,
      calls,
      summary: summarize(calls),
    };
    const markdown = summaryMarkdown(results);
    expect(markdown).toContain("# Priority PayGo test: evening");
    expect(markdown).toContain(
      "2026-10-23 13:00:00 UTC (18:30:00 IST), 12.5 min",
    );
    expect(markdown).toContain(
      "| Model | Endpoint | Arm | Calls | 200 | 429 | 429 share |",
    );
    expect(markdown).toContain(
      "| gemini-nano-banana-2.1 (photo) | global | priority | 1 | 0 | 1 | 100% |",
    );
    expect(markdown).toContain("| Cost | Most 200s in 60 s |");
    // Every trafficType seen rides beside the Priority count.
    expect(markdown).toContain("| 0 of 1; ON_DEMAND (1) |");
    expect(markdown).toContain("429 refusals: 1. None named a quota.");
    // No ladder in these records, so no ladder section.
    expect(markdown).not.toContain("## Spacing ladder");
    expect(markdown).not.toMatch(LONG_DASHES);

    const ladder = [60, 60, 15].map((gap, i) =>
      record({
        seq: 10 + i,
        lane: "photo-ladder@global",
        stage: "ladder",
        ladderGapSeconds: gap,
        outcome: i === 2 ? "429" : "ok",
        quotaNamed: i === 2 ? "metric/x" : null,
        startedAt: new Date(
          Date.UTC(2026, 9, 23, 13) + i * 20_000,
        ).toISOString(),
      }),
    );
    const withLadder = summaryMarkdown({
      ...results,
      calls: [...ladder, ...calls],
      summary: summarize([...ladder, ...calls]),
    });
    expect(withLadder).toContain("## Spacing ladder");
    expect(withLadder).toContain(
      "| gemini-nano-banana-2.1 (spacing ladder) | global | standard |",
    );
    expect(withLadder).toContain("| 60 s | 2 of 2 | 2 | 0 |");
    expect(withLadder).toContain("| 15 s | 1 of 1 | 0 | 1 |");
    expect(withLadder).toContain("The quotas they named: metric/x.");
    expect(withLadder).toContain(
      "gemini-nano-banana-2.1 at global, Standard, run alone before the pass",
    );
    expect(withLadder).toContain(
      "Most photos admitted within 60 s: 2 in the ladder",
    );
    expect(withLadder).not.toMatch(LONG_DASHES);
  });
});

describe("options and the environment", () => {
  it("is a dry run by default", () => {
    expect(readOptions([], "/tmp/out")).toEqual({
      help: false,
      live: false,
      maxUsd: DEFAULT_MAX_USD,
      gapSeconds: 40,
      lanes: DEFAULT_PROBE_LANES,
      ladders: ["standard", "priority"],
      maxInFlight: MAX_IN_FLIGHT,
      lead: "standard",
      label: "pass",
      out: "/tmp/out",
    });
  });

  it("filters without accidentally selecting or merging other work", () => {
    const opts = readOptions([]);
    if (typeof opts === "string") throw new Error(opts);
    const selected = buildPlan(opts.gapSeconds, opts.lead, opts);
    expect(selected).toHaveLength(54);
    expect(estimatePlan(selected).expectedUsd).toBeLessThan(8);
    expect(
      executionStages(selected).map((lanes) => lanes.map((lane) => lane.id)),
    ).toEqual([
      ["photo-ladder@global"],
      ["priority-ladder@global"],
      DEFAULT_PROBE_LANES,
    ]);
    expect(
      buildPlan(40, "standard", { lanes: ["check@us"], ladders: [] }),
    ).toHaveLength(10);
    expect(readOptions(["--lanes=none", "--ladders=priority"])).toMatchObject({
      lanes: [],
      ladders: ["priority"],
    });
    expect(readOptions(["--lanes=none", "--ladders=none"])).toMatch(
      /at least one/,
    );
    for (const args of [
      ["--lanes=unknown"],
      ["--lanes=check@us,check@us"],
      ["--ladders=both"],
    ]) {
      expect(typeof readOptions(args)).toBe("string");
    }
  });

  it("spends only with --live and --yes together", () => {
    expect(readOptions(["--live"])).toMatch(/--live --yes/);
    expect(readOptions(["--yes"])).toMatch(/consent/);
    expect(readOptions(["--live", "--yes"])).toMatchObject({ live: true });
  });

  it("refuses a budget over the owner's ceiling and in-flight limits past six", () => {
    expect(readOptions(["--max-usd=26"])).toMatch(/at most 25/);
    expect(readOptions(["--max-usd=0"])).toMatch(/more than 0/);
    expect(readOptions(["--max-usd=12.5"])).toMatchObject({ maxUsd: 12.5 });
    expect(readOptions(["--max-in-flight=7"])).toMatch(/1 to 6/);
    expect(readOptions(["--max-in-flight=2.5"])).toMatch(/whole number/);
    expect(readOptions(["--gap=4"])).toMatch(/between 5 and 120/);
  });

  it("takes a lead, a label and an output folder, and refuses anything else", () => {
    expect(
      readOptions(["--lead=priority", "--label=Night", "--out=/tmp/x"]),
    ).toMatchObject({ lead: "priority", label: "night", out: "/tmp/x" });
    expect(readOptions(["--lead=both"])).toMatch(/standard or priority/);
    expect(readOptions(["--label=night run"])).toMatch(/letters, digits/);
    expect(readOptions(["--force"])).toMatch(/Unknown argument --force/);
  });

  it("runs only in storemink-staging, reading Theme Studio's project first", () => {
    expect(environmentProblems(STAGING)).toEqual([]);
    expect(environmentProblems({})).toHaveLength(1);
    expect(
      targetProject({ ...STAGING, THEME_STUDIO_GCP_PROJECT_ID: "other" }),
    ).toBe("other");
    expect(
      environmentProblems({ ...STAGING, THEME_STUDIO_GCP_PROJECT_ID: "other" }),
    ).toHaveLength(1);
  });

  it("refuses any project variable naming prod, and a base URL that reroutes the calls", () => {
    expect(
      environmentProblems({ GCP_PROJECT_ID: "storemink-prod" }),
    ).toHaveLength(2);
    expect(
      environmentProblems({
        ...STAGING,
        GOOGLE_CLOUD_PROJECT: "storemink-prod",
      }),
    ).toEqual([expect.stringContaining('"prod" is refused')]);
    expect(
      environmentProblems({
        ...STAGING,
        GOOGLE_VERTEX_BASE_URL: "https://example.test/",
      }),
    ).toEqual([expect.stringContaining("GOOGLE_VERTEX_BASE_URL")]);
  });

  it("refuses a quota project other than staging, which would count the calls against it", () => {
    expect(
      environmentProblems({
        ...STAGING,
        GOOGLE_CLOUD_QUOTA_PROJECT: "storemink-prod",
      }),
    ).toEqual([expect.stringContaining("GOOGLE_CLOUD_QUOTA_PROJECT")]);
    expect(
      environmentProblems({
        ...STAGING,
        GOOGLE_CLOUD_QUOTA_PROJECT: "storemink-staging",
      }),
    ).toEqual([]);
  });
});

describe("the in-flight limit", () => {
  it("lets at most its size through and serves waiters in order", async () => {
    const slots = new Slots(2);
    const order: number[] = [];
    await slots.acquire();
    await slots.acquire();
    const third = slots.acquire().then(() => order.push(3));
    const fourth = slots.acquire().then(() => order.push(4));
    await Promise.resolve();
    expect(order).toEqual([]);
    slots.release();
    await third;
    expect(order).toEqual([3]);
    slots.release();
    await fourth;
    expect(order).toEqual([3, 4]);
  });
});
