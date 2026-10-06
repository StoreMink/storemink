// ---------------------------------------------------------------------------
// One card per colour (Website Builder → Storefront layout → Product cards
// in the grid) — H&M's grid, where "Loose Fit Sweatshirt" appears once in
// light blue, once in brown, … each with its own photo, price and stock.
//
// ★★ IT IS A VIEW, NOT A DATA MODEL. The product stays ONE product with a
// Colour × Size matrix: one place to edit, one inventory, one set of
// reviews. Each card is that product restricted to the variants of one
// colour, so its price, "Sold out" flag and filter matching come from those
// variants alone, through the card's ordinary rules.
//
// ★ A PRODUCT ONLY SPLITS WHEN THE COLOURS LOOK DIFFERENT. If no colour has
// its own photo (on the option, or on one of its variants), every card would
// show the same picture — so it stays a single card. A colour without
// photos while others have them shows the product's photo.
//
// ★ Each card links to the product page with that colour already chosen
// (`?variant=<the colour's first in-stock variant>`), which the page reads.
// ---------------------------------------------------------------------------

import {
  normalizeOptions,
  photoAxis,
  photosForVariant,
  type ProductOption,
} from "@/lib/products/options";

export interface SplittableVariant {
  id?: string;
  option_values?: string[] | null;
  images?: string[] | null;
  track_inventory: boolean;
  stock: number;
  allow_backorder: boolean;
}

export interface SplittableProduct<V extends SplittableVariant> {
  id: string;
  slug: string;
  image_url: string | null;
  images?: string[] | null;
  options?: unknown;
  variants: V[];
}

export interface ColourCard<P> {
  /** Unique per card: the product id, plus the colour when split. */
  key: string;
  product: P;
  /** The card's link when it is not the plain product page. */
  href: string | null;
  /** The colour this card shows, for the accessible name and swatches. */
  colour: string | null;
}

const sellable = (v: SplittableVariant) =>
  !v.track_inventory || v.allow_backorder || v.stock > 0;

export function colourCards<
  V extends SplittableVariant,
  P extends SplittableProduct<V>,
>(product: P): ColourCard<P>[] {
  const single: ColourCard<P>[] = [
    { key: product.id, product, href: null, colour: null },
  ];
  const parsed = normalizeOptions(product.options);
  const options: ProductOption[] = "options" in parsed ? parsed.options : [];
  const axis = photoAxis(options);
  if (axis < 0 || options[axis].values.length < 2) return single;

  const groups = options[axis].values
    .map((colour) => {
      const variants = product.variants.filter(
        (v) =>
          (v.option_values?.length ?? 0) === options.length &&
          v.option_values?.[axis] === colour,
      );
      const photos =
        variants
          .map((v) => photosForVariant(options, v))
          .find((p) => p.length) ?? [];
      return { colour, variants, photos };
    })
    .filter((g) => g.variants.length > 0);

  if (groups.length < 2 || !groups.some((g) => g.photos.length > 0))
    return single;

  return groups.map(({ colour, variants, photos }) => {
    const lead = variants.find(sellable) ?? variants[0];
    return {
      key: `${product.id}:${colour}`,
      colour,
      href: lead?.id
        ? `/shop/${product.slug}?variant=${encodeURIComponent(lead.id)}`
        : null,
      product: {
        ...product,
        image_url: photos[0] ?? product.image_url,
        // The second photo is the card's hover image; a colour without photos
        // keeps the product's own gallery.
        images: photos.length ? photos.slice(1) : product.images,
        variants,
      },
    };
  });
}
