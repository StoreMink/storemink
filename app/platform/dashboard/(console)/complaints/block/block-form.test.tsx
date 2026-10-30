// @vitest-environment jsdom
// Block an item (takedown design 6.5): finding it, confirming what it is and
// saying why, word for word; the member's unavailable "Tell the store" tick;
// and the block the form sends.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResolvedTarget,
  TargetStore,
} from "@/lib/moderation/console-read";
import { defaultStoreMessage } from "@/lib/moderation/copy";

const H = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: H.push, refresh: H.refresh }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/actions/takedown-actions", () => ({
  resolveTargetAction: vi.fn(async () => ({ ok: false, error: "unset" })),
  blockItemAction: vi.fn(async () => ({ ok: false, error: "unset" })),
}));

vi.mock("@/app/actions/platform", () => ({
  listAllStores: vi.fn(async () => []),
}));

import { toast } from "sonner";
import {
  blockItemAction,
  resolveTargetAction,
} from "@/app/actions/takedown-actions";
import { listAllStores } from "@/app/actions/platform";
import {
  BlockForm,
  REQUEST_FAILED,
  STORE_SUPERADMIN_ONLY,
  STORE_SUSPENSION_TEXT,
  TELL_MEMBER_NOTE,
  UNTOLD_WARNING,
  WARNING_TEXT,
  blockInputFor,
  defaultReason,
  imagesTickedFor,
  nowWord,
  targetHeading,
  type BlockFormComplaint,
} from "./block-form";
import { istDateTime } from "../complaints-console";

const STORE_ID = "11111111-1111-4111-8111-111111111111";

const STORE: TargetStore = {
  id: STORE_ID,
  name: "Crumb & Co",
  slug: "crumb",
  status: "active",
  label: "Crumb & Co (crumb.storemink.com)",
  address: "https://crumb.storemink.com",
  customDomain: null,
  isDemo: false,
};

const PRODUCT_APPEARS =
  "its product page, the shop, search, collections, the sitemap, homepage sections and Mink AI's answers on WhatsApp";

function target(over: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    kind: "product",
    store: STORE,
    itemId: "p-1",
    label: "Blue mug",
    url: "https://crumb.storemink.com/shop/blue-mug",
    state: "published",
    blocked: false,
    appearsOn: PRODUCT_APPEARS,
    homepage: false,
    alreadyBlocked: null,
    warnings: [],
    file: null,
    parent: null,
    authorUserId: null,
    picks: [],
    images: [],
    ...over,
  };
}

function storeTarget(): ResolvedTarget {
  return target({
    kind: "store",
    itemId: null,
    label: "Crumb & Co",
    url: STORE.address,
    state: "active",
    appearsOn: "every address of the store, its dashboard and its POS",
  });
}

function fileTarget(): ResolvedTarget {
  return target({
    kind: "file",
    itemId: null,
    label: "hero.webp",
    url: "https://storage.googleapis.com/b/stores/x/hero.webp",
    state: null,
    appearsOn: "every page that shows it, wherever the same address is used",
    file: {
      source: "bucket",
      key: "stores/x/hero.webp",
      url: "https://storage.googleapis.com/b/stores/x/hero.webp",
      themeRelease: false,
      mediaAsset: {
        id: "m-1",
        filename: "hero.webp",
        contentType: "image/webp",
        sizeBytes: 1000,
      },
    },
  });
}

