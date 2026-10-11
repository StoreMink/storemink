/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { makeDbMock } from "@/app/actions/_test-helpers";
import {
  admins,
  products,
  storeBillingSettings,
  storePages,
  storePaymentProviders,
  storeShippingSettings,
} from "@/drizzle/schema";
import type { Store } from "@/lib/store/resolve";

// ---------------------------------------------------------------------------
// The FACTS reader, run for real: only the database is stubbed. The rules have
// their own suite (launch-checklist-rules.test.ts) and launch-actions.test.ts
// replaces this module with a stand-in, so this file is the one place the
// store-row → fact mapping that go-live trusts is actually exercised.
// ---------------------------------------------------------------------------

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { buildLaunchChecklist } from "./launch-checklist";

const policyRow = (slug: string, html = "<p>Our terms.</p>") => ({
  slug,
  status: "published",
  publishedSections: [{ type: "rich_text", config: { html } }],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

/** Rows for a store whose every OTHER required task is done, so the theme
 *  fact alone decides whether it may open. Keyed by table, not call order. */
function readyRows(): Record<string, any[][]> {
  return {
    [getTableName(products)]: [[{ published: "1", samples: "0" }]],
    [getTableName(storeBillingSettings)]: [
      [
        {
          businessName: "Acme Juice",
          legalName: null,
          businessAddress: "12 MG Road, Pune",
          contactEmail: "hello@acme.in",
          contactPhone: "+919812345678",
          taxId: null,
          gstEnabled: false,
        },
      ],
    ],
    [getTableName(storePages)]: [
      [
        policyRow("terms"),
        policyRow("refund-policy"),
        policyRow("shipping-policy"),
        policyRow("privacy-policy"),
      ],
    ],
    [getTableName(storeShippingSettings)]: [[{ storeId: "store-1" }]],
    [getTableName(storePaymentProviders)]: [[]],
    [getTableName(admins)]: [[{ id: "owner-1" }]],
  };
}

const store = (settings: Record<string, unknown>): Store => ({
  id: "store-1",
  slug: "acme",
  name: "Acme Juice",
  status: "active",
  plan: "free",
  plan_expires_at: null,
  comp_plan: null,
  comp_expires_at: null,
  custom_domain: null,
  settings,
});

const themeTask = (c: Awaited<ReturnType<typeof buildLaunchChecklist>>) =>
  c.items.find((i) => i.key === "theme");

describe("buildLaunchChecklist: the theme fact", () => {
  beforeEach(() => {
    dbHolder.current = makeDbMock({ selectByTable: readyRows() });
  });

  // ★★ The line go-live relies on to keep a theme-less store closed: with it
  // broken, launchStore would open a store whose public page is "store in
  // progress".
  it("★★ holds a store with themePending: true closed and names the task", async () => {
    const c = await buildLaunchChecklist(
      store({ launched: false, themePending: true }),
    );
    expect(themeTask(c)?.done).toBe(false);
    expect(c.ready).toBe(false);
    expect(c.missing).toEqual(["Choose your storefront theme"]);
    expect(c.requiredDone).toBe(4);
    expect(c.requiredTotal).toBe(5);
  });

  it("ticks the theme task for a store with no themePending key (every existing store)", async () => {
    const c = await buildLaunchChecklist(store({ launched: false }));
    expect(themeTask(c)?.done).toBe(true);
    expect(c.ready).toBe(true);
    expect(c.missing).toEqual([]);
  });

  // ★ Only an explicit boolean `true` is pending (lib/store/launch-state.ts),
  // so a stray string or a cleared flag never strands a store behind it.
  it.each([["true"], [false], [null]])(
    "ticks the theme task when themePending is %j",
    async (value) => {
      const c = await buildLaunchChecklist(store({ themePending: value }));
      expect(themeTask(c)?.done).toBe(true);
      expect(c.ready).toBe(true);
    },
  );

  // The other facts come from the rows, so a pending store with nothing else
  // done lists the theme among every other outstanding task.
  it("reads the other tasks from the rows alongside the theme", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        ...readyRows(),
        [getTableName(admins)]: [[]],
        // A published policy with an empty body is not a policy.
        [getTableName(storePages)]: [
          [
            policyRow("terms"),
            policyRow("refund-policy", "<p> </p>"),
            policyRow("shipping-policy"),
            policyRow("privacy-policy"),
          ],
        ],
      },
    });
    const c = await buildLaunchChecklist(store({ themePending: true }));
    expect(c.missing).toEqual([
      "Verify your mobile number",
      "Choose your storefront theme",
      "Publish your store policies (Refund & Cancellation)",
    ]);
  });
});
