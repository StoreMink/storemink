import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  debugToken,
  deleteMessageTemplate,
  exchangeEmbeddedSignupCode,
  graphRequest,
  isTokenError,
  registerPhoneNumber,
  sendInteractiveMessage,
  sendMediaMessage,
  sendTemplateMessage,
  subscribeAppToWaba,
  uploadMedia,
} from "./graph";

function reply(status: number, body: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("graphRequest — the three-way outcome", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const OLD = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WHATSAPP_APP_ID = "APP";
    process.env.WHATSAPP_APP_SECRET = "SECRET";
    process.env.WHATSAPP_GRAPH_VERSION = "v26.0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD };
  });

  it("returns data on 2xx", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
    const r = await subscribeAppToWaba("tok", "WABA");
    expect(r).toEqual({ ok: true, data: { success: true } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://graph.facebook.com/v26.0/WABA/subscribed_apps",
    );
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
  });

  it("a 4xx with Meta's error object is REJECTED, carrying code and message", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(400, {
        error: {
          message: "Invalid OAuth access token",
          code: 190,
          error_subcode: 463,
        },
      }),
    );
    const r = await registerPhoneNumber("tok", "PN", "123456");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.outcome).toBe("rejected");
    expect(r.code).toBe(190);
    expect(r.subcode).toBe(463);
    expect(r.error).toContain("Invalid OAuth");
    expect(isTokenError(r)).toBe(true);
  });

  it("★ a 5xx is UNKNOWN, never a rejection — the request may have happened", async () => {
    fetchMock.mockResolvedValueOnce(reply(502, undefined));
    const r = await subscribeAppToWaba("tok", "WABA");
    expect(r).toMatchObject({ ok: false, outcome: "unknown" });
    expect(isTokenError(r)).toBe(false);
  });

  it("★ a thrown fetch is UNKNOWN too", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const r = await graphRequest({ path: "/x", token: "tok" });
    expect(r).toMatchObject({ ok: false, outcome: "unknown" });
  });

  it("a 2xx whose body carries an error object is still a rejection", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { error: { message: "Unsupported", code: 100 } }),
    );
    const r = await graphRequest({ path: "/x", token: "tok" });
    expect(r).toMatchObject({ ok: false, outcome: "rejected", code: 100 });
  });

  it("exchangeEmbeddedSignupCode sends the app id and secret as query, never a bearer", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "BIZ" }));
    const r = await exchangeEmbeddedSignupCode("the-code");
    expect(r).toEqual({ ok: true, data: { access_token: "BIZ" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe("/v26.0/oauth/access_token");
    expect(u.searchParams.get("client_id")).toBe("APP");
    expect(u.searchParams.get("client_secret")).toBe("SECRET");
    expect(u.searchParams.get("code")).toBe("the-code");
    expect(
      (init?.headers as Record<string, string> | undefined)?.authorization,
    ).toBeUndefined();
  });

  it("exchangeEmbeddedSignupCode refuses without calling Meta when unconfigured", async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const r = await exchangeEmbeddedSignupCode("c");
    expect(r).toMatchObject({ ok: false, outcome: "rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("debugToken uses the app access token (id|secret)", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { data: { is_valid: true } }));
    await debugToken("BIZ");
    const u = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(u.searchParams.get("input_token")).toBe("BIZ");
    expect(u.searchParams.get("access_token")).toBe("APP|SECRET");
  });
});

describe("sendTemplateMessage — quick-reply buttons", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WHATSAPP_GRAPH_VERSION = "v26.0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD };
  });

  async function sent(
    input: Partial<Parameters<typeof sendTemplateMessage>[2]>,
  ) {
    fetchMock.mockResolvedValueOnce(
      reply(200, { messages: [{ id: "wamid.1" }] }),
    );
    await sendTemplateMessage("TOK", "PN", {
      to: "919876543210",
      name: "sm_x_v1",
      language: "en",
      bodyParams: ["ORD1"],
      ...input,
    });
    const [, init] = fetchMock.mock.calls.at(-1)!;
    return JSON.parse(String(init?.body)).template.components;
  }

  it("★ one button component per payload, indexed in button order", async () => {
    const components = await sent({
      quickReplyPayloads: ["cod:confirm:x", "cod:cancel:x"],
    });
    expect(components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "ORD1" }] },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "0",
        parameters: [{ type: "payload", payload: "cod:confirm:x" }],
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "1",
        parameters: [{ type: "payload", payload: "cod:cancel:x" }],
      },
    ]);
  });

  it("no buttons when none are given", async () => {
    const components = await sent({});
    expect(components).toHaveLength(1);
    expect(components[0].type).toBe("body");
  });
});

