// The Activity log's group filter (`?group=`). Owner decision 11 (the GST
// release) renamed the "Plan & billing" group to "Plans & Billing"; a link
// saved before the rename must still filter, not fall back to every event.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({ can: () => true })),
}));
vi.mock("@/app/actions/notification-actions", () => ({
  getActivityFeed: vi.fn(async () => ({ events: [], total: 0 })),
}));
vi.mock("../components/realtime-refresher", () => ({
  RealtimeRefresher: () => null,
}));
vi.mock("./activity-feed-view", () => ({
  ActivityFeedView: () => null,
}));

import ActivityPage from "./page";
import { getActivityFeed } from "@/app/actions/notification-actions";
import { ActivityFeedView } from "./activity-feed-view";

async function render(sp: Record<string, string>) {
  const page = (await ActivityPage({
    searchParams: Promise.resolve(sp),
  })) as ReactElement<{ children: ReactElement[] }>;
  const view = page.props.children.find((c) => c.type === ActivityFeedView);
  return view as ReactElement<{ group: string }>;
}

describe("the Activity log's group filter", () => {
  beforeEach(() => {
    vi.mocked(getActivityFeed).mockClear();
  });

  it("filters by a group the registry has", async () => {
    const view = await render({ group: "Orders" });
    expect(getActivityFeed).toHaveBeenCalledWith(
      expect.objectContaining({ group: "Orders" }),
    );
    expect(view.props.group).toBe("Orders");
  });

  it("reads a link saved with the old group name as Plans & Billing", async () => {
    const view = await render({ group: "Plan & billing" });
    expect(getActivityFeed).toHaveBeenCalledWith(
      expect.objectContaining({ group: "Plans & Billing" }),
    );
    expect(view.props.group).toBe("Plans & Billing");
  });

  it("ignores a group it does not know", async () => {
    const view = await render({ group: "Nonsense" });
    expect(getActivityFeed).toHaveBeenCalledWith(
      expect.objectContaining({ group: undefined }),
    );
    expect(view.props.group).toBe("");
  });
});
