import { ThinkingLevel } from "@google/genai";
import sharp from "sharp";
import type { ImageCallUsage } from "@/lib/theme-studio/cost";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logInfo, logWarn } from "@/lib/observability/logger";
import { IMAGE_REVIEW_TRY_TIMEOUT_MS } from "@/lib/theme-studio/gemini-vertex";
import { IMAGE_REQUEST_TIMEOUT_MS } from "@/lib/theme-studio/image-vertex";
import {
  ZERO_IMAGE_USAGE,
  type ThemeImageRequest,
  type ThemeImageResult,
  type ThemeStudioImageClient,
} from "@/lib/theme-studio/image-provider";
import {
  NO_GOODS_PEOPLE_RULE,
  NO_GOODS_RULE,
  THEME_STUDIO_GOODS_RULE,
} from "@/lib/theme-studio/image-prompt";
import type { ThemeImageProblem } from "@/lib/theme-studio/image-review";
import {
  ZERO_USAGE,
  type ProviderUsage,
  type StructuredRequest,
  type ThemeStudioContentBlock,
  type ThemeStudioModelClient,
} from "@/lib/theme-studio/provider";
import {
  coordinatedProviderCapacity,
  IMAGE_START_PACING,
  type CapacityStore,
  type ProviderCapacity,
  type ProviderPermit,
} from "@/lib/theme-studio/provider-capacity";
import { ImageRequestPool } from "@/lib/theme-studio/image-request-pool";
import type { MinkActorContext } from "../types";
import {
  REVAMP_ERROR_MESSAGES,
  REVAMP_LIMITS,
  type RevampPhotoOutcome,
  type RevampRequest,
  type RevampShot,
  type RevampSitePlan,
  type RevampSlotBinding,
  type RevampSnapshot,
  type RevampStoredImage,
} from "./contract";
import type { StoreRevampImageInput } from "./image-store";
import {
  REVAMP_CHECKED_CROP_MAX_LOSS,
  REVAMP_PHONE_FRAME,
  REVAMP_PHOTO_CHECK_BUDGET_MS,
  REVAMP_PHOTO_SERVICE_RETRY_MS,
  REVAMP_RECROP_PROBLEM,
  REVAMP_REVIEW_PENDING_SUFFIX,
  REVAMP_REVIEW_RETRY_DELAYS_MS,
  REVAMP_SMALL_PHOTO_REASON,
  REVAMP_SMALL_PROBLEM,
  REVAMP_TOO_SMALL_CAUSE,
  REVAMP_UNCHECKED_PHOTO_REASON,
  REVAMP_UNCHECKED_PROBLEM,
  drawRevampPhotos,
  planRevampShots,
  revampAdmissionDrain,
  revampAnchorLead,
  revampDrainingCapacity,
  revampImageDirection,
  type DrawRevampPhotosOptions,
} from "./photos";
import {
  RevampDrainedError,
  RevampRetryLaterError,
  RevampStepError,
  ZERO_REVAMP_USAGE,
  addRevampUsage,
  type RevampPhotoHold,
  type RevampPhotoReviews,
  type RevampStepContext,
  type RevampUsage,
} from "./ports";

// ---------------------------------------------------------------------------
// The photos step over the REAL Theme Studio image run (runSlotImageGeneration)
// with an injected image client, reviewer and crop, and an in-memory image
// store in place of the bucket and the database. No network, no sharp.
// ---------------------------------------------------------------------------

type Row = RevampStoredImage & {
  revampId: string;
  problems: string[];
  createdAt: string;
};

const h = vi.hoisted(() => {
  const digest = (bytes: Uint8Array): string => {
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0").repeat(8);
  };
  return {
    digest,
    configured: true,
    rows: new Map<string, Row>(),
    objects: new Map<string, Uint8Array>(),
    saves: [] as StoreRevampImageInput[],
    adopts: [] as string[],
    /** Each adopt with the problems it wrote on the new row. */
    adoptCalls: [] as Array<{ slotId: string; problems: string[] }>,
    /** Slot ids whose adopt throws (a storage or database fault). */
    adoptFails: new Set<string>(),
    claims: [] as number[],
    releases: [] as number[],
    /** Claims, give-backs and hold records, in the order they happened. */
    events: [] as string[],
    /**
     * One answer per claim, in order; absent means allowed. `false` is the
     * store's day refusing; a string names the limit key that refused.
     */
    claimAnswers: [] as Array<boolean | string>,
    imageConfig: null as unknown,
    fakeClient: null as ThemeStudioImageClient | null,
    /** The options each offline client was created with. */
    fakeClientOptions: [] as unknown[],
    fakeReviewer: null as ThemeStudioModelClient | null,
    /** The shared capacity the Vertex clients are given; absent throws. */
    sharedCapacity: null as ProviderCapacity | null,
    /** Each shared capacity asked for: project, location and model. */
    sharedCapacityCalls: [] as unknown[][],
    /** The options each Vertex image / review client was created with. */
    vertexImageOptions: [] as Array<Record<string, unknown>>,
    vertexReviewOptions: [] as Array<Record<string, unknown>>,
    /** The Vertex text config the reviewer reads; null means none. */
    vertexConfig: null as unknown,
    /** The store's own photos by URL, as `readStoreOwnedImageBytes` reads them. */
    storePhotos: new Map<string, Uint8Array>(),
    /** Every read of a store photo: the URL and the store it was asked for. */
    ownedReads: [] as Array<{ url: string; storeId: string }>,
  };
});

vi.mock("./image-store", async () => {
  // ★ The store's own digest, a real SHA-256 like the crop's, so a picture
  //   the real crop prepared is recognised as the one stored.
  const { createHash } = await import("node:crypto");
  h.digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  const key = (revampId: string, role: string, slotId: string) =>
    `${revampId}|${role}|${slotId}`;
  const record = (row: Row): RevampStoredImage => ({
    role: row.role,
    slotId: row.slotId,
    url: row.url,
    path: row.path,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    review: row.review,
  });
  return {
    REVAMP_PHONE_SUFFIX: "~phone",
    revampImageStoreConfigured: () => h.configured,
    storeRevampImage: async (input: StoreRevampImageInput) => {
      h.saves.push(input);
      const existing = h.rows.get(
        key(input.revampId, input.role, input.slotId),
      );
      if (existing) return record(existing);
      const sha256 = h.digest(input.bytes);
      const path = `stores/${input.storeId}/mink-generated/revamp/${input.revampId}/${input.role}-${input.slotId}-${sha256.slice(0, 8)}.webp`;
      const row: Row = {
        revampId: input.revampId,
        role: input.role,
        slotId: input.slotId,
        url: `https://storage.googleapis.com/bucket/${path}`,
        path,
        sha256,
        width: input.width,
        height: input.height,
        review: input.review,
        problems: input.problems,
        createdAt: new Date().toISOString(),
      };
      h.rows.set(key(input.revampId, input.role, input.slotId), row);
      h.objects.set(path, input.bytes);
      return record(row);
    },
    adoptRevampImage: async (input: {
      revampId: string;
      storeId: string;
      image: RevampStoredImage;
      problems?: readonly string[];
    }) => {
      h.adopts.push(input.image.slotId);
      h.adoptCalls.push({
        slotId: input.image.slotId,
        problems: [...(input.problems ?? [])],
      });
      if (h.adoptFails.has(input.image.slotId)) {
        throw new Error("Connection terminated unexpectedly");
      }
      const k = key(input.revampId, input.image.role, input.image.slotId);
      const existing = h.rows.get(k);
      if (existing) return record(existing);
      const row: Row = {
        ...input.image,
        revampId: input.revampId,
        // ★ As the real store does: the adopt's problems on the new row.
        problems: [...(input.problems ?? [])],
        createdAt: new Date().toISOString(),
      };
      h.rows.set(k, row);
      return record(row);
    },
    listRevampImageRecords: async (revampId: string) =>
      [...h.rows.values()]
        .filter((row) => row.revampId === revampId)
        .map((row) => ({
          ...record(row),
          problems: row.problems,
          createdAt: row.createdAt,
        })),
    readRevampImageBytes: async (image: RevampStoredImage) =>
      h.objects.get(image.path) ?? null,
    // ★ As the real reader: a path under this store's own prefix, or nothing.
    readStoreOwnedImageBytes: async (url: string, storeId: string) => {
      h.ownedReads.push({ url, storeId });
      if (!url.includes(`/stores/${storeId}/`)) return null;
      return h.storePhotos.get(url) ?? null;
    },
    REVAMP_PLATFORM_PHOTO_LIMIT_KEY: "mink-revamp-photos-hour",
    claimRevampPhotos: async (storeId: string, cost: number) => {
      h.claims.push(cost);
      h.events.push(`claim:${cost}`);
      const answer = h.claimAnswers.length ? h.claimAnswers.shift() : true;
      if (answer === true) return { ok: true };
      return {
        ok: false,
        refusedKey:
          typeof answer === "string"
            ? answer
            : `mink-revamp-photos-day:${storeId}`,
      };
    },
    releaseRevampPhotos: async (_storeId: string, count: number) => {
      h.releases.push(count);
      h.events.push(`release:${count}`);
    },
  };
});

vi.mock("@/lib/theme-studio/image-fake", () => ({
  createFakeImageClient: (options?: unknown) => {
    h.fakeClientOptions.push(options);
    return h.fakeClient;
  },
  createFakeImageReviewClient: () => h.fakeReviewer,
}));
// The real model rules (imageRequestConfig, which the real image client
// applies), with the config reader replaced.
vi.mock("@/lib/theme-studio/image-models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/theme-studio/image-models")>()),
  THEME_STUDIO_IMAGE_MODEL_KEY: "gemini-nano-banana-2.1",
  // An Error stands for a setting the config reader cannot parse.
  getThemeStudioImageConfig: () => {
    if (h.imageConfig instanceof Error) throw h.imageConfig;
    return h.imageConfig;
  },
}));
// Vertex must never be reached from a test. Both clients record the options
// the photos step builds them with, and answer as an outage.
vi.mock("@/lib/theme-studio/image-vertex", async (importOriginal) => ({
  // ★ The real per-try clock a shoot photo's admission is measured by (D2).
  IMAGE_REQUEST_TIMEOUT_MS: (
    await importOriginal<typeof import("@/lib/theme-studio/image-vertex")>()
  ).IMAGE_REQUEST_TIMEOUT_MS,
  createVertexImageClient: (_config: unknown, options: unknown) => {
    h.vertexImageOptions.push(options as Record<string, unknown>);
    const client: ThemeStudioImageClient = {
      provider: "vertex-gemini",
      generateImage: async () => ({
        kind: "error",
        code: "provider_unavailable",
        usage: ZERO_IMAGE_USAGE,
      }),
    };
    return client;
  },
}));
// The real module, for the error classification the real image client uses,
// with the reviewer's own client and config replaced.
vi.mock("@/lib/theme-studio/gemini-vertex", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/theme-studio/gemini-vertex")
  >()),
  createVertexModelClient: (_config: unknown, options: unknown) => {
    h.vertexReviewOptions.push(options as Record<string, unknown>);
    const client: ThemeStudioModelClient = {
      provider: "vertex-gemini",
      generate: async () => ({
        kind: "error",
        code: "provider_unavailable",
        usage: ZERO_USAGE,
      }),
    };
    return client;
  },
  getVertexConfig: () => h.vertexConfig,
}));
vi.mock("@/lib/theme-studio/provider-capacity-store", () => ({
  sharedProviderCapacity: (...args: unknown[]) => {
    h.sharedCapacityCalls.push(args);
    if (!h.sharedCapacity) throw new Error("no network in tests");
    return h.sharedCapacity;
  },
}));
// The step's logs, off the console and readable by the tests that need
// to know what a merchant-invisible outcome was put down to.
vi.mock("@/lib/observability/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/logger")>()),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const STORE = "11111111-1111-4111-8111-111111111111";
const REVAMP = "22222222-2222-4222-8222-222222222222";
const PARENT = "33333333-3333-4333-8333-333333333333";

/** `turned_down`: the provider refused the request itself (a 400), no outage. */
type Behaviour = "ok" | "refuse" | "outage" | "turned_down";

/**
 * The test image client: bytes named after the brief, per-brief behaviour.
 * `usage` is what a picture is billed; a refusal bills its prompt only.
 */
function makeClient(
  behaviour: (request: ThemeImageRequest) => Behaviour = () => "ok",
  onCall?: (request: ThemeImageRequest) => void,
  usage = ZERO_IMAGE_USAGE,
) {
  const calls: ThemeImageRequest[] = [];
  /** Calls that reached the model: answered, not stopped before sending. */
  let sent = 0;
  const client: ThemeStudioImageClient = {
    provider: "fake",
    async generateImage(request, signal): Promise<ThemeImageResult> {
      calls.push(request);
      onCall?.(request);
      if (signal.aborted) {
        return { kind: "error", code: "cancelled", usage: ZERO_IMAGE_USAGE };
      }
      sent += 1;
      const what = behaviour(request);
      if (what === "refuse") {
        return {
          kind: "refused",
          reason: "IMAGE_SAFETY",
          usage: { inputTokens: usage.inputTokens, outputTokens: 0 },
        };
      }
      if (what === "outage" || what === "turned_down") {
        return {
          kind: "error",
          code:
            what === "outage" ? "provider_unavailable" : "provider_rejected",
          usage: ZERO_IMAGE_USAGE,
        };
      }
      return {
        kind: "ok",
        bytes: new Uint8Array(
          Buffer.from(`img:${request.briefId}:${calls.length}`),
        ),
        mediaType: "image/png",
        usage,
      };
    },
  };
  return {
    client,
    calls,
    briefs: () => calls.map((c) => c.briefId),
    sent: () => sent,
  };
}

type ReviewAnswer = ThemeImageProblem[] | "outage" | "rate_limited";

/**
 * The test review model: each candidate is answered as `decide` says, from
 * the picture's own bytes; `seen` is every review the model was sent, with
 * the anchor it was shown beside the candidate.
 */
function makeReviewer(
  decide: (candidate: string) => ReviewAnswer,
  usage: ProviderUsage = ZERO_USAGE,
) {
  const seen: Array<{ candidate: string; anchor: string | null }> = [];
  const decoded = (block: ThemeStudioContentBlock | undefined) =>
    block?.type === "image"
      ? Buffer.from(block.base64, "base64").toString()
      : null;
  const client: ThemeStudioModelClient = {
    provider: "fake",
    async generate(request) {
      const images = request.content.filter((b) => b.type === "image");
      const candidate = decoded(images[0]) ?? "";
      seen.push({ candidate, anchor: decoded(images[1]) });
      const answer = decide(candidate);
      if (answer === "outage") {
        return { kind: "error", code: "provider_unavailable", usage };
      }
      if (answer === "rate_limited") {
        return { kind: "error", code: "rate_limited", usage: ZERO_USAGE };
      }
      return {
        kind: "ok",
        usage,
        value: { problems: answer, note: answer.length ? "Noted." : "" },
      };
    },
  };
  return { reviewer: { client, providerModel: "fake" }, seen };
}

/** The anchor passes; the hero's reviews answer in turn, the last repeating. */
function heroReviews(...answers: ReviewAnswer[]) {
  let turn = 0;
  return (candidate: string): ReviewAnswer =>
    candidate.startsWith("img:anchor")
      ? []
      : answers[Math.min(turn++, answers.length - 1)];
}

/** The waits before a review is asked again, none of them slept. */
function recordingSleep() {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
    return true;
  };
  return { sleep, waits };
}

const text = (bytes: Uint8Array | undefined) =>
  bytes ? Buffer.from(bytes).toString() : "";

const prepareTargets: Array<{ width: number; height: number }> = [];

/** Crops to exactly the frame, deterministically, without sharp. */
const prepare: NonNullable<DrawRevampPhotosOptions["prepare"]> = async (
  input,
  target,
) => {
  prepareTargets.push({ width: target.width, height: target.height });
  const bytes = Buffer.concat([
    Buffer.from(input),
    Buffer.from(`@${target.width}x${target.height}`),
  ]);
  return {
    ok: true,
    value: {
      bytes,
      mediaType: "image/webp",
      width: target.width,
      height: target.height,
      sha256: h.digest(bytes),
      originalMediaType: "image/png",
      originalByteSize: input.byteLength,
    },
  };
};

const frame = (width: number, height: number) => ({
  width,
  height,
  aspect: width / height,
});

function shot(id: string, purpose: RevampShot["purpose"], subject: string) {
  return {
    id,
    purpose,
    subject,
    artDirection: `${subject}, soft light`,
    aspectRatio: "1:1",
    people: "none",
  } as RevampShot;
}

function binding(
  shotId: string,
  pageSlug: string,
  sectionId: string,
  f: ReturnType<typeof frame>,
  phone = false,
): RevampSlotBinding {
  return {
    shotId,
    pageSlug,
    sectionId,
    path: ["image_url"],
    frame: f,
    phonePath: phone ? ["mobile_image_url"] : null,
  };
}

const SHOTS = [
  shot("hero-1", "hero", "Almond shakes on a sunlit counter"),
  shot("story-1", "content", "Hands cracking almonds"),
  shot("refill-0001", "content", "A shake poured into a glass"),
  shot("category-shakes", "category", "Shakes, as sold at Almond House"),
  shot("unused-1", "content", "Nothing shows this"),
];

const BINDINGS = [
  binding("hero-1", "", "s-hero", frame(2520, 1080), true),
  binding("story-1", "about", "s-media", frame(1200, 1500)),
  binding("story-1", "about", "s-media-b", frame(960, 1200)),
  // A refill inside the merchant's own homepage section.
  binding("refill-0001", "", "s-merchant", frame(1600, 1200)),
  binding("category-shakes", "@category", "shakes", frame(1200, 1200)),
];

function section(id: string, type: string, enabled = true) {
  return { id, type, enabled, config: {} };
}

function makePlan(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    summary: "A warm almond shake shop",
    industry: "food-and-drink",
    direction: "luxury-minimal",
    design: {
      palette: { cream: "#f5efe6" },
      fonts: { body: null, display: null },
      shape: { card: 0 },
    },
    appearance: {},
    announcement: { text: "", href: "" },
    brand: { tagline: "", blurb: "" },
    newsletter: { heading: "", subtext: "", buttonLabel: "" },
    pages: [
      {
        slug: "",
        title: "Home",
        seoTitle: "",
        seoDescription: "",
        create: false,
        pageId: "page-home",
        sections: [
          section("s-ticker", "ticker"),
          section("s-hero", "hero"),
          section("s-merchant", "media_text"),
        ],
      },
      {
        slug: "about",
        title: "About",
        seoTitle: "",
        seoDescription: "",
        create: false,
        pageId: "page-about",
        sections: [section("s-media", "media_text")],
      },
    ],
    menus: { header: [], footerGroups: [] },
    shots: SHOTS,
    bindings: BINDINGS,
    productCopy: {},
    notes: [],
    skipped: [],
    ...overrides,
  } as unknown as RevampSitePlan;
}

function makeSnapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    storeId: STORE,
    storeName: "Almond House",
    theme: {
      id: "basket",
      version: "1.0.0",
      name: "Basket",
      palette: {
        page: "#ffffff",
        surface: "#fafafa",
        ink: "#111111",
        accent: "#aa5500",
      },
      layout: {},
    },
    pages: [],
    ...overrides,
  } as unknown as RevampSnapshot;
}

function makeCtx(
  signal: AbortSignal = new AbortController().signal,
  photoHold?: RevampStepContext["photoHold"],
) {
  const report = vi.fn(async (detail: string | null) => {
    void detail;
  });
  const ctx: RevampStepContext = {
    revampId: REVAMP,
    actor: { storeId: STORE } as MinkActorContext,
    signal,
    // ★ The runner's own: a context given a drain closes its draws 95 s
    //   before it (D2, `revampAdmissionDrain`).
    deadline: Date.now() + REVAMP_LIMITS.runnerDeadlineMs,
    report,
    ...(photoHold ? { photoHold } : {}),
  };
  return { ctx, report };
}

/**
 * The job row's record of the photo claim, as the runner keeps it: what a
 * previous invocation left, and each write, which `answers` may refuse (a
 * lost lease).
 */
function holdPort(
  initial: RevampPhotoHold | null = null,
  answers: boolean[] = [],
) {
  let current = initial;
  const writes: Array<RevampPhotoHold | null> = [];
  const port: NonNullable<RevampStepContext["photoHold"]> = {
    held: () => current,
    record: async (hold) => {
      writes.push(hold);
      h.events.push(hold ? `record:${hold.units.length}` : "record:clear");
      const ok = answers.length ? answers.shift()! : true;
      if (ok) current = hold;
      return ok;
    },
  };
  return { port, writes, current: () => current };
}

/**
 * The job row's record of the photo checks (P0), as the runner keeps it:
 * what a previous invocation left, and each write, round-tripped through
 * JSON the way the row stores it.
 */
function reviewsPort(initial: RevampPhotoReviews | null = null) {
  let current = initial;
  const writes: RevampPhotoReviews[] = [];
  const port: NonNullable<RevampStepContext["photoReviews"]> = {
    held: () => current,
    record: async (reviews) => {
      const saved = JSON.parse(JSON.stringify(reviews)) as RevampPhotoReviews;
      writes.push(saved);
      current = saved;
      return true;
    },
  };
  return { port, writes, current: () => current };
}

/** A stored image of `revampId`, with its bytes in the bucket. */
function seedRow(
  revampId: string,
  role: RevampStoredImage["role"],
  slotId: string,
  width: number,
  height: number,
  path?: string,
): RevampStoredImage {
  const bytes = new Uint8Array(Buffer.from(`seed:${revampId}:${slotId}`));
  const sha256 = h.digest(bytes);
  const objectPath =
    path ??
    `stores/${STORE}/mink-generated/revamp/${revampId}/${role}-${slotId}-${sha256.slice(0, 8)}.webp`;
  const image: RevampStoredImage = {
    role,
    slotId,
    url: `https://storage.googleapis.com/bucket/${objectPath}`,
    path: objectPath,
    sha256,
    width,
    height,
    review: "passed",
  };
  h.rows.set(`${revampId}|${role}|${slotId}`, {
    ...image,
    revampId,
    problems: [],
    createdAt: new Date().toISOString(),
  });
  h.objects.set(objectPath, bytes);
  return image;
}

