import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { findOldPosWording } from "../../scripts/pos-wording.mjs";
import * as Copy from "./copy";
import {
  ACKNOWLEDGEMENT_APPEAL,
  COMPLAINANT_SIGNOFF,
  ITEM,
  NOTICE,
  NOTICES,
  NOTICE_REPLY,
  SHOPPER,
  STORE_EVENTS,
  acknowledgementEmail,
  attachmentRefusal,
  blockLiftedEmail,
  blockNoticeEmail,
  blockedBell,
  complainantGreeting,
  complaintTimingSentence,
  defaultStoreMessage,
  homeBanner,
  itemBlockedBanner,
  itemStatusLabel,
  liftBanner,
  liftedBell,
  meaningFirstSentence,
  minkBlockedSentence,
  noticeReasonLabel,
  noticeTitle,
  outcomeEmail,
  outcomeSentence,
  replyBell,
  replyTick,
  routeSentence,
  storeMinkRepliedEmail,
  storeReplyAuthor,
  storeSuspendedEmail,
  uploadRefusal,
  whatThisMeans,
  whatYouCanDo,
  type BannerKind,
  type ItemKind,
} from "./copy";
import {
  BLOCK_KINDS,
  BLOCK_REASONS,
  COMPLAINT_KINDS,
  COMPLAINT_OUTCOMES,
  type AppealRoute,
} from "./kinds";

// ---------------------------------------------------------------------------
// Every merchant, shopper and complainant sentence of a takedown, rendered
// for every kind, file type, reason and route, and read for the owner's
// rules: no long dash, no square bracket, "an image" never "a image", no
// Mink credit figure, POS never "register" or "till", nothing left unfilled.
// ---------------------------------------------------------------------------

const ITEM_KINDS = BLOCK_KINDS.filter((k): k is ItemKind => k !== "store");
const BANNER_KINDS: BannerKind[] = [
  "product",
  "page",
  "blog_post",
  "collection",
];
const TYPES = [
  null,
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "video/mp4",
];
const ROUTES: AppealRoute[] = [
  "order",
  "committee",
  "grievance_officer",
  "none",
];
const COMPLAINTS = [null, "8d0b8a8e-3f7a-4a51-9a3e-6a8f1f0c2b11"];
const LABELS = ["Leather shoe", "", null];
const NAMES = ["Asha", "", null];
const REFERENCES = ["SM-000123", null];

function flat<T, U>(items: readonly T[], each: (item: T) => U[]): U[] {
  return items.flatMap(each);
}

