// Image-matting service (docs/image-matting-service.md).
//
// Cuts a product out of a photo with BiRefNet, so StoreMink can put the
// merchant's REAL product on a new background instead of asking an image
// model to redraw it.
//
//   POST /v1/matte?output=mask|cutout   body: the photo (JPEG, PNG or WebP)
//     200 image/png   the mask (8-bit grey, white = product), or the photo
//                     with the mask as its alpha channel
//     headers         X-Matting-Model, X-Matting-Verdict (ok|empty|full),
//                     X-Matting-Coverage, X-Matting-Soft, X-Matting-Width,
//                     X-Matting-Height, X-Matting-Rss-Mb, Server-Timing
//   GET  /healthz     200 {"model": "...", "ready": true}
//
//   PORT                default 8080
//   MATTING_MODEL_PATH  the BiRefNet ONNX file (default /models/birefnet.onnx)
//   MATTING_MODEL_NAME  reported in X-Matting-Model (default "birefnet")
//   MATTING_THREADS     inference threads (default: every CPU we were given).
//                       ★ SET IT on Cloud Run to the --cpu value: with
//                       start-up CPU boost the instance briefly reports more
//                       CPUs than it keeps, and a session sized to the boost
//                       runs over-threaded for the rest of its life.
//   MATTING_GRAPH_OPT   ONNX Runtime graph optimisation: disabled, basic,
//                       extended, layout or all (default basic)
//   MATTING_CPU_ARENA   "1" turns ONNX Runtime's memory arena on (default off)
//   MATTING_MEM_PATTERN "0" turns its pre-planned memory pattern off
//
// ★ THE ARENA DEFAULT IS MEASURED, NOT ONNX RUNTIME'S. On Cloud Run (4 vCPU,
// BiRefNet lite, 2026-10-17) the arena on took the peak past 8 GB and the
// instance was killed; off, the peak is 6.8-7.0 GB. "basic" is the graph
// default because it was never slower: 11.3-15.0 s across instances against
// 13.6-15.0 s for "all" and 13.3-13.9 s for "extended", masks identical. The
// gap is within the spread between instances (each may land on a different
// CPU, which the start-up log names), so it is not a proven speed-up.
// docs/image-matting-service.md has the full table.
//   MATTING_SECRET      when set, every POST must send it as X-Matting-Secret
//   MATTING_WARMUP      "1" runs one inference before the port opens. Off by
//                       default: on Cloud Run the first inference measured no
//                       slower than the rest (13.3 s against 14 s), so warming
//                       up only made every cold start 13 s longer.
//
// ★ IT KNOWS NOTHING ABOUT STORES. No database, no bucket, no credentials:
// bytes in, a mask out. Ownership, credits and where the result is stored are
// the web app's business, so this service cannot leak one store's photos to
// another because it never holds more than the one photo it was sent.
//
// ★ ONE PHOTO AT A TIME. Inference already uses every CPU, so two at once
// would each run at half speed while holding two sets of buffers. Cloud Run
// is deployed with --concurrency=1; the queue below makes the same true when
// something else (a local run, a load test) sends two together.
//
// ★ THE MODEL LOADS BEFORE THE PORT OPENS. Cloud Run sends nothing to an
// instance until it listens, so a request never meets a half-loaded model.

import http from "node:http";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  MAX_INPUT_BYTES,
  MAX_INPUT_PIXELS,
  MAX_OUTPUT_EDGE,
  MODEL_SIZE,
  judgeMask,
  maskFromOutput,
  maskStats,
  parseOutput,
  secretMatches,
  sniffImageType,
  toInputTensor,
} from "./matting-core.mjs";

export class HttpError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * The most memory this process has held at once, in MB. This, not the current
 * RSS, is what sizes the Cloud Run memory limit: the instance is killed at the
 * peak, and between requests the RSS has already fallen back.
 */
export function peakMb() {
  // maxRSS is kilobytes on Linux and macOS alike.
  return Math.round(process.resourceUsage().maxRSS / 1024);
}

/** One JSON line per event, the shape Cloud Logging parses. Never an image. */
export function log(severity, message, fields = {}) {
  const line = JSON.stringify({ severity, message, ...fields });
  if (severity === "ERROR" || severity === "WARNING") console.error(line);
  else console.log(line);
}

const GRAPH_OPT_LEVELS = ["disabled", "basic", "extended", "layout", "all"];