/** The hero's photo an earlier invocation parked before its review spoke. */
function seedParked(revampId = REVAMP): RevampStoredImage {
  const slotId = `hero-1${REVAMP_REVIEW_PENDING_SUFFIX}`;
  const image = seedRow(revampId, "slot", slotId, 2520, 1080);
  const row = h.rows.get(`${revampId}|slot|${slotId}`)!;
  row.review = "unreviewed";
  row.problems = ["review-pending"];
  return { ...image, review: "unreviewed" };
}

/** A real picture, solid so that encoding it is quick. */
async function picture(
  width: number,
  height: number,
  format: "png" | "webp" = "png",
): Promise<Uint8Array> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 196, g: 164, b: 120 },
    },
  });
  const buffer =
    format === "png"
      ? await image.png().toBuffer()
      : await image.webp().toBuffer();
  return new Uint8Array(buffer);
}

/**
 * The image model's own output sizes per aspect ratio (Gemini 3 Pro Image):
 * what a picture asked for at 2K comes back as, and at 1K, which is what the
 * live run of 2026-10-22 got (every stored size was a crop of one).
 */
const MODEL_SIZES: Record<"2K" | "1K", Record<string, [number, number]>> = {
  "2K": {
    "21:9": [3168, 1344],
    "4:3": [2400, 1792],
    "4:5": [1856, 2304],
    "1:1": [2048, 2048],
  },
  "1K": {
    "21:9": [1584, 672],
    "4:3": [1200, 896],
    "4:5": [928, 1152],
    "1:1": [1024, 1024],
  },
};

/** An image client answering every request with a real picture of that size. */
function modelSizedClient(size: "2K" | "1K") {
  const drawn: Array<{ briefId: string; width: number; height: number }> = [];
  const client: ThemeStudioImageClient = {
    provider: "fake",
    async generateImage(request): Promise<ThemeImageResult> {
      const dimensions = MODEL_SIZES[size][request.aspectRatio];
      if (!dimensions)
        throw new Error(`no ${size} size for ${request.aspectRatio}`);
      const [width, height] = dimensions;
      drawn.push({ briefId: request.briefId, width, height });
      return {
        kind: "ok",
        bytes: await picture(width, height),
        mediaType: "image/png",
        usage: ZERO_IMAGE_USAGE,
      };
    },
  };
  return { client, drawn };
}

async function measured(bytes: Uint8Array | undefined) {
  const meta = await sharp(Buffer.from(bytes ?? new Uint8Array())).metadata();
  return [meta.width, meta.height];
}

function savedSlots() {
  return h.saves.map((s) => s.slotId);
}

function outcome(run: { outcomes: RevampPhotoOutcome[] }, id: string) {
  return run.outcomes.find((o) => o.shotId === id);
}

const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);

beforeEach(() => {
  h.configured = true;
  h.rows.clear();
  h.objects.clear();
  h.saves.length = 0;
  h.adopts.length = 0;
  h.adoptCalls.length = 0;
  h.adoptFails.clear();
  h.claims.length = 0;
  h.releases.length = 0;
  h.events.length = 0;
  h.claimAnswers.length = 0;
  h.imageConfig = null;
  h.fakeClient = null;
  h.fakeClientOptions.length = 0;
  h.fakeReviewer = null;
  h.sharedCapacity = null;
  h.sharedCapacityCalls.length = 0;
  h.vertexImageOptions.length = 0;
  h.vertexReviewOptions.length = 0;
  h.vertexConfig = null;
  h.storePhotos.clear();
  h.ownedReads.length = 0;
  prepareTargets.length = 0;
  vi.unstubAllEnvs();
});

describe("planRevampShots", () => {
  it("frames every kind of shot by its bindings and leaves an unused one empty", () => {
    const planned = planRevampShots(makePlan());
    const byId = new Map(planned.map((p) => [p.shot.id, p]));

    expect(byId.get("hero-1")?.frame).toEqual(frame(2520, 1080));
    expect(byId.get("hero-1")?.needsPhone).toBe(true);
    expect(byId.get("hero-1")?.onHomepage).toBe(true);
    // Two bindings of one shape: the larger frame.
    expect(byId.get("story-1")?.frame).toEqual(frame(1200, 1500));
    expect(byId.get("story-1")?.onHomepage).toBe(false);
    expect(byId.get("story-1")?.slot?.brief.aspectRatio).toBe("4:5");
    // A refill and a category shot are shots like any other.
    expect(byId.get("refill-0001")?.slot?.target).toEqual(frame(1600, 1200));
    expect(byId.get("category-shakes")?.slot?.purpose).toBe("category");
    expect(byId.get("category-shakes")?.slot?.brief.purpose).toContain(
      "shakes category",
    );
    expect(byId.get("hero-1")?.slot?.brief.purpose).toContain(
      "opening photograph of the homepage",
    );
    expect(byId.get("unused-1")?.frame).toBeNull();
    expect(byId.get("unused-1")?.slot).toBeNull();
  });
});

describe("revampAnchorLead", () => {
  it("follows the homepage's opening photograph", () => {
    expect(revampAnchorLead(makePlan())).toEqual({
      subject: "Almond shakes on a sunlit counter",
      artDirection: "Almond shakes on a sunlit counter, soft light",
    });
  });

  it("reads a kept homepage's order from the snapshot", () => {
    const plan = makePlan({
      pages: [],
      bindings: [
        binding("hero-1", "about", "s-x", frame(2520, 1080)),
        binding("refill-0001", "", "s-merchant", frame(1600, 1200)),
      ],
    });
    const snapshot = makeSnapshot({
      pages: [
        {
          slug: "",
          sections: [
            section("s-off", "hero", false),
            section("s-merchant", "hero"),
          ],
        },
      ],
    });
    expect(revampAnchorLead(plan, snapshot)?.subject).toBe(
      "A shake poured into a glass",
    );
    // Without the snapshot it falls back to the hero a page uses.
    expect(revampAnchorLead(plan)?.subject).toBe(
      "Almond shakes on a sunlit counter",
    );
  });
});

describe("revampImageDirection", () => {
  it("takes the design's colours over the theme's and the direction's room", () => {
    const direction = revampImageDirection(makePlan(), makeSnapshot());
    expect(direction.palette).toEqual({
      page: "#f5efe6",
      surface: "#fafafa",
      ink: "#111111",
      accent: "#aa5500",
    });
    expect(direction.density).toBe("airy");
    expect(direction.shape).toBe("square");
    expect(direction.moodKeywords).toEqual(["Luxury minimal"]);
    expect(direction.themeName).toBe("Almond House");
  });
});

