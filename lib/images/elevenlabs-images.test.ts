/* eslint-disable @typescript-eslint/no-explicit-any */
// One picture from ElevenLabs' Image API, with the fewest calls that can
// produce it. The owner's rule (22 Nov 2026): "the calls made should be fully
// optimised. no extra images should be drawn." What these tests hold:
//
//   • one picture is one submitted job;
//   • a submit is sent again only after an answer that proves no job was made;
//   • once a job id is known, nothing submits again;
//   • a job that was paid for and never collected is COLLECTED by the next
//     try for the same picture, not drawn a second time;
//   • quality and resolution are stated on every request (the API's own
//     default quality is `high`).
//
// Nothing here reaches a network: the API is a small in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("./elevenlabs-generations", () => ({
  postgresGenerationStore: {
    claimUndelivered: async () => null,
    recordSubmitted: async () => {},
    settle: async () => {},
    release: async () => {},
  },
}));

import {
  ELEVENLABS_IMAGE_MODEL,
  ELEVENLABS_RATE_LIMIT_RETRIES,
  ELEVENLABS_WAIT_CEILING_MS,
  drawElevenLabsImage,
  elevenLabsCostMicroUsd,
  elevenLabsCreditsEstimate,
  elevenLabsRequestBody,
  elevenLabsRequestDigest,
  finishElevenLabsPicture,
  type ElevenLabsDrawInput,
} from "./elevenlabs-images";
import type { GenerationStore } from "./elevenlabs-generations";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

function input(over: Partial<ElevenLabsDrawInput> = {}): ElevenLabsDrawInput {
  return {
    prompt: "A studio photograph of a plain mug",
    aspectRatio: "4:5",
    quality: "low",
    resolution: "1K",
    references: [],
    scope: "revamp:r1",
    ...over,
  };
}

/** The record of submitted jobs, in memory, with the real claim rules. */
function memoryStore() {
  const rows: {
    scope: string;
    digest: string;
    id: string;
    state: string;
    claimed: boolean;
  }[] = [];
  const store: GenerationStore = {
    async claimUndelivered(scope, digest) {
      const row = rows.find(
        (r) =>
          r.scope === scope &&
          r.digest === digest &&
          r.state === "submitted" &&
          !r.claimed,
      );
      if (!row) return null;
      row.claimed = true;
      return row.id;
    },
    async recordSubmitted(scope, digest, id) {
      rows.push({ scope, digest, id, state: "submitted", claimed: true });
    },
    async settle(id, state) {
      const row = rows.find((r) => r.id === id);
      if (row && row.state === "submitted") {
        row.state = state;
        row.claimed = false;
      }
    },
    async release(id) {
      const row = rows.find((r) => r.id === id);
      if (row && row.state === "submitted") row.claimed = false;
    },
  };
  return { store, rows };
}

type Job = {
  status: "pending" | "generating" | "completed" | "failed";
  /** Reads answered before the job is done. */
  readsBeforeDone: number;
  failure?: string;
};