describe("sendInteractiveMessage — reply buttons", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WHATSAPP_GRAPH_VERSION = "v26.0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD };
  });

  it("★ posts Meta's interactive button shape: a body and one reply per button, in order", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { messages: [{ id: "wamid.9" }] }),
    );
    const r = await sendInteractiveMessage("TOK", "PN", {
      to: "919876543210",
      body: "How can we help?",
      buttons: [
        { id: "menu:b1", title: "Check my order" },
        { id: "menu:b2", title: "Talk to a person" },
      ],
    });
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe("https://graph.facebook.com/v26.0/PN/messages");
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "How can we help?" },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: "menu:b1", title: "Check my order" },
            },
            {
              type: "reply",
              reply: { id: "menu:b2", title: "Talk to a person" },
            },
          ],
        },
      },
    });
  });
});

describe("deleteMessageTemplate", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WHATSAPP_GRAPH_VERSION = "v26.0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD };
  });

  it("★ names the template and, when known, Meta's id, so only that language goes", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
    const r = await deleteMessageTemplate("TOK", "W", {
      name: "delivery_delay",
      hsmId: "123",
    });
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(init?.method).toBe("DELETE");
    expect(String(url)).toBe(
      "https://graph.facebook.com/v26.0/W/message_templates?name=delivery_delay&hsm_id=123",
    );
  });

  it("by name alone when no id was ever recorded", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
    await deleteMessageTemplate("TOK", "W", { name: "delivery_delay" });
    const [url] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe(
      "https://graph.facebook.com/v26.0/W/message_templates?name=delivery_delay",
    );
  });
});

describe("media out (slice 6)", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WHATSAPP_GRAPH_VERSION = "v26.0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD };
  });

  it("★ uploadMedia posts the bytes as multipart to the number's media endpoint and returns Meta's id", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: "MEDIA1" }));
    const r = await uploadMedia("TOK", "PN", {
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/jpeg",
      filename: "p.jpg",
    });
    expect(r).toEqual({ ok: true, data: { id: "MEDIA1" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://graph.facebook.com/v26.0/PN/media");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer TOK");
    // fetch sets the multipart boundary itself; a JSON content type would
    // make Meta read the form as a broken JSON body.
    expect(headers["content-type"]).toBeUndefined();
    const form = init?.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("image/jpeg");
    expect((form.get("file") as File).name).toBe("p.jpg");
  });

  it("an upload Meta answers without an id is unknown, never a success", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {}));
    const r = await uploadMedia("TOK", "PN", {
      bytes: new Uint8Array([1]),
      mime: "application/pdf",
      filename: "a.pdf",
    });
    expect(r).toMatchObject({ ok: false, outcome: "unknown" });
  });

  it("sendMediaMessage names the media by id under its kind, with caption, filename and the quote", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { messages: [{ id: "wamid.d" }] }),
    );
    await sendMediaMessage("TOK", "PN", {
      to: "919876543210",
      kind: "document",
      mediaId: "MEDIA1",
      caption: "Size chart",
      filename: "size-chart.pdf",
      replyToProviderId: "wamid.in1",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "document",
      context: { message_id: "wamid.in1" },
      document: {
        id: "MEDIA1",
        caption: "Size chart",
        filename: "size-chart.pdf",
      },
    });
  });

  it("an image carries no filename and no empty caption", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { messages: [{ id: "wamid.i" }] }),
    );
    await sendMediaMessage("TOK", "PN", {
      to: "919876543210",
      kind: "image",
      mediaId: "MEDIA2",
      caption: null,
      filename: "ignored.jpg",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.image).toEqual({ id: "MEDIA2" });
    expect(body.context).toBeUndefined();
  });
});
