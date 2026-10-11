// ---------------------------------------------------------------------------
// Exemplar themes — one hand-authored ThemeDefinition per design direction
// (lib/theme-studio/design-directions.ts), written with the full Phase 2
// renderer vocabulary (nested blocks, the 2c sections, the 2d layout
// variants, the 2e templates, the announcement bar) and held to the same
// gates a Studio candidate is: the package contract, the content floors, the
// Studio copy floors, the homepage opening rule and the package acceptance
// gates (lib/themes/exemplars/exemplars.test.ts, scripts/theme-studio-
// exemplar-check.ts). They are the plan's Phase 2 exit evidence: proof the
// vocabulary composes into a whole theme per direction, and a reference for
// what a generated theme of that direction should reach.
//
// ⚠ NOT bundled: they are outside THEME_DEFINITIONS and THEME_META, hidden
// and draft, and never selectable at signup. They reuse the bundled themes'
// imagery and sample catalogues (public/themes/<id>/, already provenance-
// logged in docs/theme-assets.md), so they carry no new assets.
// ---------------------------------------------------------------------------

import type { PageSectionItem, SectionStyle } from "@/lib/sections/registry";
import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import type { DesignDirection } from "@/lib/theme-studio/design-directions";
import type {
  ThemeCatalogSize,
  ThemeFeature,
  ThemeIndustry,
  ThemeMeta,
} from "../meta";
import type { ThemeDefinition, ThemePreset } from "../types";

export type ExemplarCatalogue = NonNullable<ThemePreset["sampleData"]>;

/** The bundled imagery set an exemplar borrows. */
export type ImagerySet = "basket" | "ritual" | "studio" | "vitrine";

/** An exemplar's image path. The package contract holds a bundled theme's
 *  assets to /themes/<its id>/, so each exemplar folder under public/themes/
 *  is a symbolic link to the bundled set it borrows (public/themes/README.md):
 *  the paths are the exemplar's own, the bytes are the bundled theme's. */
export const img = (exemplarId: string, name: string) =>
  `/themes/${exemplarId}/${name}.webp`;

/** A typed section seed: the config is held to the section's own shape, so a
 *  misspelt key is a compile error rather than a dropped value at seed time.
 *  Every section states its band (the Studio's own rule: padding and width
 *  are choices, never defaults); one left unstated takes medium padding in
 *  the contained width. */
export function section<T extends keyof typeof EMPTY_CONFIG>(
  id: string,
  type: T,
  config: (typeof EMPTY_CONFIG)[T],
  style: SectionStyle = { padding_y: "md", width: "contained" },
): PageSectionItem {
  return { id, type, enabled: true, config, style } as PageSectionItem;
}

/** A borrowed sample catalogue, copied so an exemplar may rename a product
 *  without touching the bundled theme it came from, with every picture
 *  re-pointed at the exemplar's own (linked) folder. */
export function catalogueOf(
  theme: ThemeDefinition,
  exemplarId: string,
): ExemplarCatalogue {
  const sample = theme.preset.sampleData;
  if (!sample) throw new Error(`${theme.id} seeds no catalogue`);
  const from = `/themes/${theme.id}/`;
  const to = `/themes/${exemplarId}/`;
  return JSON.parse(
    JSON.stringify(sample).split(from).join(to),
  ) as ExemplarCatalogue;
}

export interface ExemplarMetaInput {
  id: string;
  name: string;
  description: string;
  direction: DesignDirection;
  /** The renderer family the preset's layout implies. */
  engine: "storefront-editorial" | "storefront-grocery";
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  features: ThemeFeature[];
  keywords: string[];
  /** The borrowed catalogue picture that stands in for the catalog card. */
  previewImage: string;
  screenshotAlt: string;
}

/** Catalogue metadata for an exemplar: a hidden draft release, never
 *  selectable, with the demo slug the contract requires. */
export function exemplarMeta(input: ExemplarMetaInput): ThemeMeta {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    engine: { id: input.engine, version: 1 },
    release: {
      version: "0.1.0",
      status: "draft",
      notes: [
        `Hand-authored exemplar for the ${input.direction} design direction (plan Phase 2 exit evidence).`,
        "Reuses bundled theme imagery and sample catalogue; never bundled or selectable.",
      ],
    },
    catalog: {
      visibility: "hidden",
      industries: input.industries,
      catalogSizes: input.catalogSizes,
      features: input.features,
      keywords: [...input.keywords, "exemplar", input.direction],
      previewImage: input.previewImage,
      screenshots: [
        {
          src: input.previewImage,
          viewport: "desktop",
          alt: input.screenshotAlt,
        },
      ],
    },
    demo: {
      slug: `demo-${input.id}`,
      status: "unavailable",
      unavailableReason: "Exemplar theme; no demo store is seeded.",
    },
  };
}

/** The direction an exemplar was written for, read back by the test. */
export const EXEMPLAR_DIRECTION: Record<string, DesignDirection> = {};

export function exemplar(
  meta: ThemeMeta,
  direction: DesignDirection,
  preset: ThemePreset,
): ThemeDefinition {
  EXEMPLAR_DIRECTION[meta.id] = direction;
  return { ...meta, preset };
}
