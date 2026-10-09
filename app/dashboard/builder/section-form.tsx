"use client";

import { ChevronUp, ChevronDown, X, Plus } from "lucide-react";
import { specForRatio } from "@/lib/media/image-specs";
import { ImageUpload } from "@/components/ui/image-upload";
import { VideoUpload } from "@/components/ui/video-upload";
import { NumberField } from "@/components/ui/number-field";
import { CustomCodeFrame } from "@/app/(storefront)/components/sections/custom-code-frame";
import CodeEditor from "./code-editor-lazy";
import { FieldGroup } from "./field-group";
import { BlockList } from "./block-list";
import {
  ACCORDION_BLOCK_TYPES,
  COMPARISON_ROW_TYPES,
  MAX_ACCORDION_ITEMS,
  MAX_COMPARISON_COLUMNS,
  MAX_COMPARISON_ROWS,
  MAX_FAQ_ITEMS,
  MAX_HOTSPOTS,
  MAX_LOGO_ITEMS,
  MAX_MARQUEE_IMAGES,
  MAX_MEDIA_TEXT_STORIES,
  MAX_MULTICOLUMN_ITEMS,
  TILE_SPANS,
  MAX_GALLERY_ITEMS,
  MAX_HERO_SLIDES,
  MAX_TESTIMONIAL_ITEMS,
  MAX_TICKER_MESSAGES,
  MAX_TILES,
  MAX_USP_ITEMS,
  USP_ICONS,
  type AccordionConfig,
  type AccordionItem,
  type AnySectionConfig,
  type BeforeAfterConfig,
  type ComparisonColumn,
  type ComparisonConfig,
  type ComparisonRow,
  type CountdownConfig,
  type CustomCodeConfig,
  type FaqAccordionConfig,
  type FaqItem,
  type FeaturedProductsConfig,
  type GalleryConfig,
  type GalleryItem,
  type HeroCarouselConfig,
  type HeroConfig,
  type HeroHeight,
  type HeroImageOptions,
  type HeroSlide,
  type HomepageSectionType,
  type Hotspot,
  type ImageHotspotsConfig,
  type ImageMarqueeConfig,
  type LatestBlogsConfig,
  type LogoItem,
  type LogoStripConfig,
  type MarqueeImage,
  type MediaTextConfig,
  type MediaTextStory,
  type MulticolumnConfig,
  type MulticolumnItem,
  type NewsletterSectionConfig,
  type ProductSpotlightConfig,
  type PromoBannerConfig,
  type RichTextConfig,
  type ShopByCategoryConfig,
  type TickerConfig,
  type TileGridConfig,
  type TileItem,
  type TileSpan,
  type TestimonialItem,
  type TestimonialsConfig,
  type UspBarConfig,
  type UspItem,
  type VideoConfig,
} from "@/lib/homepage/section-types";

// ---------------------------------------------------------------------------
// Shared section-config forms. One <SectionForm> dispatches to a per-type field
// group; each group is a controlled (config, setConfig) editor with NO server
// calls, so it works both in the homepage editor dialog and in the website
// builder (which persists via its own draft-save action).
// ---------------------------------------------------------------------------

// Option rows for the pickers. Defined here (not imported from a server page)
// so both consumers share one source.
export interface ProductOption {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  featured: boolean;
}
export interface CategoryOption {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
}
export interface BlogOption {
  id: string;
  name: string; // blog title, named `name` to fit the shared OrderedPicker
  slug: string;
}

export const fieldClass =
  "border-input bg-background focus:border-primary placeholder:text-muted-foreground w-full rounded-md border px-3 py-2 text-sm outline-none";
export const labelClass =
  "text-muted-foreground mb-1.5 block text-xs font-medium uppercase tracking-wide";

