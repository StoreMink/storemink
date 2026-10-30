/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { findOldPosWording } from "../../scripts/pos-wording.mjs";

const dbHolder = vi.hoisted(() => ({ current: null as any, fail: false }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) =>
    dbHolder.fail
      ? Promise.reject(new Error("connection refused"))
      : Promise.resolve(fn(dbHolder.current.db)),
  ),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("./send", () => ({
  sendEmail: vi.fn(async () => ({ sent: true })),
}));

import { sendEmail } from "./send";
import {
  TAKEDOWN_FROM,
  buildAcknowledgementEmail,
  buildBlockLiftedEmail,
  buildBlockNoticeEmail,
  buildOutcomeEmail,
  buildStoreMinkRepliedEmail,
  buildStoreSuspendedEmail,
  noticeUrl,
  sendComplainantEmail,
  sendStoreNotice,
  storeOwnerEmails,
  uniqueEmails,
  type TakedownEmail,
} from "./takedown-emails";
import {
  BLOCK_KINDS,
  COMPLAINT_KINDS,
  COMPLAINT_OUTCOMES,
  reasonsForKind,
} from "@/lib/moderation/kinds";
import { defaultStoreMessage } from "@/lib/moderation/copy";

const BLOCK = "0f9b5c1e-4a7d-4c2b-9e1f-3a2b1c0d9e8f";
const LINK = { slug: "acme", blockId: BLOCK };
const NOTICE_URL = `https://acme.storemink.com/dashboard/settings/notices/${BLOCK}`;
const STORE_X = "11111111-1111-4111-8111-111111111111";

/** What a reader sees: the HTML with tags dropped and entities read. */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** Every rule an email must keep, for any kind, reason or route. */
function problems(name: string, email: TakedownEmail): string[] {
  const found: string[] = [];
  const text = `${email.subject} ${visibleText(email.html)}`;
  if (/[\u2013\u2014]/.test(text)) found.push(`${name}: a long dash`);
  if (/\bcredits?\b/i.test(text)) found.push(`${name}: a credit figure`);
  if (/\b(?:undefined|NaN|null)\b|\[object Object\]/.test(text)) {
    found.push(`${name}: a leaked value`);
  }
  if (/[{}]/.test(email.subject)) found.push(`${name}: a placeholder`);
  if (/reply below/i.test(text)) found.push(`${name}: "reply below"`);
  for (const hit of findOldPosWording(text)) {
    found.push(`${name}: old POS word "${hit.words}"`);
  }
  if (!email.html.includes('class="sm-email-canvas"')) {
    found.push(`${name}: not the standard frame`);
  }
  return found;
}

const TYPES = [null, "image/jpeg", "application/pdf"];
const COMPLAINTS = [null, "c"];

