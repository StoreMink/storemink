// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMyNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/app/actions/notification-inbox-actions";
import { NOTICE_SEEN_SETTLE_MS, NotificationBell } from "./notification-bell";
import { UnreadCountsProvider, useUnreadCounts } from "./unread-counts-context";

const nav = vi.hoisted(() => ({
  pathname: "/dashboard",
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  usePathname: () => nav.pathname,
}));

vi.mock("@/app/actions/notification-inbox-actions", () => ({
  getMyNotifications: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
}));

/** What the sidebar would read from the provider. */
function CountsProbe() {
  const { total, storemink } = useUnreadCounts();
  return <output data-testid="counts">{`${total}/${storemink}`}</output>;
}

function renderWithProvider() {
  return render(
    <UnreadCountsProvider>
      <NotificationBell />
      <CountsProbe />
    </UnreadCountsProvider>,
  );
}

describe("NotificationBell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.pathname = "/dashboard";
    vi.mocked(getUnreadNotificationCount).mockResolvedValue({
      total: 1,
      storemink: 0,
    });
    vi.mocked(getMyNotifications).mockResolvedValue({
      unread: 1,
      notifications: [
        {
          id: "n1",
          type: "plan.changed",
          title: "Plan changed",
          body: "Changed by StoreMink",
          url: "/dashboard/plans",
          severity: "info",
          read_at: null,
          created_at: "2026-08-31T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(markNotificationRead).mockResolvedValue({ success: true });
    vi.mocked(markAllNotificationsRead).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("anchors the phone inbox to viewport gutters and keeps desktop alignment", async () => {
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    const panel = await screen.findByRole("dialog", {
      name: "Notifications",
    });

    expect(panel).toHaveClass(
      "fixed",
      "inset-x-3",
      "top-16",
      "w-auto",
      "max-h-[calc(100dvh-5rem)]",
      "overscroll-contain",
      "sm:absolute",
      "sm:right-0",
    );
    await waitFor(() => expect(screen.getByText("Plan changed")).toBeVisible());
  });

  it("hands both counts to the sidebar through the provider (no read of its own)", async () => {
    vi.mocked(getUnreadNotificationCount).mockResolvedValue({
      total: 4,
      storemink: 2,
    });

    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId("counts")).toHaveTextContent("4/2"),
    );
    // One poll answers both numbers.
    expect(getUnreadNotificationCount).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Notifications (4 unread)" }),
    ).toBeInTheDocument();
  });

  it("works without a provider (the operator console) and keeps its own badge", async () => {
    vi.mocked(getUnreadNotificationCount).mockResolvedValue({
      total: 3,
      storemink: 1,
    });

    render(<NotificationBell />);

    expect(
      await screen.findByRole("button", { name: "Notifications (3 unread)" }),
    ).toBeInTheDocument();
  });

  it("asks again after a notice row is read, so the Notices badge follows", async () => {
    vi.mocked(getUnreadNotificationCount)
      .mockResolvedValueOnce({ total: 2, storemink: 1 })
      .mockResolvedValue({ total: 1, storemink: 0 });
    vi.mocked(getMyNotifications).mockResolvedValue({
      unread: 2,
      notifications: [
        {
          id: "n2",
          type: "store.content_blocked",
          title: "StoreMink blocked a product",
          body: "Shoe is hidden from your store. See why.",
          url: "/dashboard/settings/notices/0d2c8a4e-7a77-4d1c-9f61-3f0f1b5a6c01",
          severity: "critical",
          read_at: null,
          created_at: "2026-10-30T00:00:00.000Z",
        },
      ],
    });

    renderWithProvider();
    await waitFor(() =>
      expect(screen.getByTestId("counts")).toHaveTextContent("2/1"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /StoreMink blocked a product/,
      }),
    );

    expect(markNotificationRead).toHaveBeenCalledWith("n2");
    expect(nav.push).toHaveBeenCalledWith(
      "/dashboard/settings/notices/0d2c8a4e-7a77-4d1c-9f61-3f0f1b5a6c01",
    );
    await waitFor(() =>
      expect(screen.getByTestId("counts")).toHaveTextContent("1/0"),
    );
    expect(getUnreadNotificationCount).toHaveBeenCalledTimes(2);
  });

  it("clears both counts on Mark all read", async () => {
    vi.mocked(getUnreadNotificationCount).mockResolvedValue({
      total: 1,
      storemink: 1,
    });

    renderWithProvider();
    await waitFor(() =>
      expect(screen.getByTestId("counts")).toHaveTextContent("1/1"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Mark all read/ }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("counts")).toHaveTextContent("0/0"),
    );
    expect(markAllNotificationsRead).toHaveBeenCalledTimes(1);
  });

  it("asks once more shortly after a notice page opens, once that page has marked it seen", async () => {
    vi.useFakeTimers();
    nav.pathname =
      "/dashboard/settings/notices/0d2c8a4e-7a77-4d1c-9f61-3f0f1b5a6c01";

    render(<NotificationBell />);
    await act(async () => {});
    expect(getUnreadNotificationCount).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(NOTICE_SEEN_SETTLE_MS - 1);
    });
    expect(getUnreadNotificationCount).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(getUnreadNotificationCount).toHaveBeenCalledTimes(2);
  });

  it("does not ask again on the notices list or any other page", async () => {
    vi.useFakeTimers();
    nav.pathname = "/dashboard/settings/notices";

    render(<NotificationBell />);
    await act(async () => {
      vi.advanceTimersByTime(NOTICE_SEEN_SETTLE_MS * 4);
    });

    // Only the mount poll; the next one is the 45 s interval.
    expect(getUnreadNotificationCount).toHaveBeenCalledTimes(1);
  });

  it("treats a failed list read as nothing unread for both badges", async () => {
    vi.mocked(getUnreadNotificationCount).mockResolvedValue({
      total: 2,
      storemink: 2,
    });
    vi.mocked(getMyNotifications).mockResolvedValue({
      notifications: [],
      unread: 0,
      error: "Couldn't load notifications.",
    });

    renderWithProvider();
    await waitFor(() =>
      expect(screen.getByTestId("counts")).toHaveTextContent("2/2"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));

    await waitFor(() =>
      expect(screen.getByTestId("counts")).toHaveTextContent("0/0"),
    );
  });
});
