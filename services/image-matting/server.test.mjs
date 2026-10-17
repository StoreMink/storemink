import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_INPUT_BYTES } from "./matting-core.mjs";
import {
  HttpError,
  createMattingServer,
  readBody,
  readConfig,
} from "./server.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(32).fill(1)]);

function fakeEngine(overrides = {}) {
  return {
    calls: [],
    async matte(bytes, output) {
      this.calls.push({ bytes, output });
      return {
        body: Buffer.from("png-bytes"),
        width: 40,
        height: 30,
        verdict: "ok",
        coverage: 0.25,
        soft: 0.01,
        timings: { decode: 1, prepare: 2, infer: 300, encode: 4, total: 307 },
      };
    },
    ...overrides,
  };
}

let server;
let base;

async function start(engine, config = {}) {
  server = createMattingServer({
    engine,
    config: { modelName: "birefnet-test", secret: null, ...config },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
  vi.restoreAllMocks();
});

const post = (path, body = JPEG, headers = {}) =>
  fetch(`${base}${path}`, { method: "POST", body, headers });

describe("routes", () => {
  it("answers the health check with the model name", async () => {
    await start(fakeEngine());
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: "birefnet-test", ready: true });
  });

  it("refuses unknown paths and the wrong method", async () => {
    await start(fakeEngine());
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/v1/matte`)).status).toBe(405);
  });
});

describe("POST /v1/matte", () => {
  it("returns the engine's PNG with the verdict, coverage and timings", async () => {
    const engine = fakeEngine();
    await start(engine);
    const res = await post("/v1/matte?output=cutout");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-matting-model")).toBe("birefnet-test");
    expect(res.headers.get("x-matting-verdict")).toBe("ok");
    expect(res.headers.get("x-matting-coverage")).toBe("0.2500");
    expect(res.headers.get("x-matting-width")).toBe("40");
    expect(res.headers.get("server-timing")).toContain("infer;dur=300");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("png-bytes");
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].output).toBe("cutout");
    expect(engine.calls[0].bytes.equals(JPEG)).toBe(true);
  });

  it("asks for the mask when no output is named, and refuses an unknown one", async () => {
    const engine = fakeEngine();
    await start(engine);
    expect((await post("/v1/matte")).status).toBe(200);
    expect(engine.calls[0].output).toBe("mask");
    const bad = await post("/v1/matte?output=svg");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad_output" });
    expect(engine.calls).toHaveLength(1);
  });

  it("refuses an empty body before calling the model", async () => {
    const engine = fakeEngine();
    await start(engine);
    const res = await post("/v1/matte", Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(engine.calls).toHaveLength(0);
  });

  it("passes the engine's own refusal through, and hides an unexpected error", async () => {
    await start(
      fakeEngine({
        async matte() {
          throw new HttpError(415, "unsupported_type");
        },
      }),
    );
    const refused = await post("/v1/matte");
    expect(refused.status).toBe(415);
    expect(await refused.json()).toEqual({ error: "unsupported_type" });

    await new Promise((resolve) => server.close(resolve));
    await start(
      fakeEngine({
        async matte() {
          throw new Error("onnx exploded at /models/birefnet.onnx");
        },
      }),
    );
    const broken = await post("/v1/matte");
    expect(broken.status).toBe(500);
    // The internal message never reaches the caller.
    expect(await broken.json()).toEqual({ error: "internal_error" });
  });

  it("runs one photo at a time even when two arrive together", async () => {
    let active = 0;
    let peak = 0;
    const engine = fakeEngine({
      async matte() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return fakeEngine().matte.call({ calls: [] });
      },
    });
    await start(engine);
    const results = await Promise.all([post("/v1/matte"), post("/v1/matte")]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(peak).toBe(1);
  });

  it("keeps serving after a request fails", async () => {
    let first = true;
    const engine = fakeEngine({
      async matte() {
        if (first) {
          first = false;
          throw new Error("boom");
        }
        return fakeEngine().matte.call({ calls: [] });
      },
    });
    await start(engine);
    expect((await post("/v1/matte")).status).toBe(500);
    expect((await post("/v1/matte")).status).toBe(200);
  });
});

describe("the shared secret", () => {
  it("is required when configured, and checked exactly", async () => {
    const engine = fakeEngine();
    await start(engine, { secret: "a-long-secret" });
    expect((await post("/v1/matte")).status).toBe(401);
    expect(
      (await post("/v1/matte", JPEG, { "x-matting-secret": "a-long-secreT" }))
        .status,
    ).toBe(401);
    expect(engine.calls).toHaveLength(0);
    const ok = await post("/v1/matte", JPEG, {
      "x-matting-secret": "a-long-secret",
    });
    expect(ok.status).toBe(200);
  });

  it("does not guard the health check", async () => {
    await start(fakeEngine(), { secret: "a-long-secret" });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("readBody", () => {
  function fakeRequest() {
    const req = new EventEmitter();
    req.resume = vi.fn();
    return req;
  }

  it("collects the body", async () => {
    const req = fakeRequest();
    const done = readBody(req, 100);
    req.emit("data", Buffer.from("abc"));
    req.emit("data", Buffer.from("def"));
    req.emit("end");
    expect((await done).toString()).toBe("abcdef");
  });

  it("refuses a body the moment it passes the limit", async () => {
    const req = fakeRequest();
    const done = readBody(req, 5);
    req.emit("data", Buffer.from("abcd"));
    req.emit("data", Buffer.from("efgh"));
    await expect(done).rejects.toMatchObject({
      status: 413,
      code: "too_large",
    });
    expect(req.resume).toHaveBeenCalled();
  });

  it("refuses a declared length over the limit without reading it", async () => {
    const engine = fakeEngine();
    await start(engine);
    const { request } = await import("node:http");
    const status = await new Promise((resolve, reject) => {
      const req = request(
        `${base}/v1/matte`,
        {
          method: "POST",
          headers: { "content-length": String(MAX_INPUT_BYTES + 1) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.write("x");
      // Leave the body unfinished: the 413 must not wait for it.
    });
    expect(status).toBe(413);
    expect(engine.calls).toHaveLength(0);
  });
});

describe("readConfig", () => {
  it("reads the environment with safe defaults", () => {
    const config = readConfig({});
    expect(config.port).toBe(8080);
    expect(config.modelPath).toBe("/models/birefnet.onnx");
    expect(config.secret).toBeNull();
    expect(config.warmup).toBe(false);
    expect(config.threads).toBeGreaterThan(0);

    const custom = readConfig({
      PORT: "9000",
      MATTING_THREADS: "3",
      MATTING_SECRET: "s",
      MATTING_WARMUP: "1",
      MATTING_MODEL_NAME: "birefnet-lite",
    });
    expect(custom).toMatchObject({
      port: 9000,
      threads: 3,
      secret: "s",
      warmup: true,
      modelName: "birefnet-lite",
    });
    expect(readConfig({ MATTING_THREADS: "-2" }).threads).toBeGreaterThan(0);
  });

  it("defaults to the measured settings, and accepts only known levels", () => {
    // Arena off is what fits in 8 GB; basic was never slower than all.
    expect(readConfig({})).toMatchObject({
      graphOpt: "basic",
      cpuArena: false,
      memPattern: true,
    });
    expect(
      readConfig({
        MATTING_GRAPH_OPT: "all",
        MATTING_CPU_ARENA: "1",
        MATTING_MEM_PATTERN: "0",
      }),
    ).toMatchObject({ graphOpt: "all", cpuArena: true, memPattern: false });
    expect(readConfig({ MATTING_GRAPH_OPT: "turbo" }).graphOpt).toBe("basic");
  });
});
