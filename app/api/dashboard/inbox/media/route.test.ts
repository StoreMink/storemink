/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(async () => ({ userId: "admin-1" })),
}));
vi.mock("@/lib/whatsapp/inbox-gate", () => ({
  inboxSendGate: vi.fn(),
  isUuid: (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
}));
vi.mock("@/lib/whatsapp/inbox", () => ({
  serviceWindow: (at: string | null) => {
    const open =
      Boolean(at) && Date.now() - new Date(at!).getTime() < 86_400_000;
    return { open, closesAt: null };
  },
}));
vi.mock("@/lib/whatsapp/inbox-media", () => ({
  prepareOutboundMedia: vi.fn(async () => ({
    ok: true,
    media: {
      kind: "document",
      bytes: new Uint8Array([1]),
      mime: "application/pdf",
      ext: ".pdf",
      filename: "a.pdf",
      name: "a.pdf",
    },
  })),
  sendInboxMedia: vi.fn(async () => ({ ok: true, messageId: "m1" })),
}));
vi.mock("@/lib/whatsapp/inbox-read", () => ({
  loadQuotableProviderId: vi.fn(async () => "wamid.q"),
}));

import { POST } from "./route";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { inboxSendGate } from "@/lib/whatsapp/inbox-gate";
import {
  prepareOutboundMedia,
  sendInboxMedia,
} from "@/lib/whatsapp/inbox-media";

const CONV = "22222222-2222-4222-8222-222222222222";
const MSG = "55555555-5555-4555-8555-555555555555";

function request(fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof File) form.set(k, v, v.name);
    else form.set(k, v);
  }
  return new NextRequest("http://store.localhost/api/dashboard/inbox/media", {
    method: "POST",
    body: form,
  });
}

const pdf = () =>
  new File([new TextEncoder().encode("%PDF-1.4")], "a.pdf", {
    type: "application/pdf",
  });

function gateOk(lastInboundAt: string | null) {
  vi.mocked(inboxSendGate).mockResolvedValue({
    ok: true,
    storeId: "s1",
    userId: "admin-1",
    core: {
      id: CONV,
      contact: { phone: "+919876543210", lastInboundAt },
    } as any,
    sender: { token: "tok", phoneNumberId: "PN" } as any,
  });
}

beforeEach(() => gateOk(new Date().toISOString()));

describe("POST /api/dashboard/inbox/media", () => {
  it("★ sends a prepared file through the one send path, with the caption and the quote", async () => {
    const res = await POST(
      request({
        conversationId: CONV,
        file: pdf(),
        caption: "Size chart",
        replyTo: MSG,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: "m1" });
    expect(inboxSendGate).toHaveBeenCalledWith(CONV);
    expect(prepareOutboundMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mime: "application/pdf", name: "a.pdf" }),
    );
    expect(sendInboxMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "s1",
        userId: "admin-1",
        conversationId: CONV,
        to: "+919876543210",
        caption: "Size chart",
        quotedProviderId: "wamid.q",
      }),
    );
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("a signed-out upload is a 401 the caller can act on", async () => {
    vi.mocked(getViewerContext).mockResolvedValueOnce(null as any);
    const res = await POST(request({ conversationId: CONV, file: pdf() }));
    expect(res.status).toBe(401);
    expect(sendInboxMedia).not.toHaveBeenCalled();
  });

  it("the gate's refusal is the answer: no permission is 403, a paused number 409", async () => {
    vi.mocked(inboxSendGate).mockResolvedValueOnce({
      ok: false,
      result: {
        ok: false,
        error: "You don't have permission to reply in the inbox.",
      },
    });
    expect(
      (await POST(request({ conversationId: CONV, file: pdf() }))).status,
    ).toBe(403);
    vi.mocked(inboxSendGate).mockResolvedValueOnce({
      ok: false,
      result: { ok: false, code: "not_connected", error: "paused" },
    });
    expect(
      (await POST(request({ conversationId: CONV, file: pdf() }))).status,
    ).toBe(409);
    expect(sendInboxMedia).not.toHaveBeenCalled();
  });

  it("★ outside the 24-hour window a file is refused like text, before it is prepared", async () => {
    gateOk(new Date(Date.now() - 25 * 3600_000).toISOString());
    const res = await POST(request({ conversationId: CONV, file: pdf() }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "window_closed",
    });
    expect(prepareOutboundMedia).not.toHaveBeenCalled();
  });

  it("a file that fails preparation is a 400 with its reason, and nothing is sent", async () => {
    vi.mocked(prepareOutboundMedia).mockResolvedValueOnce({
      ok: false,
      error: "That file is not a PDF.",
    });
    const res = await POST(request({ conversationId: CONV, file: pdf() }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: "That file is not a PDF.",
    });
    expect(sendInboxMedia).not.toHaveBeenCalled();
  });

  it("no file, or a malformed conversation id, never reaches the gate", async () => {
    expect((await POST(request({ conversationId: CONV }))).status).toBe(400);
    expect(
      (await POST(request({ conversationId: "nope", file: pdf() }))).status,
    ).toBe(404);
    expect(inboxSendGate).not.toHaveBeenCalled();
  });
});
