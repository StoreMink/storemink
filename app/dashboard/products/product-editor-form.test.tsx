// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProductEditorForm } from "./product-editor-form";
import { updateProduct } from "@/app/actions/product-actions";
import type { Product } from "./page";

vi.mock("@/components/ui/image-upload", () => ({
  ImageUpload: ({
    onUploadSuccess,
    onChooseFromLibrary,
  }: {
    onUploadSuccess: (url: string) => void;
    onChooseFromLibrary?: () => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() => onUploadSuccess("https://example.test/new-photo.webp")}
      >
        Upload fixture image
      </button>
      {onChooseFromLibrary && (
        <button type="button" onClick={onChooseFromLibrary}>
          Library option of the upload box
        </button>
      )}
    </>
  ),
}));
vi.mock("@/lib/storage/uploads", () => ({ uploadImage: vi.fn() }));
vi.mock("@/app/actions/media-actions", () => ({
  getMediaPickerPage: vi.fn(async ({ tab }: { tab: string }) => ({
    items:
      tab === "library"
        ? [
            {
              url: "https://example.test/library-a.webp",
              filename: "library-a.webp",
              label: "Made by Mink AI",
              products: [],
            },
            {
              url: "https://example.test/library-b.webp",
              filename: "library-b.webp",
              label: null,
              products: [],
            },
          ]
        : [],
    total: tab === "library" ? 2 : 0,
    page: 1,
    pageSize: 24,
  })),
}));
vi.mock("@/app/actions/product-actions", () => ({
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  generateProductDescription: vi.fn(),
  generateProductSeo: vi.fn(),
}));

const product: Product = {
  id: "product-1",
  name: "Coffee beans",
  slug: "coffee-beans",
  description: "Freshly roasted coffee",
  category_id: "category-1",
  base_price: 500,
  selling_price: 450,
  cost_price: null,
  image_url: null,
  images: [],
  status: "published",
  featured: false,
  sort_order: 0,
  card_color: null,
  seo_title: "Coffee beans",
  seo_description: "Freshly roasted coffee beans",
  published_at: "2026-08-01T00:00:00.000Z",
  track_inventory: true,
  stock: 7,
  low_stock_threshold: 3,
  allow_backorder: false,
  sku: "SKU-1",
  barcode: null,
  tax_class_id: null,
  hsn_code: null,
  returnable: true,
  return_window_days: null,
  requires_shipping: true,
  weight_grams: null,
  length_cm: null,
  width_cm: null,
  height_cm: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  category: {
    id: "category-1",
    name: "Coffee",
    slug: "coffee",
  },
  variants: [
    {
      id: "variant-1",
      product_id: "product-1",
      name: "500 g",
      base_price: 500,
      selling_price: 450,
      cost_price: null,
      special_price: null,
      stock: 7,
      sku: "SKU-1-V1",
      barcode: null,
      requires_shipping: true,
      weight_grams: null,
      length_cm: null,
      width_cm: null,
      height_cm: null,
      image_url: null,
      images: [],
      sort_order: 0,
      created_at: "2026-08-01T00:00:00.000Z",
    },
  ],
};