export function SectionForm({
  type,
  config,
  setConfig,
  products,
  categories,
  blogs,
}: {
  type: HomepageSectionType;
  config: AnySectionConfig;
  setConfig: (c: AnySectionConfig) => void;
  products: ProductOption[];
  categories: CategoryOption[];
  blogs: BlogOption[];
}) {
  switch (type) {
    case "hero":
      return <HeroFields config={config as HeroConfig} setConfig={setConfig} />;
    case "hero_carousel":
      return (
        <CarouselFields
          config={config as HeroCarouselConfig}
          setConfig={setConfig}
        />
      );
    case "usp_bar":
      return (
        <UspBarFields config={config as UspBarConfig} setConfig={setConfig} />
      );
    case "ticker":
      return (
        <TickerFields config={config as TickerConfig} setConfig={setConfig} />
      );
    case "tile_grid":
      return (
        <TileGridFields
          config={config as TileGridConfig}
          setConfig={setConfig}
        />
      );
    case "media_text":
      return (
        <MediaTextFields
          config={config as MediaTextConfig}
          setConfig={setConfig}
        />
      );
    case "gallery":
      return (
        <GalleryFields config={config as GalleryConfig} setConfig={setConfig} />
      );
    case "testimonials":
      return (
        <TestimonialsFields
          config={config as TestimonialsConfig}
          setConfig={setConfig}
        />
      );
    case "video":
      return (
        <VideoFields config={config as VideoConfig} setConfig={setConfig} />
      );
    case "newsletter":
      return (
        <NewsletterFields
          config={config as NewsletterSectionConfig}
          setConfig={setConfig}
        />
      );
    case "faq_accordion":
      return (
        <FaqFields
          config={config as FaqAccordionConfig}
          setConfig={setConfig}
        />
      );
    case "accordion":
      return (
        <AccordionFields
          config={config as AccordionConfig}
          setConfig={setConfig}
        />
      );
    case "comparison":
      return (
        <ComparisonFields
          config={config as ComparisonConfig}
          setConfig={setConfig}
        />
      );
    case "multicolumn":
      return (
        <MulticolumnFields
          config={config as MulticolumnConfig}
          setConfig={setConfig}
        />
      );
    case "image_marquee":
      return (
        <ImageMarqueeFields
          config={config as ImageMarqueeConfig}
          setConfig={setConfig}
        />
      );
    case "image_hotspots":
      return (
        <ImageHotspotsFields
          config={config as ImageHotspotsConfig}
          setConfig={setConfig}
        />
      );
    case "before_after":
      return (
        <BeforeAfterFields
          config={config as BeforeAfterConfig}
          setConfig={setConfig}
        />
      );
    case "product_spotlight":
      return (
        <ProductSpotlightFields
          config={config as ProductSpotlightConfig}
          setConfig={setConfig}
          products={products}
        />
      );
    case "logo_strip":
      return (
        <LogoStripFields
          config={config as LogoStripConfig}
          setConfig={setConfig}
        />
      );
    case "countdown":
      return (
        <CountdownFields
          config={config as CountdownConfig}
          setConfig={setConfig}
        />
      );
    case "featured_products":
      return (
        <FeaturedFields
          config={config as FeaturedProductsConfig}
          setConfig={setConfig}
          products={products}
          categories={categories}
        />
      );
    case "shop_by_category":
      return (
        <CategoryFields
          config={config as ShopByCategoryConfig}
          setConfig={setConfig}
          categories={categories}
        />
      );
    case "promo_banner":
      return (
        <BannerFields
          config={config as PromoBannerConfig}
          setConfig={setConfig}
        />
      );
    case "latest_blogs":
      return (
        <BlogFields
          config={config as LatestBlogsConfig}
          setConfig={setConfig}
          blogs={blogs}
        />
      );
    case "rich_text":
      return (
        <RichTextFields
          config={config as RichTextConfig}
          setConfig={setConfig}
        />
      );
    case "custom_code":
      return (
        <CustomCodeFields
          config={config as CustomCodeConfig}
          setConfig={setConfig}
        />
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// An ordered list of chosen ids with up/down/remove + an "add" dropdown of the
// remaining options. Shared by manual products, selected categories, blogs.
// ---------------------------------------------------------------------------
function OrderedPicker({
  selectedIds,
  options,
  onChange,
  addLabel,
}: {
  selectedIds: string[];
  options: { id: string; name: string }[];
  onChange: (ids: string[]) => void;
  addLabel: string;
}) {
  const byId = new Map(options.map((o) => [o.id, o]));
  const remaining = options.filter((o) => !selectedIds.includes(o.id));

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= selectedIds.length) return;
    const next = [...selectedIds];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {selectedIds.length > 0 && (
        <div className="space-y-1.5">
          {selectedIds.map((id, i) => (
            <div
              key={id}
              className="bg-background flex items-center gap-2 rounded-md border px-2 py-1.5"
            >
              <span className="flex-1 truncate text-sm">
                {byId.get(id)?.name ?? (
                  <span className="text-[var(--dash-red)]">
                    (missing — {id.slice(0, 8)}...)
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title="Move up"
                className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === selectedIds.length - 1}
                title="Move down"
                className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onChange(selectedIds.filter((x) => x !== id))}
                title="Remove"
                className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {remaining.length > 0 && (
        <div className="flex items-center gap-2">
          <Plus className="text-muted-foreground h-3.5 w-3.5" />
          <select
            className={fieldClass}
            value=""
            onChange={(e) => {
              if (e.target.value) onChange([...selectedIds, e.target.value]);
            }}
          >
            <option value="">{addLabel}</option>
            {remaining.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// Strict-colour input: free text (hex/rgb/hsl) + a native picker swatch.
// Invalid values are dropped by validateConfig, so this stays permissive.
function ColorField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const pickable = /^#[0-9a-f]{6}$/i.test(value);
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        className="h-9 w-10 shrink-0 cursor-pointer rounded-md border p-0.5"
        value={pickable ? value : "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Pick a colour"
      />
      <input
        className={fieldClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "#f6e7cf (blank = theme default)"}
      />
    </div>
  );
}

// Video slot: upload a file (signed-URL flow, straight to storage) or paste a
// direct .mp4/.webm URL. Both write the same config field; the storefront
// plays it muted/looping in place of the image.
function VideoField({
  value,
  onChange,
}: {
  value: string;
  onChange: (url: string) => void;
}) {
  return (
    <div className="space-y-2">
      <VideoUpload
        folder="homepage"
        defaultVideo={value || undefined}
        onUploadSuccess={onChange}
      />
      <input
        className={fieldClass}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder="…or paste a YouTube / Vimeo / .mp4 link"
      />
    </div>
  );
}

const USP_ICON_LABELS: Record<(typeof USP_ICONS)[number], string> = {
  star: "Star",
  "badge-check": "Badge check",
  truck: "Truck (delivery)",
  shield: "Shield (protection)",
  leaf: "Leaf (natural)",
  gift: "Gift",
  lock: "Lock (secure)",
  refresh: "Refresh (returns)",
  clock: "Clock (speed)",
  heart: "Heart",
  headphones: "Headphones (support)",
  sparkles: "Sparkles (quality)",
};

function HeroFields({
  config,
  setConfig,
}: {
  config: HeroConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof HeroConfig>(key: K, value: HeroConfig[K]) =>
    setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Layout</label>
            <select
              className={fieldClass}
              value={config.variant}
              onChange={(e) =>
                set("variant", e.target.value as HeroConfig["variant"])
              }
            >
              <option value="fullbleed">
                Full-bleed (photo fills the band, copy on top)
              </option>
              <option value="banner">Banner card (copy + image)</option>
              <option value="split">Split (half copy, half image)</option>
              <option value="minimal">Minimal (centred statement)</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Text alignment</label>
            <select
              className={fieldClass}
              value={config.alignment}
              onChange={(e) =>
                set("alignment", e.target.value as HeroConfig["alignment"])
              }
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
            </select>
          </div>
          <HeightSelect
            value={config.height}
            onChange={(height) => setConfig(withHeight(config, height))}
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Text">
        <div>
          <label className={labelClass}>Headline</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="From farm to your kitchen"
          />
        </div>

        <div>
          <label className={labelClass}>Subheadline</label>
          <textarea
            className={`${fieldClass} min-h-[60px] resize-y`}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="(optional)"
          />
        </div>

        <div>
          <label className={labelClass}>Badge (optional)</label>
          <input
            className={fieldClass}
            value={config.badge_text}
            onChange={(e) => set("badge_text", e.target.value)}
            placeholder="51% off this week"
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Button">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Button label</label>
            <input
              className={fieldClass}
              value={config.cta_label}
              onChange={(e) => set("cta_label", e.target.value)}
              placeholder="Shop now"
            />
          </div>
          <div>
            <label className={labelClass}>Button link</label>
            <input
              className={fieldClass}
              value={config.cta_href}
              onChange={(e) => set("cta_href", e.target.value)}
              placeholder="/shop"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Image & colour">
        <div>
          <label className={labelClass}>Image</label>
          <ImageUpload
            folder="homepage"
            spec={
              config.variant === "minimal" || config.variant === "fullbleed"
                ? "hero_wide"
                : "hero_side"
            }
            defaultImage={config.image_url || undefined}
            onUploadSuccess={(url) => set("image_url", url)}
          />
          <p className="text-muted-foreground mt-1 text-[11px]">
            Banner/split show it beside the copy; full-bleed and minimal use it
            as the band&apos;s background behind the copy.
          </p>
        </div>

        <HeroImageFields
          image={config.image_url}
          value={config}
          overlay={
            config.variant === "minimal" || config.variant === "fullbleed"
          }
          onChange={(patch) => setConfig(withImageOptions(config, patch))}
        />

        <div>
          <label className={labelClass}>Video (optional)</label>
          <VideoField
            value={config.video_url}
            onChange={(url) => set("video_url", url)}
          />
          <p className="text-muted-foreground mt-1 text-[11px]">
            Plays muted on loop in place of the image; the image becomes the
            loading poster.
          </p>
        </div>

        <div>
          <label className={labelClass}>Text theme</label>
          <select
            className={fieldClass}
            value={config.theme}
            onChange={(e) =>
              set("theme", e.target.value as HeroConfig["theme"])
            }
          >
            <option value="dark">Dark text (light background)</option>
            <option value="light">Light text (dark background)</option>
          </select>
        </div>

        <div>
          <label className={labelClass}>Background colour</label>
          <ColorField
            value={config.background}
            onChange={(v) => set("background", v)}
          />
        </div>
      </FieldGroup>
    </>
  );
}

const HEIGHT_OPTIONS: { value: HeroHeight; label: string }[] = [
  { value: "auto", label: "Default" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "screen", label: "Full screen" },
];

function HeightSelect({
  value,
  onChange,
}: {
  value: HeroHeight | undefined;
  onChange: (v: HeroHeight | undefined) => void;
}) {
  return (
    <div>
      <label className={labelClass}>Height</label>
      <select
        className={fieldClass}
        value={value ?? "auto"}
        onChange={(e) => {
          const v = e.target.value as HeroHeight;
          onChange(v === "auto" ? undefined : v);
        }}
      >
        {HEIGHT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The image controls a paid Shopify theme gives a banner: where the subject
 * is (so every crop keeps it), a separate photograph for phones, how strong
 * the overlay behind the copy is, and whether the copy sits high or low.
 * Every control has an explicit "default" that stores nothing.
 */
export function HeroImageFields({
  image,
  value,
  onChange,
  overlay,
}: {
  image: string;
  value: HeroImageOptions;
  onChange: (patch: HeroImageOptions) => void;
  /** Overlay + position only mean something where copy sits on the media. */
  overlay: boolean;
}) {
  const x = value.focal_x ?? 50;
  const y = value.focal_y ?? 50;
  const setFocal = (fx: number, fy: number) => {
    const rx = Math.round(Math.min(100, Math.max(0, fx)));
    const ry = Math.round(Math.min(100, Math.max(0, fy)));
    onChange(
      rx === 50 && ry === 50
        ? { focal_x: undefined, focal_y: undefined }
        : { focal_x: rx, focal_y: ry },
    );
  };
  return (
    <div className="space-y-3">
      {image && (
        <div>
          <label className={labelClass}>Focal point</label>
          <button
            type="button"
            className="relative block w-full overflow-hidden rounded-md border"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setFocal(
                ((e.clientX - box.left) / box.width) * 100,
                ((e.clientY - box.top) / box.height) * 100,
              );
            }}
            aria-label={`Set the focal point (now ${x}% across, ${y}% down)`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- editor preview of an uploaded URL. */}
            <img src={image} alt="" className="block h-auto w-full" />
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
              style={{ left: `${x}%`, top: `${y}%` }}
            />
          </button>
          <p className="text-muted-foreground mt-1 text-[11px]">
            Click the subject. Every crop — wide desktop, tall phone — keeps
            this point in view.{" "}
            {value.focal_x !== undefined && (
              <button
                type="button"
                className="underline"
                onClick={() => setFocal(50, 50)}
              >
                Reset to centre
              </button>
            )}
          </p>
        </div>
      )}

      <div>
        <label className={labelClass}>Phone image (optional)</label>
        <ImageUpload
          folder="homepage"
          spec="hero_phone"
          defaultImage={value.mobile_image_url || undefined}
          onUploadSuccess={(url) =>
            onChange({ mobile_image_url: url || undefined })
          }
        />
        <p className="text-muted-foreground mt-1 text-[11px]">
          A taller photo composed for phones. Phones download only this one.
        </p>
      </div>

      {overlay && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>
              Overlay{" "}
              {value.overlay_opacity !== undefined
                ? `${value.overlay_opacity}%`
                : "(default)"}
            </label>
            <input
              type="range"
              min={0}
              max={80}
              step={5}
              className="w-full"
              value={value.overlay_opacity ?? 0}
              onChange={(e) =>
                onChange({ overlay_opacity: Number(e.target.value) })
              }
            />
            {value.overlay_opacity !== undefined && (
              <button
                type="button"
                className="text-muted-foreground text-[11px] underline"
                onClick={() => onChange({ overlay_opacity: undefined })}
              >
                Use default
              </button>
            )}
          </div>
          <div>
            <label className={labelClass}>Text position</label>
            <select
              className={fieldClass}
              value={value.content_position ?? "middle"}
              onChange={(e) => {
                const v = e.target.value;
                onChange({
                  content_position:
                    v === "top" || v === "bottom" ? v : undefined,
                });
              }}
            >
              <option value="top">Top</option>
              <option value="middle">Middle</option>
              <option value="bottom">Bottom</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

/** Merge a patch, dropping keys set back to their default (undefined) so
 *  the stored config stays exactly what an untouched hero always stored. */
function withImageOptions<T extends HeroImageOptions>(
  base: T,
  patch: HeroImageOptions,
): T {
  const next = { ...base, ...patch } as T & Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if ((patch as Record<string, unknown>)[key] === undefined) delete next[key];
  }
  return next;
}

/** Set or clear (back to the default) a hero/carousel height preset. */
function withHeight<T extends { height?: HeroHeight }>(
  base: T,
  height: HeroHeight | undefined,
): T {
  const next = { ...base };
  if (height) next.height = height;
  else delete next.height;
  return next;
}

const EMPTY_SLIDE: HeroSlide = {
  heading: "",
  subheading: "",
  cta_label: "",
  cta_href: "",
  image_url: "",
  video_url: "",
  background: "",
  theme: "dark",
};

function CarouselFields({
  config,
  setConfig,
}: {
  config: HeroCarouselConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof HeroCarouselConfig>(
    key: K,
    value: HeroCarouselConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const setSlide = (i: number, patch: Partial<HeroSlide>) =>
    set(
      "slides",
      config.slides.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    );
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= config.slides.length) return;
    const next = [...config.slides];
    [next[i], next[target]] = [next[target], next[i]];
    set("slides", next);
  };

  return (
    <>
      <FieldGroup title="Playback">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.autoplay}
            onChange={(e) => set("autoplay", e.target.checked)}
          />
          Auto-play slides
        </label>
        <div>
          <label className={labelClass}>Seconds per slide</label>
          <select
            className={fieldClass}
            value={config.interval_seconds}
            onChange={(e) => set("interval_seconds", Number(e.target.value))}
            disabled={!config.autoplay}
          >
            {[2, 3, 5, 8, 10, 15].map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </div>
        <HeightSelect
          value={config.height}
          onChange={(height) => setConfig(withHeight(config, height))}
        />
      </FieldGroup>

      <div className="space-y-2">
        <label className={labelClass}>Slides</label>
        {config.slides.map((slide, i) => (
          <div
            key={i}
            className="bg-background space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium">
                Slide {i + 1}
              </span>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === config.slides.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "slides",
                      config.slides.filter((_, j) => j !== i),
                    )
                  }
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <input
              className={fieldClass}
              value={slide.heading}
              onChange={(e) => setSlide(i, { heading: e.target.value })}
              placeholder="Fresh deals every week"
            />
            <input
              className={fieldClass}
              value={slide.subheading}
              onChange={(e) => setSlide(i, { subheading: e.target.value })}
              placeholder="Subheading (optional)"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={slide.cta_label}
                onChange={(e) => setSlide(i, { cta_label: e.target.value })}
                placeholder="Shop now"
              />
              <input
                className={fieldClass}
                value={slide.cta_href}
                onChange={(e) => setSlide(i, { cta_href: e.target.value })}
                placeholder="/shop"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                className={fieldClass}
                value={slide.theme}
                onChange={(e) =>
                  setSlide(i, { theme: e.target.value as HeroSlide["theme"] })
                }
              >
                <option value="dark">Dark text</option>
                <option value="light">Light text (adds a scrim)</option>
              </select>
              <ColorField
                value={slide.background}
                onChange={(v) => setSlide(i, { background: v })}
              />
            </div>
            <ImageUpload
              folder="homepage"
              spec="hero_wide"
              defaultImage={slide.image_url || undefined}
              onUploadSuccess={(url) => setSlide(i, { image_url: url })}
            />
            <HeroImageFields
              image={slide.image_url}
              value={slide}
              overlay
              onChange={(patch) =>
                set(
                  "slides",
                  config.slides.map((s, j) =>
                    j === i ? withImageOptions(s, patch) : s,
                  ),
                )
              }
            />
            <VideoField
              value={slide.video_url}
              onChange={(url) => setSlide(i, { video_url: url })}
            />
          </div>
        ))}
        {config.slides.length < MAX_HERO_SLIDES && (
          <button
            type="button"
            onClick={() =>
              set("slides", [...config.slides, { ...EMPTY_SLIDE }])
            }
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add slide
          </button>
        )}
      </div>
    </>
  );
}

function UspBarFields({
  config,
  setConfig,
}: {
  config: UspBarConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const setItems = (items: UspItem[]) => setConfig({ ...config, items });

  return (
    <>
      <div>
        <label className={labelClass}>Text theme</label>
        <select
          className={fieldClass}
          value={config.theme}
          onChange={(e) =>
            setConfig({
              ...config,
              theme: e.target.value as UspBarConfig["theme"],
            })
          }
        >
          <option value="dark">Dark text (light background)</option>
          <option value="light">Light text (dark background)</option>
        </select>
        <p className="text-muted-foreground mt-1 text-[11px]">
          For a dark strip, set a dark background in the Style tab and pick
          light text here.
        </p>
      </div>

      <BlockList
        label="Items"
        itemLabel="Item"
        items={config.items}
        max={MAX_USP_ITEMS}
        newItem={(): UspItem => ({ icon: "star", title: "", subtitle: "" })}
        onChange={setItems}
        title={(item) => item.title || USP_ICON_LABELS[item.icon]}
      >
        {(item, _index, setItem) => (
          <>
            <select
              className={`${fieldClass} max-w-[180px]`}
              value={item.icon}
              onChange={(e) =>
                setItem({ icon: e.target.value as UspItem["icon"] })
              }
            >
              {USP_ICONS.map((icon) => (
                <option key={icon} value={icon}>
                  {USP_ICON_LABELS[icon]}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={item.title}
                onChange={(e) => setItem({ title: e.target.value })}
                placeholder="Free delivery"
              />
              <input
                className={fieldClass}
                value={item.subtitle}
                onChange={(e) => setItem({ subtitle: e.target.value })}
                placeholder="On orders over ₹499 (optional)"
              />
            </div>
          </>
        )}
      </BlockList>
    </>
  );
}

function TickerFields({
  config,
  setConfig,
}: {
  config: TickerConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const setMessages = (messages: string[]) =>
    setConfig({ ...config, messages });
  const setMessage = (i: number, value: string) =>
    setMessages(config.messages.map((m, j) => (j === i ? value : m)));
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= config.messages.length) return;
    const next = [...config.messages];
    [next[i], next[target]] = [next[target], next[i]];
    setMessages(next);
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Speed</label>
          <select
            className={fieldClass}
            value={config.speed}
            onChange={(e) =>
              setConfig({
                ...config,
                speed: e.target.value as TickerConfig["speed"],
              })
            }
          >
            <option value="slow">Slow</option>
            <option value="medium">Medium</option>
            <option value="fast">Fast</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Text theme</label>
          <select
            className={fieldClass}
            value={config.theme}
            onChange={(e) =>
              setConfig({
                ...config,
                theme: e.target.value as TickerConfig["theme"],
              })
            }
          >
            <option value="dark">Dark text (light background)</option>
            <option value="light">Light text (dark background)</option>
          </select>
        </div>
      </div>
      <p className="text-muted-foreground -mt-1 text-[11px]">
        For a dark strip, set a dark background in the Style tab and pick light
        text here.
      </p>

      <div className="space-y-2">
        <label className={labelClass}>Messages</label>
        {config.messages.map((message, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={fieldClass}
              value={message}
              onChange={(e) => setMessage(i, e.target.value)}
              placeholder="Free shipping over ₹499"
              maxLength={120}
            />
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title="Move up"
                className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === config.messages.length - 1}
                title="Move down"
                className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() =>
                  setMessages(config.messages.filter((_, j) => j !== i))
                }
                title="Remove"
                className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
        {config.messages.length < MAX_TICKER_MESSAGES && (
          <button
            type="button"
            onClick={() => setMessages([...config.messages, ""])}
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add message
          </button>
        )}
      </div>
    </>
  );
}

function TileGridFields({
  config,
  setConfig,
}: {
  config: TileGridConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof TileGridConfig>(
    key: K,
    value: TileGridConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Header & layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="Top offers this week"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Columns (desktop)</label>
            <select
              className={fieldClass}
              value={config.columns}
              onChange={(e) =>
                set(
                  "columns",
                  Number(e.target.value) as TileGridConfig["columns"],
                )
              }
            >
              <option value={2}>2 — mini banners</option>
              <option value={3}>3</option>
              <option value={4}>4 — offer tiles</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Tile height</label>
            <select
              className={fieldClass}
              value={config.height}
              onChange={(e) =>
                set("height", e.target.value as TileGridConfig["height"])
              }
            >
              <option value="sm">Short</option>
              <option value="md">Medium</option>
              <option value="lg">Tall</option>
            </select>
          </div>
        </div>
        <div>
          <label className={labelClass}>Arrangement</label>
          <select
            className={fieldClass}
            value={config.layout ?? "grid"}
            onChange={(e) => {
              // The even grid is the default and is not stored.
              const next: TileGridConfig = { ...config };
              if (e.target.value === "collage") next.layout = "collage";
              else delete next.layout;
              setConfig(next);
            }}
          >
            <option value="grid">Even grid</option>
            <option value="collage">Collage — tiles can span cells</option>
          </select>
        </div>
      </FieldGroup>

      <BlockList
        label="Tiles"
        itemLabel="Tile"
        items={config.tiles}
        max={MAX_TILES}
        newItem={(): TileItem => ({
          title: "",
          subtitle: "",
          href: "",
          image_url: "",
          background: "",
          theme: "dark",
        })}
        onChange={(tiles) => set("tiles", tiles)}
        title={(tile) => tile.title}
      >
        {(tile, _index, setTile) => (
          <>
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={tile.title}
                onChange={(e) => setTile({ title: e.target.value })}
                placeholder="Fresh produce"
              />
              <input
                className={fieldClass}
                value={tile.subtitle}
                onChange={(e) => setTile({ subtitle: e.target.value })}
                placeholder="from ₹19 (optional)"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={tile.href}
                onChange={(e) => setTile({ href: e.target.value })}
                placeholder="/collections/fruits"
              />
              <select
                className={fieldClass}
                value={tile.theme}
                onChange={(e) =>
                  setTile({ theme: e.target.value as TileItem["theme"] })
                }
              >
                <option value="dark">Dark text</option>
                <option value="light">Light text</option>
              </select>
            </div>
            {config.layout === "collage" && (
              <div>
                <label className={labelClass}>Cells this tile covers</label>
                <select
                  className={fieldClass}
                  value={tile.span ?? "1x1"}
                  onChange={(e) => {
                    const span = e.target.value as TileSpan;
                    const next: TileItem = { ...tile };
                    if (span === "1x1") delete next.span;
                    else next.span = span;
                    setTile(next);
                  }}
                >
                  {TILE_SPANS.map((span) => (
                    <option key={span} value={span}>
                      {TILE_SPAN_LABELS[span]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <ColorField
              value={tile.background}
              onChange={(v) => setTile({ background: v })}
            />
            <ImageUpload
              folder="homepage"
              spec="landscape"
              defaultImage={tile.image_url || undefined}
              onUploadSuccess={(url) => setTile({ image_url: url })}
            />
          </>
        )}
      </BlockList>
    </>
  );
}

function FaqFields({
  config,
  setConfig,
}: {
  config: FaqAccordionConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof FaqAccordionConfig>(
    key: K,
    value: FaqAccordionConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const setItem = (i: number, patch: Partial<FaqItem>) =>
    set(
      "items",
      config.items.map((it, j) => (j === i ? { ...it, ...patch } : it)),
    );
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= config.items.length) return;
    const next = [...config.items];
    [next[i], next[target]] = [next[target], next[i]];
    set("items", next);
  };

  return (
    <>
      <FieldGroup title="Header">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="Frequently asked questions"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.show_filters}
            onChange={(e) => set("show_filters", e.target.checked)}
          />
          Show category filter pills
        </label>
      </FieldGroup>

      <div className="space-y-2">
        <label className={labelClass}>Questions</label>
        {config.items.map((item, i) => (
          <div
            key={i}
            className="bg-background space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium">
                Q{i + 1}
              </span>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === config.items.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "items",
                      config.items.filter((_, j) => j !== i),
                    )
                  }
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <input
              className={fieldClass}
              value={item.question}
              onChange={(e) => setItem(i, { question: e.target.value })}
              placeholder="How fresh is the produce?"
            />
            <textarea
              className={`${fieldClass} min-h-[70px] resize-y`}
              value={item.answer}
              onChange={(e) => setItem(i, { answer: e.target.value })}
              placeholder="Answer…"
            />
            {config.show_filters && (
              <input
                className={fieldClass}
                value={item.category}
                onChange={(e) => setItem(i, { category: e.target.value })}
                placeholder="Filter group (e.g. Delivery)"
              />
            )}
          </div>
        ))}
        {config.items.length < MAX_FAQ_ITEMS && (
          <button
            type="button"
            onClick={() =>
              set("items", [
                ...config.items,
                { question: "", answer: "", category: "" },
              ])
            }
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add question
          </button>
        )}
      </div>
    </>
  );
}

function MediaTextFields({
  config,
  setConfig,
}: {
  config: MediaTextConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof MediaTextConfig>(
    key: K,
    value: MediaTextConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const stories = config.stories ?? [];
  // Omitted when empty, so a section saved before stories existed keeps its
  // stored shape (the validator does the same on save).
  const setStories = (next: MediaTextStory[]) => {
    const rest: MediaTextConfig = { ...config };
    delete rest.stories;
    setConfig(next.length ? { ...rest, stories: next } : rest);
  };

  return (
    <>
      <FieldGroup title="Story">
        <div>
          <label className={labelClass}>Eyebrow</label>
          <input
            className={fieldClass}
            value={config.eyebrow}
            onChange={(e) => set("eyebrow", e.target.value)}
            placeholder="Our story"
          />
        </div>
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="Made with intention"
          />
        </div>
        <div>
          <label className={labelClass}>Body</label>
          <textarea
            className={`${fieldClass} min-h-[120px] resize-y`}
            value={config.body}
            onChange={(e) => set("body", e.target.value)}
            placeholder="Tell the story behind your materials, process or people."
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Image">
        <ImageUpload
          folder="homepage"
          spec={specForRatio(config.media_ratio)}
          defaultImage={config.image_url || undefined}
          onUploadSuccess={(url) => set("image_url", url)}
        />
        <div>
          <label className={labelClass}>Image description</label>
          <input
            className={fieldClass}
            value={config.image_alt}
            onChange={(e) => set("image_alt", e.target.value)}
            placeholder="Describe the image for screen readers"
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Layout">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Image position</label>
            <select
              className={fieldClass}
              value={config.media_position}
              onChange={(e) =>
                set(
                  "media_position",
                  e.target.value as MediaTextConfig["media_position"],
                )
              }
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Image shape</label>
            <select
              className={fieldClass}
              value={config.media_ratio}
              onChange={(e) =>
                set(
                  "media_ratio",
                  e.target.value as MediaTextConfig["media_ratio"],
                )
              }
            >
              <option value="portrait">Portrait</option>
              <option value="square">Square</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Text alignment</label>
            <select
              className={fieldClass}
              value={config.alignment}
              onChange={(e) =>
                set("alignment", e.target.value as MediaTextConfig["alignment"])
              }
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
            </select>
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Button">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Button label</label>
            <input
              className={fieldClass}
              value={config.cta_label}
              onChange={(e) => set("cta_label", e.target.value)}
              placeholder="Discover more"
            />
          </div>
          <div>
            <label className={labelClass}>Button link</label>
            <input
              className={fieldClass}
              value={config.cta_href}
              onChange={(e) => set("cta_href", e.target.value)}
              placeholder="/our-story"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="More stories" defaultOpen={stories.length > 0}>
        <p className="text-muted-foreground text-[11px]">
          Further image-and-copy bands under this one — a process told in three
          beats, an ingredient per band. Each story chooses its own image side;
          the shape and alignment above apply to all of them.
        </p>
        <BlockList
          label="Stories"
          itemLabel="Story"
          items={stories}
          max={MAX_MEDIA_TEXT_STORIES}
          newItem={(): MediaTextStory => ({
            ...EMPTY_STORY,
            // Alternate sides by default, the way an editorial page reads.
            media_position:
              (stories.length ? stories[stories.length - 1] : config)
                .media_position === "left"
                ? "right"
                : "left",
          })}
          onChange={setStories}
          title={(story) => story.heading}
        >
          {(story, _index, setStory) => (
            <>
              <input
                className={fieldClass}
                value={story.eyebrow}
                onChange={(e) => setStory({ eyebrow: e.target.value })}
                placeholder="Eyebrow (optional)"
              />
              <input
                className={fieldClass}
                value={story.heading}
                onChange={(e) => setStory({ heading: e.target.value })}
                placeholder="Heading"
              />
              <textarea
                className={`${fieldClass} min-h-[88px] resize-y`}
                value={story.body}
                onChange={(e) => setStory({ body: e.target.value })}
                placeholder="The story behind this step."
              />
              <ImageUpload
                folder="homepage"
                spec={specForRatio(config.media_ratio)}
                defaultImage={story.image_url || undefined}
                onUploadSuccess={(url) => setStory({ image_url: url })}
              />
              <input
                className={fieldClass}
                value={story.image_alt}
                onChange={(e) => setStory({ image_alt: e.target.value })}
                placeholder="Describe the image for screen readers"
              />
              <div className="grid grid-cols-3 gap-2">
                <select
                  className={fieldClass}
                  value={story.media_position}
                  onChange={(e) =>
                    setStory({
                      media_position: e.target
                        .value as MediaTextStory["media_position"],
                    })
                  }
                >
                  <option value="left">Image left</option>
                  <option value="right">Image right</option>
                </select>
                <input
                  className={fieldClass}
                  value={story.cta_label}
                  onChange={(e) => setStory({ cta_label: e.target.value })}
                  placeholder="Button label"
                />
                <input
                  className={fieldClass}
                  value={story.cta_href}
                  onChange={(e) => setStory({ cta_href: e.target.value })}
                  placeholder="/shop"
                />
              </div>
            </>
          )}
        </BlockList>
      </FieldGroup>
    </>
  );
}

const EMPTY_STORY: MediaTextStory = {
  eyebrow: "",
  heading: "",
  body: "",
  cta_label: "",
  cta_href: "",
  image_url: "",
  image_alt: "",
  media_position: "right",
};

const EMPTY_ACCORDION_ITEM: AccordionItem = {
  type: "text",
  heading: "",
  body: "",
  image_url: "",
  image_alt: "",
};

const ACCORDION_BLOCK_LABELS: Record<
  (typeof ACCORDION_BLOCK_TYPES)[number],
  string
> = {
  text: "Text",
  image: "Text with image",
};

function AccordionFields({
  config,
  setConfig,
}: {
  config: AccordionConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof AccordionConfig>(
    key: K,
    value: AccordionConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Header">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="Good to know"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.open_first}
            onChange={(e) => set("open_first", e.target.checked)}
          />
          Start with the first row open
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.allow_multiple}
            onChange={(e) => set("allow_multiple", e.target.checked)}
          />
          Let several rows stay open at once
        </label>
      </FieldGroup>

      <BlockList
        label="Rows"
        itemLabel="Row"
        items={config.items}
        max={MAX_ACCORDION_ITEMS}
        newItem={() => ({ ...EMPTY_ACCORDION_ITEM })}
        onChange={(items) => set("items", items)}
        title={(item) => item.heading}
      >
        {(item, _index, setItem) => (
          <>
            <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-2">
              <select
                className={fieldClass}
                value={item.type}
                onChange={(e) =>
                  setItem({ type: e.target.value as AccordionItem["type"] })
                }
              >
                {ACCORDION_BLOCK_TYPES.map((blockType) => (
                  <option key={blockType} value={blockType}>
                    {ACCORDION_BLOCK_LABELS[blockType]}
                  </option>
                ))}
              </select>
              <input
                className={fieldClass}
                value={item.heading}
                onChange={(e) => setItem({ heading: e.target.value })}
                placeholder="Shipping and returns"
              />
            </div>
            <textarea
              className={`${fieldClass} min-h-[70px] resize-y`}
              value={item.body}
              onChange={(e) => setItem({ body: e.target.value })}
              placeholder="What a shopper finds when they open this row."
            />
            {item.type === "image" && (
              <div>
                <label className={labelClass}>Picture in the open row</label>
                <ImageUpload
                  folder="homepage"
                  spec="landscape"
                  defaultImage={item.image_url || undefined}
                  onUploadSuccess={(url) => setItem({ image_url: url })}
                />
                <input
                  className={`${fieldClass} mt-2`}
                  value={item.image_alt}
                  onChange={(e) => setItem({ image_alt: e.target.value })}
                  placeholder="Describe the image for screen readers"
                />
              </div>
            )}
          </>
        )}
      </BlockList>
    </>
  );
}

const EMPTY_COLUMN: ComparisonColumn = {
  label: "",
  caption: "",
  cta_label: "",
  cta_href: "",
  highlight: false,
};

const COMPARISON_ROW_LABELS: Record<
  (typeof COMPARISON_ROW_TYPES)[number],
  string
> = {
  text: "Text per column",
  check: "Yes / no per column",
};

function ComparisonFields({
  config,
  setConfig,
}: {
  config: ComparisonConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof ComparisonConfig>(
    key: K,
    value: ComparisonConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const setValue = (
    row: ComparisonRow,
    setRow: (patch: Partial<ComparisonRow>) => void,
    column: number,
    value: string,
  ) =>
    setRow({
      values: config.columns.map((_, j) =>
        j === column ? value : (row.values[j] ?? ""),
      ),
    });

  return (
    <>
      <FieldGroup title="Header & layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="Which one is for you?"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>
        <div>
          <label className={labelClass}>Style</label>
          <select
            className={fieldClass}
            value={config.style}
            onChange={(e) =>
              set("style", e.target.value as ComparisonConfig["style"])
            }
          >
            <option value="table">Table — rows and columns</option>
            <option value="cards">Cards — one card per column</option>
          </select>
        </div>
      </FieldGroup>

      <BlockList
        label="Columns"
        itemLabel="Column"
        items={config.columns}
        max={MAX_COMPARISON_COLUMNS}
        newItem={() => ({ ...EMPTY_COLUMN })}
        onChange={(columns) => set("columns", columns)}
        title={(column) => column.label}
      >
        {(column, index, setColumn) => (
          <>
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={column.label}
                onChange={(e) => setColumn({ label: e.target.value })}
                placeholder="Starter"
              />
              <input
                className={fieldClass}
                value={column.caption}
                onChange={(e) => setColumn({ caption: e.target.value })}
                placeholder="For one (optional)"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={column.cta_label}
                onChange={(e) => setColumn({ cta_label: e.target.value })}
                placeholder="Button label (optional)"
              />
              <input
                className={fieldClass}
                value={column.cta_href}
                onChange={(e) => setColumn({ cta_href: e.target.value })}
                placeholder="/shop/starter-set"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={column.highlight}
                onChange={(e) =>
                  set(
                    "columns",
                    config.columns.map((c, j) => ({
                      ...c,
                      // At most one recommended column.
                      highlight: j === index ? e.target.checked : false,
                    })),
                  )
                }
              />
              Recommended column
            </label>
          </>
        )}
      </BlockList>

      <BlockList
        label="Rows"
        itemLabel="Row"
        items={config.rows}
        max={MAX_COMPARISON_ROWS}
        newItem={(): ComparisonRow => ({
          type: "text",
          label: "",
          values: config.columns.map(() => ""),
        })}
        onChange={(rows) => set("rows", rows)}
        title={(row) => row.label}
      >
        {(row, _index, setRow) => (
          <>
            <div className="grid grid-cols-[170px_minmax(0,1fr)] gap-2">
              <select
                className={fieldClass}
                value={row.type}
                onChange={(e) =>
                  setRow({ type: e.target.value as ComparisonRow["type"] })
                }
              >
                {COMPARISON_ROW_TYPES.map((rowType) => (
                  <option key={rowType} value={rowType}>
                    {COMPARISON_ROW_LABELS[rowType]}
                  </option>
                ))}
              </select>
              <input
                className={fieldClass}
                value={row.label}
                onChange={(e) => setRow({ label: e.target.value })}
                placeholder="Feature"
              />
            </div>
            {config.columns.length === 0 ? (
              <p className="text-muted-foreground text-[11px]">
                Add columns above to fill in this row.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {config.columns.map((column, j) => (
                  <label key={j} className="block">
                    <span className="text-muted-foreground mb-1 block text-[11px]">
                      {column.label || `Column ${j + 1}`}
                    </span>
                    {row.type === "check" ? (
                      <select
                        className={fieldClass}
                        value={row.values[j] ?? ""}
                        onChange={(e) =>
                          setValue(row, setRow, j, e.target.value)
                        }
                      >
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                        <option value="">Not applicable</option>
                      </select>
                    ) : (
                      <input
                        className={fieldClass}
                        value={row.values[j] ?? ""}
                        onChange={(e) =>
                          setValue(row, setRow, j, e.target.value)
                        }
                        placeholder="Value"
                      />
                    )}
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </BlockList>
    </>
  );
}

const TILE_SPAN_LABELS: Record<TileSpan, string> = {
  "1x1": "One cell",
  "2x1": "Two across",
  "1x2": "Two down",
  "2x2": "Two by two",
};

const EMPTY_COLUMN_ITEM: MulticolumnItem = {
  icon: "",
  image_url: "",
  image_alt: "",
  heading: "",
  body: "",
  cta_label: "",
  cta_href: "",
};

function MulticolumnFields({
  config,
  setConfig,
}: {
  config: MulticolumnConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof MulticolumnConfig>(
    key: K,
    value: MulticolumnConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Header">
        <input
          className={fieldClass}
          value={config.eyebrow}
          onChange={(e) => set("eyebrow", e.target.value)}
          placeholder="Eyebrow (optional)"
        />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="Why shop with us"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Layout">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Columns</label>
            <select
              className={fieldClass}
              value={config.columns}
              onChange={(e) =>
                set(
                  "columns",
                  Number(e.target.value) as MulticolumnConfig["columns"],
                )
              }
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Alignment</label>
            <select
              className={fieldClass}
              value={config.alignment}
              onChange={(e) =>
                set(
                  "alignment",
                  e.target.value as MulticolumnConfig["alignment"],
                )
              }
            >
              <option value="center">Centred</option>
              <option value="left">Left</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Picture shape</label>
            <select
              className={fieldClass}
              value={config.image_ratio}
              onChange={(e) =>
                set(
                  "image_ratio",
                  e.target.value as MulticolumnConfig["image_ratio"],
                )
              }
            >
              <option value="landscape">Landscape</option>
              <option value="square">Square</option>
              <option value="portrait">Portrait</option>
            </select>
          </div>
        </div>
      </FieldGroup>

      <BlockList
        label="Columns"
        itemLabel="Column"
        items={config.items}
        max={MAX_MULTICOLUMN_ITEMS}
        newItem={(): MulticolumnItem => ({ ...EMPTY_COLUMN_ITEM })}
        onChange={(items) => set("items", items)}
        title={(item) => item.heading}
      >
        {(item, _index, setItem) => (
          <>
            <input
              className={fieldClass}
              value={item.heading}
              onChange={(e) => setItem({ heading: e.target.value })}
              placeholder="Heading"
            />
            <textarea
              className={`${fieldClass} min-h-[70px] resize-y`}
              value={item.body}
              onChange={(e) => setItem({ body: e.target.value })}
              placeholder="A sentence or two."
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                className={fieldClass}
                value={item.icon}
                onChange={(e) =>
                  setItem({ icon: e.target.value as MulticolumnItem["icon"] })
                }
              >
                <option value="">No icon</option>
                {USP_ICONS.map((icon) => (
                  <option key={icon} value={icon}>
                    {USP_ICON_LABELS[icon]}
                  </option>
                ))}
              </select>
              <input
                className={fieldClass}
                value={item.cta_label}
                onChange={(e) => setItem({ cta_label: e.target.value })}
                placeholder="Link label (optional)"
              />
            </div>
            <input
              className={fieldClass}
              value={item.cta_href}
              onChange={(e) => setItem({ cta_href: e.target.value })}
              placeholder="/shop (link destination)"
            />
            <div>
              <label className={labelClass}>
                Picture (optional — replaces the icon)
              </label>
              <ImageUpload
                folder="homepage"
                spec={specForRatio(config.image_ratio)}
                defaultImage={item.image_url || undefined}
                onUploadSuccess={(url) => setItem({ image_url: url })}
              />
              <input
                className={`${fieldClass} mt-2`}
                value={item.image_alt}
                onChange={(e) => setItem({ image_alt: e.target.value })}
                placeholder="Describe the picture for screen readers"
              />
            </div>
          </>
        )}
      </BlockList>
    </>
  );
}

function ImageMarqueeFields({
  config,
  setConfig,
}: {
  config: ImageMarqueeConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof ImageMarqueeConfig>(
    key: K,
    value: ImageMarqueeConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Motion & size">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Speed</label>
            <select
              className={fieldClass}
              value={config.speed}
              onChange={(e) =>
                set("speed", e.target.value as ImageMarqueeConfig["speed"])
              }
            >
              <option value="slow">Slow</option>
              <option value="medium">Medium</option>
              <option value="fast">Fast</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Height</label>
            <select
              className={fieldClass}
              value={config.size}
              onChange={(e) =>
                set("size", e.target.value as ImageMarqueeConfig["size"])
              }
            >
              <option value="sm">Short</option>
              <option value="md">Medium</option>
              <option value="lg">Tall</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Picture shape</label>
            <select
              className={fieldClass}
              value={config.image_ratio}
              onChange={(e) =>
                set(
                  "image_ratio",
                  e.target.value as ImageMarqueeConfig["image_ratio"],
                )
              }
            >
              <option value="square">Square</option>
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
            </select>
          </div>
        </div>
        <p className="text-muted-foreground text-[11px]">
          The row pauses while a shopper hovers it and stays still for anyone
          who has turned on reduced motion.
        </p>
      </FieldGroup>

      <BlockList
        label="Pictures"
        itemLabel="Picture"
        items={config.items}
        max={MAX_MARQUEE_IMAGES}
        newItem={(): MarqueeImage => ({
          image_url: "",
          image_alt: "",
          href: "",
        })}
        onChange={(items) => set("items", items)}
        title={(item) => item.image_alt}
      >
        {(item, _index, setItem) => (
          <>
            <ImageUpload
              folder="homepage"
              spec={specForRatio(config.image_ratio)}
              defaultImage={item.image_url || undefined}
              onUploadSuccess={(url) => setItem({ image_url: url })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={item.image_alt}
                onChange={(e) => setItem({ image_alt: e.target.value })}
                placeholder="Describe the picture"
              />
              <input
                className={fieldClass}
                value={item.href}
                onChange={(e) => setItem({ href: e.target.value })}
                placeholder="/shop (optional link)"
              />
            </div>
          </>
        )}
      </BlockList>
    </>
  );
}

function ImageHotspotsFields({
  config,
  setConfig,
}: {
  config: ImageHotspotsConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof ImageHotspotsConfig>(
    key: K,
    value: ImageHotspotsConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const clampPercent = (value: string) =>
    Math.min(100, Math.max(0, Math.round(Number(value) || 0)));

  return (
    <>
      <FieldGroup title="Header">
        <input
          className={fieldClass}
          value={config.eyebrow}
          onChange={(e) => set("eyebrow", e.target.value)}
          placeholder="Eyebrow (optional)"
        />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="Shop the look"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Picture">
        <div>
          <label className={labelClass}>Shape</label>
          <select
            className={fieldClass}
            value={config.image_ratio}
            onChange={(e) =>
              set(
                "image_ratio",
                e.target.value as ImageHotspotsConfig["image_ratio"],
              )
            }
          >
            <option value="landscape">Landscape</option>
            <option value="square">Square</option>
            <option value="portrait">Portrait</option>
          </select>
        </div>
        <ImageUpload
          folder="homepage"
          spec={specForRatio(config.image_ratio)}
          defaultImage={config.image_url || undefined}
          onUploadSuccess={(url) => set("image_url", url)}
        />
        <input
          className={fieldClass}
          value={config.image_alt}
          onChange={(e) => set("image_alt", e.target.value)}
          placeholder="Describe the picture for screen readers"
        />
        {config.image_url && config.hotspots.length > 0 && (
          <div
            className="relative overflow-hidden rounded-md border"
            aria-hidden
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={config.image_url}
              alt=""
              className="block h-auto w-full"
            />
            {config.hotspots.map((spot, i) => (
              <span
                key={i}
                className="bg-background text-foreground absolute top-0 left-0 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[11px] font-semibold shadow"
                style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
              >
                {i + 1}
              </span>
            ))}
          </div>
        )}
      </FieldGroup>

      <BlockList
        label="Hotspots"
        itemLabel="Hotspot"
        items={config.hotspots}
        max={MAX_HOTSPOTS}
        newItem={(): Hotspot => ({
          x: 50,
          y: 50,
          title: "",
          body: "",
          href: "",
          cta_label: "",
        })}
        onChange={(hotspots) => set("hotspots", hotspots)}
        title={(spot, index) => spot.title || `Dot ${index + 1}`}
      >
        {(spot, _index, setSpot) => (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-muted-foreground mb-1 block text-[11px]">
                  From the left (%)
                </span>
                <NumberField
                  className={fieldClass}
                  value={spot.x}
                  allowDecimal={false}
                  onValueChange={(n) => setSpot({ x: clampPercent(String(n)) })}
                />
              </label>
              <label className="block">
                <span className="text-muted-foreground mb-1 block text-[11px]">
                  From the top (%)
                </span>
                <NumberField
                  className={fieldClass}
                  value={spot.y}
                  allowDecimal={false}
                  onValueChange={(n) => setSpot({ y: clampPercent(String(n)) })}
                />
              </label>
            </div>
            <input
              className={fieldClass}
              value={spot.title}
              onChange={(e) => setSpot({ title: e.target.value })}
              placeholder="What is here"
            />
            <textarea
              className={`${fieldClass} min-h-[60px] resize-y`}
              value={spot.body}
              onChange={(e) => setSpot({ body: e.target.value })}
              placeholder="A line about it (optional)"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={spot.href}
                onChange={(e) => setSpot({ href: e.target.value })}
                placeholder="/shop/the-product (link)"
              />
              <input
                className={fieldClass}
                value={spot.cta_label}
                onChange={(e) => setSpot({ cta_label: e.target.value })}
                placeholder="Link label (default: Shop)"
              />
            </div>
          </>
        )}
      </BlockList>
    </>
  );
}

function BeforeAfterFields({
  config,
  setConfig,
}: {
  config: BeforeAfterConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof BeforeAfterConfig>(
    key: K,
    value: BeforeAfterConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const side = (key: "before" | "after", placeholder: string) => (
    <FieldGroup title={key === "before" ? "Before" : "After"}>
      <ImageUpload
        folder="homepage"
        spec={specForRatio(config.image_ratio)}
        defaultImage={config[key].image_url || undefined}
        onUploadSuccess={(url) => set(key, { ...config[key], image_url: url })}
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          className={fieldClass}
          value={config[key].label}
          onChange={(e) => set(key, { ...config[key], label: e.target.value })}
          placeholder={placeholder}
        />
        <input
          className={fieldClass}
          value={config[key].image_alt}
          onChange={(e) =>
            set(key, { ...config[key], image_alt: e.target.value })
          }
          placeholder="Describe the picture"
        />
      </div>
    </FieldGroup>
  );

  return (
    <>
      <FieldGroup title="Header">
        <input
          className={fieldClass}
          value={config.eyebrow}
          onChange={(e) => set("eyebrow", e.target.value)}
          placeholder="Eyebrow (optional)"
        />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="See the difference"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Frame shape</label>
            <select
              className={fieldClass}
              value={config.image_ratio}
              onChange={(e) =>
                set(
                  "image_ratio",
                  e.target.value as BeforeAfterConfig["image_ratio"],
                )
              }
            >
              <option value="landscape">Landscape</option>
              <option value="square">Square</option>
              <option value="portrait">Portrait</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Handle starts at (%)</label>
            <NumberField
              className={fieldClass}
              value={config.start}
              allowDecimal={false}
              onValueChange={(n) =>
                set("start", Math.min(95, Math.max(5, Math.round(n) || 50)))
              }
            />
          </div>
        </div>
      </FieldGroup>
      {side("before", "Before")}
      {side("after", "After")}
    </>
  );
}

function ProductSpotlightFields({
  config,
  setConfig,
  products,
}: {
  config: ProductSpotlightConfig;
  setConfig: (c: AnySectionConfig) => void;
  products: ProductOption[];
}) {
  const set = <K extends keyof ProductSpotlightConfig>(
    key: K,
    value: ProductSpotlightConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Product">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Which product?</label>
            <select
              className={fieldClass}
              value={config.source}
              onChange={(e) =>
                set(
                  "source",
                  e.target.value as ProductSpotlightConfig["source"],
                )
              }
            >
              <option value="featured">First featured product</option>
              <option value="manual">A product I choose</option>
            </select>
          </div>
          {config.source === "manual" && (
            <div>
              <label className={labelClass}>Product</label>
              <select
                className={fieldClass}
                value={config.product_id ?? ""}
                onChange={(e) => set("product_id", e.target.value || null)}
              >
                <option value="">Choose…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.show_price}
            onChange={(e) => set("show_price", e.target.checked)}
          />
          Show the price
        </label>
      </FieldGroup>

      <FieldGroup title="Copy">
        <input
          className={fieldClass}
          value={config.eyebrow}
          onChange={(e) => set("eyebrow", e.target.value)}
          placeholder="Eyebrow (optional)"
        />
        <input
          className={fieldClass}
          value={config.heading}
          onChange={(e) => set("heading", e.target.value)}
          placeholder="Heading (defaults to the product's name)"
        />
        <textarea
          className={`${fieldClass} min-h-[100px] resize-y`}
          value={config.body}
          onChange={(e) => set("body", e.target.value)}
          placeholder="Why this product, in your words."
        />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Button label</label>
            <input
              className={fieldClass}
              value={config.cta_label}
              onChange={(e) => set("cta_label", e.target.value)}
              placeholder="View product"
            />
          </div>
          <div>
            <label className={labelClass}>Picture position</label>
            <select
              className={fieldClass}
              value={config.media_position}
              onChange={(e) =>
                set(
                  "media_position",
                  e.target.value as ProductSpotlightConfig["media_position"],
                )
              }
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </div>
        </div>
      </FieldGroup>
    </>
  );
}

function LogoStripFields({
  config,
  setConfig,
}: {
  config: LogoStripConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof LogoStripConfig>(
    key: K,
    value: LogoStripConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Strip">
        <input
          className={fieldClass}
          value={config.heading}
          onChange={(e) => set("heading", e.target.value)}
          placeholder="As seen in"
        />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Arrangement</label>
            <select
              className={fieldClass}
              value={config.layout}
              onChange={(e) =>
                set("layout", e.target.value as LogoStripConfig["layout"])
              }
            >
              <option value="row">Still row</option>
              <option value="scroll">Drifting row</option>
            </select>
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={config.monochrome}
              onChange={(e) => set("monochrome", e.target.checked)}
            />
            Show marks in one tone
          </label>
        </div>
      </FieldGroup>

      <BlockList
        label="Logos"
        itemLabel="Logo"
        items={config.items}
        max={MAX_LOGO_ITEMS}
        newItem={(): LogoItem => ({ image_url: "", image_alt: "", href: "" })}
        onChange={(items) => set("items", items)}
        title={(item) => item.image_alt}
      >
        {(item, _index, setItem) => (
          <>
            <ImageUpload
              folder="homepage"
              spec="logo"
              defaultImage={item.image_url || undefined}
              onUploadSuccess={(url) => setItem({ image_url: url })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={item.image_alt}
                onChange={(e) => setItem({ image_alt: e.target.value })}
                placeholder="Whose mark this is"
              />
              <input
                className={fieldClass}
                value={item.href}
                onChange={(e) => setItem({ href: e.target.value })}
                placeholder="https://… (optional link)"
              />
            </div>
          </>
        )}
      </BlockList>
    </>
  );
}

/** An ISO instant as the value a datetime-local input shows (local time). */
function toLocalDateTimeInput(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CountdownFields({
  config,
  setConfig,
}: {
  config: CountdownConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof CountdownConfig>(
    key: K,
    value: CountdownConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="When it ends">
        <input
          type="datetime-local"
          className={fieldClass}
          value={toLocalDateTimeInput(config.ends_at)}
          onChange={(e) => {
            const ms = Date.parse(e.target.value);
            set(
              "ends_at",
              Number.isFinite(ms) ? new Date(ms).toISOString() : "",
            );
          }}
        />
        <p className="text-muted-foreground text-[11px]">
          In your local time. Shoppers everywhere count down to the same moment.
        </p>
        <input
          className={fieldClass}
          value={config.expired_message}
          onChange={(e) => set("expired_message", e.target.value)}
          placeholder="Once it ends, show… (leave empty to hide the section)"
        />
      </FieldGroup>

      <FieldGroup title="Copy">
        <input
          className={fieldClass}
          value={config.eyebrow}
          onChange={(e) => set("eyebrow", e.target.value)}
          placeholder="Eyebrow (optional)"
        />
        <input
          className={fieldClass}
          value={config.heading}
          onChange={(e) => set("heading", e.target.value)}
          placeholder="The sale ends in"
        />
        <input
          className={fieldClass}
          value={config.subheading}
          onChange={(e) => set("subheading", e.target.value)}
          placeholder="Subheading (optional)"
        />
        <div className="grid grid-cols-3 gap-3">
          <input
            className={fieldClass}
            value={config.cta_label}
            onChange={(e) => set("cta_label", e.target.value)}
            placeholder="Button label"
          />
          <input
            className={fieldClass}
            value={config.cta_href}
            onChange={(e) => set("cta_href", e.target.value)}
            placeholder="/shop"
          />
          <select
            className={fieldClass}
            value={config.alignment}
            onChange={(e) =>
              set("alignment", e.target.value as CountdownConfig["alignment"])
            }
          >
            <option value="center">Centred</option>
            <option value="left">Left</option>
          </select>
        </div>
      </FieldGroup>
    </>
  );
}

const EMPTY_GALLERY_ITEM: GalleryItem = {
  image_url: "",
  image_alt: "",
  caption: "",
  href: "",
};

function GalleryFields({
  config,
  setConfig,
}: {
  config: GalleryConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof GalleryConfig>(
    key: K,
    value: GalleryConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const setItem = (index: number, patch: Partial<GalleryItem>) =>
    set(
      "items",
      config.items.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    );
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= config.items.length) return;
    const items = [...config.items];
    [items[index], items[target]] = [items[target], items[index]];
    set("items", items);
  };

  return (
    <>
      <FieldGroup title="Header">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="The edit"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="A closer look at the collection"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Layout">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Composition</label>
            <select
              className={fieldClass}
              value={config.layout}
              onChange={(e) =>
                set("layout", e.target.value as GalleryConfig["layout"])
              }
            >
              <option value="editorial">Editorial lead image</option>
              <option value="grid">Even grid</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Columns</label>
            <select
              className={fieldClass}
              value={config.columns}
              onChange={(e) =>
                set(
                  "columns",
                  Number(e.target.value) as GalleryConfig["columns"],
                )
              }
            >
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Image shape</label>
            <select
              className={fieldClass}
              value={config.image_ratio}
              onChange={(e) =>
                set(
                  "image_ratio",
                  e.target.value as GalleryConfig["image_ratio"],
                )
              }
            >
              <option value="portrait">Portrait</option>
              <option value="square">Square</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
        </div>
      </FieldGroup>

      <div className="space-y-2">
        <label className={labelClass}>Images</label>
        {config.items.map((item, index) => (
          <div
            key={index}
            className="bg-background space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium">
                Image {index + 1}
              </span>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === config.items.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "items",
                      config.items.filter((_, i) => i !== index),
                    )
                  }
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <ImageUpload
              folder="homepage"
              spec={specForRatio(config.image_ratio)}
              defaultImage={item.image_url || undefined}
              onUploadSuccess={(url) => setItem(index, { image_url: url })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={item.image_alt}
                onChange={(e) => setItem(index, { image_alt: e.target.value })}
                placeholder="Image description"
              />
              <input
                className={fieldClass}
                value={item.caption}
                onChange={(e) => setItem(index, { caption: e.target.value })}
                placeholder="Caption (optional)"
              />
            </div>
            <input
              className={fieldClass}
              value={item.href}
              onChange={(e) => setItem(index, { href: e.target.value })}
              placeholder="Link (optional, e.g. /shop/new-arrivals)"
            />
          </div>
        ))}
        {config.items.length < MAX_GALLERY_ITEMS && (
          <button
            type="button"
            onClick={() =>
              set("items", [...config.items, { ...EMPTY_GALLERY_ITEM }])
            }
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add image
          </button>
        )}
      </div>
    </>
  );
}

const EMPTY_TESTIMONIAL: TestimonialItem = {
  quote: "",
  author: "",
  detail: "",
  logo_url: "",
  logo_alt: "",
};

function TestimonialsFields({
  config,
  setConfig,
}: {
  config: TestimonialsConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof TestimonialsConfig>(
    key: K,
    value: TestimonialsConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Header">
        <div>
          <label className={labelClass}>Eyebrow</label>
          <input
            className={fieldClass}
            value={config.eyebrow}
            onChange={(e) => set("eyebrow", e.target.value)}
            placeholder="Loved by customers"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="What people are saying"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Style</label>
            <select
              className={fieldClass}
              value={config.layout}
              onChange={(e) =>
                set("layout", e.target.value as TestimonialsConfig["layout"])
              }
            >
              <option value="cards">Cards</option>
              <option value="editorial">Editorial quotes</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Columns</label>
            <select
              className={fieldClass}
              value={config.columns}
              onChange={(e) =>
                set(
                  "columns",
                  Number(e.target.value) as TestimonialsConfig["columns"],
                )
              }
            >
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </div>
        </div>
      </FieldGroup>

      <BlockList
        label="Quotes and mentions"
        itemLabel="Item"
        items={config.items}
        max={MAX_TESTIMONIAL_ITEMS}
        newItem={() => ({ ...EMPTY_TESTIMONIAL })}
        onChange={(items) => set("items", items)}
        title={(item) => item.author || item.quote}
      >
        {(item, _index, setItem) => (
          <>
            <textarea
              className={`${fieldClass} min-h-[88px] resize-y`}
              value={item.quote}
              onChange={(e) => setItem({ quote: e.target.value })}
              placeholder="The product changed our daily ritual…"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={item.author}
                onChange={(e) => setItem({ author: e.target.value })}
                placeholder="Name or publication"
              />
              <input
                className={fieldClass}
                value={item.detail}
                onChange={(e) => setItem({ detail: e.target.value })}
                placeholder="Customer, city or award"
              />
            </div>
            <div>
              <label className={labelClass}>Logo (optional)</label>
              <ImageUpload
                folder="homepage"
                spec="logo"
                defaultImage={item.logo_url || undefined}
                onUploadSuccess={(url) => setItem({ logo_url: url })}
              />
              <input
                className={`${fieldClass} mt-2`}
                value={item.logo_alt}
                onChange={(e) => setItem({ logo_alt: e.target.value })}
                placeholder="Logo description"
              />
            </div>
          </>
        )}
      </BlockList>
    </>
  );
}

function VideoFields({
  config,
  setConfig,
}: {
  config: VideoConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof VideoConfig>(key: K, value: VideoConfig[K]) =>
    setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Header">
        <div>
          <label className={labelClass}>Eyebrow</label>
          <input
            className={fieldClass}
            value={config.eyebrow}
            onChange={(e) => set("eyebrow", e.target.value)}
            placeholder="Watch"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="See the story unfold"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Video">
        <VideoField
          value={config.video_url}
          onChange={(url) => set("video_url", url)}
        />
        <div>
          <label className={labelClass}>Poster image</label>
          <ImageUpload
            folder="homepage"
            spec={
              config.aspect_ratio === "square"
                ? "square"
                : config.aspect_ratio === "portrait"
                  ? "portrait"
                  : "video_poster"
            }
            defaultImage={config.poster_url || undefined}
            onUploadSuccess={(url) => set("poster_url", url)}
          />
          <input
            className={`${fieldClass} mt-2`}
            value={config.poster_alt}
            onChange={(e) => set("poster_alt", e.target.value)}
            placeholder="Describe the poster image"
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Playback and layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Aspect ratio</label>
            <select
              className={fieldClass}
              value={config.aspect_ratio}
              onChange={(e) =>
                set(
                  "aspect_ratio",
                  e.target.value as VideoConfig["aspect_ratio"],
                )
              }
            >
              <option value="landscape">Landscape (16:9)</option>
              <option value="square">Square</option>
              <option value="portrait">Portrait</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Width</label>
            <select
              className={fieldClass}
              value={config.width}
              onChange={(e) =>
                set("width", e.target.value as VideoConfig["width"])
              }
            >
              <option value="contained">Contained</option>
              <option value="full">Full width</option>
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.autoplay}
            onChange={(e) => set("autoplay", e.target.checked)}
          />
          Auto-play muted
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.loop}
            onChange={(e) => set("loop", e.target.checked)}
          />
          Loop playback
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.controls}
            onChange={(e) => set("controls", e.target.checked)}
          />
          Show player controls
        </label>
      </FieldGroup>
    </>
  );
}

function NewsletterFields({
  config,
  setConfig,
}: {
  config: NewsletterSectionConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof NewsletterSectionConfig>(
    key: K,
    value: NewsletterSectionConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Message">
        <div>
          <label className={labelClass}>Eyebrow</label>
          <input
            className={fieldClass}
            value={config.eyebrow}
            onChange={(e) => set("eyebrow", e.target.value)}
            placeholder="Stay close"
          />
        </div>
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="Notes worth opening"
          />
        </div>
        <div>
          <label className={labelClass}>Subheading</label>
          <textarea
            className={`${fieldClass} min-h-[72px] resize-y`}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="New releases, useful stories and occasional offers."
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Form copy">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Button label</label>
            <input
              className={fieldClass}
              value={config.button_label}
              onChange={(e) => set("button_label", e.target.value)}
              placeholder="Subscribe"
            />
          </div>
          <div>
            <label className={labelClass}>Success message</label>
            <input
              className={fieldClass}
              value={config.success_message}
              onChange={(e) => set("success_message", e.target.value)}
              placeholder="You're on the list — thank you."
            />
          </div>
        </div>
        <div>
          <label className={labelClass}>Consent text</label>
          <textarea
            className={`${fieldClass} min-h-[72px] resize-y`}
            value={config.consent_text}
            onChange={(e) => set("consent_text", e.target.value)}
            placeholder="I agree to receive store news and offers by email."
          />
          <p className="text-muted-foreground mt-1 text-[11px]">
            Visitors must tick this before subscribing.
          </p>
        </div>
      </FieldGroup>

      <FieldGroup title="Layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Alignment</label>
            <select
              className={fieldClass}
              value={config.alignment}
              onChange={(e) =>
                set(
                  "alignment",
                  e.target.value as NewsletterSectionConfig["alignment"],
                )
              }
            >
              <option value="center">Centered</option>
              <option value="left">Split / left</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Text theme</label>
            <select
              className={fieldClass}
              value={config.theme}
              onChange={(e) =>
                set("theme", e.target.value as NewsletterSectionConfig["theme"])
              }
            >
              <option value="dark">Dark text / light field</option>
              <option value="light">Light text / dark field</option>
            </select>
          </div>
        </div>
      </FieldGroup>
    </>
  );
}

function FeaturedFields({
  config,
  setConfig,
  products,
  categories,
}: {
  config: FeaturedProductsConfig;
  setConfig: (c: AnySectionConfig) => void;
  products: ProductOption[];
  categories: CategoryOption[];
}) {
  const set = <K extends keyof FeaturedProductsConfig>(
    key: K,
    value: FeaturedProductsConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="Bestsellers"
          />
        </div>
        <div>
          <label className={labelClass}>Subheading</label>
          <input
            className={fieldClass}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="(optional)"
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>Which products?</label>
        <select
          className={fieldClass}
          value={config.source}
          onChange={(e) =>
            set("source", e.target.value as FeaturedProductsConfig["source"])
          }
        >
          <option value="featured">Featured products (auto)</option>
          <option value="manual">Hand-picked</option>
          <option value="category">All from a category</option>
        </select>
      </div>

      {config.source === "manual" && (
        <div>
          <label className={labelClass}>Products (in display order)</label>
          <OrderedPicker
            selectedIds={config.product_ids}
            options={products.map((p) => ({ id: p.id, name: p.name }))}
            onChange={(ids) => set("product_ids", ids)}
            addLabel="Add a product..."
          />
        </div>
      )}

      {config.source === "category" && (
        <div>
          <label className={labelClass}>Category</label>
          <select
            className={fieldClass}
            value={config.category_id ?? ""}
            onChange={(e) => set("category_id", e.target.value || null)}
          >
            <option value="">Select a category...</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {config.source !== "manual" && (
        <div className="max-w-[160px]">
          <label className={labelClass}>Max products</label>
          <NumberField
            className={fieldClass}
            value={config.limit}
            onValueChange={(n) => set("limit", n)}
            allowDecimal={false}
          />
          <p className="text-muted-foreground mt-1 text-[11px]">1–12.</p>
        </div>
      )}
    </>
  );
}

function CategoryFields({
  config,
  setConfig,
  categories,
}: {
  config: ShopByCategoryConfig;
  setConfig: (c: AnySectionConfig) => void;
  categories: CategoryOption[];
}) {
  const set = <K extends keyof ShopByCategoryConfig>(
    key: K,
    value: ShopByCategoryConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="Shop by Category"
          />
        </div>
        <div>
          <label className={labelClass}>Subheading</label>
          <input
            className={fieldClass}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="(optional)"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Which categories?</label>
          <select
            className={fieldClass}
            value={config.source}
            onChange={(e) =>
              set("source", e.target.value as ShopByCategoryConfig["source"])
            }
          >
            <option value="all">All active categories</option>
            <option value="selected">Selected only</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Layout</label>
          <select
            className={fieldClass}
            value={config.layout}
            onChange={(e) =>
              set("layout", e.target.value as ShopByCategoryConfig["layout"])
            }
          >
            <option value="grid">Grid</option>
            <option value="scroll">Horizontal scroll</option>
          </select>
        </div>
      </div>

      <div className="max-w-[220px]">
        <label className={labelClass}>Tile shape</label>
        <select
          className={fieldClass}
          value={config.display ?? "circles"}
          onChange={(e) =>
            set("display", e.target.value as ShopByCategoryConfig["display"])
          }
        >
          <option value="circles">Circles</option>
          <option value="cards">Rounded cards</option>
        </select>
      </div>

      {config.source === "selected" && (
        <div>
          <label className={labelClass}>Categories (in display order)</label>
          <OrderedPicker
            selectedIds={config.category_ids}
            options={categories.map((c) => ({ id: c.id, name: c.name }))}
            onChange={(ids) => set("category_ids", ids)}
            addLabel="Add a category..."
          />
        </div>
      )}
    </>
  );
}

function BannerFields({
  config,
  setConfig,
}: {
  config: PromoBannerConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof PromoBannerConfig>(
    key: K,
    value: PromoBannerConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div>
        <label className={labelClass}>Banner image</label>
        <ImageUpload
          folder="homepage"
          spec="hero_wide"
          defaultImage={config.image_url || undefined}
          onUploadSuccess={(url) => set("image_url", url)}
        />
      </div>

      <div>
        <label className={labelClass}>Heading</label>
        <input
          className={fieldClass}
          value={config.heading}
          onChange={(e) => set("heading", e.target.value)}
          placeholder="Summer Sale"
        />
      </div>

      <div>
        <label className={labelClass}>Subtext</label>
        <textarea
          className={`${fieldClass} min-h-[60px] resize-y`}
          value={config.subtext}
          onChange={(e) => set("subtext", e.target.value)}
          placeholder="(optional)"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Button label</label>
          <input
            className={fieldClass}
            value={config.cta_label}
            onChange={(e) => set("cta_label", e.target.value)}
            placeholder="Shop now"
          />
        </div>
        <div>
          <label className={labelClass}>Button link</label>
          <input
            className={fieldClass}
            value={config.cta_href}
            onChange={(e) => set("cta_href", e.target.value)}
            placeholder="/shop"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Text alignment</label>
          <select
            className={fieldClass}
            value={config.alignment}
            onChange={(e) =>
              set("alignment", e.target.value as PromoBannerConfig["alignment"])
            }
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Text theme</label>
          <select
            className={fieldClass}
            value={config.theme}
            onChange={(e) =>
              set("theme", e.target.value as PromoBannerConfig["theme"])
            }
          >
            <option value="light">Light (dark image)</option>
            <option value="dark">Dark (light image)</option>
          </select>
        </div>
      </div>
    </>
  );
}

function BlogFields({
  config,
  setConfig,
  blogs,
}: {
  config: LatestBlogsConfig;
  setConfig: (c: AnySectionConfig) => void;
  blogs: BlogOption[];
}) {
  const set = <K extends keyof LatestBlogsConfig>(
    key: K,
    value: LatestBlogsConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="From the Journal"
          />
        </div>
        <div>
          <label className={labelClass}>Subheading</label>
          <input
            className={fieldClass}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="(optional)"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Which posts?</label>
          <select
            className={fieldClass}
            value={config.source}
            onChange={(e) =>
              set("source", e.target.value as LatestBlogsConfig["source"])
            }
          >
            <option value="latest">Latest published (auto)</option>
            <option value="featured">Featured posts (auto)</option>
            <option value="manual">Hand-picked</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Layout</label>
          <select
            className={fieldClass}
            value={config.layout}
            onChange={(e) =>
              set("layout", e.target.value as LatestBlogsConfig["layout"])
            }
          >
            <option value="grid">Grid</option>
            <option value="scroll">Horizontal scroll</option>
          </select>
        </div>
      </div>

      {config.source === "manual" ? (
        <div>
          <label className={labelClass}>Posts (in display order)</label>
          <OrderedPicker
            selectedIds={config.blog_ids}
            options={blogs.map((b) => ({ id: b.id, name: b.name }))}
            onChange={(ids) => set("blog_ids", ids)}
            addLabel="Add a blog post..."
          />
          {blogs.length === 0 && (
            <p className="text-muted-foreground mt-1 text-[11px]">
              No published blogs yet — publish a post first.
            </p>
          )}
        </div>
      ) : (
        <div className="max-w-[160px]">
          <label className={labelClass}>Max posts</label>
          <NumberField
            className={fieldClass}
            value={config.limit}
            onValueChange={(n) => set("limit", n)}
            allowDecimal={false}
          />
          <p className="text-muted-foreground mt-1 text-[11px]">1–12.</p>
        </div>
      )}
    </>
  );
}

function RichTextFields({
  config,
  setConfig,
}: {
  config: RichTextConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof RichTextConfig>(
    key: K,
    value: RichTextConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div>
        <label className={labelClass}>Content (HTML)</label>
        <CodeEditor
          language="html"
          value={config.html}
          onChange={(v) => set("html", v)}
          placeholder="<h2>About us</h2>&#10;<p>Tell your story…</p>"
          minHeight="180px"
        />
        <p className="text-muted-foreground mt-1 text-[11px]">
          Basic HTML — headings, paragraphs, links, lists, images. Unsafe tags
          and scripts are removed automatically.
        </p>
      </div>
      <div className="max-w-[220px]">
        <label className={labelClass}>Width</label>
        <select
          className={fieldClass}
          value={config.width}
          onChange={(e) =>
            set("width", e.target.value as RichTextConfig["width"])
          }
        >
          <option value="contained">Contained (readable column)</option>
          <option value="full">Full width</option>
        </select>
      </div>
    </>
  );
}

function CustomCodeFields({
  config,
  setConfig,
}: {
  config: CustomCodeConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof CustomCodeConfig>(
    key: K,
    value: CustomCodeConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div className="rounded-md border border-[var(--dash-amber-border,#f0c67a)] bg-[var(--dash-amber-soft,#fdf6e7)] px-3 py-2 text-[11px] leading-relaxed text-[var(--dash-amber-ink,#8a6d1f)]">
        Your code runs in a secure sandbox — isolated from the rest of your site
        and from customer accounts. Great for self-contained widgets (carousels,
        embeds, animations).
      </div>

      <div>
        <label className={labelClass}>HTML</label>
        <CodeEditor
          language="html"
          value={config.html}
          onChange={(v) => set("html", v)}
          placeholder="<div class='my-carousel'>…</div>"
          minHeight="280px"
        />
      </div>

      <div>
        <label className={labelClass}>CSS</label>
        <CodeEditor
          language="css"
          value={config.css}
          onChange={(v) => set("css", v)}
          placeholder=".my-carousel { … }"
          minHeight="240px"
        />
      </div>

      <div>
        <label className={labelClass}>JavaScript</label>
        <CodeEditor
          language="javascript"
          value={config.js}
          onChange={(v) => set("js", v)}
          placeholder="// runs when the section loads"
          minHeight="240px"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Height</label>
          <select
            className={fieldClass}
            value={config.height_mode}
            onChange={(e) =>
              set(
                "height_mode",
                e.target.value as CustomCodeConfig["height_mode"],
              )
            }
          >
            <option value="auto">Auto (fit content)</option>
            <option value="fixed">Fixed</option>
          </select>
        </div>
        {config.height_mode === "fixed" && (
          <div>
            <label className={labelClass}>Height (px)</label>
            <NumberField
              className={fieldClass}
              value={config.fixed_height}
              onValueChange={(n) => set("fixed_height", n)}
              allowDecimal={false}
            />
          </div>
        )}
      </div>

      {(config.html.trim() || config.css.trim() || config.js.trim()) && (
        <div>
          <label className={labelClass}>Live preview</label>
          <div className="overflow-hidden rounded-md border">
            <CustomCodeFrame config={config} title="Custom code preview" />
          </div>
        </div>
      )}
    </>
  );
}