export function readConfig(env = process.env) {
  const threads = Number.parseInt(env.MATTING_THREADS ?? "", 10);
  const graphOpt = GRAPH_OPT_LEVELS.includes(env.MATTING_GRAPH_OPT ?? "")
    ? env.MATTING_GRAPH_OPT
    : "basic";
  return {
    graphOpt,
    cpuArena: env.MATTING_CPU_ARENA === "1",
    memPattern: env.MATTING_MEM_PATTERN !== "0",
    port: Number.parseInt(env.PORT ?? "", 10) || 8080,
    modelPath: env.MATTING_MODEL_PATH || "/models/birefnet.onnx",
    modelName: env.MATTING_MODEL_NAME || "birefnet",
    threads:
      Number.isInteger(threads) && threads > 0
        ? threads
        : Math.max(1, os.availableParallelism()),
    secret: env.MATTING_SECRET ? String(env.MATTING_SECRET) : null,
    warmup: env.MATTING_WARMUP === "1",
  };
}

/**
 * Loads the model and returns `matte(bytes, output)`. onnxruntime-node and
 * sharp are imported here, not at the top, so the HTTP layer and its tests
 * never need either.
 */
export async function loadEngine(config) {
  const ort = await import("onnxruntime-node");
  const sharp = (await import("sharp")).default;
  // Every request is a different photo; sharp's cache would only hold memory.
  sharp.cache(false);

  const started = performance.now();
  const session = await ort.InferenceSession.create(config.modelPath, {
    intraOpNumThreads: config.threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
    graphOptimizationLevel: config.graphOpt ?? "basic",
    enableCpuMemArena: config.cpuArena ?? false,
    enableMemPattern: config.memPattern ?? true,
  });
  const inputName = session.inputNames[0];
  // The official BiRefNet exports have one output; if a re-export has more,
  // the final prediction is the last.
  const outputName = session.outputNames[session.outputNames.length - 1];
  const loadMs = Math.round(performance.now() - started);

  async function infer(input) {
    const results = await session.run({ [inputName]: input });
    const tensor = results[outputName];
    const plane = MODEL_SIZE * MODEL_SIZE;
    try {
      const dims = tensor?.dims;
      if (
        !dims ||
        dims[dims.length - 1] !== MODEL_SIZE ||
        dims[dims.length - 2] !== MODEL_SIZE ||
        tensor.data.length < plane
      ) {
        throw new HttpError(500, "unexpected_model_output");
      }
      // Copy the first plane out before the tensors are released.
      return Float32Array.from(tensor.data.subarray(0, plane));
    } finally {
      for (const value of Object.values(results)) value.dispose?.();
    }
  }

  async function matte(bytes, output) {
    const t0 = performance.now();
    if (!sniffImageType(bytes)) throw new HttpError(415, "unsupported_type");

    let rgb;
    let info;
    try {
      ({ data: rgb, info } = await sharp(bytes, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: "error",
      })
        // EXIF orientation first, or a portrait phone photo is matted on
        // its side and the mask no longer lines up with what the merchant
        // sees.
        .rotate()
        .resize({
          width: MAX_OUTPUT_EDGE,
          height: MAX_OUTPUT_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        // A PNG that is already transparent is judged on white, the way a
        // merchant sees it in the product editor.
        .flatten({ background: "#ffffff" })
        .toColourspace("srgb")
        .removeAlpha()
        .raw({ depth: "uchar" })
        .toBuffer({ resolveWithObject: true }));
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/pixel limit/i.test(message)) {
        throw new HttpError(413, "too_many_pixels");
      }
      throw new HttpError(422, "unreadable_image");
    }
    const { width, height } = info;
    // Grey, CMYK and alpha images all arrive here as plain RGB; anything else
    // would make the tensor maths read the wrong bytes.
    if (info.channels !== 3) throw new HttpError(422, "unreadable_image");
    const t1 = performance.now();

    const square = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .resize(MODEL_SIZE, MODEL_SIZE, { fit: "fill", kernel: "lanczos3" })
      .raw({ depth: "uchar" })
      .toBuffer();
    const input = new ort.Tensor("float32", toInputTensor(square), [
      1,
      3,
      MODEL_SIZE,
      MODEL_SIZE,
    ]);
    const t2 = performance.now();

    let values;
    try {
      values = await infer(input);
    } finally {
      input.dispose?.();
    }
    const t3 = performance.now();

    const small = maskFromOutput(values);
    const stats = maskStats(small);
    const mask = await sharp(small, {
      raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 1 },
    })
      .resize(width, height, { fit: "fill", kernel: "lanczos3" })
      .extractChannel(0)
      .raw({ depth: "uchar" })
      .toBuffer();

    const body =
      output === "cutout"
        ? await sharp(rgb, { raw: { width, height, channels: 3 } })
            .joinChannel(mask, { raw: { width, height, channels: 1 } })
            .png({ compressionLevel: 6 })
            .toBuffer()
        : await sharp(mask, { raw: { width, height, channels: 1 } })
            .png({ compressionLevel: 6 })
            .toBuffer();
    const t4 = performance.now();

    return {
      body,
      width,
      height,
      verdict: judgeMask(stats),
      coverage: stats.coverage,
      soft: stats.soft,
      timings: {
        decode: t1 - t0,
        prepare: t2 - t1,
        infer: t3 - t2,
        encode: t4 - t3,
        total: t4 - t0,
      },
    };
  }

  async function warmup() {
    const started = performance.now();
    const input = new ort.Tensor(
      "float32",
      new Float32Array(3 * MODEL_SIZE * MODEL_SIZE),
      [1, 3, MODEL_SIZE, MODEL_SIZE],
    );
    try {
      await infer(input);
    } finally {
      input.dispose?.();
    }
    return Math.round(performance.now() - started);
  }

  return { matte, warmup, loadMs, inputName, outputName };
}