describe("the store notices (design 7.6)", () => {
  it("builds the block notice for every kind, reason, route and file type", () => {
    const found: string[] = [];
    let count = 0;
    for (const kind of BLOCK_KINDS) {
      if (kind === "store") continue;
      for (const reasonKind of reasonsForKind(kind)) {
        for (const complaintId of COMPLAINTS) {
          for (const contentType of TYPES) {
            const email = buildBlockNoticeEmail(
              {
                storeName: "Acme Shoes",
                kind,
                contentType,
                itemLabel: "Leather shoe",
                blockedOn: "30 Oct 2026",
                reasonKind,
                reference: complaintId ? "SM-000123" : null,
                storeMessage:
                  defaultStoreMessage(reasonKind, kind, contentType) ?? "",
                complaintId,
              },
              LINK,
            );
            count += 1;
            found.push(...problems(`${kind}/${reasonKind}`, email));
            expect(email.html).toContain(`href="${NOTICE_URL}"`);
            expect(visibleText(email.html)).toContain("Read the notice");
          }
        }
      }
    }
    expect(found).toEqual([]);
    expect(count).toBeGreaterThan(100);
  });

  it("names the route in email words: the dashboard notice, or this email", () => {
    const officer = buildBlockNoticeEmail(
      {
        storeName: "Acme",
        kind: "product",
        itemLabel: "Shoe",
        blockedOn: "30 Oct 2026",
        reasonKind: "terms_breach",
        reference: null,
        storeMessage: "We blocked it.",
        complaintId: null,
      },
      LINK,
    );
    expect(visibleText(officer.html)).toContain(
      "If you disagree, reply on the notice in your dashboard or to this email, or write to our Grievance Officer at support@storemink.com.",
    );
    const asked = buildBlockNoticeEmail(
      {
        storeName: "Acme",
        kind: "review",
        itemLabel: "Rahul S.",
        blockedOn: "30 Oct 2026",
        reasonKind: "store_request",
        reference: null,
        storeMessage: "We hid it.",
        complaintId: null,
      },
      LINK,
    );
    expect(visibleText(asked.html)).toContain(
      "If you want it shown again, reply on the notice in your dashboard and tick Please show it again.",
    );
    const suspended = buildStoreSuspendedEmail({
      storeName: "Acme",
      suspendedOn: "30 Oct 2026",
      reasonKind: "terms_breach",
      reference: null,
      storeMessage: "",
      complaintId: null,
    });
    expect(visibleText(suspended.html)).toContain(
      "If you disagree, reply to this email, or write to our Grievance Officer",
    );
  });

  it("builds the suspension notice with no button, and says POS (A9)", () => {
    const found: string[] = [];
    for (const reasonKind of reasonsForKind("store")) {
      for (const complaintId of COMPLAINTS) {
        const email = buildStoreSuspendedEmail({
          storeName: "Acme Shoes",
          suspendedOn: "30 Oct 2026",
          reasonKind,
          reference: complaintId ? "SM-000123" : null,
          storeMessage: defaultStoreMessage(reasonKind, "store") ?? "",
          complaintId,
        });
        found.push(...problems(`store/${reasonKind}`, email));
        expect(email.subject).toBe("StoreMink has suspended Acme Shoes");
        expect(email.html).not.toContain("/dashboard/settings/notices");
        expect(visibleText(email.html)).toContain(
          "you and your staff can't open its dashboard or POS.",
        );
      }
    }
    expect(found).toEqual([]);
  });

  it("builds the lifted and replied emails, and a suspended store gets no button", () => {
    const found: string[] = [];
    for (const kind of BLOCK_KINDS) {
      for (const contentType of TYPES) {
        const lifted = buildBlockLiftedEmail(
          {
            storeName: "Acme Shoes",
            kind,
            contentType,
            itemLabel: kind === "store" ? "" : "Leather shoe",
            liftNote: "We looked again.",
          },
          LINK,
        );
        found.push(...problems(`lifted/${kind}`, lifted));
        expect(lifted.html).toContain(`href="${NOTICE_URL}"`);
        for (const storeSuspended of [true, false]) {
          const replied = buildStoreMinkRepliedEmail(
            {
              storeName: "Acme Shoes",
              kind,
              contentType,
              itemLabel: kind === "store" ? "" : "Leather shoe",
              reply: "Thank you. We have looked again.",
              storeSuspended,
            },
            LINK,
          );
          found.push(...problems(`replied/${kind}`, replied));
          const shut = kind === "store" && storeSuspended;
          expect(replied.html.includes(NOTICE_URL)).toBe(!shut);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("escapes every value it places, and links nothing it was given", () => {
    const email = buildBlockNoticeEmail(
      {
        storeName: `Acme <script>alert("x")</script>`,
        kind: "product",
        itemLabel: `<img src=x onerror=alert(1)>`,
        blockedOn: "30 Oct 2026",
        reasonKind: "terms_breach",
        reference: null,
        storeMessage: `<a href="https://evil.example">click</a> & more`,
        complaintId: null,
      },
      LINK,
    );
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain('href="https://evil.example"');
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&lt;a href=");
  });

  it("builds a notice link only for a real slug and block id", () => {
    expect(noticeUrl("acme", BLOCK)).toBe(NOTICE_URL);
    expect(noticeUrl("acme", BLOCK.toUpperCase())).toBe(NOTICE_URL);
    for (const [slug, id] of [
      ["acme", "../../settings"],
      ["acme", ""],
      ["evil.example/x", BLOCK],
      ["", BLOCK],
      ["a b", BLOCK],
    ]) {
      expect(noticeUrl(slug, id)).toBeNull();
    }
    // No link, no button: the notice still reads, without one.
    const email = buildBlockNoticeEmail(
      {
        storeName: "Acme",
        kind: "page",
        itemLabel: "About us",
        blockedOn: "30 Oct 2026",
        reasonKind: "terms_breach",
        reference: null,
        storeMessage: "We blocked it.",
        complaintId: null,
      },
      { slug: "acme", blockId: "not-a-block" },
    );
    expect(email.html).not.toContain("/dashboard/settings/notices");
    expect(visibleText(email.html)).not.toContain("Read the notice");
  });
});

describe("the complainant emails (design 7.6)", () => {
  it("acknowledges every kind of complaint, quoting it as recorded", () => {
    const found: string[] = [];
    for (const kind of COMPLAINT_KINDS) {
      for (const name of ["Asha", "", null]) {
        const email = buildAcknowledgementEmail({
          name,
          receivedAt: "30 Oct 2026, 14:05 IST",
          reference: "SM-000123",
          kind,
          recorded: {
            summary: "A listing uses my photo.",
            addresses: ["https://acme.storemink.com/shop/shoe"],
          },
        });
        found.push(...problems(`ack/${kind}`, email));
        expect(email.subject).toBe(
          "We received your complaint (reference SM-000123)",
        );
        const text = visibleText(email.html);
        expect(text).toContain("Your complaint, as we recorded it:");
        expect(text).toContain("A listing uses my photo.");
        expect(text).toContain("Grievance Officer, STOREMINK LLP");
        expect(text).toContain("support@storemink.com");
        expect(text).toContain(name ? `Hello ${name},` : "Hello,");
      }
    }
    expect(found).toEqual([]);
  });

  it("never links a reported address, and escapes the complaint", () => {
    const email = buildAcknowledgementEmail({
      name: "<b>Asha</b>",
      receivedAt: "30 Oct 2026, 14:05 IST",
      reference: "SM-000123",
      kind: "grievance",
      recorded: {
        summary: "<script>x()</script>",
        addresses: ["https://evil.example/page"],
      },
    });
    expect(email.html).not.toContain("<script>x()");
    expect(email.html).not.toContain("<b>Asha</b>");
    expect(email.html).not.toContain('href="https://evil.example/page"');
    expect(visibleText(email.html)).toContain("https://evil.example/page");
  });

  it("tells the decision for every outcome", () => {
    const found: string[] = [];
    for (const outcome of COMPLAINT_OUTCOMES) {
      for (const note of ["The listing was removed.", "", null]) {
        const email = buildOutcomeEmail({
          name: "Asha",
          reference: "SM-000123",
          outcome,
          note,
        });
        found.push(...problems(`outcome/${outcome}`, email));
        expect(email.subject).toBe("Your complaint SM-000123: our decision");
        expect(visibleText(email.html)).toContain("gac.gov.in");
      }
    }
    expect(found).toEqual([]);
  });
});

describe("storeOwnerEmails", () => {
  beforeEach(() => {
    dbHolder.fail = false;
  });

  it("addresses every owner once, in the order they joined", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        stores: [[{ name: "Acme Shoes", slug: "acme", status: "active" }]],
        admins: [
          [
            { email: "owner@acme.example" },
            { email: "Partner@Acme.example" },
            { email: " owner@ACME.example " },
            { email: "" },
          ],
        ],
      },
    });
    await expect(storeOwnerEmails(STORE_X)).resolves.toEqual({
      emails: ["owner@acme.example", "Partner@Acme.example"],
      storeName: "Acme Shoes",
      slug: "acme",
      storeStatus: "active",
    });
  });

  it("falls back to the invoice contact when no owner has an email", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        stores: [[{ name: "Acme", slug: "acme", status: "suspended" }]],
        admins: [[]],
        store_billing_settings: [[{ email: "accounts@acme.example" }]],
      },
    });
    const owners = await storeOwnerEmails(STORE_X);
    expect(owners?.emails).toEqual(["accounts@acme.example"]);
    expect(owners?.storeStatus).toBe("suspended");
  });

  it("answers nobody, and null, when it cannot", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        stores: [[{ name: "Acme", slug: "acme", status: "active" }]],
        admins: [[]],
        store_billing_settings: [[]],
      },
    });
    expect((await storeOwnerEmails(STORE_X))?.emails).toEqual([]);
    dbHolder.current = makeDbMock({ selectByTable: { stores: [[]] } });
    await expect(storeOwnerEmails(STORE_X)).resolves.toBeNull();
    dbHolder.fail = true;
    await expect(storeOwnerEmails(STORE_X)).resolves.toBeNull();
  });

  it("keeps each address once", () => {
    expect(
      uniqueEmails(["a@x.example", "A@X.example ", null, "", "nope"]),
    ).toEqual(["a@x.example"]);
  });
});

