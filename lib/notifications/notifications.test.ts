import { describe, it, expect } from "vitest";
import {
  EVENTS,
  EVENT_KEYS,
  EVENT_GROUPS,
  getEventDef,
  isEventKey,
  groupEvents,
  resolveChannels,
  storeAdminEvents,
  eventKeySlug,
  eventFromSlug,
  canonicalEventGroup,
  LEGACY_EVENT_GROUPS,
  isPlatformVoiceEvent,
  type EventDef,
} from "./events";
import { renderNotification } from "./render";
import { resolveAllNotifications, resolveNotification } from "./config";
import type { Db } from "@/lib/db/client";
import { SECTIONS } from "@/app/dashboard/lib/permissions";

const byKey = (key: string): EventDef => {
  const def = getEventDef(key);
  if (!def) throw new Error(`missing event def: ${key}`);
  return def;
};

describe("event registry", () => {
  it("has one def per key, and no def without a key", () => {
    expect(EVENTS.map((e) => e.key).sort()).toEqual([...EVENT_KEYS].sort());
  });

  it("has no duplicate keys", () => {
    expect(new Set(EVENT_KEYS).size).toBe(EVENT_KEYS.length);
  });

  it("only uses groups declared in EVENT_GROUPS", () => {
    for (const e of EVENTS) expect(EVENT_GROUPS).toContain(e.group);
  });

  // Routing for store admins derives from the permission map, so an event
  // pointing at a section that doesn't exist would silently notify nobody.
  it("every event names a real dashboard permission section", () => {
    const sections = new Set(SECTIONS.map((s) => s.key));
    for (const e of EVENTS) {
      expect(sections, `${e.key} → ${e.section}`).toContain(e.section);
    }
  });

  it("platform events are the only ones aimed at operators", () => {
    for (const e of EVENTS) {
      if (e.audiences.operators) expect(e.group).toBe("Platform");
    }
  });

  it("keeps platform events out of the merchant settings matrix", () => {
    expect(storeAdminEvents().some((e) => e.group === "Platform")).toBe(false);
  });

  it("recognises known keys only", () => {
    expect(isEventKey("order.placed")).toBe(true);
    expect(isEventKey("order.teleported")).toBe(false);
    expect(isEventKey(undefined)).toBe(false);
  });

  it("groups events without dropping or duplicating any", () => {
    const defs = storeAdminEvents();
    const flattened = groupEvents(defs).flatMap((g) => g.events);
    expect(flattened).toHaveLength(defs.length);
    expect(new Set(flattened.map((e) => e.key)).size).toBe(defs.length);
  });
});

// Owner decision 11 (the GST release): the billing page has one name
// everywhere, "Plans & Billing". The group was "Plan & billing", and that
// spelling is still stored in operator overrides and saved Activity links.
describe("the Plans & Billing group", () => {
  it("is named Plans & Billing, and the old spelling is gone from the list", () => {
    expect(EVENT_GROUPS).toContain("Plans & Billing");
    expect(EVENT_GROUPS as readonly string[]).not.toContain("Plan & billing");
    expect(byKey("plan.changed").group).toBe("Plans & Billing");
  });

  it("reads the legacy group name as today's, and leaves every other name alone", () => {
    expect(canonicalEventGroup("Plan & billing")).toBe("Plans & Billing");
    expect(canonicalEventGroup("Plans & Billing")).toBe("Plans & Billing");
    expect(canonicalEventGroup("Orders")).toBe("Orders");
    expect(canonicalEventGroup("Something an operator typed")).toBe(
      "Something an operator typed",
    );
    // A Map, so a stored name never reads an inherited property.
    expect(canonicalEventGroup("toString")).toBe("toString");
  });

  it("maps every legacy name onto a group the registry still has", () => {
    for (const [legacy, current] of LEGACY_EVENT_GROUPS) {
      expect(EVENT_GROUPS as readonly string[]).not.toContain(legacy);
      expect(EVENT_GROUPS).toContain(current);
    }
  });

  // A fake connection that answers the definition read with one stored
  // override row (the only read when there is no store).
  function definitionDb(row: Record<string, unknown>): Db {
    const rows = [row];
    const query = {
      from: () => query,
      where: () =>
        Object.assign(Promise.resolve(rows), { limit: async () => rows }),
    };
    return { select: () => query } as unknown as Db;
  }

  const legacyOverride = {
    key: "plan.changed",
    displayName: null,
    description: null,
    category: "Plan & billing",
    group: "Plan & billing",
    channels: null,
    isActive: true,
    isCustom: false,
  };

  it("files a stored override with the old group name under Plans & Billing", async () => {
    const [resolved] = await resolveAllNotifications(
      definitionDb(legacyOverride),
      null,
      [byKey("plan.changed")],
    );
    expect(resolved.group).toBe("Plans & Billing");
    expect(resolved.category).toBe("Plans & Billing");
    expect(EVENT_GROUPS as readonly string[]).toContain(resolved.category);
  });

  it("does the same on the single-event read the fan-out uses", async () => {
    const resolved = await resolveNotification(
      definitionDb(legacyOverride),
      null,
      "plan.changed",
    );
    expect(resolved?.group).toBe("Plans & Billing");
    expect(resolved?.category).toBe("Plans & Billing");
  });

  it("keeps an operator's own group name as typed", async () => {
    const [resolved] = await resolveAllNotifications(
      definitionDb({
        ...legacyOverride,
        category: "Money",
        group: "Money",
      }),
      null,
      [byKey("plan.changed")],
    );
    expect(resolved.group).toBe("Money");
    expect(resolved.category).toBe("Money");
  });
});