/** A fake of the three calls: submit, read, download. */
function api() {
  const state = {
    seq: 0,
    posts: [] as any[],
    reads: [] as string[],
    downloads: [] as string[],
    jobs: new Map<string, Job>(),
    /** What the next submits answer, in order; then "ok". */
    submitPlan: [] as ("ok" | 429 | 500 | 422 | 401 | "throw" | "no-id")[],
    /** What the next reads answer before the job's own state. */
    readPlan: [] as (429 | 500 | "throw" | 404)[],
    downloadPlan: [] as ("fail" | "ok")[],
    nextJob: { readsBeforeDone: 1 } as Partial<Job>,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchFn = vi.fn(async (url: any, init: any = {}) => {
    const href = String(url);
    if (init.signal?.aborted) throw new Error("aborted");
    if (href.endsWith("/v1/flows/image") && init.method === "POST") {
      state.posts.push(JSON.parse(init.body));
      const plan = state.submitPlan.shift() ?? "ok";
      if (plan === "throw") throw new Error("socket hang up");
      if (plan === 429) {
        return json(429, { detail: { code: "concurrent_limit_exceeded" } });
      }
      if (plan === 500) return json(500, { detail: "oops" });
      if (plan === 422) return json(422, { detail: [{ msg: "bad" }] });
      if (plan === 401) return json(401, { detail: { code: "unauthorized" } });
      if (plan === "no-id") return json(200, { status: "pending" });
      const id = `gen_${++state.seq}`;
      state.jobs.set(id, {
        status: "pending",
        readsBeforeDone: 1,
        ...state.nextJob,
      } as Job);
      return json(200, { id, status: "pending" });
    }
    if (href.includes("/v1/flows/image/")) {
      const id = decodeURIComponent(href.split("/").pop()!);
      state.reads.push(id);
      const plan = state.readPlan.shift();
      if (plan === "throw") throw new Error("network");
      if (plan === 429) return json(429, {});
      if (plan === 500) return json(500, {});
      if (plan === 404) return json(404, {});
      const job = state.jobs.get(id);
      if (!job) return json(404, {});
      if (job.readsBeforeDone > 0) {
        job.readsBeforeDone -= 1;
        return json(200, { id, status: "generating" });
      }
      if (job.failure) {
        return json(200, {
          id,
          status: "failed",
          failure_reason: job.failure,
          error_message: "no",
        });
      }
      return json(200, {
        id,
        status: "completed",
        content_url: `https://files.test/${id}?n=${state.reads.length}`,
        content_mime_type: "image/png",
      });
    }
    if (href.startsWith("https://files.test/")) {
      state.downloads.push(href);
      if ((state.downloadPlan.shift() ?? "ok") === "fail") {
        return new Response("gone", { status: 403 });
      }
      return new Response(PNG, { status: 200 });
    }
    throw new Error(`unexpected request to ${href}`);
  });
  return { state, fetchFn };
}

/** A clock that moves only when the code sleeps. */
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function deps(
  a: ReturnType<typeof api>,
  store: GenerationStore,
  over: Record<string, unknown> = {},
) {
  const c = clock();
  return {
    apiKey: "key",
    fetch: a.fetchFn as any,
    now: c.now,
    sleep: c.sleep,
    random: () => 0,
    store,
    finish: null,
    ...over,
  };
}

const live = () => new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the request", () => {
  it("★★ states the model, the quality and the resolution every time: the API's own default quality is `high`", () => {
    expect(elevenLabsRequestBody(input())).toEqual({
      model_id: "gpt-image-2.5-sunburst",
      prompt: "A studio photograph of a plain mug",
      aspect_ratio: "4:5",
      resolution: "1K",
      quality: "low",
    });
    expect(
      elevenLabsRequestBody(input({ quality: "medium", resolution: "2K" })),
    ).toMatchObject({ quality: "medium", resolution: "2K" });
    expect(ELEVENLABS_IMAGE_MODEL).toBe("gpt-image-2.5-sunburst");
  });

  it("★ carries no `images` field with no reference, and each reference inline when there is one", () => {
    expect(elevenLabsRequestBody(input())).not.toHaveProperty("images");
    expect(
      elevenLabsRequestBody(
        input({ references: [{ mediaType: "image/jpeg", base64: "QUJD" }] }),
      ).images,
    ).toEqual([
      {
        type: "inline_base64",
        content_base64: "QUJD",
        mime_type: "image/jpeg",
      },
    ]);
  });

  it("the same picture has the same digest; anything that changes the picture changes it; the scope does not", () => {
    const base = elevenLabsRequestDigest(input());
    expect(elevenLabsRequestDigest(input({ scope: "other" }))).toBe(base);
    for (const other of [
      input({ prompt: "another" }),
      input({ quality: "medium" }),
      input({ resolution: "2K" }),
      input({ aspectRatio: "1:1" }),
      input({ references: [{ mediaType: "image/png", base64: "QQ==" }] }),
    ]) {
      expect(elevenLabsRequestDigest(other)).not.toBe(base);
    }
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("★★ one picture is one job", () => {
  it("one submit, the job read until it is done, one download", async () => {
    const a = api();
    const { store, rows } = memoryStore();
    const out = await drawElevenLabsImage(input(), live(), deps(a, store));
    expect(out).toMatchObject({
      kind: "ok",
      mediaType: "image/png",
      generationId: "gen_1",
      jobMayExist: true,
      adopted: false,
      submits: 1,
    });
    expect(a.state.posts).toHaveLength(1);
    expect(a.state.downloads).toHaveLength(1);
    // The job is on record as delivered: it is never handed out again.
    expect(rows).toEqual([
      expect.objectContaining({ id: "gen_1", state: "delivered" }),
    ]);
  });

  it("the key travels in the xi-api-key header, never in the URL", async () => {
    const a = api();
    await drawElevenLabsImage(input(), live(), deps(a, memoryStore().store));
    const [url, init] = a.fetchFn.mock.calls[0];
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/flows/image");
    expect(init.headers["xi-api-key"]).toBe("key");
    expect(String(url)).not.toContain("key");
  });

  it("★★ a slow job is read again and again, and never submitted again", async () => {
    const a = api();
    a.state.nextJob = { readsBeforeDone: 9 };
    const out = await drawElevenLabsImage(
      input(),
      live(),
      deps(a, memoryStore().store),
    );
    expect(out.kind).toBe("ok");
    expect(a.state.posts).toHaveLength(1);
    expect(a.state.reads.length).toBeGreaterThanOrEqual(10);
  });

  it("★★ a status read that fails (a dropped connection, a 500, a 429) is read again: still one job", async () => {
    const a = api();
    a.state.readPlan = ["throw", 500, 429, 429];
    const out = await drawElevenLabsImage(
      input(),
      live(),
      deps(a, memoryStore().store),
    );
    expect(out.kind).toBe("ok");
    expect(a.state.posts).toHaveLength(1);
  });

  it("★ a download that fails asks the job for a fresh URL, and does not draw again", async () => {
    const a = api();
    a.state.downloadPlan = ["fail", "ok"];
    const out = await drawElevenLabsImage(
      input(),
      live(),
      deps(a, memoryStore().store),
    );
    expect(out.kind).toBe("ok");
    expect(a.state.posts).toHaveLength(1);
    expect(a.state.downloads).toHaveLength(2);
    // The second download used the URL of a newer read.
    expect(a.state.downloads[1]).not.toBe(a.state.downloads[0]);
  });
});

describe("★★ when a submit may be sent again, and when it may not", () => {
  it("a 429 made no job, so the submit is sent again and the picture is drawn once", async () => {
    const a = api();
    a.state.submitPlan = [429, 429];
    const out = await drawElevenLabsImage(
      input(),
      live(),
      deps(a, memoryStore().store),
    );
    expect(out).toMatchObject({ kind: "ok", submits: 1 });
    // Three requests, one job.
    expect(a.state.posts).toHaveLength(3);
    expect(a.state.jobs.size).toBe(1);
  });

  it("refused for rate every time: it stops, and nothing was drawn", async () => {
    const a = api();
    a.state.submitPlan = Array(ELEVENLABS_RATE_LIMIT_RETRIES + 5).fill(429);
    const out = await drawElevenLabsImage(
      input(),
      live(),
      deps(a, memoryStore().store),
    );
    expect(out).toMatchObject({
      kind: "error",
      code: "rate_limited",
      jobMayExist: false,
      submits: 0,
    });
    expect(a.state.posts).toHaveLength(ELEVENLABS_RATE_LIMIT_RETRIES + 1);
    expect(a.state.jobs.size).toBe(0);
  });

  it.each([
    ["a dropped connection", "throw"],
    ["a 500", 500],
    ["a 200 with no job id", "no-id"],
  ] as const)(
    "★★ %s on the submit may have made a job: it is NOT sent again, and the caller is told a job may exist",
    async (_name, plan) => {
      const a = api();
      a.state.submitPlan = [plan];
      const out = await drawElevenLabsImage(
        input(),
        live(),
        deps(a, memoryStore().store),
      );
      expect(out).toMatchObject({
        kind: "error",
        code: "timeout",
        jobMayExist: true,
      });
      expect(a.state.posts).toHaveLength(1);
    },
  );

  it.each([
    [422, "rejected"],
    [401, "auth"],
  ] as const)(
    "a %s is a refusal: not sent again, and nothing was drawn",
    async (status, code) => {
      const a = api();
      a.state.submitPlan = [status];
      const out = await drawElevenLabsImage(
        input(),
        live(),
        deps(a, memoryStore().store),
      );
      expect(out).toMatchObject({ kind: "error", code, jobMayExist: false });
      expect(a.state.posts).toHaveLength(1);
    },
  );

  it("★ a request this model cannot draw is refused before anything is sent", async () => {
    const a = api();
    for (const bad of [
      input({ aspectRatio: "7:5" as any }),
      input({ prompt: "   " }),
      input({
        references: Array(11).fill({ mediaType: "image/png", base64: "QQ==" }),
      }),
    ]) {
      const out = await drawElevenLabsImage(
        bad,
        live(),
        deps(a, memoryStore().store),
      );
      expect(out).toMatchObject({
        kind: "error",
        code: "rejected",
        jobMayExist: false,
      });
    }
    expect(a.fetchFn).not.toHaveBeenCalled();
  });
});

describe("★★ a job that was paid for is collected, never drawn twice", () => {
  it("a job not done in time is left on record, and the NEXT try for the same picture collects it with no new submit", async () => {
    const a = api();
    const { store, rows } = memoryStore();
    // Far more reads than the wait allows.
    a.state.nextJob = { readsBeforeDone: 10_000 };
    const first = await drawElevenLabsImage(input(), live(), deps(a, store));
    expect(first).toMatchObject({
      kind: "error",
      code: "timeout",
      jobMayExist: true,
      submits: 1,
    });
    expect(rows[0]).toMatchObject({ state: "submitted", claimed: false });

    // The job finishes on the provider's side meanwhile.
    a.state.jobs.get("gen_1")!.readsBeforeDone = 0;
    const second = await drawElevenLabsImage(input(), live(), deps(a, store));
    expect(second).toMatchObject({
      kind: "ok",
      generationId: "gen_1",
      adopted: true,
      submits: 0,
      jobMayExist: true,
    });
    // ★ One job in all, for two tries.
    expect(a.state.posts).toHaveLength(1);
    expect(rows[0].state).toBe("delivered");
  });

  it("the wait has a ceiling", async () => {
    const a = api();
    a.state.nextJob = { readsBeforeDone: 10_000 };
    const out = await drawElevenLabsImage(
      input(),
      live(),
      deps(a, memoryStore().store),
    );
    expect(out.durationMs).toBeGreaterThanOrEqual(ELEVENLABS_WAIT_CEILING_MS);
    expect(out.durationMs).toBeLessThan(ELEVENLABS_WAIT_CEILING_MS + 30_000);
  });

  it("★★ a draw stopped while its job is under way is collected by the next try", async () => {
    const a = api();
    const { store } = memoryStore();
    a.state.nextJob = { readsBeforeDone: 3 };
    const stop = new AbortController();
    const c = clock();
    let sleeps = 0;
    const first = await drawElevenLabsImage(input(), stop.signal, {
      ...deps(a, store),
      now: c.now,
      sleep: async (ms: number) => {
        await c.sleep(ms);
        // The run's deadline lands during the second wait.
        if (++sleeps === 2) stop.abort();
      },
    });
    expect(first).toMatchObject({
      kind: "error",
      code: "cancelled",
      jobMayExist: true,
    });
    a.state.jobs.get("gen_1")!.readsBeforeDone = 0;
    const second = await drawElevenLabsImage(input(), live(), deps(a, store));
    expect(second).toMatchObject({ kind: "ok", adopted: true, submits: 0 });
    expect(a.state.posts).toHaveLength(1);
  });

  it("★★ a picture that was DELIVERED is not handed out again: the same request later is a deliberate redraw", async () => {
    const a = api();
    const { store } = memoryStore();
    const first = await drawElevenLabsImage(input(), live(), deps(a, store));
    const second = await drawElevenLabsImage(input(), live(), deps(a, store));
    expect(first).toMatchObject({ kind: "ok", generationId: "gen_1" });
    expect(second).toMatchObject({
      kind: "ok",
      generationId: "gen_2",
      adopted: false,
    });
    expect(a.state.posts).toHaveLength(2);
  });

  it("★ never across scopes: another redesign's uncollected job is not this one's picture", async () => {
    const a = api();
    const { store } = memoryStore();
    a.state.nextJob = { readsBeforeDone: 10_000 };
    await drawElevenLabsImage(
      input({ scope: "revamp:a" }),
      live(),
      deps(a, store),
    );
    a.state.nextJob = { readsBeforeDone: 1 };
    const other = await drawElevenLabsImage(
      input({ scope: "revamp:b" }),
      live(),
      deps(a, store),
    );
    expect(other).toMatchObject({ kind: "ok", adopted: false, submits: 1 });
  });

  it("★ nor for a different picture in the same scope", async () => {
    const a = api();
    const { store } = memoryStore();
    a.state.nextJob = { readsBeforeDone: 10_000 };
    await drawElevenLabsImage(input(), live(), deps(a, store));
    a.state.nextJob = { readsBeforeDone: 1 };
    const other = await drawElevenLabsImage(
      input({ prompt: "A different photograph" }),
      live(),
      deps(a, store),
    );
    expect(other).toMatchObject({ kind: "ok", adopted: false });
  });

  it("a collected job that is gone at the provider is replaced by ONE new job", async () => {
    const a = api();
    const { store, rows } = memoryStore();
    a.state.nextJob = { readsBeforeDone: 10_000 };
    await drawElevenLabsImage(input(), live(), deps(a, store));
    a.state.jobs.delete("gen_1");
    a.state.nextJob = { readsBeforeDone: 1 };
    const out = await drawElevenLabsImage(input(), live(), deps(a, store));
    expect(out).toMatchObject({
      kind: "ok",
      generationId: "gen_2",
      adopted: false,
      submits: 1,
    });
    expect(rows.find((r) => r.id === "gen_1")?.state).toBe("failed");
    expect(a.state.posts).toHaveLength(2);
  });

  it("★ a picture that cannot be downloaded is left to be collected, not drawn again", async () => {
    const a = api();
    const { store, rows } = memoryStore();
    a.state.downloadPlan = ["fail", "fail", "fail"];
    const first = await drawElevenLabsImage(input(), live(), deps(a, store));
    expect(first).toMatchObject({
      kind: "error",
      code: "unavailable",
      jobMayExist: true,
    });
    expect(rows[0]).toMatchObject({ state: "submitted", claimed: false });
    const second = await drawElevenLabsImage(input(), live(), deps(a, store));
    expect(second).toMatchObject({ kind: "ok", adopted: true, submits: 0 });
    expect(a.state.posts).toHaveLength(1);
  });

  it("a record that cannot be written costs the saving, never the picture", async () => {
    const a = api();
    const broken: GenerationStore = {
      claimUndelivered: async () => null,
      recordSubmitted: async () => {},
      settle: async () => {},
      release: async () => {},
    };
    const out = await drawElevenLabsImage(input(), live(), deps(a, broken));
    expect(out.kind).toBe("ok");
  });
});

describe("a job the provider failed was not charged", () => {
  it("★ moderation is a refusal, with nothing drawn", async () => {
    const a = api();
    const { store, rows } = memoryStore();
    a.state.nextJob = { readsBeforeDone: 1, failure: "moderated" };
    const out = await drawElevenLabsImage(input(), live(), deps(a, store));
    expect(out).toMatchObject({
      kind: "refused",
      reason: "moderated",
      jobMayExist: false,
    });
    expect(rows[0].state).toBe("failed");
  });

  it.each([
    ["model_error", "unavailable"],
    ["timeout", "unavailable"],
    ["internal_error", "unavailable"],
    ["dependency_failed", "unavailable"],
    ["invalid_parameters", "rejected"],
    ["charging_failed", "auth"],
  ])("%s is %s, and nothing was drawn", async (failure, code) => {
    const a = api();
    a.state.nextJob = { readsBeforeDone: 1, failure };
    const out = await drawElevenLabsImage(
      input(),
      live(),
      deps(a, memoryStore().store),
    );
    expect(out).toMatchObject({ kind: "error", code, jobMayExist: false });
    expect(a.state.posts).toHaveLength(1);
  });
});

describe("a call that is already stopped", () => {
  it("sends nothing", async () => {
    const a = api();
    const stop = new AbortController();
    stop.abort();
    const out = await drawElevenLabsImage(
      input(),
      stop.signal,
      deps(a, memoryStore().store),
    );
    expect(out).toMatchObject({
      kind: "error",
      code: "cancelled",
      jobMayExist: false,
      submits: 0,
    });
    expect(a.fetchFn).not.toHaveBeenCalled();
  });
});

describe("the picture as StoreMink keeps it", () => {
  async function png(width: number, height: number) {
    const sharp = (await import("sharp")).default;
    return new Uint8Array(
      await sharp({
        create: { width, height, channels: 3, background: "#8090a0" },
      })
        .png()
        .toBuffer(),
    );
  }
  async function sizeOf(bytes: Uint8Array) {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(bytes).metadata();
    return { width: meta.width, height: meta.height, format: meta.format };
  }

  // Theme Studio and the redesign treat a photo smaller than its frame (1,600
  // or 2,400 px) as a fault and draw it again. A 1K picture is smaller than
  // every frame, so without this each photo would be drawn twice.
  it("★★ a 1K picture is enlarged to twice its size, so nothing downstream redraws it for being small", async () => {
    const out = await finishElevenLabsPicture(await png(832, 1040), "1K");
    expect(out?.mediaType).toBe("image/jpeg");
    expect(await sizeOf(out!.bytes)).toEqual({
      width: 1664,
      height: 2080,
      format: "jpeg",
    });
    const banner = await finishElevenLabsPicture(await png(1280, 720), "1K");
    expect(await sizeOf(banner!.bytes)).toMatchObject({
      width: 2560,
      height: 1440,
    });
  });

  it("a 2K picture keeps its size", async () => {
    const out = await finishElevenLabsPicture(await png(1664, 2080), "2K");
    expect(await sizeOf(out!.bytes)).toMatchObject({
      width: 1664,
      height: 2080,
      format: "jpeg",
    });
  });

  it("bytes that are not a picture are not finished", async () => {
    expect(
      await finishElevenLabsPicture(new Uint8Array([1, 2, 3]), "1K"),
    ).toBeNull();
  });
});

describe("what a picture costs, for StoreMink's own records", () => {
  it("★ a reference is what costs; the quality moves the price little", () => {
    const plain = elevenLabsCreditsEstimate({
      quality: "medium",
      resolution: "1K",
      references: 0,
    });
    const withReference = elevenLabsCreditsEstimate({
      quality: "medium",
      resolution: "1K",
      references: 1,
    });
    expect(plain).toBe(130);
    expect(withReference).toBe(562);
    expect(
      elevenLabsCreditsEstimate({
        quality: "low",
        resolution: "1K",
        references: 2,
      }),
    ).toBe(475);
    // 2K costs a little more than 1K, never less.
    expect(
      elevenLabsCreditsEstimate({
        quality: "medium",
        resolution: "2K",
        references: 0,
      }),
    ).toBe(141);
  });

  it("is turned into whole micro-USD at the Scale plan's list price", () => {
    expect(
      elevenLabsCostMicroUsd({
        quality: "medium",
        resolution: "1K",
        references: 0,
      }),
    ).toBe(130 * 166);
  });
});
