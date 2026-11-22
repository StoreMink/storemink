// @vitest-environment jsdom
// The wishlist heart, the saved-items page and the recently-viewed row
// (owner, 22 Nov 2026). All three read lists the shopper keeps on their own
// device (lib/storefront/device-lists.ts) and fetch today's product cards.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt} />
  ),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("./quick-add-button", () => ({ QuickAddButton: () => null }));
vi.mock("@/app/(storefront)/components/homepage/horizontal-carousel", () => ({
  HorizontalCarousel: ({ children }: { children: ReactNode }) => (
    <div data-testid="row">{children}</div>
  ),
}));

import { ShopCard, type ShopCardProduct } from "./shop-card";
import { WishlistButton } from "./wishlist-button";
import { SavedProducts } from "./saved-products";
import { RecentlyViewed } from "../(pages)/shop/[slug]/recently-viewed";
import {
  noteViewed,
  readDeviceList,
  toggleSaved,
} from "@/lib/storefront/device-lists";

const product = (slug: string): ShopCardProduct =>
  ({
    id: `id-${slug}`,
    name: `The ${slug}`,
    slug,
    image_url: `https://example.com/${slug}.jpg`,
    base_price: 1200,
    selling_price: 1200,
    special_price: null,
    track_inventory: false,
    stock: 5,
    low_stock_threshold: null,
    allow_backorder: false,
    variants: [],
  }) as ShopCardProduct;

/** The cards endpoint, answering only for products the store still sells. */
const sold = new Set<string>();
const asked: string[] = [];
beforeEach(() => {
  window.localStorage.clear();
  sold.clear();
  asked.length = 0;
  for (const slug of ["bowl", "mug", "plate"]) sold.add(slug);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      // The list is in the body of a POST, never in the address.
      expect(url).toBe("/api/storefront/products");
      expect(init.method).toBe("POST");
      const slugs = (JSON.parse(String(init.body)) as { slugs: string[] })
        .slugs;
      asked.push(slugs.join(","));
      return new Response(
        JSON.stringify({
          products: slugs.filter((slug) => sold.has(slug)).map(product),
        }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("★★ the heart on a product card", () => {
  it("saves and removes the product without following the card's link", () => {
    const followed = vi.fn();
    render(
      <div onClick={followed}>
        <ShopCard product={product("bowl")} />
      </div>,
    );
    const heart = screen.getByRole("button", {
      name: "Save The bowl for later",
    });
    // Inside the card's photo frame, over the picture.
    expect(heart.closest(".shop-card-img")).not.toBeNull();
    expect(heart.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(heart);
    expect(readDeviceList("wishlist")).toEqual(["bowl"]);
    expect(followed).not.toHaveBeenCalled();
    const saved = screen.getByRole("button", {
      name: "Remove The bowl from saved items",
    });
    expect(saved.getAttribute("aria-pressed")).toBe("true");
    expect(saved.getAttribute("data-saved")).toBe("true");
    // The keyboard does what a click does.
    fireEvent.keyDown(saved, { key: "Enter" });
    expect(readDeviceList("wishlist")).toEqual([]);
    fireEvent.keyDown(screen.getByRole("button"), { key: " " });
    expect(readDeviceList("wishlist")).toEqual(["bowl"]);
  });

  it("every heart for one product agrees, and a product saved elsewhere shows saved", () => {
    toggleSaved("mug");
    render(
      <>
        <WishlistButton slug="mug" name="The mug" />
        <WishlistButton slug="mug" name="The mug" variant="page" />
        <WishlistButton slug="bowl" name="The bowl" />
      </>,
    );
    expect(
      screen
        .getAllByRole("button", { pressed: true })
        .map((b) => b.textContent),
    ).toEqual(["", "Saved: The mug"]);
    fireEvent.click(screen.getByRole("button", { name: /Saved/ }));
    expect(screen.queryAllByRole("button", { pressed: true })).toEqual([]);
    expect(screen.getByText("Save for later")).toBeTruthy();
  });
});

describe("★★ the saved-items page", () => {
  it("says so when nothing is saved, and reads no cards", () => {
    render(<SavedProducts />);
    expect(screen.getByRole("heading", { name: "Saved items" })).toBeTruthy();
    expect(screen.getByText("Nothing saved yet")).toBeTruthy();
    expect(screen.getByText(/Saved on this device/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Browse the shop" })
        .getAttribute("href"),
    ).toBe("/shop");
    expect(asked).toEqual([]);
  });

  it("shows the saved products newest first, drops one when its heart is pressed, and removes all", async () => {
    toggleSaved("bowl");
    toggleSaved("mug");
    render(<SavedProducts />);
    await waitFor(() =>
      expect(
        screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
      ).toEqual(["The mug", "The bowl"]),
    );
    expect(asked).toEqual(["mug,bowl"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove The mug from saved items" }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
      ).toEqual(["The bowl"]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
    expect(screen.getByText("Nothing saved yet")).toBeTruthy();
    expect(readDeviceList("wishlist")).toEqual([]);
  });

  it("a saved product the store no longer sells is not shown, and the page says so when none is left", async () => {
    toggleSaved("discontinued");
    render(<SavedProducts />);
    await waitFor(() =>
      expect(
        screen.getByText("These products are no longer available"),
      ).toBeTruthy(),
    );
  });

  it("a failed read shows no cards and no error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    toggleSaved("bowl");
    render(<SavedProducts />);
    await waitFor(() =>
      expect(
        screen.getByText("These products are no longer available"),
      ).toBeTruthy(),
    );
  });
});

describe("★★ recently viewed, under a product", () => {
  it("shows nothing to a first-time visitor, and notes this product for next time", async () => {
    const { container } = render(<RecentlyViewed currentSlug="bowl" />);
    await act(async () => {});
    expect(container.innerHTML).toBe("");
    expect(asked).toEqual([]);
    expect(readDeviceList("recent")).toEqual(["bowl"]);
  });

  it("lists the products looked at before, newest first, never this one", async () => {
    noteViewed("plate");
    noteViewed("mug");
    noteViewed("bowl");
    render(<RecentlyViewed currentSlug="bowl" />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Recently viewed" }),
      ).toBeTruthy(),
    );
    expect(asked[0]).toBe("mug,plate");
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["The mug", "The plate"]);
    expect(readDeviceList("recent")[0]).toBe("bowl");
  });

  it("shows no heading when none of the earlier products is still sold", async () => {
    noteViewed("discontinued");
    const { container } = render(<RecentlyViewed currentSlug="bowl" />);
    await waitFor(() => expect(asked).toHaveLength(1));
    await act(async () => {});
    expect(container.querySelector("h2")).toBeNull();
  });
});