describe("ProductEditorForm inventory flow", () => {
  it("uses a dedicated stock handoff and keeps existing variant totals read-only", () => {
    render(
      <ProductEditorForm
        product={product}
        categories={[
          {
            id: "category-1",
            name: "Coffee",
            slug: "coffee",
            status: "active",
          },
        ]}
        taxClasses={[]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inventory" }));
    expect(screen.getByText("7 units")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Manage stock by location" }),
    ).toHaveAttribute("href", "/dashboard/inventory?q=Coffee%20beans");

    fireEvent.click(screen.getByRole("button", { name: "Variants" }));
    expect(
      screen.getByText(/Existing stock is shown as a store-wide total/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Opening stock/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    expect(
      screen.getByLabelText("Opening stock for variant 2"),
    ).toBeInTheDocument();
  });
});

it("saves a Pricing edit to the single sellable variant", async () => {
  vi.mocked(updateProduct).mockResolvedValue({ success: true });
  render(
    <ProductEditorForm
      product={product}
      categories={[
        { id: "category-1", name: "Coffee", slug: "coffee", status: "active" },
      ]}
      taxClasses={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Pricing" }));
  const field = screen
    .getByText("Selling price ₹")
    .closest("div")!
    .querySelector("input")!;
  fireEvent.change(field, { target: { value: "499" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProduct).toHaveBeenCalled());
  const saved = vi.mocked(updateProduct).mock.calls.at(-1)![1];
  expect(saved.selling_price).toBe(499);
  expect(saved.variants[0].selling_price).toBe(499);
});
it("keeps multiple variants independently priced when changing product defaults", async () => {
  vi.mocked(updateProduct).mockResolvedValue({ success: true });
  const multi = {
    ...product,
    variants: [
      ...product.variants,
      {
        ...product.variants[0],
        id: "variant-2",
        name: "1 kg",
        selling_price: 480,
      },
    ],
  };
  render(
    <ProductEditorForm
      product={multi}
      categories={[
        { id: "category-1", name: "Coffee", slug: "coffee", status: "active" },
      ]}
      taxClasses={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Pricing" }));
  const field = screen
    .getByText("Selling price ₹")
    .closest("div")!
    .querySelector("input")!;
  fireEvent.change(field, { target: { value: "499" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProduct).toHaveBeenCalled());
  expect(
    vi
      .mocked(updateProduct)
      .mock.calls.at(-1)![1]
      .variants.map((v) => v.selling_price),
  ).toEqual([450, 480]);
});

it("updates a single variant primary photo and retains its extra photos", async () => {
  vi.mocked(updateProduct).mockResolvedValue({ success: true });
  render(
    <ProductEditorForm
      product={{
        ...product,
        image_url: "https://example.test/old.webp",
        variants: [
          {
            ...product.variants[0],
            images: [
              "https://example.test/old-variant.webp",
              "https://example.test/detail.webp",
            ],
          },
        ],
      }}
      categories={[
        { id: "category-1", name: "Coffee", slug: "coffee", status: "active" },
      ]}
      taxClasses={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Media$/ }));
  fireEvent.click(
    screen.getByText("Primary image").closest("div")!.querySelector("button")!,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProduct).toHaveBeenCalled());
  const saved = vi.mocked(updateProduct).mock.calls.at(-1)![1];
  expect(saved.image_url).toBe("https://example.test/new-photo.webp");
  expect(saved.variants[0].images).toEqual([
    "https://example.test/new-photo.webp",
    "https://example.test/detail.webp",
  ]);
});

function renderEditor() {
  render(
    <ProductEditorForm
      product={product}
      categories={[
        { id: "category-1", name: "Coffee", slug: "coffee", status: "active" },
      ]}
      taxClasses={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Media" }));
}

// ★ A photo already in the Media Library (or on another product) can be used
//   without uploading it again.
it("sets the primary photo from the library and saves it to the single variant", async () => {
  vi.mocked(updateProduct).mockResolvedValue({ success: true });
  renderEditor();
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "Library option of the upload box",
    })[0],
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "library-b.webp" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Use photo" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProduct).toHaveBeenCalled());
  const saved = vi.mocked(updateProduct).mock.calls.at(-1)![1];
  expect(saved.image_url).toBe("https://example.test/library-b.webp");
  expect(saved.variants[0].images[0]).toBe(
    "https://example.test/library-b.webp",
  );
});

it("adds several library photos to the gallery at once", async () => {
  vi.mocked(updateProduct).mockResolvedValue({ success: true });
  renderEditor();
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "Library option of the upload box",
    })[1],
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "library-a.webp" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "library-b.webp" }));
  fireEvent.click(screen.getByRole("button", { name: "Add 2 photos" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProduct).toHaveBeenCalled());
  expect(vi.mocked(updateProduct).mock.calls.at(-1)![1].images).toEqual([
    "https://example.test/library-a.webp",
    "https://example.test/library-b.webp",
  ]);
});
