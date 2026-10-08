import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/whatsapp/inbound", () => ({
  recordWebhookDelivery: vi.fn(async () => ({
    rows: 1,
    inserted: 1,
    unrouted: 0,
  })),
  processPendingInboundEvents: vi.fn(async () => ({
    claimed: 0,
    processed: 0,
    failed: 0,
  })),
}));
// `after()` needs a request scope; here it runs the callback at once so the
// test can see processing was scheduled.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn((fn: () => unknown) => fn()) };
});

import { GET, POST } from "./route";
import { logInfo, logWarn } from "@/lib/observability/logger";
import {
  processPendingInboundEvents,
  recordWebhookDelivery,
} from "@/lib/whatsapp/inbound";

const SECRET = "meta-app-secret";
const URL_ = "https://storemink.com/api/webhooks/whatsapp";

function sign(body: string, secret = SECRET) {
  return (
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
  );
}

function post(body: string, signature: string | null = sign(body)): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (signature) headers["x-hub-signature-256"] = signature;
  return new Request(URL_, { method: "POST", headers, body });
}

const inbound = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN" },
            messages: [
              {
                from: "919876543210",
                id: "wamid.1",
                type: "text",
                text: { body: "hi" },
              },
            ],
          },
        },
      ],
    },
  ],
});

// docs/whatsapp-commerce-plan.md §9: one URL for every merchant, verified,
// acknowledged fast, recorded idempotently, processed after the response.
describe("/api/webhooks/whatsapp", () => {
  const OLD_SECRET = process.env.WHATSAPP_APP_SECRET;
  const OLD_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRET = SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
  });
  afterEach(() => {
    if (OLD_SECRET === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = OLD_SECRET;
    if (OLD_TOKEN === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
    else process.env.WHATSAPP_VERIFY_TOKEN = OLD_TOKEN;
  });

  describe("GET (subscription handshake)", () => {
    it("echoes the bare challenge as text when the verify token matches", async () => {
      const res = await GET(
        new Request(
          `${URL_}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242`,
        ),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("4242");
    });

    it("refuses a wrong token with 403 and never echoes the challenge", async () => {
      const res = await GET(
        new Request(
          `${URL_}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242`,
        ),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("4242");
    });

    it("answers 503 when no verify token is configured", async () => {
      delete process.env.WHATSAPP_VERIFY_TOKEN;
      const res = await GET(
        new Request(
          `${URL_}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242`,
        ),
      );
      expect(res.status).toBe(503);
      expect(logWarn).toHaveBeenCalled();
    });
  });

  describe("POST (deliveries)", () => {
    it("records a signed WABA delivery, acks it, schedules processing and logs a content-free summary", async () => {
      const res = await POST(post(inbound));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        acknowledged: true,
        rows: 1,
        inserted: 1,
        unrouted: 0,
      });
      expect(recordWebhookDelivery).toHaveBeenCalledTimes(1);
      expect(processPendingInboundEvents).toHaveBeenCalledTimes(1);

      const call = vi
        .mocked(logInfo)
        .mock.calls.find((c) => c[0] === "whatsapp webhook received");
      expect(call).toBeDefined();
      const ctx = JSON.stringify(call?.[1]);
      expect(ctx).toContain('"phoneNumberIds":["PN"]');
      expect(ctx).toContain('"text":1');
      // ★ The log carries neither the sender nor what they wrote.
      expect(ctx).not.toContain("919876543210");
      expect(ctx).not.toContain('"hi"');
    });

    it("does not schedule processing when nothing new was inserted (a redelivery)", async () => {
      vi.mocked(recordWebhookDelivery).mockResolvedValueOnce({
        rows: 1,
        inserted: 0,
        unrouted: 0,
      });
      const res = await POST(post(inbound));
      expect(res.status).toBe(200);
      expect(processPendingInboundEvents).not.toHaveBeenCalled();
    });

    it("★ answers 503 so Meta retries when the rows could not be written", async () => {
      vi.mocked(recordWebhookDelivery).mockRejectedValueOnce(
        new Error("db down"),
      );
      const res = await POST(post(inbound));
      expect(res.status).toBe(503);
      expect(processPendingInboundEvents).not.toHaveBeenCalled();
    });

    it("rejects a forged or unsigned delivery with 401 before touching the database", async () => {
      expect((await POST(post(inbound, sign(inbound, "other")))).status).toBe(
        401,
      );
      expect((await POST(post(inbound, null))).status).toBe(401);
      expect(recordWebhookDelivery).not.toHaveBeenCalled();
    });

    it("★ verifies the RAW bytes — a signature over re-serialised JSON fails", async () => {
      const raw =
        '{"object":"whatsapp_business_account","entry":[],"x":"caf\\u00e9"}';
      const reserialised = JSON.stringify(JSON.parse(raw));
      expect((await POST(post(raw, sign(raw)))).status).toBe(200);
      expect((await POST(post(reserialised, sign(raw)))).status).toBe(401);
    });

    it("answers 400 to a signed body that is not JSON", async () => {
      expect((await POST(post("not json"))).status).toBe(400);
    });

    it("acknowledges and ignores a signed delivery for another object", async () => {
      const body = JSON.stringify({ object: "page", entry: [] });
      const res = await POST(post(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
      expect(recordWebhookDelivery).not.toHaveBeenCalled();
    });

    it("★ refuses with 503, never a silent 200, when no app secret is configured", async () => {
      delete process.env.WHATSAPP_APP_SECRET;
      const res = await POST(post(inbound));
      expect(res.status).toBe(503);
      expect(recordWebhookDelivery).not.toHaveBeenCalled();
    });
  });
});