describe("drawRevampPhotos", () => {
  it("draws the anchor and every shot, storing each one as it settles", async () => {
    const { client, briefs } = makeClient();
    const { ctx, report } = makeCtx();
    const run = await drawRevampPhotos(
      ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );

    expect(briefs()[0]).toBe("anchor");
    expect(briefs().slice(1).sort()).toEqual(
      ["category-shakes", "hero-1", "refill-0001", "story-1"].sort(),
    );
    expect(savedSlots()).toEqual(
      expect.arrayContaining([
        "anchor",
        "hero-1",
        "hero-1~phone",
        "story-1",
        "refill-0001",
        "category-shakes",
      ]),
    );
    expect(savedSlots()).toHaveLength(6);
    const anchor = h.saves.find((s) => s.slotId === "anchor");
    expect(anchor?.role).toBe("anchor");
    // The phone crop is a 4:5 cut, only for the shot with a phone binding.
    const phone = h.saves.find((s) => s.slotId === "hero-1~phone");
    expect([phone?.width, phone?.height]).toEqual([
      REVAMP_PHONE_FRAME.width,
      REVAMP_PHONE_FRAME.height,
    ]);
    expect(REVAMP_PHONE_FRAME.aspect).toBeCloseTo(0.8);
    // ★ Cut from the picture the model drew, never from its stored 2520x1080
    //   copy (L2-D): the crop's bytes are the draw's own, cropped once.
    expect(text(phone?.bytes)).toMatch(/^img:hero-1:\d+@1080x1350$/);
    const story = h.saves.find((s) => s.slotId === "story-1");
    expect([story?.width, story?.height]).toEqual([1200, 1500]);

    expect(h.claims).toEqual([5]);
    expect(sum(h.releases)).toBe(0);
    expect(run.usage.images).toBe(5);
    expect(run.outcomes).toEqual(
      expect.arrayContaining([
        { shotId: "hero-1", status: "generated", reason: null },
        { shotId: "category-shakes", status: "generated", reason: null },
        expect.objectContaining({ shotId: "unused-1", status: "skipped" }),
      ]),
    );
    expect(run.images.filter((i) => i.role === "slot")).toHaveLength(5);
    expect(report.mock.calls[0][0]).toBe("0 of 4");
    expect(report.mock.calls.at(-1)?.[0]).toBe("4 of 4");
  });

  it("resumes without drawing anything twice", async () => {
    seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
    const hero = seedRow(REVAMP, "slot", "hero-1", 2520, 1080);
    const story = seedRow(REVAMP, "slot", "story-1", 1200, 1500);
    const anchor = [...h.rows.values()].find((r) => r.role === "anchor")!;
    const { client, briefs } = makeClient();
    const run = await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [anchor, hero, story],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );

    // Only the missing shots, matched to the stored anchor (no new one).
    expect(briefs().sort()).toEqual(["category-shakes", "refill-0001"]);
    expect(h.claims).toEqual([2]);
    // The stored hero lacked its phone crop: cut from it, not drawn.
    expect(savedSlots().sort()).toEqual(
      ["category-shakes", "hero-1~phone", "refill-0001"].sort(),
    );
    expect(text(h.saves.find((s) => s.slotId === "hero-1~phone")?.bytes)).toBe(
      `seed:${REVAMP}:hero-1@1080x1350`,
    );
    expect(outcome(run, "hero-1")?.status).toBe("generated");
    expect(run.usage.images).toBe(2);
  });

  it("draws nothing and claims nothing when every photo is already stored", async () => {
    const stored = [
      seedRow(REVAMP, "anchor", "anchor", 1600, 1200),
      seedRow(REVAMP, "slot", "hero-1", 2520, 1080),
      seedRow(REVAMP, "slot", "hero-1~phone", 1080, 1350),
      seedRow(REVAMP, "slot", "story-1", 1200, 1500),
      seedRow(REVAMP, "slot", "refill-0001", 1600, 1200),
      seedRow(REVAMP, "slot", "category-shakes", 1200, 1200),
    ];
    const { client, calls } = makeClient();
    const run = await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored,
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );
    expect(calls).toHaveLength(0);
    expect(h.claims).toEqual([]);
    expect(h.saves).toEqual([]);
    expect(run.usage.images).toBe(0);
  });

  describe("a refinement", () => {
    function parentShoot(refillShape: [number, number] = [1600, 1200]) {
      return [
        seedRow(PARENT, "anchor", "anchor", 1600, 1200),
        seedRow(PARENT, "slot", "hero-1", 2520, 1080),
        seedRow(PARENT, "slot", "hero-1~phone", 1080, 1350),
        seedRow(PARENT, "slot", "story-1", 1200, 1500),
        seedRow(PARENT, "slot", "refill-0001", ...refillShape),
        seedRow(PARENT, "slot", "category-shakes", 1200, 1200),
      ];
    }

    it("carries the parent's photos over and redraws only what was asked", async () => {
      // The parent's refill was square; its frame is now 4:3.
      const inherited = parentShoot([1200, 1200]);
      const { client, briefs } = makeClient();
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        {
          plan: makePlan(),
          snapshot: makeSnapshot(),
          stored: [],
          inherited,
          redraw: ["story-1"],
        },
        { imageClient: client, reviewer: null, prepare },
      );

      expect(h.adopts.sort()).toEqual(
        ["anchor", "category-shakes", "hero-1", "hero-1~phone"].sort(),
      );
      // The redrawn shot and the reshaped one, matched to the parent's anchor.
      expect(briefs().sort()).toEqual(["refill-0001", "story-1"]);
      expect(h.claims).toEqual([2]);
      expect(outcome(run, "hero-1")).toEqual({
        shotId: "hero-1",
        status: "skipped",
        reason: null,
      });
      expect(outcome(run, "category-shakes")?.status).toBe("skipped");
      expect(outcome(run, "story-1")?.status).toBe("generated");
      expect(outcome(run, "refill-0001")?.status).toBe("generated");
    });

    it("keeps everything inherited when nothing is to be redrawn", async () => {
      const { client, calls } = makeClient();
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        {
          plan: makePlan(),
          snapshot: makeSnapshot(),
          stored: [],
          inherited: parentShoot(),
          redraw: null,
        },
        { imageClient: client, reviewer: null, prepare },
      );
      expect(calls).toHaveLength(0);
      expect(h.claims).toEqual([]);
      expect(h.adopts).toHaveLength(6);
      expect(
        run.outcomes.filter((o) => o.status === "skipped" && o.reason === null),
      ).toHaveLength(4);
    });

    it("on resume still counts earlier carried-over photos and takes the parent's anchor", async () => {
      const inherited = parentShoot([1200, 1200]);
      const parentHero = inherited.find((i) => i.slotId === "hero-1")!;
      const parentCategory = inherited.find(
        (i) => i.slotId === "category-shakes",
      )!;
      // An earlier attempt adopted these two, then the runner lost its lease.
      const stored = [
        seedRow(REVAMP, "slot", "hero-1", 2520, 1080, parentHero.path),
        seedRow(
          REVAMP,
          "slot",
          "category-shakes",
          1200,
          1200,
          parentCategory.path,
        ),
      ];
      const { client, briefs } = makeClient();
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        {
          plan: makePlan(),
          snapshot: makeSnapshot(),
          stored,
          inherited,
          redraw: ["story-1"],
        },
        { imageClient: client, reviewer: null, prepare },
      );
      expect(h.adopts).toContain("anchor");
      expect(h.adopts).not.toContain("hero-1");
      expect(briefs()).not.toContain("anchor");
      expect(outcome(run, "hero-1")?.status).toBe("skipped");
      expect(outcome(run, "category-shakes")?.status).toBe("skipped");
    });
  });

  it("on a partial limit refusal draws the homepage's shots and crops the rest", async () => {
    h.claimAnswers.push(false, true);
    const { client, briefs } = makeClient();
    const run = await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );

    expect(h.claims).toEqual([5, 3]);
    expect(briefs().sort()).toEqual(["anchor", "hero-1", "refill-0001"]);
    for (const id of ["story-1", "category-shakes"]) {
      const saved = h.saves.find((s) => s.slotId === id);
      expect(saved?.review).toBe("flagged");
      // ★★ Cut from a photo of the shoot that was drawn and kept, never from
      //    the anchor (B16), even where the anchor's 4:3 fits as well.
      expect(saved?.problems).toEqual([
        REVAMP_RECROP_PROBLEM,
        "recrop-source:refill-0001",
        "recrop-cause:limit",
      ]);
      expect(text(saved?.bytes)).toMatch(/^img:refill-0001:/);
      expect(outcome(run, id)?.status).toBe("failed");
      expect(outcome(run, id)).toMatchObject({
        reason: expect.stringContaining("limit for new photographs"),
      });
    }
    expect(sum(h.releases)).toBe(0);
  });

  it("stops with limit_reached when nothing can be drawn or cropped", async () => {
    h.claimAnswers.push(false, false);
    const { client, calls } = makeClient();
    const promise = drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );
    await expect(promise).rejects.toMatchObject({
      code: "limit_reached",
      transient: false,
    });
    expect(calls).toHaveLength(0);
    expect(h.saves).toEqual([]);
  });

  describe("★★ the photo claim is kept on the job row, so a runner that dies does not take it (jobs-3)", () => {
    const input = (stored: RevampStoredImage[] = []) => ({
      plan: makePlan(),
      snapshot: makeSnapshot(),
      stored,
      inherited: [] as RevampStoredImage[],
      redraw: null,
    });

    it("gives back what a dead invocation claimed and never drew, once, before claiming again", async () => {
      // The dead runner claimed the whole shoot, drew the anchor and the
      // hero, and died: three photos of its claim were never drawn.
      const stored = [
        seedRow(REVAMP, "anchor", "anchor", 1600, 1200),
        seedRow(REVAMP, "slot", "hero-1", 2520, 1080),
      ];
      const hold = holdPort({
        units: [
          "anchor:anchor",
          "slot:hero-1",
          "slot:story-1",
          "slot:refill-0001",
          "slot:category-shakes",
        ],
      });
      const { client, briefs } = makeClient();
      await drawRevampPhotos(makeCtx(undefined, hold.port).ctx, input(stored), {
        imageClient: client,
        reviewer: null,
        prepare,
      });
      expect(briefs().sort()).toEqual([
        "category-shakes",
        "refill-0001",
        "story-1",
      ]);
      // ★ Cleared, then given back; then this invocation's own claim,
      //   recorded before anything is drawn, cleared before its give-back.
      expect(h.events).toEqual([
        "record:clear",
        "release:3",
        "claim:3",
        "record:3",
        "record:clear",
        "release:0",
      ]);
      expect(hold.writes[1]).toEqual({
        units: ["slot:story-1", "slot:refill-0001", "slot:category-shakes"],
      });
      expect(hold.current()).toBeNull();
    });

    it("records the anchor with the shots it claims, before the first picture", async () => {
      const hold = holdPort();
      let drawnUnrecorded = 0;
      const { client } = makeClient(
        () => "ok",
        () => {
          // Nothing may be drawn before the claim is on the job row.
          if (hold.writes.length === 0) drawnUnrecorded += 1;
        },
      );
      await drawRevampPhotos(makeCtx(undefined, hold.port).ctx, input(), {
        imageClient: client,
        reviewer: null,
        prepare,
      });
      expect(drawnUnrecorded).toBe(0);
      expect(hold.writes[0]).toEqual({
        units: [
          "anchor:anchor",
          "slot:hero-1",
          "slot:story-1",
          "slot:refill-0001",
          "slot:category-shakes",
        ],
      });
      expect(hold.writes.at(-1)).toBeNull();
    });

    it("★ never gives back a claim whose record another runner now owns", async () => {
      // The first write (the claim) lands; the clearing write finds the
      // lease gone: the next owner gives the claim back from the record.
      const hold = holdPort(null, [true, false]);
      const { client } = makeClient((r) =>
        r.purpose === "anchor" ? "refuse" : "ok",
      );
      await expect(
        drawRevampPhotos(makeCtx(undefined, hold.port).ctx, input(), {
          imageClient: client,
          reviewer: null,
          prepare,
        }),
      ).rejects.toMatchObject({ code: "model_refused" });
      expect(h.releases).toEqual([]);
      expect(hold.current()?.units).toHaveLength(5);
    });

    it("gives the claim straight back, drawing nothing, when it cannot be recorded", async () => {
      const hold = holdPort(null, [false]);
      const { client, calls } = makeClient();
      await expect(
        drawRevampPhotos(makeCtx(undefined, hold.port).ctx, input(), {
          imageClient: client,
          reviewer: null,
          prepare,
        }),
      ).rejects.toMatchObject({ transient: true });
      expect(calls).toHaveLength(0);
      expect(h.events).toEqual(["claim:5", "record:5", "release:5"]);
    });

    it("★ claims nothing over a dead invocation's record it could not clear", async () => {
      // Claiming would write this invocation's claim over the old record,
      // and whatever the dead runner never drew would never be given back.
      const hold = holdPort({ units: ["anchor:anchor", "slot:hero-1"] }, [
        false,
      ]);
      const { client, calls } = makeClient();
      await expect(
        drawRevampPhotos(makeCtx(undefined, hold.port).ctx, input(), {
          imageClient: client,
          reviewer: null,
          prepare,
        }),
      ).rejects.toMatchObject({ transient: true });
      expect(calls).toHaveLength(0);
      expect(h.events).toEqual(["record:clear"]);
      expect(hold.current()?.units).toEqual(["anchor:anchor", "slot:hero-1"]);
    });

    it("settles a dead invocation's claim even when nothing is left to draw", async () => {
      const stored = [
        seedRow(REVAMP, "anchor", "anchor", 1600, 1200),
        seedRow(REVAMP, "slot", "hero-1", 2520, 1080),
        seedRow(REVAMP, "slot", "hero-1~phone", 1080, 1350),
        seedRow(REVAMP, "slot", "story-1", 1200, 1500),
        seedRow(REVAMP, "slot", "refill-0001", 1600, 1200),
        seedRow(REVAMP, "slot", "category-shakes", 1200, 1200),
      ];
      // It drew everything it claimed and died before clearing the record.
      const hold = holdPort({
        units: ["slot:story-1", "slot:refill-0001"],
      });
      const { client, calls } = makeClient();
      await drawRevampPhotos(makeCtx(undefined, hold.port).ctx, input(stored), {
        imageClient: client,
        reviewer: null,
        prepare,
      });
      expect(calls).toHaveLength(0);
      expect(h.events).toEqual(["record:clear", "release:0"]);
      expect(hold.current()).toBeNull();
    });
  });

  describe("★★ the platform's hourly ceiling is waited out, never the store's daily limit (jobs-2)", () => {
    const input = () => ({
      plan: makePlan(),
      snapshot: makeSnapshot(),
      stored: [] as RevampStoredImage[],
      inherited: [] as RevampStoredImage[],
      redraw: null,
    });

    it("parks the step for a later claim when the hour refuses the whole shoot", async () => {
      h.claimAnswers.push("mink-revamp-photos-hour");
      const { client, calls } = makeClient();
      const error = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: client,
        reviewer: null,
        prepare,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampRetryLaterError);
      expect(error).toMatchObject({
        code: "photos_unavailable",
        transient: true,
        retryAfterMs: REVAMP_PHOTO_SERVICE_RETRY_MS,
      });
      // ★ The store's own allowance is not what refused: no homepage-only
      //   fallback, no crops, nothing drawn, nothing claimed to give back.
      expect(h.claims).toEqual([5]);
      expect(calls).toHaveLength(0);
      expect(h.saves).toEqual([]);
      expect(sum(h.releases)).toBe(0);
    });

    it("parks too when the hour refuses the homepage's shots after the day refused the rest", async () => {
      h.claimAnswers.push(false, "mink-revamp-photos-hour");
      const { client, calls } = makeClient();
      const error = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: client,
        reviewer: null,
        prepare,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "photos_unavailable",
        transient: true,
        retryAfterMs: REVAMP_PHOTO_SERVICE_RETRY_MS,
      });
      expect(h.claims).toEqual([5, 3]);
      expect(calls).toHaveLength(0);
      expect(h.saves).toEqual([]);
    });

    it("a resumed shoot waits rather than cropping its missing shots for the hour", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const hero = seedRow(REVAMP, "slot", "hero-1", 2520, 1080);
      h.claimAnswers.push("mink-revamp-photos-hour");
      const { client, calls } = makeClient();
      const error = await drawRevampPhotos(
        makeCtx().ctx,
        { ...input(), stored: [anchor, hero] },
        { imageClient: client, reviewer: null, prepare },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampRetryLaterError);
      expect(calls).toHaveLength(0);
      expect(h.saves).toEqual([]);
    });
  });

  describe("★★ the deadline drains the shoot instead of cutting its paid calls (jobs-4)", () => {
    const input = (stored: RevampStoredImage[] = []) => ({
      plan: makePlan(),
      snapshot: makeSnapshot(),
      stored,
      inherited: [] as RevampStoredImage[],
      redraw: null,
    });
    /** A context whose deadline drain the test starts, as the runner would. */
    function drainingCtx(photoHold?: RevampStepContext["photoHold"]) {
      const drain = new AbortController();
      const { ctx, report } = makeCtx(undefined, photoHold);
      return { ctx: { ...ctx, draining: drain.signal }, drain, report };
    }
    /** What this revamp holds, as the next invocation is handed it. */
    const storedRows = (): RevampStoredImage[] =>
      [...h.rows.values()].filter((row) => row.revampId === REVAMP);
    /** The client, with the deadline passing while hero-1 is being drawn. */
    const deadlineDuringHero = (drain: AbortController) =>
      makeClient(
        () => "ok",
        (request) => {
          if (request.briefId === "hero-1") drain.abort();
        },
      );

    it("★★ starts no new draw once draining, stores the draw in flight, and gives the rest back", async () => {
      const hold = holdPort();
      const { ctx, drain, report } = drainingCtx(hold.port);
      const { client, briefs } = deadlineDuringHero(drain);
      const error = await drawRevampPhotos(ctx, input(), {
        imageClient: client,
        reviewer: null,
        prepare,
        concurrency: 1,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampDrainedError);
      // The hero was on the wire at the deadline, billed, so it finished;
      // nothing after it reached the image model.
      expect(briefs()).toEqual(["anchor", "hero-1"]);
      expect(savedSlots().sort()).toEqual(
        ["anchor", "hero-1", "hero-1~phone"].sort(),
      );
      // ★ The shots never started are the next run's, never crops of the shoot.
      expect(h.saves.some((s) => s.review === "flagged")).toBe(false);
      // The anchor and the hero were drawn; the three never started go back,
      // once the record is cleared.
      expect(h.events).toEqual([
        "claim:5",
        "record:5",
        "record:clear",
        "release:3",
      ]);
      expect(hold.current()).toBeNull();
      // The card's count follows what was drawn, not what was given up.
      expect(report.mock.calls.at(-1)?.[0]).toBe("1 of 4");
    });

    it("★ the next run draws only what the drain left, matched to the anchor already stored", async () => {
      const { ctx, drain } = drainingCtx();
      const first = deadlineDuringHero(drain);
      await drawRevampPhotos(ctx, input(), {
        imageClient: first.client,
        reviewer: null,
        prepare,
        concurrency: 1,
      }).catch(() => undefined);

      const second = makeClient();
      const run = await drawRevampPhotos(makeCtx().ctx, input(storedRows()), {
        imageClient: second.client,
        reviewer: null,
        prepare,
      });
      expect(second.briefs().sort()).toEqual(
        ["category-shakes", "refill-0001", "story-1"].sort(),
      );
      // No second anchor, and only the three left are claimed again.
      expect(h.claims).toEqual([5, 3]);
      expect(outcome(run, "hero-1")?.status).toBe("generated");
      expect(run.outcomes.filter((o) => o.status === "failed")).toEqual([]);
      expect(run.images.filter((i) => i.role === "slot")).toHaveLength(5);
    });

    it("★ starts no review once draining: the photo drawn in flight is parked for the next run to check", async () => {
      const { ctx, drain } = drainingCtx();
      const reviews: unknown[] = [];
      const reviewClient: ThemeStudioModelClient = {
        provider: "fake",
        async generate(request) {
          reviews.push(request);
          return {
            kind: "ok",
            usage: ZERO_USAGE,
            value: { problems: [], note: "" },
          };
        },
      };
      const reviewer = { client: reviewClient, providerModel: "fake" };
      const heroOnly = (stored: RevampStoredImage[] = []) => ({
        ...input(stored),
        plan: makePlan({ bindings: [BINDINGS[0]] }),
      });
      const { client } = deadlineDuringHero(drain);
      // One shot only, so no draw is left over: only the review that was not
      // started can make the step hand over.
      const error = await drawRevampPhotos(ctx, heroOnly(), {
        imageClient: client,
        reviewer,
        prepare,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampDrainedError);
      // The anchor was checked before the deadline; the hero was not.
      expect(reviews).toHaveLength(1);
      // ★★ Stored, since it is paid for, but parked where no section reads
      //   it: a photo is never the shot's before its review (L2-I).
      expect(h.saves.find((s) => s.slotId === "hero-1~review")).toMatchObject({
        review: "unreviewed",
        problems: ["review-pending"],
      });
      expect(savedSlots()).not.toContain("hero-1");
      expect(savedSlots()).not.toContain("hero-1~phone");

      // The next run starts with it: reviewed, then the shot's own.
      const next = await drawRevampPhotos(
        makeCtx().ctx,
        heroOnly(storedRows()),
        { imageClient: makeClient().client, reviewer, prepare },
      );
      expect(reviews).toHaveLength(2);
      expect(h.adopts).toEqual(["hero-1"]);
      expect(next.images.find((i) => i.slotId === "hero-1")?.review).toBe(
        "passed",
      );
      expect(next.images.map((i) => i.slotId).sort()).toEqual([
        "anchor",
        "hero-1",
        "hero-1~phone",
      ]);
    });

    it("★ a draw the image client held back at the deadline is left for the next run, never cropped", async () => {
      const { ctx, drain } = drainingCtx();
      const seen: string[] = [];
      const client: ThemeStudioImageClient = {
        provider: "fake",
        async generateImage(request) {
          seen.push(request.briefId);
          if (request.briefId === "story-1") {
            // Its permit came after the deadline, so the client never sent it.
            drain.abort();
            return {
              kind: "error",
              code: "cancelled",
              usage: ZERO_IMAGE_USAGE,
            };
          }
          return {
            kind: "ok",
            bytes: new Uint8Array(Buffer.from(`img:${request.briefId}`)),
            mediaType: "image/png",
            usage: ZERO_IMAGE_USAGE,
          };
        },
      };
      // The hero and the story only, the story drawn last.
      const error = await drawRevampPhotos(
        ctx,
        { ...input(), plan: makePlan({ bindings: BINDINGS.slice(0, 3) }) },
        { imageClient: client, reviewer: null, prepare, concurrency: 1 },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampDrainedError);
      expect(seen).toEqual(["anchor", "hero-1", "story-1"]);
      expect(savedSlots()).not.toContain("story-1");
      // Anchor and hero drawn; the story was never sent, so it goes back.
      expect(h.claims).toEqual([3]);
      expect(sum(h.releases)).toBe(1);
    });

    it("claims nothing when the drain began before the first draw", async () => {
      const hold = holdPort();
      const { ctx, drain } = drainingCtx(hold.port);
      drain.abort();
      const { client, calls } = makeClient();
      const error = await drawRevampPhotos(ctx, input(), {
        imageClient: client,
        reviewer: null,
        prepare,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampDrainedError);
      expect(calls).toHaveLength(0);
      expect(h.events).toEqual([]);
    });

    it("finishes during the drain when nothing is left to draw: a crop is not a paid call", async () => {
      const stored = [
        seedRow(REVAMP, "anchor", "anchor", 1600, 1200),
        seedRow(REVAMP, "slot", "hero-1", 2520, 1080),
        seedRow(REVAMP, "slot", "story-1", 1200, 1500),
        seedRow(REVAMP, "slot", "refill-0001", 1600, 1200),
        seedRow(REVAMP, "slot", "category-shakes", 1200, 1200),
      ];
      const { ctx, drain } = drainingCtx();
      drain.abort();
      const { client, calls } = makeClient();
      const run = await drawRevampPhotos(ctx, input(stored), {
        imageClient: client,
        reviewer: null,
        prepare,
      });
      expect(calls).toHaveLength(0);
      expect(savedSlots()).toEqual(["hero-1~phone"]);
      expect(outcome(run, "hero-1")?.status).toBe("generated");
    });

    describe("★★ no call the hard stop could cut off is admitted (D2)", () => {
      /** When a call with this clock may last be admitted. */
      const lastAdmission = (deadline: number, clockMs: number) =>
        deadline +
        REVAMP_LIMITS.deadlineGraceMs -
        clockMs -
        REVAMP_LIMITS.hardStopMarginMs;

      it("★★ a photo check's 75 s clock fits after the drain: the drain itself admits it", () => {
        const { ctx } = drainingCtx();
        expect(
          IMAGE_REVIEW_TRY_TIMEOUT_MS + REVAMP_LIMITS.hardStopMarginMs,
        ).toBeLessThanOrEqual(REVAMP_LIMITS.deadlineGraceMs);
        expect(revampAdmissionDrain(ctx, IMAGE_REVIEW_TRY_TIMEOUT_MS)).toBe(
          ctx.draining,
        );
        // A step run on its own never drains.
        expect(
          revampAdmissionDrain(makeCtx().ctx, IMAGE_REQUEST_TIMEOUT_MS),
        ).toBeUndefined();
      });

      it("★★ a shoot photo's 180 s clock does not fit the 90 s grace: its draws close 95 s before the drain", async () => {
        vi.useFakeTimers();
        try {
          const { ctx, drain } = drainingCtx();
          const closes = lastAdmission(ctx.deadline, IMAGE_REQUEST_TIMEOUT_MS);
          expect(ctx.deadline - closes).toBe(95_000);
          const draws = revampAdmissionDrain(ctx, IMAGE_REQUEST_TIMEOUT_MS)!;
          await vi.advanceTimersByTimeAsync(closes - Date.now() - 1);
          expect(draws.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(draws.aborted).toBe(true);
          // ★ The runner's own drain has not begun.
          expect(drain.signal.aborted).toBe(false);
          // Already past, it is closed at once; the drain closes it too.
          expect(
            revampAdmissionDrain(
              { ...ctx, deadline: Date.now() },
              IMAGE_REQUEST_TIMEOUT_MS,
            )?.aborted,
          ).toBe(true);
          const early = drainingCtx();
          const closing = revampAdmissionDrain(
            early.ctx,
            IMAGE_REQUEST_TIMEOUT_MS,
          )!;
          early.drain.abort();
          expect(closing.aborted).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      });

      it("★★ a draw still being drawn when the shoot's drain closes finishes and is kept; the rest are left for the next run, as at the drain", async () => {
        vi.useFakeTimers();
        try {
          const hold = holdPort();
          const { ctx, drain } = drainingCtx(hold.port);
          // The shoot's drain closes a second from now.
          const deadline =
            Date.now() + 1_000 - lastAdmission(0, IMAGE_REQUEST_TIMEOUT_MS);
          const seen: string[] = [];
          const client: ThemeStudioImageClient = {
            provider: "fake",
            async generateImage(request) {
              seen.push(request.briefId);
              // On the wire when the shoot's drain closes.
              if (request.briefId === "hero-1") {
                await new Promise((resolve) => setTimeout(resolve, 2_000));
              }
              return {
                kind: "ok",
                bytes: new Uint8Array(Buffer.from(`img:${request.briefId}`)),
                mediaType: "image/png",
                usage: ZERO_IMAGE_USAGE,
              };
            },
          };
          const pending = drawRevampPhotos({ ...ctx, deadline }, input(), {
            imageClient: client,
            reviewer: null,
            prepare,
            concurrency: 1,
          }).catch((e: unknown) => e);
          await vi.advanceTimersByTimeAsync(2_000);
          expect(await pending).toBeInstanceOf(RevampDrainedError);
          expect(drain.signal.aborted).toBe(false);
          // Nothing reached the image model after the hero.
          expect(seen).toEqual(["anchor", "hero-1"]);
          expect(savedSlots()).toEqual(
            expect.arrayContaining(["anchor", "hero-1"]),
          );
          // ★ Never sent, never billed: the three left go back with the claim.
          expect(h.events).toEqual([
            "claim:5",
            "record:5",
            "record:clear",
            "release:3",
          ]);
        } finally {
          vi.useRealTimers();
        }
      });

      it("★ a draw the client held back once the shoot's drain closed is left for the next run, never cropped", async () => {
        vi.useFakeTimers();
        try {
          const { ctx, drain } = drainingCtx();
          const deadline =
            Date.now() + 1_000 - lastAdmission(0, IMAGE_REQUEST_TIMEOUT_MS);
          const client: ThemeStudioImageClient = {
            provider: "fake",
            async generateImage(request) {
              if (request.briefId === "story-1") {
                // Its turn came after the shoot's drain closed: never sent.
                await new Promise((resolve) => setTimeout(resolve, 2_000));
                return {
                  kind: "error",
                  code: "cancelled",
                  usage: ZERO_IMAGE_USAGE,
                };
              }
              return {
                kind: "ok",
                bytes: new Uint8Array(Buffer.from(`img:${request.briefId}`)),
                mediaType: "image/png",
                usage: ZERO_IMAGE_USAGE,
              };
            },
          };
          const pending = drawRevampPhotos(
            { ...ctx, deadline },
            { ...input(), plan: makePlan({ bindings: BINDINGS.slice(0, 3) }) },
            { imageClient: client, reviewer: null, prepare, concurrency: 1 },
          ).catch((e: unknown) => e);
          await vi.advanceTimersByTimeAsync(2_000);
          expect(await pending).toBeInstanceOf(RevampDrainedError);
          expect(drain.signal.aborted).toBe(false);
          expect(savedSlots()).not.toContain("story-1");
          expect(h.saves.some((s) => s.review === "flagged")).toBe(false);
          expect(h.claims).toEqual([3]);
          expect(sum(h.releases)).toBe(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("★ claims nothing when the shoot's drain closed before the step began", async () => {
        const { ctx } = drainingCtx();
        const { client, calls } = makeClient();
        const error = await drawRevampPhotos(
          { ...ctx, deadline: Date.now() + 60_000 },
          input(),
          { imageClient: client, reviewer: null, prepare },
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RevampDrainedError);
        expect(calls).toHaveLength(0);
        expect(h.claims).toEqual([]);
      });
    });

    describe("the Vertex clients", () => {
      const request: ThemeImageRequest = {
        purpose: "hero",
        briefId: "hero-1",
        aspectRatio: "21:9",
        prompt: "A photograph of almond shakes on a sunlit counter.",
        references: [],
      };
      const imageConfig = {
        projectId: "project",
        location: "global",
        modelKey: "gemini-nano-banana-2.1",
        providerModel: "gemini-nano-banana-2.1",
      } as const;
      /** The redesign's photo request (defaultImageClient). */
      const draw = {
        imageSize: "2K",
        thinkingLevel: ThinkingLevel.MEDIUM,
      } as const;
      /** A provider answer carrying one JPEG. */
      const imageAnswer = {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  inlineData: {
                    data: Buffer.from("jpeg").toString("base64"),
                    mimeType: "image/jpeg",
                  },
                },
              ],
            },
          },
        ],
      };
      /** A shared capacity whose next permit the test hands out. */
      function heldCapacity() {
        let admit!: () => void;
        const turn = new Promise<void>((resolve) => {
          admit = resolve;
        });
        const permit = (signal: AbortSignal): ProviderPermit => ({
          signal,
          succeeded() {},
          async rateLimited() {},
        });
        const capacity: ProviderCapacity = {
          run: async (operation, signal) => {
            await turn;
            return operation(permit(signal));
          },
        };
        return { capacity, admit };
      }
      const realImageClient = async () =>
        (
          await vi.importActual<
            typeof import("@/lib/theme-studio/image-vertex")
          >("@/lib/theme-studio/image-vertex")
        ).createVertexImageClient;

      it("★★ never sends a draw that gets its permit after the deadline, and it reads as not drawn", async () => {
        const createClient = await realImageClient();
        const drain = new AbortController();
        const held = heldCapacity();
        const sent: string[] = [];
        const client = createClient(imageConfig, {
          ...draw,
          capacity: revampDrainingCapacity(held.capacity, drain.signal),
          pool: new ImageRequestPool(),
          send: async (sending) => {
            sent.push(sending.briefId);
            return imageAnswer as never;
          },
        });
        const answer = client.generateImage(
          request,
          new AbortController().signal,
        );
        // The deadline passes while the draw waits behind other stores' draws.
        drain.abort();
        held.admit();
        await expect(answer).resolves.toMatchObject({
          kind: "error",
          code: "cancelled",
        });
        expect(sent).toEqual([]);
      });

      it("lets a draw already sent at the deadline finish", async () => {
        const createClient = await realImageClient();
        const drain = new AbortController();
        const held = heldCapacity();
        const sent: string[] = [];
        let respond!: () => void;
        const responded = new Promise<void>((resolve) => {
          respond = resolve;
        });
        const client = createClient(imageConfig, {
          ...draw,
          capacity: revampDrainingCapacity(held.capacity, drain.signal),
          pool: new ImageRequestPool(),
          send: async (sending) => {
            sent.push(sending.briefId);
            // On the wire, and billed, when the deadline passes.
            drain.abort();
            await responded;
            return imageAnswer as never;
          },
        });
        const answer = client.generateImage(
          request,
          new AbortController().signal,
        );
        held.admit();
        await vi.waitFor(() => expect(sent).toEqual(["hero-1"]));
        respond();
        await expect(answer).resolves.toMatchObject({ kind: "ok" });
      });

      it("★★ a draw waiting for its paced start at the deadline is never admitted, so it takes no start from the others on the model", async () => {
        const createClient = await realImageClient();
        const drain = new AbortController();
        const claims: string[] = [];
        // The image key's next start is 40 s away for every claim.
        const store: CapacityStore = {
          async claim(_key, id) {
            claims.push(id);
            return { retryAfterMs: 40_000 };
          },
          async renew() {
            return true;
          },
          async release() {},
          async pause() {},
        };
        const sent: string[] = [];
        const client = createClient(imageConfig, {
          ...draw,
          capacity: revampDrainingCapacity(
            coordinatedProviderCapacity(store, "key", {
              pacing: IMAGE_START_PACING,
            }),
            drain.signal,
          ),
          pool: new ImageRequestPool(),
          send: async (sending) => {
            sent.push(sending.briefId);
            return imageAnswer as never;
          },
        });
        const answer = client.generateImage(
          request,
          new AbortController().signal,
        );
        await vi.waitFor(() => expect(claims).toHaveLength(1));
        // The runner drains with its own halt, which is no abort by name.
        drain.abort(new Error("revamp halted: deadline"));
        // ★ Not drawn, and read as such: never an outage that may have billed.
        await expect(answer).resolves.toMatchObject({
          kind: "error",
          code: "cancelled",
        });
        // ★★ It stopped waiting at once and never claimed again, so the
        //   key's next start is not stamped for a photo nobody sends.
        expect(claims).toHaveLength(1);
        expect(sent).toEqual([]);
      });

      it("★ keeps a sent call's own failure at the deadline, and a wait the drain ended reads as not sent", async () => {
        const drain = new AbortController();
        const halted = new Error("revamp halted: deadline");
        const failure = Object.assign(new Error("Resource exhausted"), {
          status: 429,
        });
        const sending: ProviderCapacity = {
          run: (operation, signal) =>
            operation({ signal, succeeded() {}, async rateLimited() {} }),
        };
        // On the wire when the drain begins: its 429 is its own, not "not sent".
        await expect(
          revampDrainingCapacity(sending, drain.signal).run(async () => {
            drain.abort(halted);
            throw failure;
          }, new AbortController().signal),
        ).rejects.toBe(failure);
        // A wait the capacity's admission ended, in the drain's own words.
        const later = new AbortController();
        const waiting: ProviderCapacity = {
          run: (_operation, _signal, options) =>
            new Promise((_resolve, reject) => {
              options?.admission?.addEventListener(
                "abort",
                () => reject(options.admission?.reason),
                { once: true },
              );
            }),
        };
        const pending = revampDrainingCapacity(waiting, later.signal).run(
          async () => "sent",
          new AbortController().signal,
        );
        later.abort(halted);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      });

      it("is the shared capacity itself when nothing drains", () => {
        const held = heldCapacity();
        expect(revampDrainingCapacity(held.capacity, undefined)).toBe(
          held.capacity,
        );
      });

      it("★ the photos step builds both Vertex clients on the draining capacity and 429 wait", async () => {
        vi.stubEnv("MINK_REVAMP_PROVIDER", "vertex");
        h.imageConfig = imageConfig;
        h.vertexConfig = { projectId: "project", region: "global" };
        h.sharedCapacity = {
          run: (operation, signal) =>
            operation({ signal, succeeded() {}, async rateLimited() {} }),
        };
        const drain = new AbortController();
        const { ctx } = makeCtx();
        const reported: RevampUsage[] = [];
        // The mocked image client answers the anchor as an outage, so the
        // step stops; only how it built its clients is under test.
        await drawRevampPhotos(
          { ...ctx, draining: drain.signal },
          { ...input(), onUsage: (usage: RevampUsage) => reported.push(usage) },
          { prepare },
        ).catch(() => undefined);
        expect(h.vertexImageOptions).toHaveLength(1);
        expect(h.vertexReviewOptions).toHaveLength(1);
        // ★★ Owner, 25 Oct 2026: a redesign's photos at 2K, MEDIUM thinking.
        expect(h.vertexImageOptions[0]).toMatchObject({
          imageSize: "2K",
          thinkingLevel: ThinkingLevel.MEDIUM,
          // ★★ D3: a draw the run's stop cuts off on the wire says so.
          markStoppedInFlight: true,
        });
        // ★ Each 429 the review client waits out and tries again is counted
        //   against the review model (P0).
        const before = reported.length;
        (h.vertexReviewOptions[0].onRetry as () => void)();
        expect(reported.slice(before)).toEqual([
          {
            ...ZERO_REVAMP_USAGE,
            calls: { "gemini-3.8-flash": { rateLimited: 1, timeouts: 0 } },
          },
        ]);

        // ★★ TS-3D: the reviewer knows each location's capacity, so each
        //   check goes to the US first and to global after, on its own row
        //   and on the redesigns' 75 s clock; never one capacity for both.
        const review = h.vertexReviewOptions[0];
        expect(review.capacity).toBeUndefined();
        expect(review.imageReviewTryTimeoutMs).toBe(75_000);
        const reviewAt = review.capacityAt as (
          model: string,
          location: string,
        ) => ProviderCapacity;
        h.sharedCapacityCalls.length = 0;
        const reviewCapacities = ["us", "global"].map((location) =>
          reviewAt("gemini-3.8-flash", location),
        );
        expect(h.sharedCapacityCalls).toEqual([
          ["project", "us", "gemini-3.8-flash"],
          ["project", "global", "gemini-3.8-flash"],
        ]);

        drain.abort();
        const imageCapacity = h.vertexImageOptions[0]
          .capacity as ProviderCapacity;
        // ★ The drain wraps BOTH locations' capacity: a check whose turn
        //   comes after it is sent from neither.
        for (const capacity of [imageCapacity, ...reviewCapacities]) {
          const operation = vi.fn(async () => "sent");
          await expect(
            capacity.run(operation, new AbortController().signal),
          ).rejects.toMatchObject({ name: "AbortError" });
          expect(operation).not.toHaveBeenCalled();
        }
        // ★ A 429 wait ends at the drain: the retry after it would not be sent.
        for (const options of [
          h.vertexImageOptions[0],
          h.vertexReviewOptions[0],
        ]) {
          const sleep = options.sleep as (
            ms: number,
            signal?: AbortSignal,
          ) => Promise<boolean>;
          await expect(
            sleep(60_000, new AbortController().signal),
          ).resolves.toBe(false);
        }
      });

      it("★★ D2: the image client is built on the shoot's drain: its turns and 429 waits end 95 s before the runner's drain, a check's at the drain", async () => {
        vi.useFakeTimers();
        try {
          vi.stubEnv("MINK_REVAMP_PROVIDER", "vertex");
          h.imageConfig = imageConfig;
          h.vertexConfig = { projectId: "project", region: "global" };
          h.sharedCapacity = {
            run: (operation, signal) =>
              operation({ signal, succeeded() {}, async rateLimited() {} }),
          };
          const drain = new AbortController();
          const { ctx } = makeCtx();
          // The mocked image client answers the anchor as an outage, so the
          // step stops; only how it built its clients is under test.
          await drawRevampPhotos({ ...ctx, draining: drain.signal }, input(), {
            prepare,
          }).catch(() => undefined);
          const image = h.vertexImageOptions[0];
          const capacity = image.capacity as ProviderCapacity;
          const sleep = image.sleep as (
            ms: number,
            signal?: AbortSignal,
          ) => Promise<boolean>;
          const check = (
            h.vertexReviewOptions[0].capacityAt as (
              model: string,
              location: string,
            ) => ProviderCapacity
          )("gemini-3.8-flash", "us");
          const run = (on: ProviderCapacity) =>
            on.run(async () => "sent", new AbortController().signal);
          await expect(run(capacity)).resolves.toBe("sent");
          // The shoot's drain closes, 95 s before the runner's.
          await vi.advanceTimersByTimeAsync(ctx.deadline - 95_000 - Date.now());
          expect(drain.signal.aborted).toBe(false);
          await expect(run(capacity)).rejects.toMatchObject({
            name: "AbortError",
          });
          await expect(
            sleep(60_000, new AbortController().signal),
          ).resolves.toBe(false);
          // ★ A photo check's 75 s clock still fits: admitted until the drain.
          await expect(run(check)).resolves.toBe("sent");
          drain.abort();
          await expect(run(check)).rejects.toMatchObject({
            name: "AbortError",
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it("★★ TS-3D: with the real review client, a check waiting for its turn at the US stops at the drain and is never sent to global", async () => {
        vi.stubEnv("MINK_REVAMP_PROVIDER", "vertex");
        h.imageConfig = imageConfig;
        h.vertexConfig = { projectId: "project", region: "global" };
        // No row ever gives a turn: only a stop or the drain's admission
        // signal (the shared capacity's `admission`) ends the wait, so
        // nothing can reach Google from this test.
        const waits: string[] = [];
        h.sharedCapacity = {
          run: (_operation, signal, options) => {
            waits.push("wait");
            return new Promise((_resolve, reject) => {
              const stop = options?.admission
                ? AbortSignal.any([signal, options.admission])
                : signal;
              stop.addEventListener("abort", () => reject(stop.reason), {
                once: true,
              });
            });
          },
        };
        const drain = new AbortController();
        const { ctx } = makeCtx();
        // The mocked image client answers the anchor as an outage, so the
        // step stops; it is run only to build the reviewer's options.
        await drawRevampPhotos({ ...ctx, draining: drain.signal }, input(), {
          prepare,
        }).catch(() => undefined);
        expect(h.vertexReviewOptions).toHaveLength(1);
        const { createVertexModelClient } = await vi.importActual<
          typeof import("@/lib/theme-studio/gemini-vertex")
        >("@/lib/theme-studio/gemini-vertex");
        const client = createVertexModelClient(
          { projectId: "project", region: "global" },
          h.vertexReviewOptions[0] as Parameters<
            typeof createVertexModelClient
          >[1],
        );
        h.sharedCapacityCalls.length = 0;
        const check: StructuredRequest = {
          stage: "image_review",
          modelKey: "gemini-3.8-flash",
          providerModel: "gemini-3.8-flash-preview",
          system: "system",
          content: [{ type: "text", text: "check" }],
          schema: {},
          effort: "high",
        };
        const answer = client.generate(check, new AbortController().signal);
        await vi.waitFor(() => expect(waits).toHaveLength(1));
        drain.abort(new Error("revamp halted: deadline"));
        // ★ Not sent, and read as such: never an outage that goes on to global.
        await expect(answer).resolves.toMatchObject({
          kind: "error",
          code: "cancelled",
        });
        expect(waits).toHaveLength(1);
        expect(h.sharedCapacityCalls).toEqual([
          ["project", "us", "gemini-3.8-flash-preview"],
        ]);
      });
    });
  });

  describe("★★ a photo is the shot's only once its review has spoken (L2-I)", () => {
    /** The hero alone: one shot, with a phone crop. */
    const input = (stored: RevampStoredImage[] = []) => ({
      plan: makePlan({ bindings: [BINDINGS[0]] }),
      snapshot: makeSnapshot(),
      stored,
      inherited: [] as RevampStoredImage[],
      redraw: null,
    });
    const storedRows = (): RevampStoredImage[] =>
      [...h.rows.values()].filter((row) => row.revampId === REVAMP);
    const parkedRow = () => h.rows.get(`${REVAMP}|slot|hero-1~review`);
    const heroSeen = (seen: Array<{ candidate: string }>) =>
      seen.filter((r) => !r.candidate.startsWith("img:anchor"));

    it("★★ asks an unavailable review again after 15 s and 30 s, and a pass makes the photo the shot's own", async () => {
      const { reviewer, seen } = makeReviewer(
        heroReviews("outage", "outage", []),
      );
      const { sleep, waits } = recordingSleep();
      const { client } = makeClient();
      const run = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: client,
        reviewer,
        prepare,
        sleep,
      });

      // Parked first, where no section reads it: never the shot's before a
      // verdict, even for the length of one wait.
      expect(h.saves.find((s) => s.slotId === "hero-1~review")).toMatchObject({
        review: "unreviewed",
        problems: ["review-pending"],
      });
      expect(savedSlots()).not.toContain("hero-1");
      // Asked again after the first two of the three waits (P0).
      expect(waits).toHaveLength(2);
      expect(waits[0]).toBeGreaterThan(REVAMP_REVIEW_RETRY_DELAYS_MS[0] - 1000);
      expect(waits[0]).toBeLessThanOrEqual(REVAMP_REVIEW_RETRY_DELAYS_MS[0]);
      expect(waits[1]).toBeGreaterThan(REVAMP_REVIEW_RETRY_DELAYS_MS[1] - 1000);
      expect(waits[1]).toBeLessThanOrEqual(REVAMP_REVIEW_RETRY_DELAYS_MS[1]);
      expect(REVAMP_REVIEW_RETRY_DELAYS_MS).toEqual([15_000, 30_000, 60_000]);
      expect(heroSeen(seen)).toHaveLength(3);
      // Then made the shot's own: the same object, now passed.
      expect(h.adopts).toEqual(["hero-1"]);
      const hero = run.images.find((i) => i.slotId === "hero-1");
      expect(hero).toMatchObject({ review: "passed", path: parkedRow()?.path });
      // ★ Its phone crop is cut from the picture the model drew (L2-D).
      expect(
        text(h.saves.find((s) => s.slotId === "hero-1~phone")?.bytes),
      ).toBe("img:hero-1:2@1080x1350");
      expect(run.images.map((i) => i.slotId).sort()).toEqual([
        "anchor",
        "hero-1",
        "hero-1~phone",
      ]);
      expect(outcome(run, "hero-1")?.status).toBe("generated");
      expect(run.usage.reviews).toBe(4);
    });

    it("★★ never shows a photo its delayed review blocks: a crop of the shoot stands in", async () => {
      // The hero's checks answer in turn; the homepage's other photo passes.
      let heroTurn = 0;
      const heroAnswers: ReviewAnswer[] = ["outage", ["text_or_logo"]];
      const { reviewer } = makeReviewer((candidate) =>
        candidate.startsWith("img:hero-1")
          ? heroAnswers[Math.min(heroTurn++, heroAnswers.length - 1)]
          : [],
      );
      const { sleep, waits } = recordingSleep();
      const { client } = makeClient();
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        {
          ...input(),
          plan: makePlan({ bindings: [BINDINGS[0], BINDINGS[3]] }),
        },
        { imageClient: client, reviewer, prepare, sleep },
      );
      const parked = parkedRow()!;
      expect(waits).toHaveLength(1);
      expect(h.adopts).toEqual([]);
      // ★★ The shot's photo is a crop of the shoot's kept photo, never the
      //    blocked picture and never the anchor (B16).
      expect(h.saves.find((s) => s.slotId === "hero-1")).toMatchObject({
        review: "flagged",
        problems: [
          REVAMP_RECROP_PROBLEM,
          "recrop-source:refill-0001",
          "recrop-cause:rejected",
        ],
      });
      expect(text(h.saves.find((s) => s.slotId === "hero-1")?.bytes)).toMatch(
        /^img:refill-0001:/,
      );
      expect(run.images.some((i) => i.sha256 === parked.sha256)).toBe(false);
      expect(
        text(h.saves.find((s) => s.slotId === "hero-1~phone")?.bytes),
      ).not.toContain("img:hero-1");
      expect(outcome(run, "hero-1")).toEqual({
        shotId: "hero-1",
        status: "failed",
        reason: expect.stringContaining("did not pass Mink AI's own check"),
      });
    });

    it("★★ with no kept photo to crop from, a blocked photo stops the step for good: the anchor never stands in (B16)", async () => {
      const { reviewer } = makeReviewer(
        heroReviews("outage", ["text_or_logo"]),
      );
      const { sleep } = recordingSleep();
      const error = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: makeClient().client,
        reviewer,
        prepare,
        sleep,
      }).catch((e: unknown) => e);
      // ★ Not transient: the parked photo is never drawn again, so a later
      //   invocation would find the same nothing until the job's ceiling.
      // ★★ Its own code, so the card says the photographs did not pass their
      //   checks rather than that the photo service was busy.
      expect(error).toBeInstanceOf(RevampStepError);
      expect(error).toMatchObject({
        code: "photos_failed",
        transient: false,
      });
      expect(savedSlots()).not.toContain("hero-1");
      expect(
        h.saves.some((s) => s.problems.includes("recrop-source:anchor")),
      ).toBe(false);
    });

    it("★★ waits instead when a blocked photo is missing beside a shot that can still be drawn", async () => {
      // The hero's parked photo is blocked by its delayed check, and the
      // other shot's draw is an outage, so nothing is kept to crop from.
      // ★ Once a later invocation draws that shot, the hero can be cropped
      //   from it: one shot still drawable keeps the step waiting.
      let heroTurn = 0;
      const heroAnswers: ReviewAnswer[] = ["outage", ["text_or_logo"]];
      const { reviewer } = makeReviewer((candidate) =>
        candidate.startsWith("img:hero-1")
          ? heroAnswers[Math.min(heroTurn++, heroAnswers.length - 1)]
          : [],
      );
      const { sleep } = recordingSleep();
      const { client } = makeClient((r) =>
        r.briefId.startsWith("refill-0001") ? "outage" : "ok",
      );
      const error = await drawRevampPhotos(
        makeCtx().ctx,
        {
          ...input(),
          plan: makePlan({ bindings: [BINDINGS[0], BINDINGS[3]] }),
        },
        { imageClient: client, reviewer, prepare, sleep },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampStepError);
      expect(error).toMatchObject({
        code: "photos_unavailable",
        transient: true,
      });
      expect((error as Error).message).toMatch(/^2 of 2 photographs/);
      expect(savedSlots()).not.toContain("hero-1");
    });

    it("★★ tells the merchant plainly why a shoot that can never finish stopped, and what to do", () => {
      const sentence = REVAMP_ERROR_MESSAGES.photos_failed;
      expect(sentence).toBe(
        "The new photographs did not pass Mink AI's own checks this time. Nothing was changed. Ask Mink to try again.",
      );
      // Not the busy service's sentence, and not its advice to wait.
      expect(sentence).not.toBe(REVAMP_ERROR_MESSAGES.photos_unavailable);
      expect(sentence).not.toMatch(/busy|few minutes/i);
      // ★ House rules: no long dash, no figure, no mechanism words.
      expect(sentence).not.toMatch(/[–—]/);
      expect(sentence).not.toMatch(/\d/);
      expect(sentence).not.toMatch(
        /\b(parked|anchor|review|lease|step|attempt|credit)s?\b/i,
      );
    });

    it("★ keeps the shoot's flagged earlier attempt when the redraw kept unreviewed is blocked later", async () => {
      // Attempt 1 has a minor problem, so it is redrawn; the redraw's review
      // is unavailable, and asked again it blocks.
      const { reviewer } = makeReviewer(
        heroReviews(["poor_crop"], "outage", ["text_or_logo"]),
      );
      const { sleep } = recordingSleep();
      const { client } = makeClient();
      const run = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: client,
        reviewer,
        prepare,
        sleep,
      });
      expect(text(parkedRow() && h.objects.get(parkedRow()!.path))).toBe(
        "img:hero-1:3@2520x1080",
      );
      const hero = h.saves.find((s) => s.slotId === "hero-1");
      expect(hero).toMatchObject({
        review: "flagged",
        problems: ["poor_crop"],
      });
      expect(text(hero?.bytes)).toBe("img:hero-1:2@2520x1080");
      // The phone crop follows the photo shown, from its own draw.
      expect(
        text(h.saves.find((s) => s.slotId === "hero-1~phone")?.bytes),
      ).toBe("img:hero-1:2@1080x1350");
      expect(outcome(run, "hero-1")?.status).toBe("generated");
    });

    it("keeps the least flawed picture, as the engine does, when the delayed review finds more problems", async () => {
      const { reviewer } = makeReviewer(
        heroReviews(["poor_crop"], "outage", ["poor_crop", "off_style"]),
      );
      const { sleep } = recordingSleep();
      await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: makeClient().client,
        reviewer,
        prepare,
        sleep,
      });
      const hero = h.saves.find((s) => s.slotId === "hero-1");
      expect(text(hero?.bytes)).toBe("img:hero-1:2@2520x1080");
      expect(hero?.problems).toEqual(["poor_crop"]);
      expect(h.adopts).toEqual([]);
    });

    it("★ waits for every parked photo at once, so an outage costs the shoot one round of waits", async () => {
      // Every shot's first review finds no reviewer; asked again, all pass.
      const asked = new Set<string>();
      const { reviewer } = makeReviewer((candidate) => {
        if (candidate.startsWith("img:anchor")) return [];
        const shotId = candidate.split(":")[1];
        if (asked.has(shotId)) return [];
        asked.add(shotId);
        return "outage";
      });
      let waiting = 0;
      let peak = 0;
      let everyone!: () => void;
      const allWaiting = new Promise<void>((resolve) => {
        everyone = resolve;
      });
      const sleep = async () => {
        waiting += 1;
        peak = Math.max(peak, waiting);
        if (waiting === 4) everyone();
        // A bounded wait, so a pool of three would show up as a peak of three
        // rather than hang the suite.
        await Promise.race([
          allWaiting,
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
        waiting -= 1;
        return true;
      };
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        { ...input(), plan: makePlan() },
        { imageClient: makeClient().client, reviewer, prepare, sleep },
      );
      expect(peak).toBe(4);
      const shots = run.images.filter(
        (i) => i.role === "slot" && !i.slotId.includes("~"),
      );
      expect(shots).toHaveLength(4);
      expect(shots.every((i) => i.review === "passed")).toBe(true);
    });

    it("still sends at most three delayed review calls at once, the engine's own bound", async () => {
      const asked = new Set<string>();
      let inFlight = 0;
      let peakCalls = 0;
      const client: ThemeStudioModelClient = {
        provider: "fake",
        async generate(request) {
          const image = request.content.find((b) => b.type === "image");
          const candidate =
            image?.type === "image"
              ? Buffer.from(image.base64, "base64").toString()
              : "";
          const shotId = candidate.split(":")[1];
          const passed = {
            kind: "ok" as const,
            usage: ZERO_USAGE,
            value: { problems: [], note: "" },
          };
          if (candidate.startsWith("img:anchor")) return passed;
          if (!asked.has(shotId)) {
            asked.add(shotId);
            return {
              kind: "error",
              code: "provider_unavailable",
              usage: ZERO_USAGE,
            };
          }
          inFlight += 1;
          peakCalls = Math.max(peakCalls, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          return passed;
        },
      };
      const { sleep, waits } = recordingSleep();
      await drawRevampPhotos(
        makeCtx().ctx,
        { ...input(), plan: makePlan() },
        {
          imageClient: makeClient().client,
          reviewer: { client, providerModel: "fake" },
          prepare,
          sleep,
        },
      );
      expect(waits).toHaveLength(4);
      expect(peakCalls).toBe(3);
    });

    it("★★ lets the photo in unchecked once its review stays unavailable after every wait, and the card says so (owner's decision 2)", async () => {
      const { reviewer, seen } = makeReviewer(heroReviews("outage"));
      const { sleep, waits } = recordingSleep();
      const run = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: makeClient().client,
        reviewer,
        prepare,
        sleep,
      });
      // Asked in the shoot, then after 15, 30 and 60 s.
      expect(waits).toHaveLength(3);
      expect(heroSeen(seen)).toHaveLength(4);
      // ★ No checked photo of the shoot fits its 21:9 frame (the anchor is
      //   never one), so it is the photo itself, unchecked, never a crop.
      expect(
        h.saves.some((s) => s.problems.includes(REVAMP_RECROP_PROBLEM)),
      ).toBe(false);
      // ★★ ADOPTED under the shot WITH its marker (p0c leftover b): the
      //   parked object itself, no second upload and no second Media row,
      //   and the marker on the row from the moment it is the shot's.
      expect(h.saves.some((s) => s.slotId === "hero-1")).toBe(false);
      expect(h.adoptCalls).toEqual([
        { slotId: "hero-1", problems: [REVAMP_UNCHECKED_PROBLEM] },
      ]);
      const unchecked = h.rows.get(`${REVAMP}|slot|hero-1`);
      expect(unchecked).toMatchObject({
        review: "unreviewed",
        problems: [REVAMP_UNCHECKED_PROBLEM],
      });
      expect(unchecked?.path).toBe(
        h.rows.get(`${REVAMP}|slot|hero-1~review`)?.path,
      );
      expect(run.images.find((i) => i.slotId === "hero-1")?.review).toBe(
        "unreviewed",
      );
      expect(outcome(run, "hero-1")).toEqual({
        shotId: "hero-1",
        status: "failed",
        reason: REVAMP_UNCHECKED_PHOTO_REASON,
      });
      expect(REVAMP_UNCHECKED_PHOTO_REASON).toBe(
        "Mink AI could not check this photograph in time, so it is shown unchecked.",
      );
      expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
        "mink.revamp: a photograph is let in unchecked",
        expect.objectContaining({ shotId: "hero-1" }),
      );
    });

    it("★★ an unchecked photo that cannot be adopted is stored again WITH its marker, and is still never charged", async () => {
      h.adoptFails.add("hero-1");
      const { reviewer } = makeReviewer(heroReviews("outage"));
      const run = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: makeClient().client,
        reviewer,
        prepare,
        sleep: recordingSleep().sleep,
      });
      expect(h.adoptCalls).toContainEqual({
        slotId: "hero-1",
        problems: [REVAMP_UNCHECKED_PROBLEM],
      });
      const again = h.saves.find((s) => s.slotId === "hero-1");
      expect(again).toMatchObject({
        review: "unreviewed",
        problems: [REVAMP_UNCHECKED_PROBLEM],
      });
      expect(text(again?.bytes)).toBe(
        text(h.saves.find((s) => s.slotId === "hero-1~review")?.bytes),
      );
      expect(outcome(run, "hero-1")).toEqual({
        shotId: "hero-1",
        status: "failed",
        reason: REVAMP_UNCHECKED_PHOTO_REASON,
      });
    });

    it("★★ a later invocation reviews the photo an earlier one left parked, before drawing anything", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const parked = seedParked();
      // The earlier runner died holding its claim for the anchor and hero.
      const hold = holdPort({ units: ["anchor:anchor", "slot:hero-1"] });
      const { reviewer, seen } = makeReviewer(() => []);
      const { client, calls } = makeClient();
      const run = await drawRevampPhotos(
        makeCtx(undefined, hold.port).ctx,
        input([anchor, parked]),
        { imageClient: client, reviewer, prepare },
      );
      // ★ The parked photo was drawn and paid for: it is not drawn again, and
      //   the dead runner's claim counts it as used.
      expect(calls).toHaveLength(0);
      expect(h.claims).toEqual([]);
      expect(h.events).toEqual(["record:clear", "release:0"]);
      // Reviewed at once, beside the stored anchor, then the shot's own.
      expect(seen).toEqual([
        {
          candidate: `seed:${REVAMP}:hero-1~review`,
          anchor: `seed:${REVAMP}:anchor`,
        },
      ]);
      expect(h.adopts).toEqual(["hero-1"]);
      expect(run.images.find((i) => i.slotId === "hero-1")).toMatchObject({
        path: parked.path,
        review: "passed",
      });
      // ★ A resumed run only has the stored copy: its phone crop is cut
      //   from that (L2-D).
      expect(
        text(h.saves.find((s) => s.slotId === "hero-1~phone")?.bytes),
      ).toBe(`seed:${REVAMP}:hero-1~review@1080x1350`);
      expect(outcome(run, "hero-1")?.status).toBe("generated");
      expect(run.usage).toMatchObject({ images: 0, reviews: 1 });
    });

    it("★ a later invocation whose review blocks the parked photo crops the shoot instead", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const refill = seedRow(REVAMP, "slot", "refill-0001", 1600, 1200);
      const parked = seedParked();
      const { reviewer } = makeReviewer(() => ["person"]);
      const { client, calls } = makeClient();
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        {
          ...input([anchor, refill, parked]),
          plan: makePlan({ bindings: [BINDINGS[0], BINDINGS[3]] }),
        },
        { imageClient: client, reviewer, prepare },
      );
      expect(calls).toHaveLength(0);
      expect(h.adopts).toEqual([]);
      // ★★ The kept photo of the shoot, never the stored anchor (B16).
      expect(h.saves.find((s) => s.slotId === "hero-1")).toMatchObject({
        review: "flagged",
        problems: [
          REVAMP_RECROP_PROBLEM,
          "recrop-source:refill-0001",
          "recrop-cause:rejected",
        ],
      });
      expect(text(h.saves.find((s) => s.slotId === "hero-1")?.bytes)).toBe(
        `seed:${REVAMP}:refill-0001@2520x1080`,
      );
      expect(run.images.some((i) => i.path === parked.path)).toBe(false);
      expect(outcome(run, "hero-1")?.status).toBe("failed");
    });

    it("★★ a later invocation with only the stored anchor beside a blocked photo stops for good, cropping nothing from it", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const parked = seedParked();
      const { reviewer } = makeReviewer(() => ["person"]);
      const { client, calls } = makeClient();
      const error = await drawRevampPhotos(
        makeCtx().ctx,
        input([anchor, parked]),
        { imageClient: client, reviewer, prepare },
      ).catch((e: unknown) => e);
      expect(calls).toHaveLength(0);
      expect(error).toMatchObject({
        code: "photos_failed",
        transient: false,
      });
      expect(h.saves).toEqual([]);
    });

    it("lets a parked photo in unreviewed when the review model is switched off", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const parked = seedParked();
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        input([anchor, parked]),
        { imageClient: makeClient().client, reviewer: null, prepare },
      );
      expect(h.adopts).toEqual(["hero-1"]);
      expect(run.images.find((i) => i.slotId === "hero-1")).toMatchObject({
        path: parked.path,
        review: "unreviewed",
      });
    });

    it("crops the shoot for a parked photo whose object cannot be read back", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const refill = seedRow(REVAMP, "slot", "refill-0001", 1600, 1200);
      const parked = seedParked();
      h.objects.delete(parked.path);
      const { reviewer, seen } = makeReviewer(() => []);
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        {
          ...input([anchor, refill, parked]),
          plan: makePlan({ bindings: [BINDINGS[0], BINDINGS[3]] }),
        },
        { imageClient: makeClient().client, reviewer, prepare },
      );
      expect(seen).toEqual([]);
      expect(h.adopts).toEqual([]);
      expect(outcome(run, "hero-1")).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("could not finish this picture"),
      });
      expect(h.saves.find((s) => s.slotId === "hero-1")?.problems).toContain(
        "recrop-source:refill-0001",
      );
      // ★ With nothing kept to crop from, the step is tried again later: an
      //   object that could not be read may be read on the next try.
      h.saves.length = 0;
      h.rows.clear();
      const alone = seedParked();
      h.objects.delete(alone.path);
      const error = await drawRevampPhotos(
        makeCtx().ctx,
        input([seedRow(REVAMP, "anchor", "anchor", 1600, 1200), alone]),
        { imageClient: makeClient().client, reviewer, prepare },
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "photos_unavailable",
        transient: true,
      });
      expect(h.saves).toEqual([]);
    });

    it("★★ leaves the photo parked when the deadline drains a wait, and the next run decides", async () => {
      const hold = holdPort();
      const drain = new AbortController();
      const ctx = {
        ...makeCtx(undefined, hold.port).ctx,
        draining: drain.signal,
      };
      const { reviewer, seen } = makeReviewer(heroReviews("outage", []));
      // The deadline passes while the step waits to ask again.
      const sleep = async (_ms: number, signal: AbortSignal) => {
        drain.abort();
        return !signal.aborted;
      };
      const error = await drawRevampPhotos(ctx, input(), {
        imageClient: makeClient().client,
        reviewer,
        prepare,
        sleep,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampDrainedError);
      // Kept for the next run: neither promoted nor cropped over.
      expect(savedSlots().sort()).toEqual(["anchor", "hero-1~review"]);
      expect(h.adopts).toEqual([]);
      expect(heroSeen(seen)).toHaveLength(1);
      // Both pictures were drawn, so none of the claim goes back.
      expect(h.events).toEqual([
        "claim:2",
        "record:2",
        "record:clear",
        "release:0",
      ]);

      const run = await drawRevampPhotos(makeCtx().ctx, input(storedRows()), {
        imageClient: makeClient().client,
        reviewer,
        prepare,
      });
      expect(h.claims).toEqual([2]);
      expect(heroSeen(seen)).toHaveLength(2);
      expect(run.images.find((i) => i.slotId === "hero-1")?.review).toBe(
        "passed",
      );
    });
  });

  describe("★★ a photo's check has about four minutes in all, kept across hand-overs (P0)", () => {
    /** The hero alone, or a plan given. */
    const input = (
      stored: RevampStoredImage[] = [],
      plan: RevampSitePlan = makePlan({ bindings: [BINDINGS[0]] }),
    ) => ({
      plan,
      snapshot: makeSnapshot(),
      stored,
      inherited: [] as RevampStoredImage[],
      redraw: null,
    });
    const storedRows = (): RevampStoredImage[] =>
      [...h.rows.values()].filter((row) => row.revampId === REVAMP);
    const parkedRow = () => h.rows.get(`${REVAMP}|slot|hero-1~review`);
    const heroSeen = (seen: Array<{ candidate: string }>) =>
      seen.filter((r) => !r.candidate.startsWith("img:anchor"));

    it("★★ asks a parked photo again during the shoot, not once the shoot has ended", async () => {
      // The hero's check is unavailable once; the story is drawn only once the
      // hero has been asked again, which a check left for after the shoot
      // could never reach.
      let askedAgain!: () => void;
      const heroAskedAgain = new Promise<void>((resolve) => {
        askedAgain = resolve;
      });
      let heroTurns = 0;
      const { reviewer } = makeReviewer((candidate) => {
        if (!candidate.startsWith("img:hero-1")) return [];
        heroTurns += 1;
        if (heroTurns === 1) return "outage";
        askedAgain();
        return [];
      });
      const base = makeClient();
      let late = false;
      const client: ThemeStudioImageClient = {
        provider: "fake",
        async generateImage(request, signal) {
          if (request.briefId === "story-1") {
            late = !(await Promise.race([
              heroAskedAgain.then(() => true),
              new Promise<boolean>((resolve) =>
                setTimeout(() => resolve(false), 2000),
              ),
            ]));
          }
          return base.client.generateImage(request, signal);
        },
      };
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        input([], makePlan({ bindings: BINDINGS.slice(0, 3) })),
        {
          imageClient: client,
          reviewer,
          prepare,
          sleep: recordingSleep().sleep,
          concurrency: 1,
        },
      );
      expect(late).toBe(false);
      expect(base.briefs()).toEqual(["anchor", "hero-1", "story-1"]);
      expect(run.images.find((i) => i.slotId === "hero-1")?.review).toBe(
        "passed",
      );
    });

    it("★★ stops asking once the photo's budget is spent, counted from its first ask: a wait that would end past it is not waited", async () => {
      expect(REVAMP_PHOTO_CHECK_BUDGET_MS).toBe(240_000);
      const clock = { t: 1_000_000 };
      // Every check of the hero runs its full 75 s try with no answer.
      const { reviewer, seen } = makeReviewer((candidate) => {
        if (candidate.startsWith("img:anchor")) return [];
        clock.t += 75_000;
        return "outage";
      });
      const waits: number[] = [];
      const sleep = async (ms: number) => {
        waits.push(ms);
        clock.t += ms;
        return true;
      };
      const reviews = reviewsPort();
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        input(),
        {
          imageClient: makeClient().client,
          reviewer,
          prepare,
          sleep,
          now: () => clock.t,
        },
      );
      // Asked at 0 s (answered at 75 s), at 90 s and at 195 s; the 60 s wait
      // after that would end at 330 s, past the budget's 240 s.
      expect(waits).toEqual([15_000, 30_000]);
      expect(heroSeen(seen)).toHaveLength(3);
      expect(reviews.current()?.shots["hero-1"]).toEqual({
        sha256: parkedRow()!.sha256,
        tries: 3,
        firstAskedAt: 1_000_000,
        lastTriedAt: 1_270_000,
        verdict: "expired",
      });
      expect(outcome(run, "hero-1")?.reason).toBe(
        REVAMP_UNCHECKED_PHOTO_REASON,
      );
    });

    it("★★ a check still in flight when the budget runs out is cut off and counted as a timeout", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const parked = seedParked();
      // An earlier invocation asked, and never heard back, almost the whole
      // budget ago.
      const reviews = reviewsPort({
        shots: {
          "hero-1": {
            sha256: parked.sha256,
            tries: 0,
            firstAskedAt: Date.now() - REVAMP_PHOTO_CHECK_BUDGET_MS + 80,
          },
        },
      });
      // A reviewer that never answers: only a signal ends its call.
      const hanging: ThemeStudioModelClient = {
        provider: "fake",
        generate: (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      };
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        input([anchor, parked]),
        {
          imageClient: makeClient().client,
          reviewer: { client: hanging, providerModel: "fake" },
          prepare,
        },
      );
      expect(run.usage.calls).toEqual({
        "gemini-3.8-flash": { rateLimited: 0, timeouts: 1 },
      });
      expect(reviews.current()?.shots["hero-1"]).toMatchObject({
        sha256: parked.sha256,
        tries: 1,
        verdict: "expired",
      });
      expect(outcome(run, "hero-1")).toMatchObject({
        status: "failed",
        reason: REVAMP_UNCHECKED_PHOTO_REASON,
      });
    });

    it("★★ keeps the tries and the first ask on the job row, so the next invocation carries on instead of starting over", async () => {
      const reviews = reviewsPort();
      const drain = new AbortController();
      const { reviewer, seen } = makeReviewer(heroReviews("outage", []));
      // The deadline passes while the step waits to ask again.
      const sleep = async (_ms: number, signal: AbortSignal) => {
        drain.abort();
        return !signal.aborted;
      };
      const error = await drawRevampPhotos(
        {
          ...makeCtx().ctx,
          draining: drain.signal,
          photoReviews: reviews.port,
        },
        input(),
        { imageClient: makeClient().client, reviewer, prepare, sleep },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampDrainedError);
      const kept = reviews.current()?.shots["hero-1"];
      expect(kept).toMatchObject({ sha256: parkedRow()!.sha256, tries: 1 });
      expect(kept?.firstAskedAt).toEqual(expect.any(Number));
      expect(kept?.lastTriedAt).toBeGreaterThanOrEqual(kept!.firstAskedAt!);
      expect(kept?.verdict).toBeUndefined();

      // ★ The next invocation waits out the rest of the first wait, where a
      //   check that started over would ask at once, then asks once more.
      const next = recordingSleep();
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        input(storedRows()),
        {
          imageClient: makeClient().client,
          reviewer,
          prepare,
          sleep: next.sleep,
        },
      );
      expect(next.waits).toHaveLength(1);
      expect(next.waits[0]).toBeGreaterThan(
        REVAMP_REVIEW_RETRY_DELAYS_MS[0] - 5_000,
      );
      expect(next.waits[0]).toBeLessThanOrEqual(
        REVAMP_REVIEW_RETRY_DELAYS_MS[0],
      );
      expect(heroSeen(seen)).toHaveLength(2);
      expect(run.images.find((i) => i.slotId === "hero-1")?.review).toBe(
        "passed",
      );
      expect(reviews.current()?.shots["hero-1"]).toMatchObject({
        tries: 2,
        firstAskedAt: kept?.firstAskedAt,
        verdict: { problems: [] },
      });
    });

    it("★★ never asks again about a photo whose blocking verdict the job row holds", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const refill = seedRow(REVAMP, "slot", "refill-0001", 1600, 1200);
      const parked = seedParked();
      const reviews = reviewsPort({
        shots: {
          "hero-1": {
            sha256: parked.sha256,
            tries: 2,
            firstAskedAt: Date.now() - 60_000,
            lastTriedAt: Date.now() - 30_000,
            verdict: { problems: ["text_or_logo"] },
          },
        },
      });
      const { reviewer, seen } = makeReviewer(() => []);
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        input(
          [anchor, refill, parked],
          makePlan({ bindings: [BINDINGS[0], BINDINGS[3]] }),
        ),
        { imageClient: makeClient().client, reviewer, prepare },
      );
      expect(seen).toEqual([]);
      expect(h.adopts).toEqual([]);
      expect(h.saves.find((s) => s.slotId === "hero-1")).toMatchObject({
        problems: [
          REVAMP_RECROP_PROBLEM,
          "recrop-source:refill-0001",
          "recrop-cause:rejected",
        ],
      });
      expect(outcome(run, "hero-1")?.status).toBe("failed");
    });

    it("lets a photo whose passing verdict the job row holds in without asking again, and never applies a record about another picture", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const parked = seedParked();
      const { reviewer, seen } = makeReviewer(() => []);
      const passed = reviewsPort({
        shots: {
          "hero-1": {
            sha256: parked.sha256,
            tries: 1,
            verdict: { problems: [] },
          },
        },
      });
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: passed.port },
        input([anchor, parked]),
        { imageClient: makeClient().client, reviewer, prepare },
      );
      expect(seen).toEqual([]);
      expect(run.images.find((i) => i.slotId === "hero-1")).toMatchObject({
        path: parked.path,
        review: "passed",
      });

      // A blocking verdict about some other picture says nothing about this one.
      h.rows.clear();
      h.objects.clear();
      h.adopts.length = 0;
      const anchorAgain = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const parkedAgain = seedParked();
      const other = reviewsPort({
        shots: {
          "hero-1": {
            sha256: "f".repeat(64),
            tries: 1,
            verdict: { problems: ["person"] },
          },
        },
      });
      const again = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: other.port },
        input([anchorAgain, parkedAgain]),
        { imageClient: makeClient().client, reviewer, prepare },
      );
      expect(seen).toHaveLength(1);
      expect(again.images.find((i) => i.slotId === "hero-1")?.review).toBe(
        "passed",
      );
      expect(other.current()?.shots["hero-1"]).toMatchObject({
        sha256: parkedAgain.sha256,
        tries: 1,
        verdict: { problems: [] },
      });
    });

    it("★★ a budget the job row says is spent goes straight to owner's decision 2, with no ask", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const parked = seedParked();
      const reviews = reviewsPort({
        shots: {
          "hero-1": {
            sha256: parked.sha256,
            tries: 1,
            firstAskedAt: Date.now() - REVAMP_PHOTO_CHECK_BUDGET_MS - 1_000,
            lastTriedAt: Date.now() - 60_000,
          },
        },
      });
      const { reviewer, seen } = makeReviewer(() => []);
      const { sleep, waits } = recordingSleep();
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        input([anchor, parked]),
        { imageClient: makeClient().client, reviewer, prepare, sleep },
      );
      expect(seen).toEqual([]);
      expect(waits).toEqual([]);
      expect(h.saves.some((s) => s.slotId === "hero-1")).toBe(false);
      expect(h.adoptCalls).toEqual([
        { slotId: "hero-1", problems: [REVAMP_UNCHECKED_PROBLEM] },
      ]);
      expect(h.rows.get(`${REVAMP}|slot|hero-1`)).toMatchObject({
        review: "unreviewed",
        problems: [REVAMP_UNCHECKED_PROBLEM],
        path: parked.path,
      });
      expect(outcome(run, "hero-1")).toEqual({
        shotId: "hero-1",
        status: "failed",
        reason: REVAMP_UNCHECKED_PHOTO_REASON,
      });
      expect(reviews.current()?.shots["hero-1"]?.verdict).toBe("expired");
    });

    it("★★ owner's decision 2: a crop of a CHECKED photo of the shoot stands in when one fits, never the anchor; when none fits, the photo itself, unchecked", async () => {
      expect(REVAMP_CHECKED_CROP_MAX_LOSS).toBe(0.3);
      // The hero and the refill are never checked; the story and the
      // category pass.
      const { reviewer } = makeReviewer((candidate) =>
        candidate.startsWith("img:hero-1") ||
        candidate.startsWith("img:refill-0001")
          ? "outage"
          : [],
      );
      const run = await drawRevampPhotos(makeCtx().ctx, input([], makePlan()), {
        imageClient: makeClient().client,
        reviewer,
        prepare,
        sleep: recordingSleep().sleep,
      });
      // The refill's 4:3 frame: the category's checked 1:1 photo fits (a
      // quarter cut away), where the anchor would have fitted exactly.
      expect(h.saves.find((s) => s.slotId === "refill-0001")).toMatchObject({
        review: "flagged",
        problems: [
          REVAMP_RECROP_PROBLEM,
          "recrop-source:category-shakes",
          "recrop-cause:unchecked",
        ],
      });
      expect(outcome(run, "refill-0001")).toEqual({
        shotId: "refill-0001",
        status: "failed",
        reason: expect.stringContaining(
          "could not check the new photograph in time",
        ),
      });
      // The hero's 21:9 frame: no checked photo keeps enough of itself.
      expect(run.images.find((i) => i.slotId === "hero-1")?.review).toBe(
        "unreviewed",
      );
      expect(outcome(run, "hero-1")).toEqual({
        shotId: "hero-1",
        status: "failed",
        reason: REVAMP_UNCHECKED_PHOTO_REASON,
      });
      expect(outcome(run, "story-1")?.status).toBe("generated");
      expect(outcome(run, "category-shakes")?.status).toBe("generated");
    });

    /** A shot's photo an earlier invocation parked, its budget long spent. */
    const seedSpentParked = (shotId: string, width: number, height: number) => {
      const slotId = `${shotId}${REVAMP_REVIEW_PENDING_SUFFIX}`;
      seedRow(REVAMP, "slot", slotId, width, height);
      const row = h.rows.get(`${REVAMP}|slot|${slotId}`)!;
      row.review = "unreviewed";
      row.problems = ["review-pending"];
      return {
        sha256: row.sha256,
        tries: 1,
        firstAskedAt: Date.now() - REVAMP_PHOTO_CHECK_BUDGET_MS - 1_000,
        lastTriedAt: Date.now() - 60_000,
      };
    };
    const categoryLetInUnchecked = (run: {
      outcomes: RevampPhotoOutcome[];
    }) => {
      // Adopted with its marker, never uploaded again.
      expect(h.saves.some((s) => s.slotId === "category-shakes")).toBe(false);
      expect(
        h.adoptCalls.find((call) => call.slotId === "category-shakes"),
      ).toEqual({
        slotId: "category-shakes",
        problems: [REVAMP_UNCHECKED_PROBLEM],
      });
      expect(h.rows.get(`${REVAMP}|slot|category-shakes`)).toMatchObject({
        review: "unreviewed",
        problems: [REVAMP_UNCHECKED_PROBLEM],
      });
      expect(outcome(run, "category-shakes")).toEqual({
        shotId: "category-shakes",
        status: "failed",
        reason: REVAMP_UNCHECKED_PHOTO_REASON,
      });
    };

    it("★★ owner's decision 2 never crops a photo that was never checked, even one that fits", async () => {
      // Only the anchor and the hero pass; the story, the refill and the
      // category are never checked. The hero's 21:9 photo keeps too little of
      // itself for the category's 1:1 frame; the story's 4:5 photo and the
      // refill's 4:3 one would fit it, unchecked.
      const { reviewer } = makeReviewer((candidate) =>
        candidate.startsWith("img:anchor") || candidate.startsWith("img:hero-1")
          ? []
          : "outage",
      );
      const run = await drawRevampPhotos(makeCtx().ctx, input([], makePlan()), {
        imageClient: makeClient().client,
        reviewer,
        prepare,
        sleep: recordingSleep().sleep,
      });
      expect(outcome(run, "hero-1")?.status).toBe("generated");
      expect(
        h.saves.some((s) => s.problems.includes("recrop-cause:unchecked")),
      ).toBe(false);
      categoryLetInUnchecked(run);
    });

    it("★★ owner's decision 2 never takes a crop an earlier invocation stored for a checked photo", async () => {
      seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      // The story's photo is a crop an earlier invocation stored: flagged,
      // like a checked photo with a minor problem, and the only photo that
      // would fit the category's 1:1 frame.
      seedRow(REVAMP, "slot", "story-1", 1200, 1500);
      const storyRow = h.rows.get(`${REVAMP}|slot|story-1`)!;
      storyRow.review = "flagged";
      storyRow.problems = [
        REVAMP_RECROP_PROBLEM,
        "recrop-source:anchor",
        "recrop-cause:failed",
      ];
      const reviews = reviewsPort({
        shots: {
          "category-shakes": seedSpentParked("category-shakes", 1200, 1200),
        },
      });
      const { reviewer, seen } = makeReviewer(() => []);
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        input(
          storedRows(),
          makePlan({ bindings: [BINDINGS[1], BINDINGS[2], BINDINGS[4]] }),
        ),
        { imageClient: makeClient().client, reviewer, prepare },
      );
      expect(seen).toEqual([]);
      categoryLetInUnchecked(run);
    });

    it("★★ owner's decision 2 never takes a flagged photo a refinement carried over from its parent", async () => {
      const parentAnchor = seedRow(PARENT, "anchor", "anchor", 1600, 1200);
      // The parent's story photo: flagged, carried over whole, and the only
      // photo that would fit the category's 1:1 frame.
      const parentStory = seedRow(PARENT, "slot", "story-1", 1200, 1500);
      h.rows.get(`${PARENT}|slot|story-1`)!.review = "flagged";
      const reviews = reviewsPort({
        shots: {
          "category-shakes": seedSpentParked("category-shakes", 1200, 1200),
        },
      });
      const { reviewer, seen } = makeReviewer(() => []);
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        {
          ...input(
            storedRows(),
            makePlan({ bindings: [BINDINGS[1], BINDINGS[2], BINDINGS[4]] }),
          ),
          inherited: [parentAnchor, { ...parentStory, review: "flagged" }],
          redraw: null,
        },
        { imageClient: makeClient().client, reviewer, prepare },
      );
      expect(seen).toEqual([]);
      expect(h.adopts).toContain("story-1");
      categoryLetInUnchecked(run);
    });

    it("★ the engine's own first check of a photo ends with the photo's budget", async () => {
      vi.useFakeTimers();
      try {
        // The hero's check never answers: only a signal ends it.
        const hanging: ThemeStudioModelClient = {
          provider: "fake",
          generate: (request, signal) => {
            const image = request.content.find((b) => b.type === "image");
            const candidate =
              image?.type === "image"
                ? Buffer.from(image.base64, "base64").toString()
                : "";
            if (candidate.startsWith("img:anchor")) {
              return Promise.resolve({
                kind: "ok",
                usage: ZERO_USAGE,
                value: { problems: [], note: "" },
              });
            }
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
        };
        let settled = false;
        const pending = drawRevampPhotos(makeCtx().ctx, input(), {
          imageClient: makeClient().client,
          reviewer: { client: hanging, providerModel: "fake" },
          prepare,
          sleep: recordingSleep().sleep,
        }).finally(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(REVAMP_PHOTO_CHECK_BUDGET_MS + 1);
        // A check the budget did not end would still be waiting here.
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2_000 });
        const run = await pending;
        // Cut off at the budget: a timeout, and the photo let in unchecked.
        expect(run.usage.calls).toEqual({
          "gemini-3.8-flash": { rateLimited: 0, timeouts: 1 },
        });
        expect(outcome(run, "hero-1")).toEqual({
          shotId: "hero-1",
          status: "failed",
          reason: REVAMP_UNCHECKED_PHOTO_REASON,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("★★ a later invocation still tells the card a photo it let in unchecked was not checked", async () => {
      const reviews = reviewsPort();
      const { reviewer } = makeReviewer(heroReviews("outage"));
      await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        input(),
        {
          imageClient: makeClient().client,
          reviewer,
          prepare,
          sleep: recordingSleep().sleep,
        },
      );
      // The step ran again (the runner resumed it): everything is stored.
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        input(storedRows()),
        { imageClient: makeClient().client, reviewer, prepare },
      );
      expect(outcome(run, "hero-1")).toEqual({
        shotId: "hero-1",
        status: "failed",
        reason: REVAMP_UNCHECKED_PHOTO_REASON,
      });
    });

    it("★★ a photo let in unchecked stays unchecked on a later invocation even when the job row never heard its check ran out", async () => {
      // The job row's record, where every write carrying the expired verdict
      // meets a database error (each earlier write lands).
      const saved: { reviews: RevampPhotoReviews | null } = { reviews: null };
      let lost = 0;
      const port: NonNullable<RevampStepContext["photoReviews"]> = {
        held: () => saved.reviews,
        record: async (reviews) => {
          if (
            Object.values(reviews.shots).some((s) => s.verdict === "expired")
          ) {
            lost += 1;
            throw new Error("Connection terminated unexpectedly");
          }
          saved.reviews = JSON.parse(
            JSON.stringify(reviews),
          ) as RevampPhotoReviews;
          return true;
        },
      };
      const { reviewer } = makeReviewer(heroReviews("outage"));
      const first = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: port },
        input(),
        {
          imageClient: makeClient().client,
          reviewer,
          prepare,
          sleep: recordingSleep().sleep,
        },
      );
      expect(lost).toBeGreaterThan(0);
      expect(saved.reviews?.shots["hero-1"]?.verdict).toBeUndefined();
      expect(outcome(first, "hero-1")).toEqual({
        shotId: "hero-1",
        status: "failed",
        reason: REVAMP_UNCHECKED_PHOTO_REASON,
      });
      // The step runs again (something after the promotion ended it before
      // its outcomes were saved): the row itself still says unchecked, so
      // the photo is neither charged nor missing from the card.
      const again = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: port },
        input(storedRows()),
        { imageClient: makeClient().client, reviewer, prepare },
      );
      expect(outcome(again, "hero-1")).toEqual({
        shotId: "hero-1",
        status: "failed",
        reason: REVAMP_UNCHECKED_PHOTO_REASON,
      });
    });

    it("★ keeps why each photo was drawn again on its outcome, and the anchor's on the job row", async () => {
      const reviews = reviewsPort();
      let anchorTurn = 0;
      let storyTurn = 0;
      const { reviewer } = makeReviewer((candidate) => {
        if (candidate.startsWith("img:anchor")) {
          return anchorTurn++ === 0 ? ["poor_crop"] : [];
        }
        if (candidate.startsWith("img:story-1")) {
          return storyTurn++ === 0 ? ["poor_crop"] : [];
        }
        return [];
      });
      let refills = 0;
      const { client } = makeClient((request) =>
        request.briefId === "refill-0001" && refills++ === 0 ? "refuse" : "ok",
      );
      const run = await drawRevampPhotos(
        { ...makeCtx().ctx, photoReviews: reviews.port },
        input([], makePlan()),
        { imageClient: client, reviewer, prepare },
      );
      expect(outcome(run, "story-1")).toEqual({
        shotId: "story-1",
        status: "generated",
        reason: null,
        redraws: [{ attempt: 1, problems: ["poor_crop"] }],
      });
      expect(outcome(run, "refill-0001")?.redraws).toEqual([
        { attempt: 1, problems: ["refused"] },
      ]);
      expect(outcome(run, "hero-1")).not.toHaveProperty("redraws");
      expect(reviews.current()?.shots["@anchor"]?.redraws).toEqual([
        { attempt: 1, problems: ["poor_crop"] },
      ]);
    });

    it("★★ counts every try refused with 429 or cut off by its clock, per model, in the step's usage", async () => {
      const reported: RevampUsage[] = [];
      const base = makeClient();
      const client: ThemeStudioImageClient = {
        provider: "fake",
        async generateImage(request, signal) {
          const answer = await base.client.generateImage(request, signal);
          const timing = (providerAttempts: number) => ({
            durationMs: 1,
            capacityWaitMs: 0,
            providerAttempts,
          });
          // The hero got through after two 429s; the category's one try ran
          // out of its clock.
          if (request.briefId === "hero-1")
            return { ...answer, timing: timing(3) };
          if (request.briefId === "category-shakes") {
            return {
              kind: "error",
              code: "provider_timeout",
              usage: ZERO_IMAGE_USAGE,
              timing: timing(1),
            };
          }
          return answer;
        },
      };
      let storyTurn = 0;
      const { reviewer } = makeReviewer((candidate) =>
        candidate.startsWith("img:story-1") && storyTurn++ === 0
          ? "rate_limited"
          : [],
      );
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        {
          ...input([], makePlan()),
          onUsage: (usage: RevampUsage) => reported.push(usage),
        },
        {
          imageClient: client,
          reviewer,
          prepare,
          sleep: recordingSleep().sleep,
        },
      );
      expect(run.usage.calls).toEqual({
        "gemini-nano-banana-2.1": { rateLimited: 2, timeouts: 1 },
        "gemini-3.8-flash": { rateLimited: 1, timeouts: 0 },
      });
      expect(run.usage).toEqual(
        reported.reduce(addRevampUsage, { ...ZERO_REVAMP_USAGE }),
      );
    });
  });

  describe("★★ the phone crop is cut from the picture the model drew (L2-D)", () => {
    // Real pictures at the sizes the image model returns, through the real
    // crop (sharp): the 4:5 phone cut is 1344 px tall from a 2K 21:9 draw.
    const input = (stored: RevampStoredImage[] = []) => ({
      plan: makePlan({ bindings: [BINDINGS[0]] }),
      snapshot: makeSnapshot(),
      stored,
      inherited: [] as RevampStoredImage[],
      redraw: null,
    });

    it("★★ cuts 1075x1344 from a 2K 21:9 draw, where its stored 2520x1080 copy would leave 864x1080", async () => {
      const { client, drawn } = modelSizedClient("2K");
      const run = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: client,
        reviewer: null,
      });
      expect(drawn.find((d) => d.briefId === "hero-1")).toMatchObject({
        width: 3168,
        height: 1344,
      });
      // The wide slot is stored at its frame: 2520 across.
      const hero = h.saves.find((s) => s.slotId === "hero-1");
      expect([hero?.width, hero?.height]).toEqual([2520, 1080]);
      expect(await measured(hero?.bytes)).toEqual([2520, 1080]);
      const phone = h.saves.find((s) => s.slotId === "hero-1~phone");
      expect([phone?.width, phone?.height]).toEqual([1075, 1344]);
      expect(await measured(phone?.bytes)).toEqual([1075, 1344]);
      expect(run.images.find((i) => i.slotId === "hero-1~phone")).toMatchObject(
        { width: 1075, height: 1344 },
      );
    });

    it("★ a resumed run that only has the stored 2520x1080 copy still cuts the phone crop, from it", async () => {
      const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
      const hero = seedRow(REVAMP, "slot", "hero-1", 2520, 1080);
      h.objects.set(hero.path, await picture(2520, 1080, "webp"));
      const { client, drawn } = modelSizedClient("2K");
      await drawRevampPhotos(makeCtx().ctx, input([anchor, hero]), {
        imageClient: client,
        reviewer: null,
      });
      expect(drawn).toEqual([]);
      const phone = h.saves.find((s) => s.slotId === "hero-1~phone");
      expect([phone?.width, phone?.height]).toEqual([864, 1080]);
      expect(await measured(phone?.bytes)).toEqual([864, 1080]);
    });

    it("★ with no check to pass it, a 1K draw is kept, leaves no phone crop, says why in the log and on the card, and the step still finishes", async () => {
      const { client } = modelSizedClient("1K");
      const run = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: client,
        reviewer: null,
      });
      // The largest 21:9 cut of a 1584x672 picture; the crop never upscales.
      const hero = h.saves.find((s) => s.slotId === "hero-1");
      expect([hero?.width, hero?.height]).toEqual([1568, 672]);
      expect(savedSlots()).not.toContain("hero-1~phone");
      // ★★ B14: kept smaller than its frame, so listed under "Not done this
      //   time" (a failed outcome) and never charged; its row says so.
      expect(outcome(run, "hero-1")).toMatchObject({
        status: "failed",
        reason: REVAMP_SMALL_PHOTO_REASON,
      });
      expect(hero?.problems).toEqual([REVAMP_SMALL_PROBLEM]);
      expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
        "mink.revamp: a photograph came back smaller than its frame",
        expect.objectContaining({
          shotId: "hero-1",
          width: 1568,
          height: 672,
          frameWidth: 2520,
          frameHeight: 1080,
        }),
      );
      // ★ Tried once, from the draw: a 4:5 cut of 672 px is 537 px across,
      //   under the storefront's 800 px floor, and the stored copy (a crop
      //   of the same picture) is not tried again.
      const phoneLogs = vi
        .mocked(logWarn)
        .mock.calls.filter(
          ([message]) =>
            message === "mink.revamp: phone crop could not be made",
        );
      expect(phoneLogs).toEqual([
        [
          "mink.revamp: phone crop could not be made",
          expect.objectContaining({
            shotId: "hero-1",
            from: "drawn",
            width: 1584,
            height: 672,
            cropWidth: 537,
            minWidth: 800,
          }),
        ],
      ]);
    });
  });

  describe("★★ every paid call is reported the moment it returns (L2-F)", () => {
    const DRAW = { inputTokens: 600, outputTokens: 1680 };
    const REVIEW: ProviderUsage = {
      inputTokens: 900,
      cachedTokens: 0,
      outputTokens: 20,
      thinkingTokens: 300,
    };
    const input = (
      onUsage: (usage: RevampUsage) => void,
      stored: RevampStoredImage[] = [],
    ) => ({
      plan: makePlan(),
      snapshot: makeSnapshot(),
      stored,
      inherited: [] as RevampStoredImage[],
      redraw: null,
      onUsage,
    });
    const total = (list: RevampUsage[]) =>
      list.reduce(addRevampUsage, { ...ZERO_REVAMP_USAGE });

    it("★★ reports each draw, redraw, refusal and review as it returns, and the step's usage is their sum", async () => {
      const reported: RevampUsage[] = [];
      // The refill is refused on every attempt; the story's first picture
      // has a minor problem, so it is redrawn.
      const { client, sent } = makeClient(
        (r) => (r.briefId === "refill-0001" ? "refuse" : "ok"),
        undefined,
        DRAW,
      );
      let story = 0;
      const { reviewer, seen } = makeReviewer(
        (candidate) =>
          candidate.startsWith("img:story-1") && story++ === 0
            ? ["poor_crop"]
            : [],
        REVIEW,
      );
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        input((usage) => reported.push(usage)),
        { imageClient: client, reviewer, prepare },
      );
      // Anchor, hero, story twice, category, and the refill's three refusals.
      expect(sent()).toBe(8);
      expect(seen).toHaveLength(5);
      expect(reported).toHaveLength(8 + 5);
      const draws = reported.filter((u) => u.images === 1);
      expect(draws).toHaveLength(8);
      expect(draws.filter((u) => u.outputTokens === 0)).toHaveLength(3);
      expect(draws.every((u) => u.reviews === 0 && u.inputTokens === 600)).toBe(
        true,
      );
      const reviews = reported.filter((u) => u.reviews === 1);
      expect(reviews).toHaveLength(5);
      expect(
        reviews.every(
          (u) =>
            u.images === 0 &&
            u.inputTokens === 900 &&
            u.thinkingTokens === 300 &&
            u.estimatedCostMicroUsd > 0,
        ),
      ).toBe(true);
      expect(run.usage).toEqual(total(reported));
      expect(run.usage.estimatedCostMicroUsd).toBeGreaterThan(0);
    });

    it("★★ a draw's thinking is counted, and it is priced at the rates of the model that drew it (25 Oct 2026)", async () => {
      const reported: RevampUsage[] = [];
      const drawn: ImageCallUsage = {
        inputTokens: 600,
        outputTokens: 1680,
        thinkingTokens: 1000,
        model: "gemini-nano-banana-2.1",
      };
      const { client } = makeClient(() => "ok", undefined, drawn);
      const { reviewer } = makeReviewer(() => [], REVIEW);
      await drawRevampPhotos(
        makeCtx().ctx,
        input((usage) => reported.push(usage)),
        { imageClient: client, reviewer, prepare },
      );
      const draws = reported.filter((u) => u.images === 1);
      expect(draws.length).toBeGreaterThan(0);
      for (const draw of draws) {
        expect(draw.thinkingTokens).toBe(1000);
        // $1.50 in, $30 a picture token and $7.50 a thinking token, a million.
        expect(draw.estimatedCostMicroUsd).toBe(900 + 50_400 + 7_500);
      }
    });

    it("★★ a run stopped half way has reported every call it paid for, and only those", async () => {
      const controller = new AbortController();
      const reason = new Error("lease lost");
      const reported: RevampUsage[] = [];
      const { client, sent } = makeClient(
        () => "ok",
        (request) => {
          if (request.briefId === "story-1") controller.abort(reason);
        },
        DRAW,
      );
      const { reviewer, seen } = makeReviewer(() => [], REVIEW);
      await expect(
        drawRevampPhotos(
          makeCtx(controller.signal).ctx,
          input((usage) => reported.push(usage)),
          { imageClient: client, reviewer, prepare, concurrency: 1 },
        ),
      ).rejects.toBe(reason);
      // The step never returned a total: what it reported is the record.
      expect(sent()).toBeGreaterThanOrEqual(2);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(total(reported)).toMatchObject({
        images: sent(),
        reviews: seen.length,
      });
      expect(reported).toHaveLength(sent() + seen.length);
    });

    describe("★★ a draw the run's stop cuts off on the wire (B3, D3)", () => {
      /**
       * The client, with the run stopping while Google draws `briefId`.
       * `late`: that draw's answer comes back only after the shoot has
       * stopped waiting for it.
       */
      const stoppedWhileDrawing = (
        briefId: string,
        controller: AbortController,
        reason: Error,
        late = false,
      ) => {
        const drawing = makeClient(() => "ok", undefined, DRAW);
        const client: ThemeStudioImageClient = {
          provider: "fake",
          async generateImage(request, signal) {
            if (request.briefId !== briefId) {
              return drawing.client.generateImage(request, signal);
            }
            // Sent, and still being drawn when the run stops.
            controller.abort(reason);
            if (late) await new Promise((resolve) => setTimeout(resolve, 0));
            return {
              kind: "error",
              code: "cancelled",
              usage: ZERO_IMAGE_USAGE,
              timing: {
                durationMs: 30_000,
                capacityWaitMs: 0,
                providerAttempts: 1,
                stoppedInFlight: true,
              },
            };
          },
        };
        return { client, sent: drawing.sent };
      };

      it("★★ keeps its photo spent and counts it as a call, since it may have been billed", async () => {
        const controller = new AbortController();
        // ★ The merchant's Stop (or the hard stop): the run still owns the
        //   job, so its own clear of the claim lands. After a lost lease the
        //   next run settles the claim from the stored photos instead.
        const reason = new Error("revamp halted: cancelled");
        const reported: RevampUsage[] = [];
        const { client, sent } = stoppedWhileDrawing(
          "story-1",
          controller,
          reason,
        );
        await expect(
          drawRevampPhotos(
            makeCtx(controller.signal).ctx,
            input((usage) => reported.push(usage)),
            { imageClient: client, reviewer: null, prepare, concurrency: 1 },
          ),
        ).rejects.toBe(reason);
        expect(sent()).toBe(2);
        // The anchor and the hero were drawn and the story was cut off on
        // the wire: those three stay spent, the two never sent go back.
        expect(h.claims).toEqual([5]);
        expect(sum(h.releases)).toBe(2);
        // ★ Counted as a call, priced from what came back (nothing), with no
        //   429 or timeout of its own.
        expect(reported).toContainEqual({ ...ZERO_REVAMP_USAGE, images: 1 });
        expect(total(reported)).toMatchObject({ images: 3 });
        expect(total(reported).calls).toBeUndefined();
        // ★ Never a photograph: nothing was stored for it.
        expect(savedSlots()).not.toContain("story-1");
      });

      it("★★ the anchor cut off on the wire keeps its photo spent too", async () => {
        const controller = new AbortController();
        const reason = new Error("cancelled");
        const reported: RevampUsage[] = [];
        const { client } = stoppedWhileDrawing("anchor", controller, reason);
        await expect(
          drawRevampPhotos(
            makeCtx(controller.signal).ctx,
            input((usage) => reported.push(usage)),
            { imageClient: client, reviewer: null, prepare, concurrency: 1 },
          ),
        ).rejects.toBe(reason);
        expect(h.claims).toEqual([5]);
        // The anchor may have been billed; the four shots never started.
        expect(sum(h.releases)).toBe(4);
        expect(total(reported)).toMatchObject({ images: 1 });
      });

      it.each([
        ["a shot", "story-1", 2, 3],
        ["the anchor", "anchor", 4, 1],
      ])(
        "★★ %s whose answer comes back after the shoot stopped waiting for it is counted all the same",
        async (_label, briefId, givenBack, images) => {
          const controller = new AbortController();
          const reason = new Error("revamp halted: cancelled");
          const reported: RevampUsage[] = [];
          const { client } = stoppedWhileDrawing(
            briefId,
            controller,
            reason,
            true,
          );
          await expect(
            drawRevampPhotos(
              makeCtx(controller.signal).ctx,
              input((usage) => reported.push(usage)),
              { imageClient: client, reviewer: null, prepare, concurrency: 1 },
            ),
          ).rejects.toBe(reason);
          expect(h.claims).toEqual([5]);
          expect(sum(h.releases)).toBe(givenBack);
          expect(total(reported)).toMatchObject({ images });
        },
      );

      describe("through the real image client (image-vertex.ts)", () => {
        /** A provider answer carrying one JPEG. */
        const answer = {
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    inlineData: {
                      data: Buffer.from("jpeg").toString("base64"),
                      mimeType: "image/jpeg",
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 1690 },
        };
        /**
         * The redesign's photo client, real but for its send: Google never
         * answers `briefId`, and the run stops `afterMs` after it was sent.
         */
        const realClient = async (
          briefId: string,
          controller: AbortController,
          reason: Error,
          afterMs: number,
        ) => {
          const { createVertexImageClient } = await vi.importActual<
            typeof import("@/lib/theme-studio/image-vertex")
          >("@/lib/theme-studio/image-vertex");
          return createVertexImageClient(
            {
              projectId: "project",
              location: "global",
              modelKey: "gemini-nano-banana-2.1",
              providerModel: "gemini-nano-banana-2.1",
            },
            {
              imageSize: "2K",
              thinkingLevel: ThinkingLevel.MEDIUM,
              markStoppedInFlight: true,
              pool: new ImageRequestPool(),
              send: async (request) => {
                if (request.briefId !== briefId) return answer as never;
                setTimeout(() => controller.abort(reason), afterMs);
                return new Promise<never>(() => {});
              },
            },
          );
        };

        it("★★ the anchor cut off on the wire keeps its photo spent", async () => {
          const controller = new AbortController();
          const reason = new Error("revamp halted: cancelled");
          const reported: RevampUsage[] = [];
          await expect(
            drawRevampPhotos(
              makeCtx(controller.signal).ctx,
              input((usage) => reported.push(usage)),
              {
                imageClient: await realClient("anchor", controller, reason, 5),
                reviewer: null,
                prepare,
              },
            ),
          ).rejects.toBe(reason);
          expect(h.claims).toEqual([5]);
          expect(h.releases).toEqual([4]);
          expect(total(reported)).toMatchObject({ images: 1 });
        });

        it("★★ so does the last shot of three drawn at once", async () => {
          const controller = new AbortController();
          const reason = new Error("revamp halted: cancelled");
          const reported: RevampUsage[] = [];
          await expect(
            drawRevampPhotos(
              makeCtx(controller.signal).ctx,
              input((usage) => reported.push(usage)),
              {
                imageClient: await realClient(
                  "category-shakes",
                  controller,
                  reason,
                  30,
                ),
                reviewer: null,
                prepare,
                concurrency: 3,
              },
            ),
          ).rejects.toBe(reason);
          // The anchor and all four shots: none goes back.
          expect(h.claims).toEqual([5]);
          expect(sum(h.releases)).toBe(0);
          expect(total(reported)).toMatchObject({ images: 5 });
        });
      });
    });

    it("★★ a run the deadline drains has reported what it paid for, and the next run reports only the rest", async () => {
      const drain = new AbortController();
      const ctx = { ...makeCtx().ctx, draining: drain.signal };
      const first: RevampUsage[] = [];
      const draws = makeClient(
        () => "ok",
        (request) => {
          if (request.briefId === "hero-1") drain.abort();
        },
        DRAW,
      );
      const { reviewer, seen } = makeReviewer(() => [], REVIEW);
      const error = await drawRevampPhotos(
        ctx,
        input((usage) => first.push(usage)),
        { imageClient: draws.client, reviewer, prepare, concurrency: 1 },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RevampDrainedError);
      // The anchor, its review, and the hero drawn in flight at the
      // deadline; nothing was sent after it.
      expect(first).toHaveLength(3);
      expect(total(first)).toMatchObject({ images: 2, reviews: 1 });

      const second: RevampUsage[] = [];
      const next = makeClient(() => "ok", undefined, DRAW);
      const stored = [...h.rows.values()].filter((r) => r.revampId === REVAMP);
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        input((usage) => second.push(usage), stored),
        { imageClient: next.client, reviewer, prepare },
      );
      // The parked hero's review, then the three shots left and theirs.
      expect(total(second)).toMatchObject({ images: 3, reviews: 4 });
      expect(run.usage).toEqual(total(second));
      // Across the hand-over every call sent was reported exactly once.
      expect(first.length + second.length).toBe(
        draws.sent() + next.sent() + seen.length,
      );
    });

    it("keeps drawing when the reporter throws: the record loses that call, never a photograph", async () => {
      const { client } = makeClient(() => "ok", undefined, DRAW);
      const run = await drawRevampPhotos(
        makeCtx().ctx,
        input(() => {
          throw new Error("checkpoint write failed");
        }),
        { imageClient: client, reviewer: null, prepare },
      );
      expect(run.images.filter((i) => i.role === "slot")).toHaveLength(5);
      expect(run.usage.images).toBe(5);
      expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
        "mink.revamp: a photo call's usage could not be reported",
        expect.objectContaining({ error: "checkpoint write failed" }),
      );
    });
  });

  it("crops a stand-in from a kept photo of the shoot when one shot cannot be drawn, never from the anchor", async () => {
    const { client } = makeClient((r) =>
      r.briefId === "refill-0001" ? "outage" : "ok",
    );
    const run = await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );
    const refill = h.saves.filter((s) => s.slotId === "refill-0001");
    expect(refill).toHaveLength(1);
    expect(refill[0].review).toBe("flagged");
    expect(refill[0].problems).toContain("recrop-cause:failed");
    // ★★ The least cut kept photo on another page (the square category
    //    photo); the anchor's 4:3 would have fitted exactly (B16).
    expect(refill[0].problems).toContain("recrop-source:category-shakes");
    expect(text(refill[0].bytes)).toMatch(/^img:category-shakes:/);
    expect(outcome(run, "refill-0001")).toEqual({
      shotId: "refill-0001",
      status: "failed",
      reason: expect.stringContaining("could not finish this picture"),
    });
    expect(outcome(run, "hero-1")?.status).toBe("generated");
    // A call the outage answered may have been billed: nothing goes back.
    expect(sum(h.releases)).toBe(0);
  });

  // ★★ An anchor that can never come back fails the job at once, with the
  //   closed code whose sentence is true for it. Each of these used to be
  //   photos_unavailable, whose sentence says the photo service was too busy
  //   and to try again in a few minutes, which no wait fixes.
  const busyService = REVAMP_ERROR_MESSAGES.photos_unavailable;

  it("★★ refuses the step when the anchor is declined, as the model's own refusal, and gives the photos back", async () => {
    const { client } = makeClient((r) =>
      r.purpose === "anchor" ? "refuse" : "ok",
    );
    const promise = drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );
    await expect(promise).rejects.toMatchObject({
      code: "model_refused",
      transient: false,
    });
    expect(REVAMP_ERROR_MESSAGES.model_refused).not.toBe(busyService);
    expect(h.saves).toEqual([]);
    expect(sum(h.releases)).toBe(5);
  });

  it("★★ fails as photos_failed when every anchor drawn fails its check", async () => {
    const { reviewer } = makeReviewer((candidate) =>
      candidate.startsWith("img:anchor") ? ["wrong_subject"] : [],
    );
    const { client, briefs } = makeClient();
    const error = await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer, prepare },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevampStepError);
    expect(error).toMatchObject({ code: "photos_failed", transient: false });
    expect(REVAMP_ERROR_MESSAGES.photos_failed).not.toBe(busyService);
    // Drawn again after each check it failed, and nothing else was drawn.
    expect(briefs().length).toBeGreaterThan(1);
    expect(new Set(briefs())).toEqual(new Set(["anchor"]));
    expect(h.saves).toEqual([]);
  });

  it("★ fails as internal when the model turns the anchor's request itself down, never as a wait", async () => {
    const { client } = makeClient((r) =>
      r.purpose === "anchor" ? "turned_down" : "ok",
    );
    const error = await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevampStepError);
    expect(error).toMatchObject({ code: "internal", transient: false });
    expect(REVAMP_ERROR_MESSAGES.internal).not.toMatch(/busy|few minutes/i);
    expect(h.saves).toEqual([]);
  });

  it("treats an anchor outage as transient", async () => {
    const { client } = makeClient((r) =>
      r.purpose === "anchor" ? "outage" : "ok",
    );
    const promise = drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevampStepError);
    expect(error).toMatchObject({
      code: "photos_unavailable",
      transient: true,
    });
    // The anchor call may have been billed; the four shots go back.
    expect(sum(h.releases)).toBe(4);
  });

  it("lets an abort through untouched, keeping what was already stored", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    const { client } = makeClient(
      () => "ok",
      (request) => {
        if (request.briefId === "story-1") controller.abort(reason);
      },
    );
    const promise = drawRevampPhotos(
      makeCtx(controller.signal).ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare, concurrency: 1 },
    );
    await expect(promise).rejects.toBe(reason);
    expect(savedSlots()).toEqual(
      expect.arrayContaining(["anchor", "hero-1", "hero-1~phone"]),
    );
    expect(savedSlots()).not.toContain("refill-0001");
    expect(h.saves.some((s) => s.review === "flagged")).toBe(false);
    // Anchor and hero were drawn; the other three photos go back.
    expect(sum(h.releases)).toBe(3);
  });

  it("uses the offline client and reviewer when the provider is fake", async () => {
    vi.stubEnv("MINK_REVAMP_PROVIDER", "fake");
    const fake = makeClient();
    h.fakeClient = fake.client;
    const reviews: unknown[] = [];
    h.fakeReviewer = {
      provider: "fake",
      async generate(request) {
        reviews.push(request);
        return {
          kind: "ok",
          usage: ZERO_USAGE,
          value: { problems: [], note: "" },
        };
      },
    };
    const run = await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { prepare },
    );
    expect(fake.calls.length).toBe(5);
    // ★ The model's own output sizes, so a wide photo leaves a phone crop the
    //   storefront accepts (Theme Studio's own fakes keep their 2K edge).
    expect(h.fakeClientOptions).toEqual([{ size: "model" }]);
    expect(reviews.length).toBeGreaterThan(0);
    expect(h.saves.find((s) => s.slotId === "hero-1")?.review).toBe("passed");
    expect(run.usage.reviews).toBeGreaterThan(0);
  });

  it("gives the claimed photos back when no image model is configured, failing as StoreMink's own fault", async () => {
    vi.stubEnv("MINK_REVAMP_PROVIDER", "vertex");
    h.imageConfig = null;
    const promise = drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan(),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { prepare },
    );
    // ★ Not a busy photo service: no wait fixes a missing setting.
    await expect(promise).rejects.toMatchObject({
      code: "internal",
      transient: false,
    });
    expect(h.claims).toEqual([5]);
    expect(sum(h.releases)).toBe(5);

    // Nor one that cannot be read.
    h.imageConfig = new Error("the image model setting cannot be read");
    await expect(
      drawRevampPhotos(
        makeCtx().ctx,
        {
          plan: makePlan(),
          snapshot: makeSnapshot(),
          stored: [],
          inherited: [],
          redraw: null,
        },
        { prepare },
      ),
    ).rejects.toMatchObject({ code: "internal", transient: false });
    expect(sum(h.releases)).toBe(10);
  });

  it("returns at once when no section uses a photograph", async () => {
    const { client, calls } = makeClient();
    const run = await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: makePlan({ bindings: [] }),
        snapshot: makeSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );
    expect(calls).toHaveLength(0);
    expect(h.claims).toEqual([]);
    expect(run.outcomes.every((o) => o.status === "skipped" && o.reason)).toBe(
      true,
    );
  });

  it("refuses without storage, and refuses another store's snapshot", async () => {
    const input = {
      plan: makePlan(),
      snapshot: makeSnapshot(),
      stored: [],
      inherited: [],
      redraw: null,
    };
    h.configured = false;
    // ★ StoreMink's own setup, not a busy photo service: no wait fixes it.
    await expect(
      drawRevampPhotos(makeCtx().ctx, input, { prepare }),
    ).rejects.toMatchObject({ code: "internal", transient: false });
    h.configured = true;
    await expect(
      drawRevampPhotos(
        makeCtx().ctx,
        { ...input, snapshot: makeSnapshot({ storeId: PARENT }) },
        { prepare },
      ),
    ).rejects.toMatchObject({ code: "internal" });
  });
});