const COMPLAINT: BlockFormComplaint = {
  id: "c-1",
  ref: "SM-000123",
  kind: "court_order",
  storeId: STORE_ID,
  storeLabel: STORE.label,
  firstUrl: null,
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in tests");
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the pure helpers", () => {
  it("starts from the complaint's reason, or the policy for StoreMink's own block", () => {
    expect(defaultReason("product", null)).toBe("terms_breach");
    expect(defaultReason("product", "court_order")).toBe("court_order");
    expect(defaultReason("product", "government_order")).toBe(
      "government_order",
    );
    expect(defaultReason("review", "intimate_or_impersonation")).toBe(
      "intimate_or_impersonation",
    );
    expect(defaultReason("page", "listed_content")).toBe("listed_content");
    expect(defaultReason("store", "other_removal")).toBe("other_removal");
    // A complaint that names no removal starts with no reason chosen.
    expect(defaultReason("product", "grievance")).toBe("");
    expect(defaultReason("product", "data_request")).toBe("");
  });

  it("ticks the images for the two orders and an intimate image only", () => {
    expect(imagesTickedFor("court_order")).toBe(true);
    expect(imagesTickedFor("government_order")).toBe(true);
    expect(imagesTickedFor("intimate_or_impersonation")).toBe(true);
    expect(imagesTickedFor("terms_breach")).toBe(false);
    expect(imagesTickedFor("listed_content")).toBe(false);
    expect(imagesTickedFor("")).toBe(false);
  });

  it("names the state: a store is Open, an item Published", () => {
    expect(nowWord("store", "active")).toBe("Open");
    expect(nowWord("store", "suspended")).toBe("Suspended");
    expect(nowWord("product", "published")).toBe("Published");
    expect(nowWord("blog_post", "pending_review")).toBe("Pending review");
    expect(nowWord("review", null)).toBeNull();
  });

  it("heads the card with the kind and the label", () => {
    expect(targetHeading(target())).toBe("Product: Blue mug");
    expect(targetHeading(storeTarget())).toBe(
      "Store: Crumb & Co (crumb.storemink.com)",
    );
    expect(targetHeading(fileTarget())).toBe("Image: hero.webp");
    expect(targetHeading(target({ kind: "blog_post", label: "Spring" }))).toBe(
      "Blog post: Spring",
    );
  });

  it("builds the block: images only when ticked and not already blocked", () => {
    const withImages = target({
      images: [
        { source: "bucket", key: "a", url: "https://img/a", blocked: false },
        { source: "bucket", key: "b", url: "https://img/b", blocked: true },
      ],
    });
    const answers = {
      reason: "terms_breach" as const,
      legalBasis: "stale",
      complaintId: null,
      storeMessage: "m",
      tellStore: true,
      alsoBlockImages: true,
    };
    expect(blockInputFor(withImages, answers)).toEqual({
      kind: "product",
      storeId: STORE_ID,
      itemId: "p-1",
      reason: "terms_breach",
      legalBasis: null,
      complaintId: null,
      storeMessage: "m",
      tellStore: true,
      alsoBlockImages: ["https://img/a"],
    });
    expect(
      blockInputFor(withImages, { ...answers, alsoBlockImages: false })
        .alsoBlockImages,
    ).toEqual([]);
    expect(
      blockInputFor(withImages, { ...answers, reason: "court_order" })
        .legalBasis,
    ).toBe("stale");
    expect(blockInputFor(storeTarget(), answers)).toMatchObject({
      kind: "store",
      storeId: STORE_ID,
      itemId: STORE_ID,
    });
    expect(blockInputFor(fileTarget(), answers)).toMatchObject({
      kind: "file",
      fileAddress: "https://storage.googleapis.com/b/stores/x/hero.webp",
    });
  });
});

