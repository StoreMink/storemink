// @vitest-environment jsdom
// Quick view (owner, 22 Nov 2026): the eye on a product card, and the dialog
// it opens over the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cart = vi.hoisted(() => ({
  addItem: vi.fn(),
  items: [] as {
    productId: string;
    variantId: string | null;
    quantity: number;
  }[],
}));
vi.mock("./cart/CartProvider", () => ({
  useCart: () => ({ addItem: cart.addItem, items: cart.items }),
  lineKey: (p: string, v: string | null) => `${p}:${v ?? ""}`,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
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
const getQuickViewProduct = vi.fn();
vi.mock("@/app/actions/quick-add-actions", () => ({
  getQuickViewProduct: (...args: unknown[]) => getQuickViewProduct(...args),
}));
vi.mock("./quick-add-button", () => ({ QuickAddButton: () => null }));

import { QuickViewButton, variantOfHref } from "./quick-view-button";
import { QUICK_VIEW_THUMBS } from "./quick-view-dialog";
import { ShopCard, type ShopCardProduct } from "./shop-card";

const variant = (id: string, values: string[], extra = {}) => ({
  id,
  name: values.join(" / "),
  base_price: 1200,
  selling_price: 999,
  special_price: null,
  images: [] as string[],
  track_inventory: true,
  stock: 5,
  low_stock_threshold: null,
  allow_backorder: false,
  option_values: values,
  ...extra,
});

/** A shirt in two sizes and two colours; each colour has its own photos. */
const shirt = {
  id: "p1",
  slug: "linen-shirt",
  name: "Linen shirt",
  image_url: "/shirt.webp",
  category: "Shirts",
  gallery: ["/shirt.webp", "/shirt-back.webp"],
  excerpt: "Washed linen, cut loose through the body.",
  base_price: 1200,
  selling_price: 999,
  track_inventory: true,
  stock: 0,
  low_stock_threshold: null,
  allow_backorder: false,
  options: [
    { name: "Size", values: ["S", "M"] },
    {
      name: "Colour",
      values: ["White", "Navy"],
      images: {
        White: ["/white-1.webp", "/white-2.webp"],
        Navy: ["/navy-1.webp", "/navy-2.webp"],
      },
    },
  ],
  variants: [
    // The first variant is sold out: the view must open on one that sells.
    variant("sw", ["S", "White"], { stock: 0 }),
    variant("sn", ["S", "Navy"]),
    variant("mw", ["M", "White"], { base_price: 1500, selling_price: 1500 }),
    variant("mn", ["M", "Navy"]),
  ],
};

/** A mug sold as it is, with no variants. */
const mug = {
  id: "p2",
  slug: "mug",
  name: "Stoneware mug",
  image_url: "/mug.webp",
  category: null,
  gallery: ["/mug.webp"],
  excerpt: null,
  base_price: 500,
  selling_price: 400,
  track_inventory: true,
  stock: 2,
  low_stock_threshold: null,
  allow_backorder: false,
  options: [],
  variants: [],
};

function renderEye(
  href = "/shop/linen-shirt",
  id = "p1",
  name = "Linen shirt",
) {
  const navigate = vi.fn();
  render(
    <div className="storefront-root">
      {/* Stands in for the card's <Link>: any click that reaches it navigates. */}
      <a href={href} onClick={(e) => (e.preventDefault(), navigate())}>
        <QuickViewButton productId={id} name={name} href={href} />
      </a>
    </div>,
  );
  return navigate;
}
const eye = (name = "Linen shirt") =>
  screen.getByRole("button", { name: `Quick view: ${name}` });
const photo = () =>
  document
    .querySelector<HTMLImageElement>(".sm-qv-photo img")
    ?.getAttribute("src");

beforeEach(() => {
  cart.addItem.mockReset();
  cart.items = [];
  toast.success.mockReset();
  toast.error.mockReset();
  getQuickViewProduct.mockReset();
  getQuickViewProduct.mockResolvedValue(shirt);
  window.localStorage.clear();
});
afterEach(cleanup);

describe("the eye on a product card", () => {
  it("is on every card, named for its product", () => {
    render(
      <ShopCard
        product={
          {
            id: "p1",
            name: "Linen shirt",
            slug: "linen-shirt",
            image_url: "/shirt.webp",
            base_price: 1200,
            selling_price: 999,
            track_inventory: false,
            stock: 5,
            low_stock_threshold: null,
            allow_backorder: false,
            variants: [],
          } as ShopCardProduct
        }
      />,
    );
    expect(eye().closest(".shop-card-img")).not.toBeNull();
    expect(eye()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("opens the quick view instead of following the card's link", async () => {
    const navigate = renderEye();
    fireEvent.click(eye());
    const dialog = await screen.findByRole("dialog", { name: "Linen shirt" });
    expect(navigate).not.toHaveBeenCalled();
    expect(getQuickViewProduct).toHaveBeenCalledWith("p1");
    // Inside the storefront root, where the theme's tokens live, and outside
    // the card's link.
    expect(dialog.closest(".storefront-root")).not.toBeNull();
    expect(dialog.closest("a")).toBeNull();
  });

  it("opens from the keyboard and reads nothing until it is opened", async () => {
    renderEye();
    expect(getQuickViewProduct).not.toHaveBeenCalled();
    fireEvent.keyDown(eye(), { key: "Enter" });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(getQuickViewProduct).toHaveBeenCalledTimes(1);
  });

  it("reads the variant a per-colour card stands for from its link", () => {
    expect(variantOfHref("/shop/linen-shirt?variant=mn")).toBe("mn");
    expect(variantOfHref("/shop/linen-shirt?a=1&variant=mw#top")).toBe("mw");
    expect(variantOfHref("/shop/linen-shirt")).toBeNull();
    expect(variantOfHref("/shop/linen-shirt?variant=")).toBeNull();
    expect(variantOfHref(null)).toBeNull();
  });
});

describe("the quick view", () => {
  it("shows the product: category, name, price, the first lines and its photos", async () => {
    renderEye();
    fireEvent.click(eye());
    const dialog = await screen.findByRole("dialog", { name: "Linen shirt" });
    expect(dialog).toHaveTextContent("Shirts");
    expect(dialog).toHaveTextContent(
      "Washed linen, cut loose through the body.",
    );
    // S / Navy: 999 against an MRP of 1,200.
    const price = dialog.querySelector(".sm-qv-price")!;
    expect(price).toHaveTextContent("999");
    expect(price.querySelector(".sm-qv-was")).toHaveTextContent("1,200");
    expect(price).toHaveTextContent("17% off");
    expect(
      screen.getByRole("link", { name: "View full details" }),
    ).toHaveAttribute("href", "/shop/linen-shirt?variant=sn");
  });

  it("opens on a variant that sells, and on the card's own colour when it has one", async () => {
    renderEye();
    fireEvent.click(eye());
    // S / White is sold out, so it opens on S / Navy, with Navy's photos.
    expect(
      await screen.findByRole("button", { name: "Colour Navy" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(photo()).toBe("/navy-1.webp");
    cleanup();

    renderEye("/shop/linen-shirt?variant=mw");
    fireEvent.click(eye());
    expect(
      await screen.findByRole("button", { name: "Colour White" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Size M" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(photo()).toBe("/white-1.webp");
  });

  it("swaps the photo and the price with the option chosen, and adds that one", async () => {
    const navigate = renderEye();
    const button = eye();
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Colour Navy" });
    fireEvent.click(screen.getByRole("button", { name: "Size M" }));
    fireEvent.click(screen.getByRole("button", { name: "Colour White" }));
    expect(photo()).toBe("/white-1.webp");
    // M / White is not marked down.
    const price = document.querySelector(".sm-qv-price")!;
    expect(price).toHaveTextContent("1,500");
    expect(price.querySelector(".sm-qv-was")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(cart.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p1",
        slug: "linen-shirt",
        variantId: "mw",
        variantName: "M / White",
        price: 1500,
        basePrice: 1500,
        image: "/white-1.webp",
        trackInventory: true,
        stock: 5,
        allowBackorder: false,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Linen shirt (M / White) added to cart",
      expect.anything(),
    );
    // It closes, hands focus back to the eye, and no tap reached the link.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("lets the shopper look through the photos", async () => {
    renderEye();
    fireEvent.click(eye());
    const second = await screen.findByRole("button", { name: "Photo 2 of 2" });
    expect(
      screen.getByRole("button", { name: "Photo 1 of 2" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(second);
    expect(photo()).toBe("/navy-2.webp");
    expect(second).toHaveAttribute("aria-pressed", "true");
  });

  it("shows at most a row of thumbnails, and none for a single photo", async () => {
    getQuickViewProduct.mockResolvedValue({
      ...mug,
      gallery: Array.from({ length: 14 }, (_, i) => `/mug-${i}.webp`),
    });
    renderEye("/shop/mug", "p2", "Stoneware mug");
    fireEvent.click(eye("Stoneware mug"));
    await screen.findByRole("dialog", { name: "Stoneware mug" });
    expect(document.querySelectorAll(".sm-qv-thumb")).toHaveLength(
      QUICK_VIEW_THUMBS,
    );
    cleanup();

    getQuickViewProduct.mockResolvedValue(mug);
    renderEye("/shop/mug", "p2", "Stoneware mug");
    fireEvent.click(eye("Stoneware mug"));
    await screen.findByRole("dialog", { name: "Stoneware mug" });
    expect(document.querySelector(".sm-qv-thumbs")).toBeNull();
  });

  it("sells a product that has no variants, and no more than there are", async () => {
    getQuickViewProduct.mockResolvedValue(mug);
    renderEye("/shop/mug", "p2", "Stoneware mug");
    fireEvent.click(eye("Stoneware mug"));
    const dialog = await screen.findByRole("dialog", { name: "Stoneware mug" });
    expect(dialog.querySelector(".sm-opts")).toBeNull();
    expect(dialog.querySelector(".sm-qv-price")).toHaveTextContent("400");
    expect(
      screen.getByRole("link", { name: "View full details" }),
    ).toHaveAttribute("href", "/shop/mug");
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(cart.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p2",
        variantId: null,
        variantName: null,
        price: 400,
        basePrice: 500,
        stock: 2,
      }),
    );
    cleanup();

    // Both mugs are already in the cart: it says so and adds nothing.
    cart.addItem.mockReset();
    cart.items = [{ productId: "p2", variantId: null, quantity: 2 }];
    renderEye("/shop/mug", "p2", "Stoneware mug");
    fireEvent.click(eye("Stoneware mug"));
    await screen.findByRole("dialog", { name: "Stoneware mug" });
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(cart.addItem).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Only 2 of Stoneware mug available - already in your cart.",
      expect.anything(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("says Sold out, and sells nothing, when there is none to buy", async () => {
    getQuickViewProduct.mockResolvedValue({ ...mug, stock: 0 });
    renderEye("/shop/mug", "p2", "Stoneware mug");
    fireEvent.click(eye("Stoneware mug"));
    const button = await screen.findByRole("button", { name: "Sold out" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(cart.addItem).not.toHaveBeenCalled();
  });

  it("says so when the product cannot be loaded", async () => {
    getQuickViewProduct.mockResolvedValue(null);
    renderEye();
    fireEvent.click(eye());
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    cleanup();

    getQuickViewProduct.mockRejectedValue(new Error("offline"));
    renderEye();
    fireEvent.click(eye());
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });

  it("closes on Escape, on its Close button and on the backdrop, returning focus", async () => {
    renderEye();
    const button = eye();
    fireEvent.click(button);
    await screen.findByRole("dialog", { name: "Linen shirt" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    await screen.findByRole("dialog", { name: "Linen shirt" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Linen shirt" });
    // A click on the panel itself is not a click on the backdrop.
    fireEvent.click(dialog);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(document.querySelector(".sm-qv")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("★ keeps Tab inside: past the last control is the first, and back again", async () => {
    renderEye();
    fireEvent.click(eye());
    const dialog = await screen.findByRole("dialog", { name: "Linen shirt" });
    const close = screen.getByRole("button", { name: "Close" });
    const details = screen.getByRole("link", { name: "View full details" });
    // The dialog itself holds focus on opening; from there Tab is the
    // browser's own, which goes to the first control.
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);

    details.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(details);
    // In the middle Tab is the browser's own.
    screen.getByRole("button", { name: "Add to cart" }).focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("offers Save for later with the product's own slug", async () => {
    renderEye();
    fireEvent.click(eye());
    await screen.findByRole("dialog", { name: "Linen shirt" });
    fireEvent.click(screen.getByRole("button", { name: /Save for later/ }));
    expect(JSON.stringify(window.localStorage).includes("linen-shirt")).toBe(
      true,
    );
    // Saving is not closing.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(
    join(process.cwd(), "app/(storefront)/storefront-theme.css"),
    "utf8",
  );

  it("★ hides the eye unless the store keeps its quick view", () => {
    const hidden = css.indexOf(".shop-card-view {\n  display: none;\n}");
    const shown = css.indexOf(".sm-quickview .shop-card-view {");
    expect(hidden).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(hidden);
    // Every other rule for it is under the merchant's switch.
    const selectors = css.match(/^[^\n{}]*\.shop-card-view[^\n{]*[{,]/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(4);
    for (const selector of selectors.slice(1))
      expect(selector).toContain(".sm-quickview");
  });

  it("moves the eye under the heart when the store keeps both", () => {
    expect(css).toMatch(
      /\.sm-wishlist\.sm-quickview \.shop-card-view \{\n\s+top: 60px;/,
    );
  });
});