/** The request body, refusing it the moment it passes `limit` bytes rather
 * than after buffering the lot. */
export function readBody(req, limit = MAX_INPUT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, "too_large"));
        // Drain the rest instead of destroying the socket, so the client
        // reads our 413 rather than a reset connection.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new HttpError(400, "aborted")));
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * The HTTP layer. `engine` is whatever `loadEngine` returned, or a stand-in
 * in tests.
 */
export function createMattingServer({ engine, config }) {
  // Requests wait their turn: see "ONE PHOTO AT A TIME" above.
  let queue = Promise.resolve();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") {
        if (req.method !== "GET")
          throw new HttpError(405, "method_not_allowed");
        sendJson(res, 200, { model: config.modelName, ready: true });
        return;
      }
      if (url.pathname !== "/v1/matte") throw new HttpError(404, "not_found");
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      if (
        config.secret &&
        !secretMatches(req.headers["x-matting-secret"], config.secret)
      ) {
        throw new HttpError(401, "unauthorized");
      }
      const output = parseOutput(url.searchParams.get("output"));
      if (!output) throw new HttpError(400, "bad_output");
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_INPUT_BYTES) {
        throw new HttpError(413, "too_large");
      }

      const bytes = await readBody(req);
      if (bytes.length === 0) throw new HttpError(400, "empty_body");

      const run = queue.then(() => engine.matte(bytes, output));
      queue = run.catch(() => {});
      const result = await run;

      const t = result.timings;
      const ms = (value) => Math.round(value);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": result.body.length,
        "cache-control": "no-store",
        "x-matting-model": config.modelName,
        "x-matting-verdict": result.verdict,
        "x-matting-coverage": result.coverage.toFixed(4),
        "x-matting-soft": result.soft.toFixed(4),
        "x-matting-width": String(result.width),
        "x-matting-height": String(result.height),
        "x-matting-rss-mb": String(
          Math.round(process.memoryUsage().rss / 1048576),
        ),
        "x-matting-peak-mb": String(peakMb()),
        "server-timing": `decode;dur=${ms(t.decode)}, prepare;dur=${ms(t.prepare)}, infer;dur=${ms(t.infer)}, encode;dur=${ms(t.encode)}, total;dur=${ms(t.total)}`,
      });
      res.end(result.body);
      log("INFO", "matte", {
        model: config.modelName,
        output,
        bytes: bytes.length,
        width: result.width,
        height: result.height,
        verdict: result.verdict,
        coverage: Number(result.coverage.toFixed(4)),
        inferMs: ms(t.infer),
        totalMs: ms(t.total),
        peakMb: peakMb(),
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      if (status >= 500) {
        log("ERROR", "matte failed", {
          code,
          error: String(error?.stack ?? error),
        });
      }
      if (!res.headersSent) sendJson(res, status, { error: code });
      else res.destroy();
    }
  });
}

async function main() {
  const config = readConfig();
  log("INFO", "loading model", {
    model: config.modelName,
    path: config.modelPath,
    threads: config.threads,
    cpu: os.cpus()[0]?.model ?? null,
    graphOpt: config.graphOpt,
    cpuArena: config.cpuArena,
    memPattern: config.memPattern,
  });
  const engine = await loadEngine(config);
  const warmupMs = config.warmup ? await engine.warmup() : null;
  const server = createMattingServer({ engine, config });
  server.listen(config.port, () => {
    log("INFO", "ready", {
      model: config.modelName,
      port: config.port,
      loadMs: engine.loadMs,
      warmupMs,
      input: engine.inputName,
      output: engine.outputName,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      peakMb: peakMb(),
    });
  });
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    log("ERROR", "start-up failed", { error: String(error?.stack ?? error) });
    process.exit(1);
  });
}