describe("step 1, find it", () => {
  /** A match is drawn while its find is still finishing, and its button
   *  waits on `busy`, so a click before that is lost. Wait until it can be
   *  pressed (under a loaded run the gap is long enough to matter). */
  async function pressableMatch(name: RegExp): Promise<HTMLButtonElement> {
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    return screen.getByRole("button", { name }) as HTMLButtonElement;
  }

  it("asks for an address, and offers a whole store to a superadmin only", () => {
    const { unmount } = render(
      <BlockForm superadmin={false} complaint={null} />,
    );
    const address = screen.getByLabelText("Address");
    expect(address.getAttribute("placeholder")).toBe(
      "Paste a store address or an image address",
    );
    expect(screen.getByRole("button", { name: "Find" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Or choose a store and search it" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Or suspend a whole store" }),
    ).toBeNull();
    unmount();
    render(<BlockForm superadmin complaint={null} />);
    expect(
      screen.getByRole("button", { name: "Or suspend a whole store" }),
    ).toBeTruthy();
  });

  it("finds an address and shows the server's sentence when it refuses", async () => {
    vi.mocked(resolveTargetAction).mockResolvedValueOnce({
      ok: false,
      error: "That address is not a StoreMink store.",
    });
    render(<BlockForm superadmin={false} complaint={null} />);
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://example.com/a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That address is not a StoreMink store.",
    );
    expect(resolveTargetAction).toHaveBeenCalledWith({
      address: "https://example.com/a",
      storeId: null,
    });
  });

  it("starts from the complaint's first address and store", async () => {
    vi.mocked(resolveTargetAction).mockResolvedValueOnce({
      ok: true,
      found: "target",
      target: target(),
    });
    render(
      <BlockForm
        superadmin={false}
        complaint={{ ...COMPLAINT, firstUrl: "https://crumb.storemink.com/x" }}
      />,
    );
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe(
      "https://crumb.storemink.com/x",
    );
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText("Product: Blue mug")).toBeTruthy();
    expect(resolveTargetAction).toHaveBeenCalledWith({
      address: "https://crumb.storemink.com/x",
      storeId: STORE_ID,
    });
  });

  it("says when the request never reached StoreMink", async () => {
    vi.mocked(resolveTargetAction).mockRejectedValueOnce(new Error("down"));
    render(<BlockForm superadmin={false} complaint={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect((await screen.findByRole("alert")).textContent).toBe(REQUEST_FAILED);
  });

  it("searches a chosen store, and looks a match up by its id", async () => {
    vi.mocked(listAllStores).mockResolvedValue([
      { id: STORE_ID, name: "Crumb & Co", slug: "crumb" } as never,
    ]);
    vi.mocked(resolveTargetAction)
      .mockResolvedValueOnce({
        ok: true,
        found: "matches",
        store: STORE,
        kind: "product",
        matches: [
          {
            itemId: "p-1",
            label: "Blue mug",
            url: "https://crumb.storemink.com/shop/blue-mug",
            state: "published",
            blocked: false,
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, found: "target", target: target() });
    render(<BlockForm superadmin={false} complaint={null} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Or choose a store and search it" }),
    );
    fireEvent.change(screen.getByLabelText("Store"), {
      target: { value: "crumb" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Crumb & Co/ }));
    expect(screen.getByText("Crumb & Co (crumb.storemink.com)")).toBeTruthy();
    expect(screen.getByLabelText("What to search for")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "mug" },
    });
    const finds = screen.getAllByRole("button", { name: "Find" });
    fireEvent.click(finds[finds.length - 1]);
    await waitFor(() =>
      expect(resolveTargetAction).toHaveBeenCalledWith({
        storeId: STORE_ID,
        kind: "product",
        search: "mug",
      }),
    );
    fireEvent.click(await pressableMatch(/Blue mug/));
    await waitFor(() =>
      expect(resolveTargetAction).toHaveBeenLastCalledWith({
        storeId: STORE_ID,
        kind: "product",
        itemId: "p-1",
      }),
    );
    expect(await screen.findByText("Product: Blue mug")).toBeTruthy();
  });

  it("looks a file match up by its address", async () => {
    vi.mocked(resolveTargetAction)
      .mockResolvedValueOnce({
        ok: true,
        found: "matches",
        store: STORE,
        kind: "file",
        matches: [
          {
            itemId: "m-1",
            label: "hero.webp",
            url: "https://storage.googleapis.com/b/stores/x/hero.webp",
            state: null,
            blocked: false,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        found: "target",
        target: fileTarget(),
      });
    render(<BlockForm superadmin={false} complaint={COMPLAINT} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Or choose a store and search it" }),
    );
    fireEvent.change(screen.getByLabelText("What to search for"), {
      target: { value: "file" },
    });
    const finds = screen.getAllByRole("button", { name: "Find" });
    fireEvent.click(finds[finds.length - 1]);
    fireEvent.click(await pressableMatch(/hero\.webp/));
    await waitFor(() =>
      expect(resolveTargetAction).toHaveBeenLastCalledWith({
        address: "https://storage.googleapis.com/b/stores/x/hero.webp",
        storeId: STORE_ID,
      }),
    );
    expect(await screen.findByText("Image: hero.webp")).toBeTruthy();
  });

  it("lets a superadmin pick a store to suspend whole", async () => {
    vi.mocked(listAllStores).mockResolvedValue([
      { id: STORE_ID, name: "Crumb & Co", slug: "crumb" } as never,
    ]);
    vi.mocked(resolveTargetAction).mockResolvedValueOnce({
      ok: true,
      found: "target",
      target: storeTarget(),
    });
    render(<BlockForm superadmin complaint={null} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Or suspend a whole store" }),
    );
    fireEvent.change(screen.getByLabelText("Store"), {
      target: { value: "crumb" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Crumb & Co/ }));
    await waitFor(() =>
      expect(resolveTargetAction).toHaveBeenCalledWith({
        storeId: STORE_ID,
        kind: "store",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Suspend the store" }),
    ).toBeTruthy();
  });

  it("tells a member who was sent to a whole store why it is not offered", () => {
    render(<BlockForm superadmin={false} complaint={null} storeRefused />);
    expect(screen.getByRole("alert").textContent).toBe(STORE_SUPERADMIN_ONLY);
  });
});

describe("step 2, confirm what it is", () => {
  it("shows the item: kind and label, store, state, where it appears", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target()}
      />,
    );
    expect(screen.getByText("Product: Blue mug")).toBeTruthy();
    expect(
      screen.getByText("Store: Crumb & Co (crumb.storemink.com)"),
    ).toBeTruthy();
    expect(screen.getByText("Now: Published")).toBeTruthy();
    expect(screen.getByText(`Appears on: ${PRODUCT_APPEARS}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Block now" })).toBeTruthy();
  });

  it("shows a whole store with what suspending it does (its POS, A9)", () => {
    render(
      <BlockForm superadmin complaint={null} initialTarget={storeTarget()} />,
    );
    expect(
      screen.getByText("Store: Crumb & Co (crumb.storemink.com)"),
    ).toBeTruthy();
    expect(screen.getByText("Now: Open")).toBeTruthy();
    expect(screen.getByText(STORE_SUSPENSION_TEXT)).toBeTruthy();
    expect(STORE_SUSPENSION_TEXT).toContain("its dashboard and its POS");
    expect(STORE_SUSPENSION_TEXT).not.toMatch(/register|till/);
    expect(screen.queryByText(/^Appears on:/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Suspend the store" }),
    ).toBeTruthy();
  });

  it("never offers a member a whole store, even when one is found", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={storeTarget()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(STORE_SUPERADMIN_ONLY);
    expect(
      screen.queryByRole("button", { name: "Suspend the store" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Reason")).toBeNull();
  });

  it("writes each warning the design gives", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target({
          warnings: ["homepage", "theme_release", "bundled", "external"],
        })}
      />,
    );
    expect(
      screen.getByText(
        "This is the store's homepage. Blocking it leaves the homepage empty; the rest of the store stays open.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "This image belongs to a theme and appears on every store that uses it.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(WARNING_TEXT.bundled)).toBeTruthy();
    expect(
      screen.getByText(
        "StoreMink does not store this file. Pages on this store will stop showing it, but it stays at its own address.",
      ),
    ).toBeTruthy();
    // The old-storage warning is gone (A2).
    expect(screen.queryByText(/old storage/)).toBeNull();
  });

  it("points an item already blocked at its block, and offers no second one", () => {
    const blockedAt = "2026-10-26T07:01:00.000Z";
    render(
      <BlockForm
        superadmin
        complaint={null}
        initialTarget={target({
          warnings: ["already_blocked"],
          alreadyBlocked: { blockId: "b-7", blockedAt },
        })}
      />,
    );
    const link = screen.getByRole("link", { name: "Open the block" });
    expect(link.getAttribute("href")).toBe("/dashboard/complaints/blocks/b-7");
    expect(link.parentElement?.textContent).toBe(
      `This is already blocked (since ${istDateTime(blockedAt)}). Open the block.`,
    );
    expect(screen.queryByRole("button", { name: "Block now" })).toBeNull();
  });

  it("lists the reviews on a product, each to block on its own", async () => {
    vi.mocked(resolveTargetAction).mockResolvedValueOnce({
      ok: true,
      found: "target",
      target: target({ kind: "review", label: "Rude words", state: null }),
    });
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target({
          picks: [
            {
              kind: "review",
              id: "r-1",
              author: "Asha K.",
              at: "2026-10-20T06:30:00.000Z",
              excerpt: "Rude words",
              authorUserId: "u-1",
              parentId: "p-1",
              blocked: false,
            },
            {
              kind: "review",
              id: "r-2",
              author: "Ravi S.",
              at: "2026-10-21T06:30:00.000Z",
              excerpt: "Old one",
              authorUserId: "u-2",
              parentId: "p-1",
              blocked: true,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Reviews on it")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Block this review" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Block this review" }));
    await waitFor(() =>
      expect(resolveTargetAction).toHaveBeenCalledWith({
        storeId: STORE_ID,
        kind: "review",
        itemId: "r-1",
      }),
    );
    expect(await screen.findByText("Review: Rude words")).toBeTruthy();
  });

  it("calls a post's picks comments", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target({
          kind: "blog_post",
          picks: [
            {
              kind: "blog_comment",
              id: "c-9",
              author: "Asha K.",
              at: "2026-10-20T06:30:00.000Z",
              excerpt: "Spam",
              authorUserId: null,
              parentId: "p-1",
              blocked: false,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Comments on it")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Block this comment" }),
    ).toBeTruthy();
  });

  it("offers the item's images, ticked for an order and unticked otherwise", () => {
    const images = [
      {
        source: "bucket" as const,
        key: "a",
        url: "https://img/a",
        blocked: false,
      },
    ];
    const tick =
      "Also block these images (they stop loading everywhere they are used)";
    const { unmount } = render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target({ images })}
      />,
    );
    const box = screen.getByRole("checkbox", {
      name: tick,
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    // The reason moves the tick until the operator touches it.
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "intimate_or_impersonation" },
    });
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "court_order" },
    });
    expect(box.checked).toBe(false);
    unmount();
    render(
      <BlockForm
        superadmin={false}
        complaint={COMPLAINT}
        initialTarget={target({ images })}
      />,
    );
    expect(
      (screen.getByRole("checkbox", { name: tick }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });
});

describe("step 3, why", () => {
  it("★ shows a member 'Tell the store' ticked and unavailable, the reason written under it", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target()}
      />,
    );
    const tell = screen.getByRole("checkbox", {
      name: "Tell the store",
    }) as HTMLInputElement;
    expect(tell.checked).toBe(true);
    expect(tell.disabled).toBe(true);
    const note = screen.getByText(TELL_MEMBER_NOTE);
    expect(tell.getAttribute("aria-describedby")).toBe(note.id);
    // Written, never a tooltip.
    expect(tell.getAttribute("title")).toBeNull();
    expect(tell.closest("label")?.getAttribute("title")).toBeNull();
    fireEvent.click(tell);
    expect(tell.checked).toBe(true);
  });

  it("★ a member's block is always told", async () => {
    vi.mocked(blockItemAction).mockResolvedValueOnce({
      ok: true,
      blockId: "b-9",
      childBlockIds: [],
      warnings: [],
      message: "Blocked. It is hidden from the store now.",
    });
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Tell the store" }));
    fireEvent.click(screen.getByRole("button", { name: "Block now" }));
    await waitFor(() => expect(blockItemAction).toHaveBeenCalled());
    expect(vi.mocked(blockItemAction).mock.calls[0][0].tellStore).toBe(true);
  });

  it("lets a superadmin untick it, with the warning, and sends it untold", async () => {
    vi.mocked(blockItemAction).mockResolvedValueOnce({
      ok: false,
      error:
        "To keep a block from the store, choose the court or government order and fill in its legal basis.",
    });
    render(<BlockForm superadmin complaint={null} initialTarget={target()} />);
    const tell = screen.getByRole("checkbox", {
      name: "Tell the store",
    }) as HTMLInputElement;
    expect(tell.disabled).toBe(false);
    expect(screen.queryByText(TELL_MEMBER_NOTE)).toBeNull();
    expect(screen.queryByText(UNTOLD_WARNING)).toBeNull();
    fireEvent.click(tell);
    expect(tell.checked).toBe(false);
    expect(screen.getByText(UNTOLD_WARNING)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Block now" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "To keep a block from the store, choose the court or government order and fill in its legal basis.",
    );
    expect(vi.mocked(blockItemAction).mock.calls[0][0].tellStore).toBe(false);
  });

  it("starts from the complaint's reason and asks for an order's legal basis", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={COMPLAINT}
        initialTarget={target()}
      />,
    );
    const reason = screen.getByLabelText("Reason") as HTMLSelectElement;
    expect(reason.value).toBe("court_order");
    const options = Array.from(reason.options).map((o) => o.textContent);
    expect(options).toEqual([
      "Court order",
      "Government or police order",
      "Intimate image or impersonation",
      "Content listed in Acceptable Use section 2",
      "Other removal request",
      "Breaks our Acceptable Use Policy",
    ]);
    expect(screen.getByLabelText("Legal basis")).toBeTruthy();
    expect(
      screen.getByText("Order number, date and the law it names"),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: "SM-000123" });
    expect(link.getAttribute("href")).toBe("/dashboard/complaints/SM-000123");
    fireEvent.change(reason, { target: { value: "terms_breach" } });
    expect(screen.queryByLabelText("Legal basis")).toBeNull();
  });

  it("starts StoreMink's own block on the policy, with no complaint", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target()}
      />,
    );
    expect((screen.getByLabelText("Reason") as HTMLSelectElement).value).toBe(
      "terms_breach",
    );
    expect(screen.getByText("No complaint: StoreMink found it")).toBeTruthy();
  });

  it("asks for a reason when the complaint names none", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={{ ...COMPLAINT, kind: "grievance" }}
        initialTarget={target()}
      />,
    );
    const reason = screen.getByLabelText("Reason") as HTMLSelectElement;
    expect(reason.value).toBe("");
    expect(reason.options[0].textContent).toBe("Choose a reason");
  });

  it("offers a store's own request for a review only", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target({ kind: "review", label: "Rude", state: null })}
      />,
    );
    const reason = screen.getByLabelText("Reason") as HTMLSelectElement;
    expect(Array.from(reason.options).map((o) => o.textContent)).toContain(
      "The store asked us to remove it",
    );
    fireEvent.change(reason, { target: { value: "store_request" } });
    expect(screen.getByText("No complaint: the store asked us")).toBeTruthy();
    expect(
      (screen.getByLabelText("Message to the store") as HTMLTextAreaElement)
        .value,
    ).toBe(defaultStoreMessage("store_request", "review"));
  });

  it("prefills the message from the reason until the operator edits it", () => {
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target()}
      />,
    );
    const message = screen.getByLabelText(
      "Message to the store",
    ) as HTMLTextAreaElement;
    expect(message.value).toBe(defaultStoreMessage("terms_breach", "product"));
    expect(
      screen.getByText(
        "The store sees this in its dashboard and by email. Do not include the complainant's name or contact details unless they agreed.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "listed_content" },
    });
    expect(message.value).toBe(
      defaultStoreMessage("listed_content", "product"),
    );
    fireEvent.change(message, { target: { value: "Our own words." } });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "other_removal" },
    });
    expect(message.value).toBe("Our own words.");
  });

  it("blocks, toasts the design's words and its warnings, and opens the block", async () => {
    vi.mocked(blockItemAction).mockResolvedValueOnce({
      ok: true,
      blockId: "b-9",
      childBlockIds: [],
      warnings: [
        "The file could not be archived yet, so it is still at its storage address, although pages no longer show it. StoreMink retries every minute.",
      ],
      message: "Blocked. It is hidden from the store now.",
    });
    render(
      <BlockForm
        superadmin={false}
        complaint={COMPLAINT}
        initialTarget={target()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Legal basis"), {
      target: { value: "Order 12 of 26 Oct 2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Block now" }));
    await waitFor(() =>
      expect(H.push).toHaveBeenCalledWith("/dashboard/complaints/blocks/b-9"),
    );
    expect(blockItemAction).toHaveBeenCalledWith({
      kind: "product",
      storeId: STORE_ID,
      itemId: "p-1",
      reason: "court_order",
      legalBasis: "Order 12 of 26 Oct 2026",
      complaintId: "c-1",
      storeMessage: defaultStoreMessage("court_order", "product"),
      tellStore: true,
      alsoBlockImages: [],
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Blocked. It is hidden from the store now.",
    );
    expect(toast.warning).toHaveBeenCalledWith(
      "The file could not be archived yet, so it is still at its storage address, although pages no longer show it. StoreMink retries every minute.",
    );
  });

  it("shows a refusal as the server words it, and a lost request plainly", async () => {
    vi.mocked(blockItemAction)
      .mockResolvedValueOnce({
        ok: false,
        error: "It changed while you were blocking it. Find it again.",
      })
      .mockRejectedValueOnce(new Error("down"));
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={target()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Block now" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "It changed while you were blocking it. Find it again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Block now" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(REQUEST_FAILED),
    );
    expect(H.push).not.toHaveBeenCalled();
  });

  it("suspends a whole store as itself", async () => {
    vi.mocked(blockItemAction).mockResolvedValueOnce({
      ok: true,
      blockId: "b-s",
      childBlockIds: [],
      warnings: [],
      message: "Store suspended. StoreMink is copying its files.",
    });
    render(
      <BlockForm superadmin complaint={null} initialTarget={storeTarget()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Suspend the store" }));
    await waitFor(() => expect(H.push).toHaveBeenCalled());
    expect(blockItemAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "store",
        storeId: STORE_ID,
        itemId: STORE_ID,
        reason: "terms_breach",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Store suspended. StoreMink is copying its files.",
    );
  });

  it("blocks a file by its address", async () => {
    vi.mocked(blockItemAction).mockResolvedValueOnce({
      ok: true,
      blockId: "b-f",
      childBlockIds: [],
      warnings: [],
      message: "Blocked. It is hidden from the store now.",
    });
    render(
      <BlockForm
        superadmin={false}
        complaint={null}
        initialTarget={fileTarget()}
      />,
    );
    const card = screen.getByText("Image: hero.webp").closest("section");
    expect(card).toBeTruthy();
    expect(within(card as HTMLElement).queryByText(/^Now:/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Block now" }));
    await waitFor(() => expect(blockItemAction).toHaveBeenCalled());
    expect(vi.mocked(blockItemAction).mock.calls[0][0]).toMatchObject({
      kind: "file",
      fileAddress: "https://storage.googleapis.com/b/stores/x/hero.webp",
      storeMessage: defaultStoreMessage("terms_breach", "file", "image/webp"),
    });
  });
});