const SWEEP: Record<string, () => unknown[]> = {
  noticeTitle: () =>
    flat(BLOCK_KINDS, (kind) =>
      flat(BLOCK_REASONS, (reasonKind) =>
        flat(TYPES, (contentType) =>
          [true, false].map((lifted) =>
            noticeTitle({ kind, reasonKind, contentType, lifted }),
          ),
        ),
      ),
    ),
  noticeReasonLabel: () => BLOCK_REASONS.map(noticeReasonLabel),
  whatThisMeans: () =>
    flat(BLOCK_KINDS, (kind) => TYPES.map((t) => whatThisMeans(kind, t))),
  meaningFirstSentence: () =>
    flat(BLOCK_KINDS, (kind) =>
      TYPES.map((t) => meaningFirstSentence(kind, t)),
    ),
  routeSentence: () => ROUTES.map(routeSentence),
  whatYouCanDo: () =>
    flat(BLOCK_REASONS, (reasonKind) =>
      COMPLAINTS.map((complaintId) =>
        whatYouCanDo({ reasonKind, complaintId }),
      ),
    ),
  liftBanner: () => [
    liftBanner("30 Oct 2026", "The order was set aside."),
    liftBanner("30 Oct 2026", ""),
    liftBanner(" 30 Oct 2026 ", null),
  ],
  storeReplyAuthor: () => [
    storeReplyAuthor("owner@shop.example.com", false),
    storeReplyAuthor("owner@shop.example.com", true),
    storeReplyAuthor("", true),
    storeReplyAuthor(null, false),
  ],
  replyTick: () => ROUTES.map(replyTick),
  defaultStoreMessage: () =>
    flat(BLOCK_REASONS, (reason) =>
      flat(BLOCK_KINDS, (kind) =>
        TYPES.map((t) => defaultStoreMessage(reason, kind, t)),
      ),
    ).filter((m): m is string => m !== null),
  itemStatusLabel: () => BLOCK_KINDS.map(itemStatusLabel),
  itemBlockedBanner: () => BANNER_KINDS.map(itemBlockedBanner),
  homeBanner: () => [0, 1, 2, 17, Number.NaN].map(homeBanner),
  minkBlockedSentence: () =>
    ["Leather shoe", "", null, undefined].map(minkBlockedSentence),
  uploadRefusal: () =>
    flat([true, false], (told) =>
      ["image", "file", "anything"].map((kindWord) =>
        uploadRefusal({ told, kindWord }),
      ),
    ),
  attachmentRefusal: () => [true, false].map(attachmentRefusal),
  blockedBell: () =>
    flat(BLOCK_KINDS, (kind) =>
      flat(TYPES, (contentType) =>
        LABELS.map((itemLabel) =>
          blockedBell({ kind, contentType, itemLabel }),
        ),
      ),
    ),
  liftedBell: () =>
    flat(BLOCK_KINDS, (kind) =>
      flat(TYPES, (contentType) =>
        LABELS.map((itemLabel) => liftedBell({ kind, contentType, itemLabel })),
      ),
    ),
  replyBell: () =>
    flat(BLOCK_KINDS, (kind) =>
      flat(TYPES, (contentType) =>
        LABELS.map((itemLabel) => replyBell({ kind, contentType, itemLabel })),
      ),
    ),
  blockNoticeEmail: () =>
    flat(ITEM_KINDS, (kind) =>
      flat(TYPES, (contentType) =>
        flat(BLOCK_REASONS, (reasonKind) =>
          flat(COMPLAINTS, (complaintId) =>
            flat(REFERENCES, (reference) =>
              ["Leather shoe", ""].map((itemLabel) =>
                blockNoticeEmail({
                  storeName: "Acme Shoes",
                  kind,
                  contentType,
                  itemLabel,
                  blockedOn: "30 Oct 2026",
                  reasonKind,
                  reference,
                  storeMessage:
                    defaultStoreMessage(reasonKind, kind, contentType) ?? "",
                  complaintId,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  storeSuspendedEmail: () =>
    flat(BLOCK_REASONS, (reasonKind) =>
      flat(COMPLAINTS, (complaintId) =>
        REFERENCES.map((reference) =>
          storeSuspendedEmail({
            storeName: "Acme Shoes",
            suspendedOn: "30 Oct 2026",
            reasonKind,
            reference,
            storeMessage: defaultStoreMessage(reasonKind, "store") ?? "",
            complaintId,
          }),
        ),
      ),
    ),
  blockLiftedEmail: () =>
    flat(BLOCK_KINDS, (kind) =>
      flat(TYPES, (contentType) =>
        ["Lifted after review.", "", null].map((liftNote) =>
          blockLiftedEmail({
            storeName: "Acme Shoes",
            kind,
            contentType,
            itemLabel: "Leather shoe",
            liftNote,
          }),
        ),
      ),
    ),
  storeMinkRepliedEmail: () =>
    flat(BLOCK_KINDS, (kind) =>
      flat(TYPES, (contentType) =>
        [true, false].map((storeSuspended) =>
          storeMinkRepliedEmail({
            storeName: "Acme Shoes",
            kind,
            contentType,
            itemLabel: kind === "store" ? "" : "Leather shoe",
            reply: "Thank you. We have looked again.",
            storeSuspended,
          }),
        ),
      ),
    ),
  complainantGreeting: () => NAMES.map(complainantGreeting),
  complaintTimingSentence: () => COMPLAINT_KINDS.map(complaintTimingSentence),
  acknowledgementEmail: () =>
    flat(COMPLAINT_KINDS, (kind) =>
      NAMES.map((name) =>
        acknowledgementEmail({
          name,
          receivedAt: "30 Oct 2026, 14:05 IST",
          reference: "SM-000123",
          kind,
        }),
      ),
    ),
  outcomeSentence: () => COMPLAINT_OUTCOMES.map(outcomeSentence),
  outcomeEmail: () =>
    flat(COMPLAINT_OUTCOMES, (outcome) =>
      ["The listing was removed.", "", null].map((note) =>
        outcomeEmail({ name: "Asha", reference: "SM-000123", outcome, note }),
      ),
    ),
};

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) stringsIn(v, out);
  }
  return out;
}

const PROBLEMS: { name: string; pattern: RegExp }[] = [
  { name: "a long dash", pattern: /[\u2013\u2014]/ },
  { name: "a square bracket", pattern: /[[\]]/ },
  { name: "a before a vowel", pattern: /\ba [aeiou]/i },
  { name: "an before a consonant", pattern: /\ban (?![aeiou])[a-z]/i },
  { name: "a credit figure", pattern: /\bcredits?\b/i },
  { name: "an HTML entity", pattern: /&(?:[a-z]+|#\d+);/i },
  {
    name: "a leaked value",
    pattern: /\b(?:undefined|NaN|null|Infinity)\b|\[object Object\]/,
  },
  { name: "an unfilled placeholder", pattern: /[{}]/ },
  { name: "a double space", pattern: / {2}/ },
  { name: "a space before punctuation", pattern: / [,.;:!?](?:\s|$)/ },
  { name: "space at an edge", pattern: /^\s|\s$/ },
];

function problemsIn(where: string, texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const { name, pattern } of PROBLEMS) {
      if (pattern.test(text)) found.push(`${where}: ${name} in "${text}"`);
    }
    for (const hit of findOldPosWording(text)) {
      found.push(`${where}: old POS word "${hit.words}" in "${text}"`);
    }
  }
  return found;
}

describe("the sweep", () => {
  it("covers every exported function", () => {
    const functions = Object.entries(Copy)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(functions).toEqual(Object.keys(SWEEP).sort());
  });

  it("finds nothing wrong in any output, for any kind, file type, reason or route", () => {
    const found: string[] = [];
    let count = 0;
    for (const [name, run] of Object.entries(SWEEP)) {
      const texts = stringsIn(run());
      expect(texts.length, name).toBeGreaterThan(0);
      count += texts.length;
      found.push(...problemsIn(name, texts));
    }
    expect(found).toEqual([]);
    expect(count).toBeGreaterThan(5000);
  });

  it("finds nothing wrong in any exported constant", () => {
    const constants = Object.entries(Copy).filter(
      ([, v]) => typeof v !== "function",
    );
    expect(constants.length).toBeGreaterThan(8);
    const found = constants.flatMap(([name, value]) =>
      problemsIn(name, stringsIn(value)),
    );
    expect(found).toEqual([]);
  });

  it("CONTROL: the checks catch what they look for", () => {
    const bad = [
      "StoreMink has blocked a image",
      "We blocked an product",
      "closed to shoppers \u2014 for now",
      "pages 1\u20132",
      "See [the notice]",
      "This used 5 Mink credits",
      "its dashboard and register could not be opened",
      "Open the till",
      "Blocked on undefined",
      "Hello {name},",
      "Two  spaces",
      "A &amp; B",
      "Ends with a space ",
    ];
    for (const text of bad) {
      expect(problemsIn("control", [text]), text).not.toEqual([]);
    }
  });
});

describe("the words, as the design writes them", () => {
  it("titles each notice by kind, request and lift", () => {
    expect(
      noticeTitle({
        kind: "product",
        reasonKind: "court_order",
        lifted: false,
      }),
    ).toBe("Product blocked by StoreMink");
    expect(
      noticeTitle({
        kind: "file",
        reasonKind: "terms_breach",
        contentType: "image/png",
        lifted: false,
      }),
    ).toBe("Image blocked by StoreMink");
    expect(
      noticeTitle({
        kind: "blog_comment",
        reasonKind: "store_request",
        lifted: false,
      }),
    ).toBe("Comment removed at your request");
    expect(
      noticeTitle({ kind: "store", reasonKind: "court_order", lifted: false }),
    ).toBe("Store suspended by StoreMink");
    expect(
      noticeTitle({
        kind: "blog_post",
        reasonKind: "court_order",
        lifted: true,
      }),
    ).toBe("Blog post unblocked by StoreMink");
    expect(
      noticeTitle({ kind: "store", reasonKind: "terms_breach", lifted: true }),
    ).toBe("Suspension lifted by StoreMink");
  });

  it("says what a block means, kind by kind (A9, A16)", () => {
    expect(whatThisMeans("page")).toHaveLength(3);
    expect(whatThisMeans("file", "application/pdf")[0]).toBe(
      "It can no longer be opened from your store.",
    );
    expect(whatThisMeans("file", "image/webp")[0]).toContain(
      "You can't put the same image back while it is blocked.",
    );
    expect(whatThisMeans("store")[0]).toContain("its dashboard and POS");
    for (const kind of BLOCK_KINDS) {
      expect(whatThisMeans(kind).at(-1)).toBe(
        "StoreMink keeps a copy for at least 180 days, as the law requires. You can't see or change that copy.",
      );
    }
    expect(meaningFirstSentence("product")).toBe(
      "Shoppers can't see it on your store, in search or in your sitemap.",
    );
  });

  it("says what the store can do, route by route", () => {
    expect(
      whatYouCanDo({ reasonKind: "court_order", complaintId: "c" }),
    ).toEqual([
      "Reply below to tell us your side. If you have fixed the problem, tick Please review it again.",
      "This block follows a legal order. We can lift it only when the order allows it.",
    ]);
    expect(
      whatYouCanDo({ reasonKind: "store_request", complaintId: null }),
    ).toEqual([
      "Reply below to tell us your side.",
      "If you want it shown again, reply below and tick Please show it again.",
    ]);
    expect(routeSentence("grievance_officer")).toContain(
      "write to our Grievance Officer at support@storemink.com",
    );
    expect(replyTick("none")).toBe("Please show it again.");
    expect(replyTick("committee")).toBe(
      "I have fixed this. Please review it again.",
    );
  });

  it("prefills the store's message from the reason (design 7.2)", () => {
    expect(defaultStoreMessage("terms_breach", "file", "image/jpeg")).toBe(
      "We blocked this image because it breaks our Acceptable Use Policy.",
    );
    expect(defaultStoreMessage("store_request", "review")).toBe(
      "We removed this review because you asked us to.",
    );
    expect(defaultStoreMessage("store_request", "product")).toBeNull();
    expect(defaultStoreMessage("store_request", "store")).toBeNull();
    expect(defaultStoreMessage("court_order", "store")).toBe(
      "We suspended your store because a court ordered us to. We can't open it again while the order applies.",
    );
    for (const reason of BLOCK_REASONS) {
      if (reason === "store_request") continue;
      for (const kind of BLOCK_KINDS) {
        expect(
          defaultStoreMessage(reason, kind),
          `${reason} ${kind}`,
        ).not.toBeNull();
      }
    }
  });

  it("labels and banners on the item (design 7.3)", () => {
    expect(itemStatusLabel("product")).toBe(ITEM.blocked);
    expect(itemStatusLabel("review")).toBe(ITEM.removed);
    expect(itemBlockedBanner("collection")).toBe(
      "StoreMink has blocked this collection, so it isn't shown on your store. You can still edit it. It stays hidden until StoreMink lifts the block.",
    );
    expect(itemBlockedBanner("page")).toContain(
      "You can still edit and publish it",
    );
    expect(homeBanner(1)).toBe("StoreMink has blocked 1 item on your store.");
    expect(homeBanner(3)).toBe("StoreMink has blocked 3 items on your store.");
  });

  it("Mink AI, the shopper and the upload refusals (design 7.4, A4, D21)", () => {
    expect(minkBlockedSentence("Leather shoe")).toBe(
      "StoreMink has blocked Leather shoe. It stays hidden from your store until StoreMink lifts the block. You can read why in Settings, Notices from StoreMink.",
    );
    expect(minkBlockedSentence(" ")).toContain(
      "StoreMink has blocked this item.",
    );
    expect(SHOPPER.reviewRemoved).toBe(
      "StoreMink has removed your review of this product, so it can't be changed or posted again.",
    );
    expect(uploadRefusal({ told: true, kindWord: "image" })).toBe(
      "StoreMink has blocked this image, so it can't be uploaded again. See Settings, Notices from StoreMink.",
    );
    expect(uploadRefusal({ told: true, kindWord: "file" })).toBe(
      "StoreMink has blocked this file, so it can't be uploaded again. See Settings, Notices from StoreMink.",
    );
    expect(uploadRefusal({ told: false, kindWord: "image" })).toBe(
      "This file can't be uploaded. If you need help, write to support@storemink.com.",
    );
    expect(attachmentRefusal(true)).toBe(
      "StoreMink has blocked this image, so it can't be used in your store. See Settings, Notices from StoreMink.",
    );
    expect(attachmentRefusal(false)).toBe(
      "This image can't be used. If you need help, write to support@storemink.com.",
    );
  });

  it("the store's bell (design 7.5)", () => {
    expect(
      blockedBell({
        kind: "file",
        contentType: "image/png",
        itemLabel: "hero.png",
      }),
    ).toEqual({
      title: "StoreMink blocked an image",
      body: "hero.png is hidden from your store. See why.",
    });
    expect(liftedBell({ kind: "product", itemLabel: "Leather shoe" })).toEqual({
      title: "StoreMink lifted a block",
      body: "Leather shoe is no longer blocked.",
    });
    expect(replyBell({ kind: "review", itemLabel: "" })).toEqual({
      title: "StoreMink replied",
      body: "About the review. Open the notice to read it.",
    });
    expect(STORE_EVENTS.contentBlocked.label).toBe(
      "Content blocked by StoreMink",
    );
  });

  it("the block notice email (design 7.6)", () => {
    const email = blockNoticeEmail({
      storeName: "Acme Shoes",
      kind: "file",
      contentType: "image/jpeg",
      itemLabel: "shoe.jpg",
      blockedOn: "30 Oct 2026",
      reasonKind: "intimate_or_impersonation",
      reference: "SM-000123",
      storeMessage: "We blocked this image.",
      complaintId: "c",
    });
    expect(email.subject).toBe("StoreMink has blocked an image on Acme Shoes");
    expect(email.heading).toBe("We have blocked an image on your store");
    expect(email.details.map((d) => d.label)).toEqual([
      "Store",
      "Image",
      "Blocked on",
      "Reason",
      "Reference",
    ]);
    expect(email.paragraphs).toEqual([
      "We blocked this image.",
      "Wherever your store uses it, it now shows a grey 'Image not available' picture.",
      "If you are not satisfied with our decision, you can appeal to the Grievance Appellate Committee at gac.gov.in within 30 days.",
    ]);
    expect(email.buttonLabel).toBe("Read the notice");
  });

  it("the suspension email has no button and says POS (A9)", () => {
    const email = storeSuspendedEmail({
      storeName: "Acme Shoes",
      suspendedOn: "30 Oct 2026",
      reasonKind: "terms_breach",
      reference: null,
      storeMessage: "",
      complaintId: null,
    });
    expect(email.buttonLabel).toBeNull();
    expect(email.details.map((d) => d.label)).toEqual([
      "Store",
      "Suspended on",
      "Reason",
    ]);
    expect(email.paragraphs).toContain(
      "While it is suspended, shoppers can't open your store, and you and your staff can't open its dashboard or POS.",
    );
  });

  it("the lifted and replied emails", () => {
    expect(
      blockLiftedEmail({ storeName: "Acme", kind: "store", itemLabel: "" })
        .subject,
    ).toBe("StoreMink has lifted the suspension of Acme");
    expect(
      blockLiftedEmail({
        storeName: "Acme",
        kind: "page",
        itemLabel: "About us",
      }).paragraphs[0],
    ).toBe(
      "About us on Acme is no longer blocked. If it is published, shoppers can see it again.",
    );
    const shut = storeMinkRepliedEmail({
      storeName: "Acme",
      kind: "store",
      itemLabel: "",
      reply: "We looked again.",
      storeSuspended: true,
    });
    expect(shut.subject).toBe("StoreMink replied about your suspended store");
    expect(shut.buttonLabel).toBeNull();
    expect(
      storeMinkRepliedEmail({
        storeName: "Acme",
        kind: "blog_post",
        itemLabel: "Our story",
        reply: "We looked again.",
        storeSuspended: false,
      }),
    ).toMatchObject({
      subject: "StoreMink replied about your blocked blog post",
      heading: "We replied about Our story",
      buttonLabel: "Read and reply",
    });
  });

  it("the complainant's emails", () => {
    const ack = acknowledgementEmail({
      name: "Asha",
      receivedAt: "30 Oct 2026, 14:05 IST",
      reference: "SM-000123",
      kind: "data_request",
    });
    expect(ack.subject).toBe(
      "We received your complaint (reference SM-000123)",
    );
    expect(ack.greeting).toBe("Hello Asha,");
    expect(ack.afterRecorded).toEqual([
      "We will answer your request within 10 working days.",
      ACKNOWLEDGEMENT_APPEAL,
    ]);
    expect(ack.signoff).toEqual(COMPLAINANT_SIGNOFF);
    expect(complainantGreeting("")).toBe("Hello,");
    expect(complaintTimingSentence("court_order")).toBe(
      "We act on the order within 3 hours of receiving it.",
    );
    const outcome = outcomeEmail({
      name: null,
      reference: "SM-000123",
      outcome: "not_ours",
      note: "",
    });
    expect(outcome.subject).toBe("Your complaint SM-000123: our decision");
    expect(outcome.paragraphs).toEqual([
      "The content you reported is not hosted by StoreMink, so we can't remove it.",
      routeSentence("committee"),
    ]);
  });

  it("the page constants", () => {
    expect(NOTICES.title).toBe("Notices from StoreMink");
    expect(NOTICE.messageHeading).toBe("Message from StoreMink");
    expect(NOTICE_REPLY.errors.tooLong).toBe(
      "Keep your reply under 4,000 characters.",
    );
    expect(storeReplyAuthor("a@b.example", true)).toBe("a@b.example, by email");
  });
});

// ── Client-safe ─────────────────────────────────────────────────────────────

describe("client safety", () => {
  const ROOT = process.cwd();
  const MODULES = [
    "kinds",
    "deadlines",
    "media-key",
    "media-refs",
    "copy",
    "archive-paths",
  ];

  /** The module specifiers a file imports at runtime (type-only skipped). */
  function runtimeImports(file: string): string[] {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
    );
    const out: string[] = [];
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        const bindings = clause?.namedBindings;
        const onlyTypes =
          clause &&
          !clause.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((e) => e.isTypeOnly);
        if (onlyTypes) continue;
        out.push((statement.moduleSpecifier as ts.StringLiteral).text);
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        !statement.isTypeOnly
      ) {
        out.push((statement.moduleSpecifier as ts.StringLiteral).text);
      }
    }
    return out;
  }

  function resolveSpecifier(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    else return null;
    for (const candidate of [
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  it("the six modules import nothing but each other", () => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = MODULES.map((m) => join(ROOT, `lib/moderation/${m}.ts`));
    for (const file of queue) expect(existsSync(file), file).toBe(true);
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of runtimeImports(file)) {
        const target = resolveSpecifier(file, spec);
        if (target) queue.push(target);
        else packages.add(spec);
      }
    }
    expect([...seen].map((f) => relative(ROOT, f)).sort()).toEqual(
      MODULES.map((m) => `lib/moderation/${m}.ts`).sort(),
    );
    expect([...packages]).toEqual([]);
    for (const file of seen) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/^\s*import\s+["']server-only["']/m);
      expect(text, file).not.toMatch(/["']@\/lib\/db|["']next\/headers["']/);
    }
  });
});