// Dashboard URLs must not contain dots: proxy.ts exempts asset-like paths from
// the session gate, and a dotted route segment slipped straight through it.
describe("event key slugs", () => {
  it("removes every dot", () => {
    for (const key of EVENT_KEYS) {
      expect(eventKeySlug(key), key).not.toContain(".");
    }
  });

  it("round-trips every key in the registry", () => {
    for (const key of EVENT_KEYS) {
      expect(eventFromSlug(eventKeySlug(key))?.key).toBe(key);
    }
  });

  it("produces a unique slug per key (no two events share a URL)", () => {
    const slugs = EVENT_KEYS.map(eventKeySlug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("only produces URL-safe characters", () => {
    for (const key of EVENT_KEYS) {
      expect(eventKeySlug(key), key).toMatch(/^[a-z0-9_-]+$/);
    }
  });

  it("returns undefined for an unknown or empty slug", () => {
    expect(eventFromSlug("not-a-thing")).toBeUndefined();
    expect(eventFromSlug("")).toBeUndefined();
  });

  it("still resolves a slug given in the wrong case", () => {
    expect(eventFromSlug("Order-Placed")?.key).toBe("order.placed");
  });
});

describe("resolveChannels", () => {
  const orderPlaced = byKey("order.placed");

  it("falls back to the registry default when nothing overrides", () => {
    expect(resolveChannels(orderPlaced, "store-admins")).toEqual({
      inApp: true,
      email: true,
      digest: "instant",
    });
  });

  it("lets a store default override the registry", () => {
    expect(
      resolveChannels(orderPlaced, "store-admins", { email: false }),
    ).toMatchObject({ inApp: true, email: false });
  });

  it("lets a user override beat the store default", () => {
    expect(
      resolveChannels(
        orderPlaced,
        "store-admins",
        { email: false },
        { email: true },
      ),
    ).toMatchObject({ email: true });
  });

  it("treats a null channel as 'no opinion', not as off", () => {
    expect(
      resolveChannels(
        orderPlaced,
        "store-admins",
        { email: false },
        { email: null },
      ),
    ).toMatchObject({ email: false });
  });

  it("ignores overrides on a non-configurable event", () => {
    const roleChanged = byKey("admin.role_changed");
    expect(
      resolveChannels(
        roleChanged,
        "store-admins",
        { inApp: false, email: false },
        { inApp: false, email: false },
      ),
    ).toEqual({ inApp: true, email: true, digest: "instant" });
  });

  it("delivers nothing to an audience the event doesn't target", () => {
    expect(resolveChannels(orderPlaced, "operators")).toEqual({
      inApp: false,
      email: false,
      digest: "instant",
    });
  });

  it("rejects a junk digest value stored in the DB", () => {
    expect(
      resolveChannels(orderPlaced, "store-admins", null, {
        digest: "yearly" as never,
      }).digest,
    ).toBe("instant");
  });

  it("audit-only events resolve to no delivery at all", () => {
    const audit = byKey("product.updated");
    expect(resolveChannels(audit, "store-admins")).toMatchObject({
      inApp: false,
      email: false,
    });
  });
});

describe("renderNotification", () => {
  it("speaks to the store and the shopper differently about one event", () => {
    const event = {
      type: "order.placed",
      actorLabel: "Priya S.",
      subjectId: "11111111-1111-4111-8111-111111111111",
      subjectLabel: "ORD10010004",
      payload: { total: 1240, currency: "INR" },
    };

    const admin = renderNotification(event, "store-admins");
    expect(admin?.title).toContain("ORD10010004");
    expect(admin?.body).toContain("Priya S.");
    expect(admin?.url).toBe("/dashboard/orders?q=ORD10010004");

    const customer = renderNotification(event, "customer");
    expect(customer?.title).toBe("Order confirmed");
    expect(customer?.url).toBe("/orders/11111111-1111-4111-8111-111111111111");
  });

  it("returns null for an audience the event never targets", () => {
    expect(
      renderNotification({ type: "enquiry.received" }, "customer"),
    ).toBeNull();
  });

  it("returns null for an unknown event type", () => {
    expect(
      renderNotification({ type: "not.a.thing" }, "store-admins"),
    ).toBeNull();
  });

  // A half-populated payload must never render "undefined" into someone's bell.
  it("degrades to the registry label when the payload is empty", () => {
    const rendered = renderNotification(
      { type: "order.placed" },
      "store-admins",
    );
    expect(rendered?.title).toBe("New order");
    expect(rendered?.title).not.toContain("undefined");
    expect(rendered?.body).toBeNull();
  });

  it("never renders 'undefined'/'null' into any template", () => {
    for (const def of EVENTS) {
      for (const audience of Object.keys(def.audiences) as Array<
        keyof typeof def.audiences
      >) {
        const r = renderNotification({ type: def.key }, audience);
        if (!r) continue;
        for (const text of [r.title, r.body ?? "", r.url ?? ""]) {
          expect(text, `${def.key}/${audience}`).not.toMatch(/undefined|null/);
        }
      }
    }
  });

  it("formats money in INR", () => {
    const r = renderNotification(
      { type: "order.payment_received", payload: { total: 1240 } },
      "store-admins",
    );
    expect(r?.title).toContain("1,240");
  });
});

// ★ TS-3B (owner's decision 8): three operator notices for Theme Studio, in
// the bell and by email, told only to the operator who started the theme.
describe("Theme Studio operator notices", () => {
  const PROJECT = "0f9b5c1e-4a7d-4c2b-9e1f-3a2b1c0d9e8f";
  const KEYS = [
    "platform.theme_studio_ready",
    "platform.theme_studio_needs_fix",
    "platform.theme_studio_questions",
  ] as const;

  it("are operator-only platform events, in the bell and by email, with no switch", () => {
    for (const key of KEYS) {
      const def = byKey(key);
      expect(def.group).toBe("Platform");
      expect(def.audiences).toEqual({
        operators: { inApp: true, email: true },
      });
      // No operator has a settings page: nothing may switch them off.
      expect(def.configurable).toBe(false);
      expect(resolveChannels(def, "operators", null, { email: false })).toEqual(
        { inApp: true, email: true, digest: "instant" },
      );
      expect(storeAdminEvents().some((e) => e.key === key)).toBe(false);
    }
  });

  it("name the theme and link to its page in the operator console", () => {
    const copy = (type: (typeof KEYS)[number]) =>
      renderNotification(
        { type, subjectId: PROJECT, subjectLabel: "Monsoon Market" },
        "operators",
      );
    expect(copy("platform.theme_studio_ready")).toEqual({
      title: "Ready to publish · Monsoon Market",
      body: "Theme Studio finished building and checking this theme. Open it to look it over, read any warnings and publish it.",
      url: `/dashboard/themes/studio/${PROJECT}`,
    });
    expect(copy("platform.theme_studio_needs_fix")).toEqual({
      title: "Needs a fix · Monsoon Market",
      body: "Theme Studio stopped before this theme was ready. Open it to see why and what to do next.",
      url: `/dashboard/themes/studio/${PROJECT}`,
    });
    expect(copy("platform.theme_studio_questions")).toEqual({
      title: "Questions about Monsoon Market",
      body: "Theme Studio needs a few answers before it can design this theme. Open it to reply.",
      url: `/dashboard/themes/studio/${PROJECT}`,
    });
  });

  it("never links anywhere but a project page or the Theme Studio list", () => {
    for (const key of KEYS) {
      for (const subjectId of [
        "../../settings",
        "https://evil.example/x",
        `${PROJECT}/../x`,
        "",
        null,
      ]) {
        expect(
          renderNotification({ type: key, subjectId }, "operators")?.url,
        ).toBe("/dashboard/themes/studio");
      }
      // Without a name the title still reads as a sentence.
      expect(renderNotification({ type: key }, "operators")?.title).not.toMatch(
        /·\s*$|undefined|null/,
      );
    }
  });

  it("carry no long dash and no Mink credit count", () => {
    for (const key of KEYS) {
      const def = byKey(key);
      const copy = renderNotification(
        { type: key, subjectId: PROJECT, subjectLabel: "Monsoon Market" },
        "operators",
      )!;
      for (const text of [
        def.label,
        def.description,
        copy.title,
        copy.body ?? "",
      ]) {
        expect(text).not.toMatch(/[\u2013\u2014]/);
        expect(text).not.toMatch(/credit/i);
      }
    }
  });
});

// ★ Takedowns (design 7.5): three store notices in the bell (the email goes
// to every owner from lib/email/takedown-emails.ts), and three operator
// alerts, always emitted with storeId null (lib/moderation/notify.ts).
describe("takedown notices", () => {
  const BLOCK = "0f9b5c1e-4a7d-4c2b-9e1f-3a2b1c0d9e8f";
  const STORE_KEYS = [
    "store.content_blocked",
    "store.content_block_lifted",
    "store.content_block_reply",
  ] as const;
  const OPERATOR_KEYS = [
    "platform.complaint_urgent",
    "platform.complaint_due",
    "platform.takedown_reply",
  ] as const;

  it("tells the store in the bell only, under Settings, with no switch", () => {
    const severity = {
      "store.content_blocked": "critical",
      "store.content_block_lifted": "success",
      "store.content_block_reply": "info",
    };
    for (const key of STORE_KEYS) {
      const def = byKey(key);
      expect(def.group).toBe("Content");
      expect(def.section).toBe("settings");
      expect(def.severity).toBe(severity[key]);
      expect(def.audiences).toEqual({
        "store-admins": { inApp: true, email: false },
      });
      expect(def.configurable).toBe(false);
      // StoreMink speaks to the store as itself.
      expect(isPlatformVoiceEvent(key)).toBe(true);
      expect(
        resolveChannels(
          def,
          "store-admins",
          { inApp: false },
          { inApp: false },
        ),
      ).toMatchObject({ inApp: true, email: false });
    }
    expect(byKey("store.content_blocked").label).toBe(
      "Content blocked by StoreMink",
    );
  });

  it("tells every operator in the bell and by email, with no switch", () => {
    const severity = {
      "platform.complaint_urgent": "critical",
      "platform.complaint_due": "warning",
      "platform.takedown_reply": "info",
    };
    for (const key of OPERATOR_KEYS) {
      const def = byKey(key);
      expect(def.group).toBe("Platform");
      expect(def.section).toBe("activity");
      expect(def.severity).toBe(severity[key]);
      expect(def.audiences).toEqual({
        operators: { inApp: true, email: true },
      });
      expect(def.configurable).toBe(false);
      expect(storeAdminEvents().some((e) => e.key === key)).toBe(false);
      expect(isPlatformVoiceEvent(key)).toBe(false);
    }
  });

  it("speaks the store's bell in copy.ts's words, linking the notice", () => {
    const event = (type: (typeof STORE_KEYS)[number]) => ({
      type,
      subjectId: BLOCK,
      subjectLabel: "Leather shoe",
      payload: { kind: "product" },
    });
    expect(
      renderNotification(event("store.content_blocked"), "store-admins"),
    ).toEqual({
      title: "StoreMink blocked a product",
      body: "Leather shoe is hidden from your store. See why.",
      url: `/dashboard/settings/notices/${BLOCK}`,
    });
    expect(
      renderNotification(event("store.content_block_lifted"), "store-admins"),
    ).toEqual({
      title: "StoreMink lifted a block",
      body: "Leather shoe is no longer blocked.",
      url: `/dashboard/settings/notices/${BLOCK}`,
    });
    expect(
      renderNotification(event("store.content_block_reply"), "store-admins"),
    ).toEqual({
      title: "StoreMink replied",
      body: "About Leather shoe. Open the notice to read it.",
      url: `/dashboard/settings/notices/${BLOCK}`,
    });
    expect(
      renderNotification(
        {
          type: "store.content_blocked",
          subjectId: BLOCK,
          payload: { kind: "file", contentType: "image/png" },
        },
        "store-admins",
      )?.title,
    ).toBe("StoreMink blocked an image");
    expect(
      renderNotification(
        {
          type: "store.content_blocked",
          subjectId: BLOCK,
          subjectLabel: "Acme Shoes",
          payload: { kind: "store" },
        },
        "store-admins",
      ),
    ).toMatchObject({ title: "StoreMink suspended your store" });
  });

  it("never links a store notice anywhere but a notice page or the list", () => {
    for (const key of STORE_KEYS) {
      for (const subjectId of [
        "../../settings",
        "https://evil.example/x",
        `${BLOCK}/../x`,
        "",
        null,
      ]) {
        expect(
          renderNotification(
            { type: key, subjectId, payload: { kind: "page" } },
            "store-admins",
          )?.url,
        ).toBe("/dashboard/settings/notices");
      }
      // A payload with no kind still reads: the registry's own label.
      expect(renderNotification({ type: key }, "store-admins")).toEqual({
        title: byKey(key).label,
        body: null,
        url: "/dashboard/settings/notices",
      });
    }
  });

  it("speaks the operators' alerts as design 7.5 says", () => {
    expect(
      renderNotification(
        {
          type: "platform.complaint_urgent",
          subjectLabel: "SM-000123",
          payload: {
            kind: "court_order",
            stage: "act",
            dueAt: "2026-10-30T08:35:00.000Z",
          },
        },
        "operators",
      ),
    ).toEqual({
      title: "Urgent: Court order SM-000123",
      body: "Remove or block by 30 Oct, 14:05 IST.",
      url: "/dashboard/complaints/SM-000123",
    });
    expect(
      renderNotification(
        {
          type: "platform.complaint_urgent",
          subjectLabel: "SM-000124",
          payload: {
            kind: "information_order",
            stage: "act",
            dueAt: "2026-11-02T08:35:00.000Z",
          },
        },
        "operators",
      )?.body,
    ).toBe("Provide by 2 Nov, 14:05 IST.");
    expect(
      renderNotification(
        {
          type: "platform.complaint_due",
          subjectLabel: "SM-000123",
          payload: {
            kind: "grievance",
            stage: "acknowledge",
            phase: "overdue",
            minutes: 70,
          },
        },
        "operators",
      ),
    ).toEqual({
      title: "SM-000123: Acknowledge overdue by 1 h 10 min",
      body: "Other complaint.",
      url: "/dashboard/complaints/SM-000123",
    });
    expect(
      renderNotification(
        {
          type: "platform.takedown_reply",
          subjectId: BLOCK,
          subjectLabel: "Leather shoe",
          payload: { storeName: "Acme Shoes", askedForReview: true },
        },
        "operators",
      ),
    ).toEqual({
      title: "Acme Shoes replied about Leather shoe",
      body: "They ask for a review.",
      url: `/dashboard/complaints/blocks/${BLOCK}`,
    });
  });

  it("never links an operator alert outside the Complaints console", () => {
    for (const key of OPERATOR_KEYS) {
      for (const label of ["../x", "https://evil.example", "", null]) {
        const url = renderNotification(
          { type: key, subjectId: label, subjectLabel: label },
          "operators",
        )?.url;
        expect(url).toBe("/dashboard/complaints");
      }
    }
  });

  it("carry no long dash and no Mink credit count", () => {
    for (const key of [...STORE_KEYS, ...OPERATOR_KEYS]) {
      const def = byKey(key);
      const audience = def.audiences.operators ? "operators" : "store-admins";
      const copy = renderNotification(
        {
          type: key,
          subjectId: BLOCK,
          subjectLabel: "SM-000123",
          payload: {
            kind: key.startsWith("store.") ? "product" : "court_order",
            stage: "act",
            phase: "soon",
            minutes: 30,
            dueAt: "2026-10-30T08:35:00.000Z",
            storeName: "Acme",
          },
        },
        audience,
      )!;
      for (const text of [
        def.label,
        def.description,
        copy.title,
        copy.body ?? "",
      ]) {
        expect(text).not.toMatch(/[\u2013\u2014]/);
        expect(text).not.toMatch(/credit/i);
      }
    }
  });
});
