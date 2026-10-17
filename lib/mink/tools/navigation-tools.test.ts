import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkActorContext } from "../types";
import { MinkToolInputError } from "../errors";

const db = vi.hoisted(() => ({ withUser: vi.fn(async () => []) }));
vi.mock("@/lib/db/client", () => ({ withUser: db.withUser }));

import { openDashboardPage } from "./navigation-tools";

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "member",
  permissions: {
    dashboard: ["view"],
    settings: ["view", "manage"],
    promotions: ["view", "manage"],
    products: ["view"],
  },
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("open_dashboard_page", () => {
  it("points at a control: the destination follows the target", async () => {
    const output = await openDashboardPage.execute(ACTOR, {
      highlight: "shipping_rate_mode",
    });
    expect(output).toMatchObject({
      path: "/dashboard/settings/shipping",
      title: "Show Delivery rate",
      highlight: { target: "shipping_rate_mode", label: "Delivery rate" },
    });
    expect(openDashboardPage.artifact?.(output)).toMatchObject({
      type: "navigation",
      highlight: { target: "shipping_rate_mode" },
    });
    await expect(
      openDashboardPage.execute(ACTOR, {
        destination: "orders",
        highlight: "shipping_rate_mode",
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(
      openDashboardPage.execute(ACTOR, { highlight: "delete_store" }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
  });

  it("fills a form of any kind, bounded, and only with its manage permission", async () => {
    const offer = await openDashboardPage.execute(ACTOR, {
      destination: "new_offer",
      prefill: {
        name: "Diwali 10",
        reward_type: "percent_off",
        reward_value: "10",
        code: "diwali 10",
        delivery: "code",
        secret: "dropped",
      },
    });
    expect(offer).toMatchObject({
      path: "/dashboard/offers/new?prefill=mink",
      prefill: {
        kind: "offer",
        fields: {
          name: "Diwali 10",
          rewardType: "percent_off",
          rewardValue: 10,
          code: "DIWALI10",
          delivery: "code",
        },
      },
    });
    expect(openDashboardPage.artifact?.(offer)).toMatchObject({
      prefill: { kind: "offer", fields: { code: "DIWALI10" } },
    });
    const shipping = await openDashboardPage.execute(ACTOR, {
      destination: "shipping_settings",
      prefill: { mode: "flat", flat_rate: 49, free_above: null },
    });
    expect(shipping).toMatchObject({
      path: "/dashboard/settings/shipping?prefill=mink",
      prefill: {
        kind: "shipping",
        fields: { mode: "flat", flatRate: 49, freeAbove: null },
      },
    });
    // Products can be viewed but not changed by this admin.
    expect(
      await openDashboardPage.execute(ACTOR, {
        destination: "new_product",
        prefill: { name: "Tea" },
      }),
    ).toMatchObject({ error: { code: "permission_denied" } });
    await expect(
      openDashboardPage.execute(ACTOR, {
        destination: "new_offer",
        prefill: { nonsense: true },
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    expect(db.withUser).not.toHaveBeenCalled();
  });

  it("refuses a page the admin cannot open rather than guessing another", async () => {
    expect(
      await openDashboardPage.execute(ACTOR, { destination: "staff" }),
    ).toMatchObject({ error: { code: "permission_denied" } });
    expect(
      await openDashboardPage.execute(ACTOR, { destination: "offers" }),
    ).toMatchObject({ path: "/dashboard/offers", title: "Open Offers" });
  });
});
