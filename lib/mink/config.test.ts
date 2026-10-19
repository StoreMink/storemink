import { afterEach, describe, expect, it } from "vitest";
import { getMinkConfig } from "./config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getMinkConfig", () => {
  // ★★ CHARGING IS A PRICING FACT, SO IT IS PINNED IN BOTH DIRECTIONS. It
  // shipped opt-in and was then never set anywhere — no cloudbuild substitution,
  // no Cloud Run revision — so every conversation was free while the shadow
  // meter recorded what it would have cost. Nothing failed, because nothing
  // asserted the default. These two do.
  it("charges credits when nothing is set", () => {
    delete process.env.MINK_CHARGE_CREDITS;
    expect(getMinkConfig().chargeCredits).toBe(true);
  });
  it.each(["false", "0", "FALSE", " false "])(
    "stops charging on an explicit %s",
    (value) => {
      process.env.MINK_CHARGE_CREDITS = value;
      expect(getMinkConfig().chargeCredits).toBe(false);
    },
  );
  // ⚠ The failure direction is the whole reason this is not `enabled()`: that
  // helper reads anything it does not recognise as OFF, which here means
  // silently free. A value meant to turn charging ON must never turn it off.
  it.each(["TRUE", "true ", "1", "yes", ""])(
    "keeps charging on %s rather than reading it as off",
    (value) => {
      process.env.MINK_CHARGE_CREDITS = value;
      expect(getMinkConfig().chargeCredits).toBe(true);
    },
  );

  it("enables by default and uses the production model defaults", () => {
    delete process.env.MINK_AI_ENABLED;
    delete process.env.MINK_VERTEX_MODEL;
    delete process.env.MINK_VERTEX_LOCATION;
    delete process.env.MINK_IMAGE_MODEL;
    delete process.env.MINK_IMAGE_LOCATION;
    process.env.GCP_PROJECT_ID = "storemink-test";

    expect(getMinkConfig()).toMatchObject({
      enabled: true,
      betaRequireInvite: false,
      projectId: "storemink-test",
      location: "global",
      model: "gemini-3.7-flash",
      imageModel: "gemini-3.1-flash-image",
      imageLocation: "global",
      maxSteps: 12,
      maxToolCalls: 16,
      maxParallelReadTools: 4,
      maxOutputTokens: 2_048,
      maxModelRetries: 2,
      runTimeoutMs: 180_000,
      firstChunkTimeoutMs: 20_000,
      streamIdleTimeoutMs: 20_000,
      fallbackModel: "gemini-3.5-flash",
      fallbackLocation: "asia-south1",
    });
  });

  // ★ The fallback is a different capacity pool, on unless switched off; a
  // value that is not a Gemini id is read as off, never trusted.
  it.each([
    ["gemini-3.8-flash", "gemini-3.8-flash"],
    [" Gemini-3.5-Flash ", "gemini-3.5-flash"],
    ["off", null],
    ["none", null],
    ["", null],
    ["false", null],
    ["claude", null],
    ["gemini 3.5", null],
  ] as const)("reads MINK_FALLBACK_MODEL=%j as %j", (value, expected) => {
    process.env.MINK_FALLBACK_MODEL = value;
    expect(getMinkConfig().fallbackModel).toBe(expected);
  });
  it("takes the fallback's location from MINK_FALLBACK_LOCATION", () => {
    process.env.MINK_FALLBACK_LOCATION = " us-central1 ";
    expect(getMinkConfig().fallbackLocation).toBe("us-central1");
  });

  // ★ Routing is on by default (a narrowed run can always ask for the rest);
  // the lite model is off by default, because it changes who answers.
  it("routes tools by default and keeps the lite model off", () => {
    delete process.env.MINK_TOOL_ROUTING;
    delete process.env.MINK_LITE_ROUTING;
    delete process.env.MINK_LITE_MODEL;
    expect(getMinkConfig()).toMatchObject({
      toolRouting: true,
      liteRouting: false,
      liteModel: "gemini-3.5-flash-lite",
    });
  });
  it.each(["false", "0", " FALSE "])(
    "turns routing off on an explicit %s",
    (value) => {
      process.env.MINK_TOOL_ROUTING = value;
      expect(getMinkConfig().toolRouting).toBe(false);
    },
  );
  it.each([
    ["true", true],
    ["1", true],
    [" TRUE ", true],
    ["yes", false],
    ["", false],
  ] as const)("reads MINK_LITE_ROUTING=%j as %s", (value, expected) => {
    process.env.MINK_LITE_ROUTING = value;
    expect(getMinkConfig().liteRouting).toBe(expected);
  });
  it("accepts only a Flash-Lite model for the lite tier", () => {
    process.env.MINK_LITE_MODEL = "gemini-3.1-flash-lite";
    expect(getMinkConfig().liteModel).toBe("gemini-3.1-flash-lite");
    process.env.MINK_LITE_MODEL = "gemini-3.5-flash-lite-preview-10-2026";
    expect(getMinkConfig().liteModel).toBe(
      "gemini-3.5-flash-lite-preview-10-2026",
    );
    for (const value of ["gemini-3.1-pro", "gemini-3.7-flash", "lite", ""]) {
      process.env.MINK_LITE_MODEL = value;
      expect(getMinkConfig().liteModel, value).toBe("gemini-3.5-flash-lite");
    }
  });

  it("is available to every store without an invitation", () => {
    expect(getMinkConfig().betaRequireInvite).toBe(false);
  });

  it("allows an explicit false value to disable the default-on runtime", () => {
    delete process.env.MINK_AI_ENABLED;
    expect(getMinkConfig().enabled).toBe(true);
    for (const value of ["false", "0", "yes", "TRUE", "enabled", ""]) {
      process.env.MINK_AI_ENABLED = value;
      expect(getMinkConfig().enabled, value).toBe(false);
    }
    process.env.MINK_AI_ENABLED = "true";
    expect(getMinkConfig().enabled).toBe(true);
    process.env.MINK_AI_ENABLED = "1";
    expect(getMinkConfig().enabled).toBe(true);
  });

  it("rejects unsafe numeric limits instead of trusting environment input", () => {
    process.env.MINK_MAX_STEPS_PER_RUN = "999";
    process.env.MINK_MAX_TOOL_CALLS_PER_RUN = "0";
    process.env.MINK_MAX_PARALLEL_READ_TOOLS = "not-a-number";
    process.env.MINK_MAX_OUTPUT_TOKENS = "12.5";
    process.env.MINK_MAX_MODEL_RETRIES = "9";
    process.env.MINK_RUN_TIMEOUT_SECONDS = "5";
    process.env.MINK_FIRST_CHUNK_SECONDS = "1";
    process.env.MINK_STREAM_IDLE_SECONDS = "600";

    expect(getMinkConfig()).toMatchObject({
      maxSteps: 12,
      maxToolCalls: 16,
      maxParallelReadTools: 4,
      maxOutputTokens: 2_048,
      maxModelRetries: 2,
      runTimeoutMs: 180_000,
      firstChunkTimeoutMs: 20_000,
      streamIdleTimeoutMs: 20_000,
    });
  });
});
