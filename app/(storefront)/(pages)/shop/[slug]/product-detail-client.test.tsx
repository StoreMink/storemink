// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(storefront)/components/cart/CartProvider", () => ({
  useCart: () => ({ addItem: vi.fn() }),
}));
vi.mock("@/app/(storefront)/components/share-buttons", () => ({
  ShareButtons: () => <div data-testid="share" />,
}));
vi.mock(
  "@/app/(storefront)/components/delivery/product-delivery-estimator",
  () => ({
    ProductDeliveryEstimator: () => <div data-testid="delivery" />,
  }),
);
vi.mock("./related-products", () => ({
  RelatedProducts: () => <div data-testid="related" />,
}));
vi.mock("./reviews-section", () => ({
  default: () => <div data-testid="reviews" />,
  RatingStars: () => <span />,
}));
vi.mock("./product-gallery", () => ({
  ProductGallery: ({ mode }: { mode?: string }) => (
    <div data-testid="gallery" data-mode={mode} />
  ),
  ProductLightbox: () => null,
}));
vi.mock("./sticky-add-to-cart", () => ({
  StickyAddToCart: () => <div data-testid="sticky" />,
}));
vi.mock("./grocery-product-detail", () => ({
  GroceryProductDetail: ({ galleryMode }: { galleryMode?: string }) => (
    <div data-testid="grocery" data-mode={galleryMode} />
  ),
}));

import ProductDetailClient, {
  type DetailProduct,
} from "./product-detail-client";
import { defaultTemplates, type ProductTemplate } from "@/lib/themes/templates";

const product: DetailProduct = {
  id: "p1",
  name: "Linen shirt",
  slug: "linen-shirt",
  description: "Soft, breathable linen.",
  category_id: null,
  base_price: 2000,
  selling_price: 1800,
  image_url: "/a.webp",
  images: ["/a.webp", "/b.webp"],
  seo_title: null,
  seo_description: null,
  category: null,
  track_inventory: false,
  stock: 0,
  low_stock_threshold: null,
  allow_backorder: false,
  variants: [],
};

const template = (
  blocks: ProductTemplate["blocks"],
  gallery: ProductTemplate["gallery"] = "thumbs-bottom",
): ProductTemplate => ({
  gallery,
  blocks,
});

const order = (container: HTMLElement) =>
  Array.from(container.querySelector(".pdp-info")!.children).map(
    (el) => el.className || el.getAttribute("data-testid") || el.tagName,
  );

// Plan Phase 2e: the information column is composed from the template.
describe("ProductDetailClient as a block renderer", () => {
  it("renders the default template as the page always was", () => {
    const { container } = render(
      <ProductDetailClient product={product} related={[]} reviews={[]} />,
    );
    const info = order(container);
    // Title area first, then the blocks in the default order.
    expect(info.indexOf("pdp-price")).toBeLessThan(
      info.indexOf("pdp-description"),
    );
    expect(screen.getByTestId("share")).toBeTruthy();
    expect(screen.getByTestId("delivery")).toBeTruthy();
    expect(container.querySelector(".pdp-actions")).toBeTruthy();
    expect(screen.getByTestId("reviews")).toBeTruthy();
    expect(screen.getByTestId("related")).toBeTruthy();
    // No sticky bar unless the template carries one.
    expect(screen.queryByTestId("sticky")).toBeNull();
    expect(screen.getByTestId("gallery").getAttribute("data-mode")).toBe(
      "thumbs-bottom",
    );
    expect(
      defaultTemplates(undefined).product.blocks.map((b) => b.type),
    ).not.toContain("sticky_bar");
  });

  it("follows the template's order, renders the authored blocks and the sticky bar", () => {
    const { container } = render(
      <ProductDetailClient
        product={product}
        related={[]}
        reviews={[]}
        template={template(
          [
            {
              type: "trust_row",
              items: [{ icon: "truck", label: "Free delivery" }],
            },
            { type: "buy_box" },
            { type: "price" },
            {
              type: "accordion",
              rows: [{ heading: "Care", body: "Cold wash." }],
            },
            {
              type: "rich_text",
              html: "<p>Made in <strong>Jaipur</strong>.</p>",
            },
            { type: "recommendations" },
            { type: "sticky_bar" },
          ],
          "grid",
        )}
      />,
    );
    const info = order(container);
    expect(info.indexOf("pdp-trust")).toBeLessThan(info.indexOf("pdp-price"));
    expect(info.indexOf("pdp-accordion")).toBeGreaterThan(
      info.indexOf("pdp-price"),
    );
    expect(screen.getByText("Free delivery")).toBeTruthy();
    expect(
      container.querySelector(".pdp-accordion-row > summary")?.textContent,
    ).toBe("Care");
    expect(container.querySelector(".pdp-rich strong")?.textContent).toBe(
      "Jaipur",
    );
    // Blocks the template omits are absent: no description, share, delivery.
    expect(container.querySelector(".pdp-description")).toBeNull();
    expect(screen.queryByTestId("share")).toBeNull();
    expect(screen.queryByTestId("delivery")).toBeNull();
    // Page blocks: only recommendations, and the sticky bar is on.
    expect(screen.queryByTestId("reviews")).toBeNull();
    expect(screen.getByTestId("related")).toBeTruthy();
    expect(screen.getByTestId("sticky")).toBeTruthy();
    expect(screen.getByTestId("gallery").getAttribute("data-mode")).toBe(
      "grid",
    );
  });

  it("gives the grocery layout its page blocks, gallery shape and sticky bar", () => {
    render(
      <ProductDetailClient
        product={product}
        related={[]}
        reviews={[]}
        grocery
        template={template(
          [{ type: "price" }, { type: "buy_box" }, { type: "reviews" }],
          "carousel",
        )}
      />,
    );
    expect(screen.getByTestId("grocery").getAttribute("data-mode")).toBe(
      "carousel",
    );
    expect(screen.getByTestId("reviews")).toBeTruthy();
    expect(screen.queryByTestId("related")).toBeNull();
    expect(screen.queryByTestId("sticky")).toBeNull();
  });
});

// Plan Phase 2e, second slice: the size guide block.
it("renders a size guide block as a table with one column per measurement", () => {
  const { container } = render(
    <ProductDetailClient
      product={product}
      related={[]}
      reviews={[]}
      template={template([
        { type: "price" },
        {
          type: "size_guide",
          columns: ["Chest", "Waist"],
          sizes: [
            { label: "S", values: ["86", "70"] },
            { label: "M", values: ["90", "74"] },
          ],
        },
        { type: "buy_box" },
      ])}
    />,
  );
  const guide = container.querySelector(".pdp-size-guide")!;
  expect(guide.querySelector("summary")?.textContent).toBe("Size guide");
  expect(
    Array.from(guide.querySelectorAll("thead th")).map((th) => th.textContent),
  ).toEqual(["Size", "Chest", "Waist"]);
  expect(
    Array.from(guide.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.children).map((cell) => cell.textContent),
    ),
  ).toEqual([
    ["S", "86", "70"],
    ["M", "90", "74"],
  ]);
});