describe("sending", () => {
  const email: TakedownEmail = { subject: "S", html: "<p>H</p>" };

  it("sends a store notice to every owner, logged under the store", async () => {
    const result = await sendStoreNotice({
      storeId: STORE_X,
      to: ["owner@acme.example", "partner@acme.example", "OWNER@acme.example"],
      email,
    });
    expect(result).toEqual({ recipients: 2, sent: 2, failed: 0 });
    expect(vi.mocked(sendEmail).mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        storeId: STORE_X,
        to: "owner@acme.example",
        from: TAKEDOWN_FROM,
        mailer: "takedown_notice",
      }),
      expect.objectContaining({
        storeId: STORE_X,
        to: "partner@acme.example",
        mailer: "takedown_notice",
      }),
    ]);
    expect(TAKEDOWN_FROM).toBe("StoreMink <support@storemink.com>");
  });

  it("counts a send that did not go as failed", async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({
      sent: false,
      error: "boom",
    });
    const result = await sendStoreNotice({
      storeId: STORE_X,
      to: ["a@acme.example", "b@acme.example"],
      email,
    });
    expect(result).toEqual({ recipients: 2, sent: 1, failed: 1 });
  });

  // Design F9: a complaint about a store must never land in that store's
  // email log, which its staff can read.
  it("sends a complainant email as platform mail, never under the store", async () => {
    await sendComplainantEmail({
      to: "asha@example.com",
      email,
      complaint: { id: "complaint-1", storeId: STORE_X },
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toMatchObject({
      storeId: null,
      to: "asha@example.com",
      from: TAKEDOWN_FROM,
      mailer: "complaint_reply",
    });
  });
});