// ---------------------------------------------------------------------------
// ★★ B16: real goods or no goods. A shot of the merchant's goods is drawn with
// each product's OWN photo after the anchor, from this store's photos only;
// every other shot, and the anchor, shows no products; a product photo that
// cannot be read means no products, never invented ones.
// ---------------------------------------------------------------------------

describe("★★ real goods or no goods (B16)", () => {
  const OTHER_STORE = "44444444-4444-4444-8444-444444444444";
  const own = (name: string) =>
    `https://storage.googleapis.com/bucket/stores/${STORE}/media/${name}.jpg`;
  const FOREIGN = `https://storage.googleapis.com/bucket/stores/${OTHER_STORE}/media/wash.jpg`;

  async function jpeg(colour: { r: number; g: number; b: number }) {
    return new Uint8Array(
      await sharp({
        create: { width: 600, height: 800, channels: 3, background: colour },
      })
        .jpeg()
        .toBuffer(),
    );
  }

  /** The plan with goods on some shots; the rest name none. */
  function goodsPlan(goods: Record<string, Partial<RevampShot>>) {
    return makePlan({
      shots: SHOTS.map((s) => ({ ...s, ...(goods[s.id] ?? {}) })),
    });
  }

  function goodsSnapshot() {
    return makeSnapshot({
      products: [
        {
          id: "prod-aloe",
          name: "Aloe gel",
          slug: "aloe-gel",
          status: "published",
          updatedAt: "2026-10-01T00:00:00Z",
          sample: false,
          imageUrl: own("aloe"),
          categoryId: null,
        },
        {
          // Somebody else's photo: never this store's to show.
          id: "prod-foreign",
          name: "Foreign wash",
          slug: "foreign-wash",
          status: "published",
          updatedAt: "2026-10-01T00:00:00Z",
          sample: false,
          imageUrl: FOREIGN,
          categoryId: null,
        },
      ],
      categories: [],
      pages: [],
      photos: { replaceable: [], broken: [] },
    });
  }

  const request = {
    brief: { business: "Herbal skincare made by hand in Pune" },
    products: [
      {
        key: "p1",
        name: "Neem face wash",
        description: "",
        sizes: [],
        photoUrl: own("p1"),
        categorySlug: null,
      },
    ],
  } as unknown as RevampRequest;

  /**
   * A check keeping every request it was sent: it passes everything, except
   * that `outages` of the hero's first checks get no answer.
   */
  function capturingReviewer(outages = 0) {
    const requests: StructuredRequest[] = [];
    let heroAsks = 0;
    const client: ThemeStudioModelClient = {
      provider: "fake",
      async generate(reviewRequest) {
        requests.push(reviewRequest);
        const candidate = reviewRequest.content.find((b) => b.type === "image");
        const hero =
          candidate?.type === "image" &&
          Buffer.from(candidate.base64, "base64")
            .toString()
            .startsWith("img:hero-1:");
        if (hero && heroAsks++ < outages) {
          return {
            kind: "error",
            code: "provider_unavailable",
            usage: ZERO_USAGE,
          };
        }
        return {
          kind: "ok",
          usage: ZERO_USAGE,
          value: { problems: [], note: "" },
        };
      },
    };
    return { reviewer: { client, providerModel: "fake" }, requests };
  }

  const reviewText = (r: StructuredRequest) =>
    r.content.map((b) => (b.type === "text" ? b.text : "<image>")).join("\n");
  /** The check of a shot: the one shown that shot's own drawn picture. */
  const reviewOf = (requests: StructuredRequest[], briefId: string) =>
    requests.find((r) => {
      const candidate = r.content.find((b) => b.type === "image");
      return (
        candidate?.type === "image" &&
        Buffer.from(candidate.base64, "base64")
          .toString()
          .startsWith(`img:${briefId}:`)
      );
    });
  const isWebp = (base64: string) => {
    const bytes = Buffer.from(base64, "base64");
    return (
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP"
    );
  };

  it("★★ sends each named product's own photo after the anchor, read from this store's photos only, and checks the photo against them", async () => {
    h.storePhotos.set(own("p1"), await jpeg({ r: 30, g: 140, b: 60 }));
    h.storePhotos.set(own("aloe"), await jpeg({ r: 200, g: 230, b: 120 }));
    // Even present in the bucket, another store's photo is never asked for.
    h.storePhotos.set(FOREIGN, await jpeg({ r: 250, g: 0, b: 0 }));
    const { client, calls } = makeClient();
    const { reviewer, requests } = capturingReviewer();
    await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: goodsPlan({
          "hero-1": {
            goods: "merchant",
            productKeys: ["p1", "shop:foreign-wash"],
          },
          "category-shakes": {
            goods: "merchant",
            productKeys: ["shop:aloe-gel"],
          },
        }),
        snapshot: goodsSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
        request,
      },
      { imageClient: client, reviewer, prepare },
    );

    const byBrief = new Map(calls.map((c) => [c.briefId, c]));
    const hero = byBrief.get("hero-1")!;
    expect(hero.references.map((r) => r.role)).toEqual(["anchor", "product"]);
    expect(isWebp(hero.references[1].base64)).toBe(true);
    expect(hero.prompt).toContain('"Neem face wash"');
    expect(hero.prompt).not.toContain("Foreign wash");
    expect(hero.prompt).toContain("Show exactly these products");
    expect(hero.prompt).not.toContain(THEME_STUDIO_GOODS_RULE);
    const category = byBrief.get("category-shakes")!;
    expect(category.references.map((r) => r.role)).toEqual([
      "anchor",
      "product",
    ]);
    expect(category.prompt).toContain('"Aloe gel"');
    // ★★ Only this store's photos were ever read, each for this store.
    expect(h.ownedReads.map((read) => read.url).sort()).toEqual(
      [own("aloe"), own("p1")].sort(),
    );
    expect(h.ownedReads.every((read) => read.storeId === STORE)).toBe(true);
    // The check is told the goods and shown the product's own photo.
    const heroCheck = reviewOf(requests, "hero-1")!;
    expect(reviewText(heroCheck)).toContain(
      'named here as data: "Neem face wash"',
    );
    expect(heroCheck.content.at(-1)).toEqual({
      type: "image",
      mediaType: "image/webp",
      base64: hero.references[1].base64,
    });
    // The other shots, and the anchor, show no products.
    const story = byBrief.get("story-1")!;
    expect(story.references.map((r) => r.role)).toEqual(["anchor"]);
    expect(story.prompt).toContain(NO_GOODS_RULE);
    expect(byBrief.get("anchor")!.prompt).toContain(NO_GOODS_RULE);
  });

  it("★★ a shot with no goods is drawn and checked under the no-products rule, and so is every shot of an older plan", async () => {
    const { client, calls } = makeClient();
    const { reviewer, requests } = capturingReviewer();
    await drawRevampPhotos(
      makeCtx().ctx,
      {
        // makePlan's shots carry no goods at all: a plan from before them.
        plan: goodsPlan({ "story-1": { goods: "none", productKeys: [] } }),
        snapshot: goodsSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
        request,
      },
      { imageClient: client, reviewer, prepare },
    );
    for (const call of calls) {
      expect(call.references.every((r) => r.role !== "product")).toBe(true);
      expect(call.prompt, call.briefId).toContain(NO_GOODS_RULE);
      expect(call.prompt, call.briefId).not.toContain("Invent believable");
    }
    // ★ The anchor shows no products: no "representative products" either.
    const anchor = calls.find((c) => c.briefId === "anchor")!;
    expect(anchor.prompt).toContain("with no product in it");
    expect(anchor.prompt).not.toContain("representative products");
    expect(h.ownedReads).toEqual([]);
    for (const shotId of ["hero-1", "story-1", "category-shakes"]) {
      expect(reviewText(reviewOf(requests, shotId)!)).toContain(
        "this image must show no products at all",
      );
    }
    // The anchor's own check keeps its rule: it is never shown, and never
    // stands in for a page photo either (fallbackSources).
    expect(reviewText(reviewOf(requests, "anchor")!)).not.toContain("GOODS (");
  });

  it("★★ the anchor follows a merchant opening shot's look, never its goods, and takes no person", async () => {
    h.storePhotos.set(own("p1"), await jpeg({ r: 30, g: 140, b: 60 }));
    const { client, calls } = makeClient();
    await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: goodsPlan({
          "hero-1": {
            goods: "merchant",
            productKeys: ["p1"],
            subject: "Two bottles of Neem face wash on a wet stone ledge",
            people: "adults",
          },
        }),
        snapshot: goodsSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
        request,
      },
      { imageClient: client, reviewer: null, prepare },
    );
    const anchor = calls.find((c) => c.briefId === "anchor")!;
    // ★★ No product the anchor could only invent: not the subject's goods,
    //    the store's own setting instead, with the shoot's art direction.
    expect(anchor.prompt).not.toContain("Neem face wash");
    expect(anchor.prompt).not.toContain("bottles");
    expect(anchor.prompt).toContain(
      "the setting behind Almond House (Herbal skincare made by hand in Pune): its place, materials and light, with no products in the picture",
    );
    expect(anchor.prompt).toContain(
      "Art direction: Almond shakes on a sunlit counter, soft light",
    );
    expect(anchor.prompt).toContain(NO_GOODS_RULE);
    expect(anchor.prompt).toContain(NO_GOODS_PEOPLE_RULE);
    expect(anchor.references).toEqual([]);
    // The opening shot itself still shows the product, from its own photo.
    const hero = calls.find((c) => c.briefId === "hero-1")!;
    expect(hero.prompt).toContain(
      "Subject: Two bottles of Neem face wash on a wet stone ledge",
    );
    expect(hero.references.map((r) => r.role)).toEqual(["anchor", "product"]);
  });

  it("★★ a shot whose product photo cannot be read is described by what it shows: a scene with nobody and no product in it", async () => {
    // No photo for p1 in the bucket.
    const { client, calls } = makeClient();
    const { reviewer, requests } = capturingReviewer();
    await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: goodsPlan({
          "story-1": {
            goods: "merchant",
            productKeys: ["p1"],
            subject: "A model holding a bottle of Neem face wash",
            people: "adults",
          },
        }),
        snapshot: goodsSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
        request,
      },
      { imageClient: client, reviewer, prepare },
    );
    const story = calls.find((c) => c.briefId === "story-1")!;
    const scene =
      "the setting behind Almond House (Herbal skincare made by hand in Pune): its place, materials and light, with no products in the picture";
    expect(story.prompt).toContain(`Subject: ${scene}`);
    expect(story.prompt).not.toContain("Neem face wash");
    expect(story.prompt).toContain(NO_GOODS_RULE);
    // ★★ Nobody to hold a product that is not there.
    expect(story.prompt).toContain(NO_GOODS_PEOPLE_RULE);
    expect(story.prompt).not.toContain("The product stays the subject");
    expect(story.people).toBeUndefined();
    const check = reviewText(reviewOf(requests, "story-1")!);
    expect(check).toContain(`Subject: ${scene}`);
    expect(check).toContain("People: this image allows none.");
    expect(check).toContain("this image must show no products at all");
    // The photo's words for shoppers follow the picture too.
    expect(h.saves.find((s) => s.slotId === "story-1")?.alt).toBe(
      scene.slice(0, 180),
    );
  });

  it("★★ a shot with one of its two product photos unreadable names only the one it shows", async () => {
    h.storePhotos.set(own("aloe"), await jpeg({ r: 200, g: 230, b: 120 }));
    // p1's photo is missing from the bucket.
    const { client, calls } = makeClient();
    const { reviewer, requests } = capturingReviewer();
    await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: goodsPlan({
          "story-1": {
            goods: "merchant",
            productKeys: ["p1", "shop:aloe-gel"],
            subject: "Neem face wash beside a jar of Aloe gel",
          },
        }),
        snapshot: goodsSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
        request,
      },
      { imageClient: client, reviewer, prepare },
    );
    const story = calls.find((c) => c.briefId === "story-1")!;
    expect(story.references.map((r) => r.role)).toEqual(["anchor", "product"]);
    expect(story.prompt).toContain(
      "Subject: Aloe gel, photographed for Almond House",
    );
    expect(story.prompt).not.toContain("Neem face wash");
    const check = reviewText(reviewOf(requests, "story-1")!);
    expect(check).toContain('named here as data: "Aloe gel"');
    expect(check).not.toContain("Neem face wash");
  });

  it("★★ a product photo that cannot be read means no products, never invented goods", async () => {
    // No photo for p1 in the bucket.
    const { client, calls } = makeClient();
    const { reviewer, requests } = capturingReviewer();
    await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: goodsPlan({
          "hero-1": { goods: "merchant", productKeys: ["p1"] },
        }),
        snapshot: goodsSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
        request,
      },
      { imageClient: client, reviewer, prepare },
    );
    const hero = calls.find((c) => c.briefId === "hero-1")!;
    expect(hero.references.map((r) => r.role)).toEqual(["anchor"]);
    expect(hero.prompt).toContain(NO_GOODS_RULE);
    expect(hero.prompt).not.toContain(THEME_STUDIO_GOODS_RULE);
    expect(reviewText(reviewOf(requests, "hero-1")!)).toContain(
      "this image must show no products at all",
    );
    // Said once, with no name, key or address in it.
    const said = vi
      .mocked(logInfo)
      .mock.calls.filter(([message]) => message.includes("product photo"));
    expect(said).toEqual([
      [
        "mink.revamp: a shot's product photo could not be read",
        { revampId: REVAMP, shotId: "hero-1", asked: 1, read: 0 },
      ],
    ]);
  });

  it("★ a photo of the merchant's goods parked for its check is checked later against the same goods", async () => {
    h.storePhotos.set(own("p1"), await jpeg({ r: 30, g: 140, b: 60 }));
    const { client } = makeClient();
    const { reviewer, requests } = capturingReviewer(1);
    const { sleep } = recordingSleep();
    const run = await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: goodsPlan({
          "hero-1": { goods: "merchant", productKeys: ["p1"] },
        }),
        snapshot: goodsSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
        request,
      },
      { imageClient: client, reviewer, prepare, sleep },
    );
    const heroChecks = requests.filter((r) =>
      reviewText(r).includes("PRODUCT ("),
    );
    // The engine's first ask, then the delayed one: both told the goods.
    expect(heroChecks).toHaveLength(2);
    for (const check of heroChecks) {
      expect(reviewText(check)).toContain(
        'named here as data: "Neem face wash"',
      );
    }
    expect(run.images.find((i) => i.slotId === "hero-1")?.review).toBe(
      "passed",
    );
  });

  it("★ without the request, a product named by its request key shows no products", async () => {
    h.storePhotos.set(own("p1"), await jpeg({ r: 30, g: 140, b: 60 }));
    const { client, calls } = makeClient();
    await drawRevampPhotos(
      makeCtx().ctx,
      {
        plan: goodsPlan({
          "hero-1": { goods: "merchant", productKeys: ["p1"] },
        }),
        snapshot: goodsSnapshot(),
        stored: [],
        inherited: [],
        redraw: null,
      },
      { imageClient: client, reviewer: null, prepare },
    );
    const hero = calls.find((c) => c.briefId === "hero-1")!;
    expect(hero.references.map((r) => r.role)).toEqual(["anchor"]);
    expect(hero.prompt).toContain(NO_GOODS_RULE);
    expect(h.ownedReads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ★★ B14: a photo smaller than its frame is drawn again, once, inside the
// engine's redraw budget; of the two, the larger the check let through is
// kept; a photo still smaller than its frame is listed and never charged.
// ---------------------------------------------------------------------------

describe("★★ a photo smaller than its frame is drawn again once (B14)", () => {
  const input = () => ({
    plan: makePlan({ bindings: [BINDINGS[0]] }),
    snapshot: makeSnapshot(),
    stored: [] as RevampStoredImage[],
    inherited: [] as RevampStoredImage[],
    redraw: null,
  });

  /**
   * Real pictures: the hero's draws at the sizes given, in turn ("outage"
   * gets no picture); every other request at 2K.
   */
  function sequencedClient(hero: Array<[number, number] | "outage">) {
    const calls: ThemeImageRequest[] = [];
    const client: ThemeStudioImageClient = {
      provider: "fake",
      async generateImage(request): Promise<ThemeImageResult> {
        calls.push(request);
        const turn =
          request.briefId === "hero-1"
            ? hero[calls.filter((c) => c.briefId === "hero-1").length - 1]
            : MODEL_SIZES["2K"][request.aspectRatio];
        if (!turn || turn === "outage") {
          return {
            kind: "error",
            code: "provider_unavailable",
            usage: ZERO_IMAGE_USAGE,
          };
        }
        return {
          kind: "ok",
          bytes: await picture(turn[0], turn[1]),
          mediaType: "image/png",
          usage: ZERO_IMAGE_USAGE,
        };
      },
    };
    const heroCalls = () => calls.filter((c) => c.briefId === "hero-1");
    return { client, heroCalls };
  }

  /** A check answering in turn (the anchor's is the first), then passing. */
  function sequencedReviewer(...answers: ReviewAnswer[]) {
    let turn = 0;
    return makeReviewer(() => answers[turn++] ?? []);
  }

  const heroRow = () => h.rows.get(`${REVAMP}|slot|hero-1`);

  it("★★ a 1K draw its check passed is drawn again once, and the full-size redraw is kept and charged", async () => {
    const { client, heroCalls } = sequencedClient([
      [1584, 672],
      [3168, 1344],
    ]);
    const { reviewer } = makeReviewer(() => []);
    const run = await drawRevampPhotos(makeCtx().ctx, input(), {
      imageClient: client,
      reviewer,
    });
    expect(heroCalls()).toHaveLength(2);
    // The redraw says what happened, beside the closest fixed problem.
    expect(heroCalls()[1].prompt).toContain(
      "it came back at a lower resolution than the size asked for",
    );
    expect([heroRow()?.width, heroRow()?.height]).toEqual([2520, 1080]);
    expect(heroRow()?.review).toBe("passed");
    expect(heroRow()?.problems).toEqual([]);
    expect(outcome(run, "hero-1")).toEqual({
      shotId: "hero-1",
      status: "generated",
      reason: null,
      redraws: [{ attempt: 1, problems: [REVAMP_TOO_SMALL_CAUSE] }],
    });
    // ★ Inside the same claim: the anchor and the hero, one unit each.
    expect(h.claims).toEqual([2]);
    expect(sum(h.releases)).toBe(0);
  });

  it.each([
    ["the first is larger", [1584, 672], [1400, 600], 1568],
    ["the redraw is larger", [1400, 600], [1584, 672], 1568],
  ] as const)(
    "★★ when the redraw is also small, the larger is kept (%s), listed under Not done this time and not charged",
    async (_label, first, second, kept) => {
      const { client, heroCalls } = sequencedClient([
        [...first],
        [...second],
        [3168, 1344],
      ]);
      const { reviewer } = makeReviewer(() => []);
      const run = await drawRevampPhotos(makeCtx().ctx, input(), {
        imageClient: client,
        reviewer,
      });
      // ★ Drawn again once for its size, never twice.
      expect(heroCalls()).toHaveLength(2);
      expect(heroRow()?.width).toBe(kept);
      expect(heroRow()?.review).toBe("passed");
      expect(heroRow()?.problems).toEqual([REVAMP_SMALL_PROBLEM]);
      expect(outcome(run, "hero-1")).toMatchObject({
        status: "failed",
        reason: REVAMP_SMALL_PHOTO_REASON,
      });
      expect(h.claims).toEqual([2]);
    },
  );

  it("★ when the redraw does not come back, the first picture is kept with its own verdict, never the size redraw's problem", async () => {
    const { client, heroCalls } = sequencedClient([[1584, 672], "outage"]);
    const { reviewer } = makeReviewer(() => []);
    const run = await drawRevampPhotos(makeCtx().ctx, input(), {
      imageClient: client,
      reviewer,
    });
    expect(heroCalls()).toHaveLength(2);
    expect(heroRow()?.width).toBe(1568);
    expect(heroRow()?.review).toBe("passed");
    expect(heroRow()?.problems).toEqual([REVAMP_SMALL_PROBLEM]);
    expect(outcome(run, "hero-1")?.status).toBe("failed");
  });

  it("★ a small picture whose check found a blocking problem is redrawn for that problem, not its size", async () => {
    const { client, heroCalls } = sequencedClient([
      [1584, 672],
      [3168, 1344],
    ]);
    // The anchor passes; the hero's first picture carries lettering.
    const { reviewer } = sequencedReviewer([], ["text_or_logo"], []);
    const run = await drawRevampPhotos(makeCtx().ctx, input(), {
      imageClient: client,
      reviewer,
    });
    expect(heroCalls()).toHaveLength(2);
    expect(heroCalls()[1].prompt).not.toContain("lower resolution");
    expect(outcome(run, "hero-1")).toMatchObject({
      status: "generated",
      redraws: [{ attempt: 1, problems: ["text_or_logo"] }],
    });
    expect(heroRow()?.width).toBe(2520);
  });

  it("★ with no redraw left in the engine's budget, a small last attempt is kept and listed, never redrawn for its size", async () => {
    const { client, heroCalls } = sequencedClient([
      [3168, 1344],
      [3168, 1344],
      [1584, 672],
      [3168, 1344],
    ]);
    // Two pictures with lettering use up both redraws; the third is small.
    const { reviewer } = sequencedReviewer(
      [],
      ["text_or_logo"],
      ["text_or_logo"],
      [],
    );
    const run = await drawRevampPhotos(makeCtx().ctx, input(), {
      imageClient: client,
      reviewer,
    });
    expect(heroCalls()).toHaveLength(3);
    expect(heroRow()?.width).toBe(1568);
    expect(outcome(run, "hero-1")).toEqual({
      shotId: "hero-1",
      status: "failed",
      reason: REVAMP_SMALL_PHOTO_REASON,
      redraws: [
        { attempt: 1, problems: ["text_or_logo"] },
        { attempt: 2, problems: ["text_or_logo"] },
      ],
    });
  });

  it("★ a small photo parked for its check is promoted with its marker, listed, and not drawn again", async () => {
    const { client, heroCalls } = sequencedClient([[1584, 672]]);
    // The anchor passes; the hero's first check gets no answer, the next
    // (the delayed one) passes.
    const { reviewer } = sequencedReviewer([], "outage", []);
    const { sleep } = recordingSleep();
    const run = await drawRevampPhotos(makeCtx().ctx, input(), {
      imageClient: client,
      reviewer,
      sleep,
    });
    expect(heroCalls()).toHaveLength(1);
    expect(h.adoptCalls).toEqual([
      { slotId: "hero-1", problems: [REVAMP_SMALL_PROBLEM] },
    ]);
    expect(outcome(run, "hero-1")).toMatchObject({
      status: "failed",
      reason: REVAMP_SMALL_PHOTO_REASON,
    });
  });

  it("★ when the full-size redraw fails its delayed check, the first picture stands in, marked and listed", async () => {
    const { client, heroCalls } = sequencedClient([
      [1584, 672],
      [3168, 1344],
    ]);
    // The anchor passes, the small first picture passes, the redraw's check
    // gets no answer, and its delayed check finds lettering.
    const { reviewer } = sequencedReviewer([], [], "outage", ["text_or_logo"]);
    const { sleep } = recordingSleep();
    const run = await drawRevampPhotos(makeCtx().ctx, input(), {
      imageClient: client,
      reviewer,
      sleep,
    });
    expect(heroCalls()).toHaveLength(2);
    expect(heroRow()?.width).toBe(1568);
    expect(heroRow()?.review).toBe("passed");
    expect(heroRow()?.problems).toEqual([REVAMP_SMALL_PROBLEM]);
    expect(outcome(run, "hero-1")).toMatchObject({
      status: "failed",
      reason: REVAMP_SMALL_PHOTO_REASON,
    });
  });

  it("★ a first picture kept back for its size never beats the full-size redraw on problem count", async () => {
    const { client } = sequencedClient([
      [1584, 672],
      [3168, 1344],
    ]);
    // The redraw's delayed check finds a minor problem only.
    const { reviewer } = sequencedReviewer([], [], "outage", ["off_style"]);
    const { sleep } = recordingSleep();
    const run = await drawRevampPhotos(makeCtx().ctx, input(), {
      imageClient: client,
      reviewer,
      sleep,
    });
    expect(heroRow()?.width).toBe(2520);
    expect(heroRow()?.review).toBe("flagged");
    expect(outcome(run, "hero-1")?.status).toBe("generated");
  });

  it("★ a later invocation still lists a photo an earlier one kept smaller than its frame", async () => {
    const anchor = seedRow(REVAMP, "anchor", "anchor", 1600, 1200);
    const hero = seedRow(REVAMP, "slot", "hero-1", 1568, 672);
    h.rows.get(`${REVAMP}|slot|hero-1`)!.problems = [REVAMP_SMALL_PROBLEM];
    h.objects.set(hero.path, await picture(1568, 672, "webp"));
    const { client, heroCalls } = sequencedClient([]);
    const run = await drawRevampPhotos(
      makeCtx().ctx,
      { ...input(), stored: [anchor, hero] },
      { imageClient: client, reviewer: null },
    );
    expect(heroCalls()).toEqual([]);
    expect(outcome(run, "hero-1")).toMatchObject({
      status: "failed",
      reason: REVAMP_SMALL_PHOTO_REASON,
    });
  });
});

describe("bounded image work", () => {
  function boundedInput(stored: RevampStoredImage[] = [], withAbout = false) {
    const shots = [
      shot("one", "hero", "A quiet setting"),
      shot("two", "content", "Materials"),
      shot("three", "content", "The shop"),
    ].map((shot) => ({ ...shot, goods: "none" as const, productKeys: [] }));
    if (withAbout)
      shots.push({
        ...shot("about", "content", "The shop"),
        goods: "none",
        productKeys: [],
      });
    return {
      plan: makePlan({
        shots,
        bindings: shots.map((shot) =>
          binding(
            shot.id,
            shot.id === "about" ? "about" : "",
            `s-${shot.id}`,
            frame(1200, 1200),
          ),
        ),
      }),
      snapshot: makeSnapshot(),
      stored,
      inherited: [],
      redraw: null,
    };
  }

  it("journals image attempts before sending and resumes the prior correction", async () => {
    const stored = [seedRow(REVAMP, "anchor", "anchor", 1200, 1200)];
    const reviews = reviewsPort({
      shots: { one: { tries: 0, draws: 2, correction: "wrong_subject" } },
    });
    const model = makeClient();
    const observed: number[] = [];
    const client: ThemeStudioImageClient = {
      provider: "fake",
      generateImage: async (request, signal) => {
        observed.push(reviews.current()?.shots[request.briefId]?.draws ?? 0);
        return model.client.generateImage(request, signal);
      },
    };
    const { reviewer } = makeReviewer(() => []);
    const ctx = {
      ...makeCtx().ctx,
      finishBy: Date.now() + 12 * 60_000,
      photoReviews: reviews.port,
    };
    const run = await drawRevampPhotos(ctx, boundedInput(stored), {
      imageClient: client,
      reviewer,
      prepare,
      concurrency: 1,
    });
    expect(model.briefs().filter((id) => id === "one")).toHaveLength(1);
    expect(
      model.calls.find((request) => request.briefId === "one")?.prompt,
    ).toContain("wrong_subject");
    expect(observed.every((attempt) => attempt > 0)).toBe(true);
    expect(reviews.current()?.shots.one.draws).toBe(3);
    expect(run.images.filter((image) => image.role === "slot")).toHaveLength(3);
  });

  it("checks a paid candidate recovered after a crash without drawing it again", async () => {
    const stored = [
      seedRow(REVAMP, "anchor", "anchor", 1200, 1200),
      seedRow(REVAMP, "slot", "one~candidate-1", 1200, 1200),
    ];
    stored[1] = { ...stored[1], review: "unreviewed" };
    const reviews = reviewsPort({ shots: { one: { tries: 0, draws: 1 } } });
    const model = makeClient();
    const ctx = {
      ...makeCtx().ctx,
      finishBy: Date.now() + 12 * 60_000,
      photoReviews: reviews.port,
    };
    const run = await drawRevampPhotos(ctx, boundedInput(stored), {
      imageClient: model.client,
      reviewer: makeReviewer(() => []).reviewer,
      prepare,
    });
    expect(model.briefs()).not.toContain("one");
    expect(run.images.find((image) => image.slotId === "one")?.review).toBe(
      "passed",
    );
    expect(
      run.images.every((image) => !image.slotId.includes("~candidate-")),
    ).toBe(true);
  });

  it("cannot send more images after a previous invocation spent the whole image budget", async () => {
    const reviews = reviewsPort({ shots: { old: { tries: 0, draws: 11 } } });
    const model = makeClient();
    const stored = [seedRow(REVAMP, "anchor", "anchor", 1200, 1200)];
    const ctx = {
      ...makeCtx().ctx,
      finishBy: Date.now() + 12 * 60_000,
      photoReviews: reviews.port,
    };
    await expect(
      drawRevampPhotos(ctx, boundedInput(stored), {
        imageClient: model.client,
        reviewer: makeReviewer(() => []).reviewer,
        prepare,
      }),
    ).rejects.toMatchObject({ code: "photos_failed" });
    expect(model.calls).toHaveLength(0);
  });

  it("does not complete with unchecked homepage photos when the reviewer is unavailable", async () => {
    const model = makeClient();
    const ctx = {
      ...makeCtx().ctx,
      finishBy: Date.now() + 12 * 60_000,
      photoReviews: reviewsPort().port,
    };
    await expect(
      drawRevampPhotos(ctx, boundedInput(), {
        imageClient: model.client,
        reviewer: null,
        prepare,
      }),
    ).rejects.toMatchObject({ code: "photos_failed" });
  });

  it("finishes with compatible checked crops when no complete new image attempt fits", async () => {
    const stored = ["one", "two", "three"].map((id) =>
      seedRow(REVAMP, "slot", id, 1200, 1200),
    );
    const model = makeClient();
    const ctx = {
      ...makeCtx().ctx,
      finishBy: Date.now() + 2 * 60_000,
      draining: new AbortController().signal,
    };
    const run = await drawRevampPhotos(ctx, boundedInput(stored, true), {
      imageClient: model.client,
      reviewer: makeReviewer(() => []).reviewer,
      prepare,
    });
    expect(model.calls).toHaveLength(0);
    expect(run.images.find((image) => image.slotId === "about")).toBeDefined();
    expect(run.images.some((image) => image.review === "unreviewed")).toBe(
      false,
    );
  });

  it("hands over at the invocation drain without omitting unfinished photographs", async () => {
    const stored = ["one", "two", "three"].map((id) =>
      seedRow(REVAMP, "slot", id, 1200, 1200),
    );
    const drain = new AbortController();
    drain.abort();
    const model = makeClient();
    await expect(
      drawRevampPhotos(
        { ...makeCtx().ctx, recoverable: true, draining: drain.signal },
        boundedInput(stored, true),
        {
          imageClient: model.client,
          reviewer: makeReviewer(() => []).reviewer,
          prepare,
        },
      ),
    ).rejects.toBeInstanceOf(RevampDrainedError);
    expect(model.calls).toHaveLength(0);
    expect([...h.rows.values()].some((row) => row.slotId === "about")).toBe(
      false,
    );
  });

  it("retains checked photos through repeated free 429s without spending redraws, then finishes", async () => {
    const anchor = seedRow(REVAMP, "anchor", "anchor", 1200, 1200);
    const reviews = reviewsPort();
    const normal = makeClient();
    const client: ThemeStudioImageClient = {
      provider: "fake",
      generateImage: async (request, signal) =>
        request.briefId === "one"
          ? { kind: "error", code: "rate_limited", usage: ZERO_IMAGE_USAGE }
          : normal.client.generateImage(request, signal),
    };
    const ctx = {
      ...makeCtx().ctx,
      recoverable: true,
      photoReviews: reviews.port,
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        drawRevampPhotos(ctx, boundedInput([...h.rows.values()]), {
          imageClient: client,
          reviewer: makeReviewer(() => []).reviewer,
          prepare,
        }),
      ).rejects.toBeInstanceOf(RevampRetryLaterError);
      expect(reviews.current()?.shots.one.draws).toBe(0);
    }
    expect(normal.briefs().filter((id) => id === "two")).toHaveLength(1);
    expect(normal.briefs().filter((id) => id === "three")).toHaveLength(1);
    const finished = await drawRevampPhotos(
      ctx,
      boundedInput([...h.rows.values()]),
      {
        imageClient: normal.client,
        reviewer: makeReviewer(() => []).reviewer,
        prepare,
      },
    );
    expect(
      finished.images.filter((image) => image.role === "slot"),
    ).toHaveLength(3);
    expect(normal.briefs().filter((id) => id === "two")).toHaveLength(1);
    expect(normal.briefs()).not.toContain("anchor");
    expect(anchor.slotId).toBe("anchor");
  });

  it("keeps paid photos parked through a reviewer outage and later reviews without redrawing", async () => {
    seedRow(REVAMP, "anchor", "anchor", 1200, 1200);
    const reviews = reviewsPort();
    const ctx = {
      ...makeCtx().ctx,
      recoverable: true,
      photoReviews: reviews.port,
    };
    const model = makeClient();
    await expect(
      drawRevampPhotos(ctx, boundedInput([...h.rows.values()]), {
        imageClient: model.client,
        reviewer: makeReviewer(() => "outage").reviewer,
        prepare,
      }),
    ).rejects.toBeInstanceOf(RevampRetryLaterError);
    const draws = model.calls.length;
    const finished = await drawRevampPhotos(
      ctx,
      boundedInput([...h.rows.values()]),
      {
        imageClient: model.client,
        reviewer: makeReviewer(() => []).reviewer,
        prepare,
      },
    );
    expect(model.calls).toHaveLength(draws);
    expect(
      finished.images.filter((image) => image.role === "slot"),
    ).toHaveLength(3);
    expect(
      finished.images
        .filter((image) => image.role === "slot")
        .every((image) => image.review === "passed"),
    ).toBe(true);
  });

  it("reuses the paid hidden reference after its reviewer recovers", async () => {
    const reviews = reviewsPort();
    const ctx = {
      ...makeCtx().ctx,
      recoverable: true,
      photoReviews: reviews.port,
    };
    const model = makeClient();
    await expect(
      drawRevampPhotos(ctx, boundedInput(), {
        imageClient: model.client,
        reviewer: makeReviewer(() => "outage").reviewer,
        prepare,
      }),
    ).rejects.toBeInstanceOf(RevampRetryLaterError);
    expect(model.briefs()).toEqual(["anchor"]);
    expect(
      [...h.rows.values()].some(
        (image) => image.slotId === "anchor~candidate-1",
      ),
    ).toBe(true);
    const finished = await drawRevampPhotos(
      ctx,
      boundedInput([...h.rows.values()]),
      {
        imageClient: model.client,
        reviewer: makeReviewer(() => []).reviewer,
        prepare,
      },
    );
    expect(model.briefs().filter((id) => id === "anchor")).toHaveLength(1);
    expect(
      finished.images.filter((image) => image.role === "slot"),
    ).toHaveLength(3);
    expect(
      finished.images.every((image) => !image.slotId.includes("~candidate-")),
    ).toBe(true);
  });
});

describe("durable image admission", () => {
  it("does not send an image when its attempt reservation cannot be saved", async () => {
    const model = makeClient();
    const ctx = {
      ...makeCtx().ctx,
      finishBy: Date.now() + 12 * 60_000,
      photoReviews: {
        held: () => null,
        record: async () => {
          throw new Error("local journal unavailable");
        },
      },
    };
    await expect(
      drawRevampPhotos(
        ctx,
        {
          plan: makePlan(),
          snapshot: makeSnapshot(),
          stored: [],
          inherited: [],
          redraw: null,
        },
        {
          imageClient: model.client,
          reviewer: makeReviewer(() => []).reviewer,
          prepare,
        },
      ),
    ).rejects.toBeDefined();
    expect(model.calls).toHaveLength(0);
  });
});
