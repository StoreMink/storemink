"use client";

import { useState } from "react";
import { ChevronDown, GripVertical, Plus, X } from "lucide-react";
import type {
  ChromeLink,
  FooterGroup,
  StoreChrome,
  StorefrontAppearance,
} from "@/lib/chrome/types";
import { NAV_LIMITS } from "@/lib/chrome/nav";
import { ImageUpload } from "@/components/ui/image-upload";
import { BlockList } from "./block-list";
import { USP_ICON_LABELS } from "./section-form";
import { USP_ICONS, type UspIcon } from "@/lib/homepage/section-types";
import {
  ACCOUNT_LAYOUTS,
  ACCOUNT_SCHEMES,
  BLOG_ARTICLE_LAYOUTS,
  BLOG_INDEX_LAYOUTS,
  COLLECTION_FILTERS,
  COLLECTION_PAGINATIONS,
  MAX_ACCORDION_ROWS,
  MAX_PROMO_AFTER,
  MAX_PROMO_TILES,
  MAX_SIZE_GUIDE_COLUMNS,
  MAX_SIZE_GUIDE_ROWS,
  MAX_TRUST_ROW_ITEMS,
  PRODUCT_BLOCK_TYPES,
  PRODUCT_GALLERIES,
  type AccordionRow,
  type AccountLayout,
  type AccountScheme,
  type AccountTemplate,
  type BlogArticleLayout,
  type BlogIndexLayout,
  type BlogTemplate,
  type CollectionFilters,
  type CollectionPagination,
  type CollectionTemplate,
  type ProductBlock,
  type ProductBlockType,
  type ProductGalleryMode,
  type ProductTemplate,
  type PromoTile,
  type SizeGuideRow,
  type TrustRowItem,
} from "@/lib/themes/templates";
import {
  contrastIssuesFor,
  DESIGN_PALETTE_TOKENS,
  DESIGN_PILL_MAX,
  DESIGN_RADIUS_MAX,
  DESIGN_SHAPE_KEYS,
  type DesignFont,
  type DesignPaletteToken,
  type DesignShapeKey,
  type StorefrontDesignOverrides,
  type ThemeDesignDefaults,
} from "@/lib/chrome/design";
import {
  FONT_CATEGORIES,
  FONT_CATEGORY_LABELS,
  THEME_FONT_FACES,
} from "@/lib/themes/fonts";

// ---------------------------------------------------------------------------
// Header + footer editors, inside the builder's inspector.
//
// These replace /dashboard/navigation, which was a separate dashboard page with
// a separate form and no preview: you edited your footer blind, saved, then
// navigated to the storefront to see what you'd done. Here every keystroke
// paints in the preview iframe beside it.
//
// Deliberately NOT a section canvas. The merchant controls what each block
// SAYS and whether it appears; the arrangement stays theme-controlled. A footer
// you can drag arbitrary blocks into is a footer merchants can make look
// broken, and it is the one surface that appears on every page of the store.
// ---------------------------------------------------------------------------

// A collapsible group, matching the inspector's field-group treatment so the
// chrome editor doesn't look like a different product bolted on.
function Group({
  title,
  hint,
  children,
  defaultOpen = true,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sm-b-group">
      <button
        type="button"
        className="sm-b-group-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="sm-b-group-body">
          {hint && <p className="sm-b-hint">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="sm-b-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="sm-b-toggle-label">{label}</span>
        {hint && <span className="sm-b-toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

/** One editable label→href list. Used by the header and by each footer column. */
function LinkList({
  links,
  onChange,
  addLabel = "Add link",
}: {
  links: ChromeLink[];
  onChange: (next: ChromeLink[]) => void;
  addLabel?: string;
}) {
  const set = (i: number, patch: Partial<ChromeLink>) =>
    onChange(links.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= links.length) return;
    const next = [...links];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="sm-b-linklist">
      {links.map((link, i) => (
        <div key={i} className="sm-b-linkrow">
          <span className="sm-b-linkgrip" aria-hidden>
            <GripVertical className="h-3.5 w-3.5" />
          </span>
          <div className="sm-b-linkfields">
            <input
              className="sm-b-input"
              value={link.label}
              placeholder="Label"
              onChange={(e) => set(i, { label: e.target.value })}
            />
            <input
              className="sm-b-input sm-b-input-mono"
              value={link.href}
              placeholder="/shop"
              onChange={(e) => set(i, { href: e.target.value })}
            />
          </div>
          <div className="sm-b-linkactions">
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              aria-label="Move up"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === links.length - 1}
              aria-label="Move down"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => onChange(links.filter((_, n) => n !== i))}
              aria-label="Remove link"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="sm-b-addbtn"
        onClick={() => onChange([...links, { label: "", href: "" }])}
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </button>
      {links.length === 0 && (
        <p className="sm-b-hint">
          No links yet. Visitors will still reach your pages from the footer and
          from links inside your content.
        </p>
      )}
    </div>
  );
}

const NAV_LEVEL_CAP = [
  NAV_LIMITS.topLevel,
  NAV_LIMITS.children,
  NAV_LIMITS.grandchildren,
];

/**
 * The header menu: the same rows as LinkList, but each row can hold sub-links,
 * and those their own — three levels, the ceiling the storefront renders.
 *
 * ★ Only a TOP-LEVEL item with sub-links offers an image, because that is the
 *   only place one appears (the tile in the desktop panel). Offering it
 *   anywhere else would be a field that silently does nothing — the cleaner
 *   drops it on save.
 * ★ A row with sub-links may leave its link empty: it then only opens its
 *   menu. The placeholder says so, rather than letting the merchant find out
 *   that an empty leaf was dropped on save.
 */
export function NavTreeList({
  links,
  onChange,
  depth = 0,
}: {
  links: ChromeLink[];
  onChange: (next: ChromeLink[]) => void;
  depth?: number;
}) {
  const set = (i: number, patch: Partial<ChromeLink>) =>
    onChange(links.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= links.length) return;
    const next = [...links];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  // Removing the last sub-link also removes the image it was for, so the row
  // goes back to exactly the plain link it started as.
  const setChildren = (i: number, children: ChromeLink[]) =>
    onChange(
      links.map((l, n) => {
        if (n !== i) return l;
        if (children.length) return { ...l, children };
        return { label: l.label, href: l.href };
      }),
    );

  const cap = NAV_LEVEL_CAP[depth];
  const noun = depth === 0 ? "menu link" : "sub-link";

  return (
    <div className={`sm-b-linklist${depth ? " sm-b-subnav" : ""}`}>
      {links.map((link, i) => {
        const hasChildren = !!link.children?.length;
        return (
          <div key={i} className="sm-b-navnode">
            <div className="sm-b-linkrow">
              <span className="sm-b-linkgrip" aria-hidden>
                <GripVertical className="h-3.5 w-3.5" />
              </span>
              <div className="sm-b-linkfields">
                <input
                  className="sm-b-input"
                  value={link.label}
                  placeholder="Label"
                  aria-label={`${depth ? "Sub-link" : "Menu link"} ${i + 1} label`}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
                <input
                  className="sm-b-input sm-b-input-mono"
                  value={link.href}
                  placeholder={hasChildren ? "Optional: /shop" : "/shop"}
                  aria-label={`${depth ? "Sub-link" : "Menu link"} ${i + 1} link`}
                  onChange={(e) => set(i, { href: e.target.value })}
                />
              </div>
              <div className="sm-b-linkactions">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === links.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => onChange(links.filter((_, n) => n !== i))}
                  aria-label={`Remove ${link.label || noun}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {hasChildren && (
              <NavTreeList
                links={link.children!}
                depth={depth + 1}
                onChange={(children) => setChildren(i, children)}
              />
            )}

            {depth === 0 && hasChildren && (
              <div className="sm-b-subnav sm-b-navimage">
                <span className="sm-b-hint">
                  Menu image (optional) — shown beside these links on larger
                  screens.
                </span>
                <ImageUpload
                  key={link.image_url ?? "none"}
                  folder="navigation"
                  spec="menu"
                  defaultImage={link.image_url || undefined}
                  onUploadSuccess={(url) => set(i, { image_url: url })}
                />
                {link.image_url && (
                  <button
                    type="button"
                    className="sm-b-addbtn"
                    onClick={() =>
                      onChange(
                        links.map((l, n) =>
                          n === i
                            ? {
                                label: l.label,
                                href: l.href,
                                children: l.children,
                              }
                            : l,
                        ),
                      )
                    }
                  >
                    Remove image
                  </button>
                )}
              </div>
            )}

            {depth + 1 < NAV_LEVEL_CAP.length &&
              (link.children?.length ?? 0) < NAV_LEVEL_CAP[depth + 1] && (
                <button
                  type="button"
                  className="sm-b-addbtn sm-b-addsub"
                  onClick={() =>
                    set(i, {
                      children: [
                        ...(link.children ?? []),
                        { label: "", href: "" },
                      ],
                    })
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add sub-link{link.label ? ` under ${link.label}` : ""}
                </button>
              )}
          </div>
        );
      })}
      {links.length < cap && (
        <button
          type="button"
          className="sm-b-addbtn"
          onClick={() => onChange([...links, { label: "", href: "" }])}
        >
          <Plus className="h-3.5 w-3.5" />
          Add {noun}
        </button>
      )}
      {depth === 0 && links.length === 0 && (
        <p className="sm-b-hint">
          No links yet. Visitors will still reach your pages from the footer and
          from links inside your content.
        </p>
      )}
    </div>
  );
}

export function HeaderForm({
  chrome,
  onChange,
}: {
  chrome: StoreChrome;
  onChange: (next: StoreChrome) => void;
}) {
  const h = chrome.header;
  const patch = (p: Partial<typeof h>) =>
    onChange({ ...chrome, header: { ...h, ...p } });

  return (
    <>
      <Group
        title="Menu"
        hint="The links across the top of every page. Give a link sub-links to open a menu from it; give those sub-links their own to lay the menu out in columns."
      >
        <NavTreeList links={h.links} onChange={(links) => patch({ links })} />
      </Group>

      <Group title="What appears">
        <Toggle
          label="Search"
          hint="A search box in the header."
          checked={h.showSearch}
          onChange={(showSearch) => patch({ showSearch })}
        />
        <Toggle
          label="Account"
          hint="Sign in and order history."
          checked={h.showAccount}
          onChange={(showAccount) => patch({ showAccount })}
        />
        <Toggle
          label="Cart"
          hint="Turn off for a catalogue-only store that takes enquiries instead of orders."
          checked={h.showCart}
          onChange={(showCart) => patch({ showCart })}
        />
        <Toggle
          label="Stay visible when scrolling"
          checked={h.sticky}
          onChange={(sticky) => patch({ sticky })}
        />
      </Group>

      <Group title="Logo" defaultOpen={false}>
        <p className="sm-b-hint">
          Your logo and store name come from your brand, so they stay the same
          everywhere — invoices and emails included.{" "}
          <a href="/dashboard/branding" target="_blank" rel="noopener">
            Edit branding
          </a>
        </p>
      </Group>
    </>
  );
}

export function FooterForm({
  chrome,
  onChange,
}: {
  chrome: StoreChrome;
  onChange: (next: StoreChrome) => void;
}) {
  const f = chrome.footer;
  const patch = (p: Partial<typeof f>) =>
    onChange({ ...chrome, footer: { ...f, ...p } });

  const setGroup = (i: number, next: Partial<FooterGroup>) =>
    patch({
      groups: f.groups.map((g, n) => (n === i ? { ...g, ...next } : g)),
    });

  return (
    <>
      <Group
        title="Link columns"
        hint="Each column becomes one list in the footer."
      >
        {f.groups.map((group, i) => (
          <div key={i} className="sm-b-column">
            <div className="sm-b-column-head">
              <input
                className="sm-b-input sm-b-input-strong"
                value={group.title}
                placeholder="Column title"
                onChange={(e) => setGroup(i, { title: e.target.value })}
              />
              <button
                type="button"
                onClick={() =>
                  patch({ groups: f.groups.filter((_, n) => n !== i) })
                }
                aria-label="Remove column"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <LinkList
              links={group.links}
              onChange={(links) => setGroup(i, { links })}
            />
          </div>
        ))}
        {f.groups.length < 6 && (
          <button
            type="button"
            className="sm-b-addbtn"
            onClick={() =>
              patch({ groups: [...f.groups, { title: "", links: [] }] })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            Add column
          </button>
        )}
      </Group>

      <Group title="Newsletter" defaultOpen={false}>
        <Toggle
          label="Show the sign-up bar"
          checked={f.newsletter.enabled}
          onChange={(enabled) =>
            patch({ newsletter: { ...f.newsletter, enabled } })
          }
        />
        {f.newsletter.enabled && (
          <>
            <label className="sm-b-field">
              <span>Heading</span>
              <input
                className="sm-b-input"
                value={f.newsletter.heading}
                onChange={(e) =>
                  patch({
                    newsletter: { ...f.newsletter, heading: e.target.value },
                  })
                }
              />
            </label>
            <label className="sm-b-field">
              <span>Subtext</span>
              <input
                className="sm-b-input"
                value={f.newsletter.subtext}
                onChange={(e) =>
                  patch({
                    newsletter: { ...f.newsletter, subtext: e.target.value },
                  })
                }
              />
            </label>
            <label className="sm-b-field">
              <span>Button</span>
              <input
                className="sm-b-input"
                value={f.newsletter.buttonLabel}
                onChange={(e) =>
                  patch({
                    newsletter: {
                      ...f.newsletter,
                      buttonLabel: e.target.value,
                    },
                  })
                }
              />
            </label>
            <label className="sm-b-field">
              <span>Consent text</span>
              <input
                className="sm-b-input"
                value={f.newsletter.consentText}
                onChange={(e) =>
                  patch({
                    newsletter: {
                      ...f.newsletter,
                      consentText: e.target.value,
                    },
                  })
                }
              />
            </label>
          </>
        )}
      </Group>

      <Group title="Blocks" defaultOpen={false}>
        <Toggle
          label="Contact details"
          hint="Email, phone and hours from your branding."
          checked={f.contact.enabled}
          onChange={(enabled) => patch({ contact: { enabled } })}
        />
        <Toggle
          label="Social links"
          hint="Only the profiles you've set in branding appear."
          checked={f.social.enabled}
          onChange={(enabled) => patch({ social: { enabled } })}
        />
        <Toggle
          label="Trust badges"
          checked={f.badges.enabled}
          onChange={(enabled) => patch({ badges: { enabled } })}
        />
      </Group>

      <Group
        title="Legal row"
        defaultOpen={false}
        hint="The small print along the very bottom."
      >
        <LinkList
          links={f.legal}
          onChange={(legal) => patch({ legal })}
          addLabel="Add legal link"
        />
      </Group>
    </>
  );
}

const PALETTE_LABELS: Record<DesignPaletteToken, string> = {
  cream: "Page background",
  creamDeep: "Alternate background",
  surface: "Cards and inputs",
  ink: "Headings and body text",
  inkSoft: "Muted text",
  inkFaint: "Faint text",
  border: "Hairlines and borders",
  accent: "Accent",
};

const SHAPE_LABELS: Record<DesignShapeKey, string> = {
  card: "Cards",
  control: "Buttons and inputs",
  sm: "Small controls",
  pill: "Pills and chips",
};

/**
 * Palette, type and corners — the store's own skin over its theme.
 *
 * ★ EVERY CONTROL HAS AN EXPLICIT "USE THEME" STATE, and an unset one shows
 * the value the storefront will really use rather than an empty box. Without
 * that a merchant cannot tell "I have not chosen" from "I chose this exact
 * colour", and cannot get back to the theme once they have nudged a picker —
 * a colour input has no null.
 */
function DesignForm({
  design,
  themeDefaults,
  onChange,
}: {
  design: StorefrontDesignOverrides;
  themeDefaults: ThemeDesignDefaults;
  onChange: (next: StorefrontDesignOverrides) => void;
}) {
  const setPalette = (token: DesignPaletteToken, value: string | null) => {
    const palette = { ...design.palette };
    if (value === null) delete palette[token];
    else palette[token] = value;
    onChange({ ...design, palette });
  };
  const setShape = (key: DesignShapeKey, value: number | null) => {
    const shape = { ...design.shape };
    if (value === null) delete shape[key];
    else shape[key] = value;
    onChange({ ...design, shape });
  };

  // Judged on the RESOLVED pair, so changing the page background flags body
  // text inherited from the theme that was never touched here. Shown while
  // editing rather than only on Publish, where it would be a dead end.
  const issues = contrastIssuesFor(design, themeDefaults);

  return (
    <>
      <Group
        title="Colours"
        hint="Leave a colour on its theme value, or set your own. Publishes with the website."
      >
        {DESIGN_PALETTE_TOKENS.map((token) => {
          const overridden = design.palette[token];
          const themeValue = themeDefaults.palette[token] ?? "#ffffff";
          return (
            <div className="sm-b-field" key={token}>
              <span>{PALETTE_LABELS[token]}</span>
              <div className="sm-b-colorrow">
                <input
                  type="color"
                  className="sm-b-color"
                  value={overridden ?? themeValue}
                  onChange={(e) => setPalette(token, e.target.value)}
                  aria-label={PALETTE_LABELS[token]}
                />
                <input
                  className="sm-b-input sm-b-input-mono"
                  value={overridden ?? ""}
                  placeholder={`Theme ${themeValue}`}
                  onChange={(e) =>
                    setPalette(token, e.target.value.trim() || null)
                  }
                  aria-label={`${PALETTE_LABELS[token]} hex`}
                />
                {overridden ? (
                  <button
                    type="button"
                    className="sm-b-reset"
                    onClick={() => setPalette(token, null)}
                    title="Use the theme colour"
                  >
                    Reset
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        {issues.length > 0 ? (
          <p className="sm-b-warn" role="status">
            {issues.join(" ")} You can keep editing, but this cannot be
            published until it is readable.
          </p>
        ) : null}
      </Group>

      <Group title="Type" defaultOpen={false}>
        {(["body", "display"] as const).map((slot) => (
          <label className="sm-b-field" key={slot}>
            <span>{slot === "body" ? "Body text" : "Headings"}</span>
            <select
              className="sm-b-input"
              value={design.fonts[slot] ?? "theme"}
              onChange={(e) =>
                onChange({
                  ...design,
                  fonts: {
                    ...design.fonts,
                    [slot]:
                      e.target.value === "theme"
                        ? null
                        : (e.target.value as DesignFont),
                  },
                })
              }
            >
              <option value="theme">Theme default</option>
              {FONT_CATEGORIES.map((category) => (
                <optgroup key={category} label={FONT_CATEGORY_LABELS[category]}>
                  {THEME_FONT_FACES.filter(
                    (face) => face.category === category,
                  ).map((face) => (
                    <option key={face.key} value={face.key}>
                      {face.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        ))}
      </Group>

      <Group title="Corners" defaultOpen={false}>
        {DESIGN_SHAPE_KEYS.map((key) => {
          const overridden = design.shape[key];
          const themeValue = themeDefaults.shape[key] ?? 0;
          const max = key === "pill" ? DESIGN_PILL_MAX : DESIGN_RADIUS_MAX;
          return (
            <div className="sm-b-field" key={key}>
              <span>{SHAPE_LABELS[key]}</span>
              <div className="sm-b-colorrow">
                <input
                  type="range"
                  min={0}
                  max={max}
                  value={overridden ?? themeValue}
                  onChange={(e) => setShape(key, Number(e.target.value))}
                  aria-label={SHAPE_LABELS[key]}
                />
                <span className="sm-b-hint">
                  {overridden !== undefined
                    ? `${overridden}px`
                    : `Theme ${themeValue}px`}
                </span>
                {overridden !== undefined ? (
                  <button
                    type="button"
                    className="sm-b-reset"
                    onClick={() => setShape(key, null)}
                    title="Use the theme radius"
                  >
                    Reset
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </Group>
    </>
  );
}

export interface BrandAppearance {
  name: string;
  primaryColor: string;
  logoUrl: string | null;
}

// ---------------------------------------------------------------------------
// The page templates (plan Phase 2e, lib/themes/templates.ts): the product
// page's gallery shape and ordered blocks, and the collection page's filters,
// paging and promotional tiles. Each page inherits the theme's template until
// the merchant customises it, starting from a copy of that template, and can
// go back to the theme's with one choice. Saved with the chrome draft and
// published with the website; the preview shows the pages after a reload.
// ---------------------------------------------------------------------------

const GALLERY_LABELS: Record<ProductGalleryMode, string> = {
  "thumbs-bottom": "Thumbnails under the photo",
  "thumbs-left": "Thumbnails beside the photo",
  stacked: "Every photo in a column",
  carousel: "One photo at a time, with arrows",
  grid: "A grid of photos",
};
const PRODUCT_BLOCK_LABELS: Record<ProductBlockType, string> = {
  price: "Price",
  variant_picker: "Options",
  buy_box: "Quantity and buttons",
  description: "Description",
  delivery_estimate: "Delivery check",
  share: "Share buttons",
  trust_row: "Trust row",
  accordion: "Collapsible rows",
  size_guide: "Size guide",
  rich_text: "Rich text",
  reviews: "Reviews",
  recommendations: "You may also like",
  sticky_bar: "Sticky add to cart on phones",
};
const FILTER_LABELS: Record<CollectionFilters, string> = {
  sidebar: "Column beside the grid",
  drawer: "Filter button only",
  "top-bar": "Row of filters above the grid",
};
const PAGINATION_LABELS: Record<CollectionPagination, string> = {
  "load-more": "Load more button",
  paged: "Numbered pages",
  infinite: "Load as the shopper scrolls",
};
const BLOG_INDEX_LABELS: Record<BlogIndexLayout, string> = {
  grid: "Grid of cards",
  list: "List, picture beside the copy",
  featured: "Featured post above the grid",
};
const BLOG_ARTICLE_LABELS: Record<BlogArticleLayout, string> = {
  narrow: "Reading column",
  wide: "Wide column",
  sidebar: "Column with related posts beside it",
};
const ACCOUNT_LAYOUT_LABELS: Record<AccountLayout, string> = {
  plain: "Pages as they are",
  tabs: "Tabs above each page",
  sidebar: "Navigation beside each page",
};
const ACCOUNT_SCHEME_LABELS: Record<AccountScheme, string> = {
  "": "Page colours",
  soft: "Soft",
  tint: "Tinted",
  accent: "Brand",
  inverse: "Dark",
};

function freshBlock(type: ProductBlockType): ProductBlock {
  switch (type) {
    case "trust_row":
      return { type, items: [{ icon: "truck", label: "Free delivery" }] };
    case "accordion":
      return { type, rows: [{ heading: "Care", body: "" }] };
    case "size_guide":
      return {
        type,
        columns: ["Chest", "Waist"],
        sizes: [{ label: "S", values: ["", ""] }],
      };
    case "rich_text":
      return { type, html: "" };
    default:
      return { type };
  }
}

function TemplatesForm({
  templates,
  themeDefaults,
  onChange,
}: {
  templates: StorefrontAppearance["templates"];
  themeDefaults: ThemeDesignDefaults;
  onChange: (next: StorefrontAppearance["templates"]) => void;
}) {
  const product = templates.product;
  const collection = templates.collection;
  // Rows saved before the blog and account templates carry no key.
  const blog = templates.blog ?? "theme";
  const account = templates.account ?? "theme";
  const setProduct = (next: "theme" | ProductTemplate) =>
    onChange({ ...templates, product: next });
  const setCollection = (next: "theme" | CollectionTemplate) =>
    onChange({ ...templates, collection: next });
  const setBlog = (next: "theme" | BlogTemplate) =>
    onChange({ ...templates, blog: next });
  const setAccount = (next: "theme" | AccountTemplate) =>
    onChange({ ...templates, account: next });
  const used = new Set<ProductBlockType>(
    product === "theme" ? [] : product.blocks.map((b) => b.type),
  );

  return (
    <>
      <Group
        title="Product page"
        hint="The gallery's shape and the blocks under the product name, in order. Price and the quantity and buttons are always shown. The preview shows the product page after a reload."
        defaultOpen={false}
      >
        <label className="sm-b-field">
          <span>Blocks and gallery</span>
          <select
            className="sm-b-input"
            value={product === "theme" ? "theme" : "custom"}
            onChange={(e) =>
              setProduct(
                e.target.value === "theme"
                  ? "theme"
                  : structuredClone(themeDefaults.templates.product),
              )
            }
          >
            <option value="theme">Theme default</option>
            <option value="custom">Customise</option>
          </select>
        </label>
        {product !== "theme" && (
          <>
            <label className="sm-b-field">
              <span>Gallery</span>
              <select
                className="sm-b-input"
                value={product.gallery}
                onChange={(e) =>
                  setProduct({
                    ...product,
                    gallery: e.target.value as ProductGalleryMode,
                  })
                }
              >
                {PRODUCT_GALLERIES.map((mode) => (
                  <option key={mode} value={mode}>
                    {GALLERY_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            <BlockList<ProductBlock>
              label="Blocks"
              itemLabel="Block"
              items={product.blocks}
              max={PRODUCT_BLOCK_TYPES.length}
              newItem={() =>
                freshBlock(
                  PRODUCT_BLOCK_TYPES.find((t) => !used.has(t)) ?? "rich_text",
                )
              }
              onChange={(blocks) => setProduct({ ...product, blocks })}
              title={(block) => PRODUCT_BLOCK_LABELS[block.type]}
            >
              {(block, index, setItem) => (
                <div className="space-y-2">
                  <label className="sm-b-field">
                    <span>Block</span>
                    <select
                      className="sm-b-input"
                      value={block.type}
                      onChange={(e) =>
                        setProduct({
                          ...product,
                          blocks: product.blocks.map((b, i) =>
                            i === index
                              ? freshBlock(e.target.value as ProductBlockType)
                              : b,
                          ),
                        })
                      }
                    >
                      {PRODUCT_BLOCK_TYPES.filter(
                        (t) => t === block.type || !used.has(t),
                      ).map((t) => (
                        <option key={t} value={t}>
                          {PRODUCT_BLOCK_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {block.type === "trust_row" && (
                    <BlockList<TrustRowItem>
                      label="Items"
                      itemLabel="Item"
                      items={block.items}
                      max={MAX_TRUST_ROW_ITEMS}
                      newItem={() => ({ icon: "star", label: "" })}
                      onChange={(items) => setItem({ items })}
                      title={(item) => item.label || USP_ICON_LABELS[item.icon]}
                    >
                      {(item, _i, setRow) => (
                        <div className="space-y-2">
                          <label className="sm-b-field">
                            <span>Icon</span>
                            <select
                              className="sm-b-input"
                              value={item.icon}
                              onChange={(e) =>
                                setRow({ icon: e.target.value as UspIcon })
                              }
                            >
                              {USP_ICONS.map((icon) => (
                                <option key={icon} value={icon}>
                                  {USP_ICON_LABELS[icon]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="sm-b-field">
                            <span>Label</span>
                            <input
                              className="sm-b-input"
                              value={item.label}
                              maxLength={60}
                              onChange={(e) =>
                                setRow({ label: e.target.value })
                              }
                            />
                          </label>
                        </div>
                      )}
                    </BlockList>
                  )}
                  {block.type === "accordion" && (
                    <BlockList<AccordionRow>
                      label="Rows"
                      itemLabel="Row"
                      items={block.rows}
                      max={MAX_ACCORDION_ROWS}
                      newItem={() => ({ heading: "", body: "" })}
                      onChange={(rows) => setItem({ rows })}
                      title={(row) => row.heading}
                    >
                      {(row, _i, setRow) => (
                        <div className="space-y-2">
                          <label className="sm-b-field">
                            <span>Heading</span>
                            <input
                              className="sm-b-input"
                              value={row.heading}
                              maxLength={120}
                              onChange={(e) =>
                                setRow({ heading: e.target.value })
                              }
                            />
                          </label>
                          <label className="sm-b-field">
                            <span>Text</span>
                            <textarea
                              className="sm-b-input"
                              rows={4}
                              value={row.body}
                              onChange={(e) => setRow({ body: e.target.value })}
                            />
                          </label>
                        </div>
                      )}
                    </BlockList>
                  )}
                  {block.type === "size_guide" && (
                    <>
                      <label className="sm-b-field">
                        <span>Measurements (comma-separated)</span>
                        <input
                          className="sm-b-input"
                          value={block.columns.join(", ")}
                          onChange={(e) => {
                            const columns = e.target.value
                              .split(",")
                              .map((c) => c.trim())
                              .filter(Boolean)
                              .slice(0, MAX_SIZE_GUIDE_COLUMNS);
                            setItem({
                              columns,
                              sizes: block.sizes.map((row) => ({
                                ...row,
                                values: columns.map(
                                  (_, i) => row.values[i] ?? "",
                                ),
                              })),
                            });
                          }}
                        />
                        <span className="sm-b-hint">
                          Chest, Waist, Length. Up to {MAX_SIZE_GUIDE_COLUMNS}.
                        </span>
                      </label>
                      <BlockList<SizeGuideRow>
                        label="Sizes"
                        itemLabel="Size"
                        items={block.sizes}
                        max={MAX_SIZE_GUIDE_ROWS}
                        newItem={() => ({
                          label: "",
                          values: block.columns.map(() => ""),
                        })}
                        onChange={(sizes) => setItem({ sizes })}
                        title={(row) => row.label}
                      >
                        {(row, _i, setRow) => (
                          <div className="space-y-2">
                            <label className="sm-b-field">
                              <span>Size</span>
                              <input
                                className="sm-b-input"
                                value={row.label}
                                maxLength={40}
                                onChange={(e) =>
                                  setRow({ label: e.target.value })
                                }
                              />
                            </label>
                            {block.columns.map((column, c) => (
                              <label
                                className="sm-b-field"
                                key={`${column}-${c}`}
                              >
                                <span>{column}</span>
                                <input
                                  className="sm-b-input"
                                  value={row.values[c] ?? ""}
                                  maxLength={40}
                                  onChange={(e) =>
                                    setRow({
                                      values: block.columns.map((_, i) =>
                                        i === c
                                          ? e.target.value
                                          : (row.values[i] ?? ""),
                                      ),
                                    })
                                  }
                                />
                              </label>
                            ))}
                          </div>
                        )}
                      </BlockList>
                    </>
                  )}
                  {block.type === "rich_text" && (
                    <label className="sm-b-field">
                      <span>HTML</span>
                      <textarea
                        className="sm-b-input sm-b-input-mono"
                        rows={5}
                        value={block.html}
                        onChange={(e) => setItem({ html: e.target.value })}
                      />
                      <span className="sm-b-hint">
                        Paragraphs, links, bold and lists; anything else is
                        removed when the page renders.
                      </span>
                    </label>
                  )}
                </div>
              )}
            </BlockList>
          </>
        )}
      </Group>

      <Group
        title="Collection page"
        hint="Where the filters sit, how the grid pages, and the promotional tiles among the products. The preview shows the shop after a reload."
        defaultOpen={false}
      >
        <label className="sm-b-field">
          <span>Filters, paging and tiles</span>
          <select
            className="sm-b-input"
            value={collection === "theme" ? "theme" : "custom"}
            onChange={(e) =>
              setCollection(
                e.target.value === "theme"
                  ? "theme"
                  : structuredClone(themeDefaults.templates.collection),
              )
            }
          >
            <option value="theme">Theme default</option>
            <option value="custom">Customise</option>
          </select>
        </label>
        {collection !== "theme" && (
          <>
            <label className="sm-b-field">
              <span>Filters</span>
              <select
                className="sm-b-input"
                value={collection.filters}
                onChange={(e) =>
                  setCollection({
                    ...collection,
                    filters: e.target.value as CollectionFilters,
                  })
                }
              >
                {COLLECTION_FILTERS.map((mode) => (
                  <option key={mode} value={mode}>
                    {FILTER_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            <label className="sm-b-field">
              <span>Paging</span>
              <select
                className="sm-b-input"
                value={collection.pagination}
                onChange={(e) =>
                  setCollection({
                    ...collection,
                    pagination: e.target.value as CollectionPagination,
                  })
                }
              >
                {COLLECTION_PAGINATIONS.map((mode) => (
                  <option key={mode} value={mode}>
                    {PAGINATION_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            <BlockList<PromoTile>
              label="Promotional tiles"
              itemLabel="Tile"
              items={collection.promoTiles}
              max={MAX_PROMO_TILES}
              newItem={() => ({
                afterIndex: 4,
                heading: "",
                body: "",
                cta_label: "",
                href: "",
                image_url: "",
                image_alt: "",
                theme: "dark",
                background: "",
              })}
              onChange={(promoTiles) =>
                setCollection({ ...collection, promoTiles })
              }
              title={(tile) => tile.heading}
            >
              {(tile, _i, setTile) => (
                <div className="space-y-2">
                  <label className="sm-b-field">
                    <span>After how many products</span>
                    <input
                      className="sm-b-input"
                      type="number"
                      min={1}
                      max={MAX_PROMO_AFTER}
                      value={tile.afterIndex}
                      onChange={(e) =>
                        setTile({
                          afterIndex: Math.min(
                            MAX_PROMO_AFTER,
                            Math.max(
                              1,
                              Math.floor(Number(e.target.value) || 1),
                            ),
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="sm-b-field">
                    <span>Heading</span>
                    <input
                      className="sm-b-input"
                      value={tile.heading}
                      maxLength={120}
                      onChange={(e) => setTile({ heading: e.target.value })}
                    />
                  </label>
                  <label className="sm-b-field">
                    <span>Text</span>
                    <textarea
                      className="sm-b-input"
                      rows={3}
                      value={tile.body}
                      onChange={(e) => setTile({ body: e.target.value })}
                    />
                  </label>
                  <label className="sm-b-field">
                    <span>Button label</span>
                    <input
                      className="sm-b-input"
                      value={tile.cta_label}
                      maxLength={60}
                      onChange={(e) => setTile({ cta_label: e.target.value })}
                    />
                  </label>
                  <label className="sm-b-field">
                    <span>Link</span>
                    <input
                      className="sm-b-input"
                      value={tile.href}
                      placeholder="/collections/sale"
                      onChange={(e) => setTile({ href: e.target.value })}
                    />
                  </label>
                  <div className="sm-b-field">
                    <span>Picture</span>
                    <ImageUpload
                      key={tile.image_url || "none"}
                      folder="promo-tiles"
                      spec="category"
                      defaultImage={tile.image_url || undefined}
                      onUploadSuccess={(url) => setTile({ image_url: url })}
                    />
                    {tile.image_url && (
                      <button
                        type="button"
                        className="sm-b-link"
                        onClick={() =>
                          setTile({ image_url: "", image_alt: "" })
                        }
                      >
                        Remove picture
                      </button>
                    )}
                  </div>
                  {tile.image_url && (
                    <label className="sm-b-field">
                      <span>Picture description</span>
                      <input
                        className="sm-b-input"
                        value={tile.image_alt}
                        maxLength={160}
                        onChange={(e) => setTile({ image_alt: e.target.value })}
                      />
                    </label>
                  )}
                  <label className="sm-b-field">
                    <span>Text colour</span>
                    <select
                      className="sm-b-input"
                      value={tile.theme}
                      onChange={(e) =>
                        setTile({
                          theme: e.target.value === "light" ? "light" : "dark",
                        })
                      }
                    >
                      <option value="dark">Light text on a dark tile</option>
                      <option value="light">Dark text on a light tile</option>
                    </select>
                  </label>
                  <label className="sm-b-field">
                    <span>Background colour</span>
                    <div className="sm-b-colorrow">
                      <input
                        type="color"
                        className="sm-b-color"
                        value={tile.background || "#000000"}
                        onChange={(e) =>
                          setTile({ background: e.target.value })
                        }
                        aria-label="Tile background colour"
                      />
                      <input
                        className="sm-b-input sm-b-input-mono"
                        value={tile.background}
                        placeholder="Theme ink"
                        onChange={(e) =>
                          setTile({ background: e.target.value })
                        }
                        aria-label="Tile background colour hex"
                      />
                    </div>
                  </label>
                </div>
              )}
            </BlockList>
          </>
        )}
      </Group>

      <Group
        title="Blog"
        hint="How the journal lists its posts and how wide an article reads."
        defaultOpen={false}
      >
        <label className="sm-b-field">
          <span>Layouts</span>
          <select
            className="sm-b-input"
            value={blog === "theme" ? "theme" : "custom"}
            onChange={(e) =>
              setBlog(
                e.target.value === "theme"
                  ? "theme"
                  : structuredClone(themeDefaults.templates.blog),
              )
            }
          >
            <option value="theme">Theme default</option>
            <option value="custom">Customise</option>
          </select>
        </label>
        {blog !== "theme" && (
          <>
            <label className="sm-b-field">
              <span>Post list</span>
              <select
                className="sm-b-input"
                value={blog.index}
                onChange={(e) =>
                  setBlog({ ...blog, index: e.target.value as BlogIndexLayout })
                }
              >
                {BLOG_INDEX_LAYOUTS.map((mode) => (
                  <option key={mode} value={mode}>
                    {BLOG_INDEX_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            <label className="sm-b-field">
              <span>Article</span>
              <select
                className="sm-b-input"
                value={blog.article}
                onChange={(e) =>
                  setBlog({
                    ...blog,
                    article: e.target.value as BlogArticleLayout,
                  })
                }
              >
                {BLOG_ARTICLE_LAYOUTS.map((mode) => (
                  <option key={mode} value={mode}>
                    {BLOG_ARTICLE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </Group>

      <Group
        title="Account pages"
        hint="The profile, orders and notifications pages: a shared navigation and a colour scheme."
        defaultOpen={false}
      >
        <label className="sm-b-field">
          <span>Layout and colours</span>
          <select
            className="sm-b-input"
            value={account === "theme" ? "theme" : "custom"}
            onChange={(e) =>
              setAccount(
                e.target.value === "theme"
                  ? "theme"
                  : structuredClone(themeDefaults.templates.account),
              )
            }
          >
            <option value="theme">Theme default</option>
            <option value="custom">Customise</option>
          </select>
        </label>
        {account !== "theme" && (
          <>
            <label className="sm-b-field">
              <span>Navigation</span>
              <select
                className="sm-b-input"
                value={account.layout}
                onChange={(e) =>
                  setAccount({
                    ...account,
                    layout: e.target.value as AccountLayout,
                  })
                }
              >
                {ACCOUNT_LAYOUTS.map((mode) => (
                  <option key={mode} value={mode}>
                    {ACCOUNT_LAYOUT_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            <label className="sm-b-field">
              <span>Colour scheme</span>
              <select
                className="sm-b-input"
                value={account.scheme}
                onChange={(e) =>
                  setAccount({
                    ...account,
                    scheme: e.target.value as AccountScheme,
                  })
                }
              >
                {ACCOUNT_SCHEMES.map((scheme) => (
                  <option key={scheme || "page"} value={scheme}>
                    {ACCOUNT_SCHEME_LABELS[scheme]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </Group>
    </>
  );
}

/**
 * Brand — the third global "section".
 *
 * Deliberately narrow: the colour and logo that decide how the WEBSITE looks.
 * Contact details, social profiles and the legal name stay in
 * /dashboard/branding because they are store identity — they print on invoices
 * and go out in email, so they are not a website decision and should not be
 * edited from a screen whose Publish button is about the website.
 */
export function BrandForm({
  brand,
  onChange,
  chrome,
  onChromeChange,
  themeDefaults,
}: {
  brand: BrandAppearance;
  onChange: (next: BrandAppearance) => void;
  chrome: StoreChrome;
  onChromeChange: (next: StoreChrome) => void;
  themeDefaults: ThemeDesignDefaults;
}) {
  const appearance = chrome.appearance;
  const patchAppearance = (patch: Partial<typeof appearance>) =>
    onChromeChange({
      ...chrome,
      appearance: { ...appearance, ...patch },
    });

  return (
    <>
      <Group title="Colour" hint="Used for buttons, links and accents.">
        <div className="sm-b-colorrow">
          <input
            type="color"
            className="sm-b-color"
            value={brand.primaryColor}
            onChange={(e) =>
              onChange({ ...brand, primaryColor: e.target.value })
            }
            aria-label="Primary colour"
          />
          <input
            className="sm-b-input sm-b-input-mono"
            value={brand.primaryColor}
            onChange={(e) =>
              onChange({ ...brand, primaryColor: e.target.value })
            }
            aria-label="Primary colour hex"
          />
        </div>
      </Group>

      <DesignForm
        design={chrome.design}
        themeDefaults={themeDefaults}
        onChange={(design) => onChromeChange({ ...chrome, design })}
      />

      <Group
        title="Storefront layout"
        hint="Use the theme default, or override individual surfaces. Changes publish with the website."
      >
        <label className="sm-b-field">
          <span>Header</span>
          <select
            className="sm-b-input"
            value={appearance.header}
            onChange={(e) =>
              patchAppearance({
                header: e.target.value as typeof appearance.header,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="classic">Classic left logo</option>
            <option value="market">Market search bar</option>
            <option value="centered">Centered logo</option>
            <option value="minimal">Minimal</option>
            <option value="transparent">Transparent over the opening</option>
            <option value="hamburger">Centred logo, menu button</option>
            <option value="stacked">Centred logo, menu below</option>
            <option value="utility">Utility bar above the logo</option>
          </select>
        </label>
        <label className="sm-b-field">
          <span>Product cards</span>
          <select
            className="sm-b-input"
            value={appearance.card}
            onChange={(e) =>
              patchAppearance({
                card: e.target.value as typeof appearance.card,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="classic">Classic</option>
            <option value="quick_add">Classic with quick add</option>
            <option value="overlay">Editorial overlay</option>
            <option value="framed">Framed</option>
            <option value="grocery">Grocery</option>
            <option value="centered">Centred under a tall photo</option>
            <option value="soft">Soft tile</option>
            <option value="wide">Wide photo</option>
          </select>
        </label>
        <label className="sm-b-field">
          <span>Card photo shape</span>
          <select
            className="sm-b-input"
            value={appearance.cardPhoto}
            onChange={(e) =>
              patchAppearance({
                cardPhoto: e.target.value === "square" ? "square" : "portrait",
              })
            }
          >
            <option value="portrait">Portrait 3:4 (1200 × 1600 photos)</option>
            <option value="square">Square 1:1 (1200 × 1200 photos)</option>
          </select>
          <span className="sm-b-hint">
            Classic cards fill this frame edge to edge. Match it to your product
            photos so nothing is cropped.
          </span>
        </label>
        <label className="sm-b-field">
          <span>Colours in the shop grid</span>
          <select
            className="sm-b-input"
            value={appearance.productCards}
            onChange={(e) =>
              patchAppearance({
                productCards:
                  e.target.value === "colour" ? "colour" : "product",
              })
            }
          >
            <option value="product">One card per product</option>
            <option value="colour">One card per colour</option>
          </select>
          <span className="sm-b-hint">
            One card per colour shows each colour of a product as its own card,
            with that colour&rsquo;s photos. It applies to products with photos
            for each colour.
          </span>
        </label>
        <label className="sm-b-field">
          <span>Product page</span>
          <select
            className="sm-b-input"
            value={appearance.productDetail}
            onChange={(e) =>
              patchAppearance({
                productDetail: e.target
                  .value as typeof appearance.productDetail,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="classic">Classic</option>
            <option value="editorial">Editorial</option>
            <option value="grocery">Grocery</option>
            <option value="stacked">Stacked (photos above the details)</option>
          </select>
        </label>
        <label className="sm-b-field">
          <span>Cart</span>
          <select
            className="sm-b-input"
            value={appearance.cart}
            onChange={(e) =>
              patchAppearance({
                cart: e.target.value as typeof appearance.cart,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="classic">Classic</option>
            <option value="compact">Compact</option>
            <option value="grocery">Grocery</option>
          </select>
        </label>
        <label className="sm-b-field">
          <span>Footer</span>
          <select
            className="sm-b-input"
            value={appearance.footer}
            onChange={(e) =>
              patchAppearance({
                footer: e.target.value as typeof appearance.footer,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="rich">Rich columns</option>
            <option value="editorial">Editorial</option>
            <option value="minimal">Minimal</option>
            <option value="centered">Centred</option>
            <option value="compact">Compact row</option>
          </select>
        </label>
      </Group>

      <TemplatesForm
        templates={appearance.templates}
        themeDefaults={themeDefaults}
        onChange={(templates) => patchAppearance({ templates })}
      />

      <Group title="Logo" defaultOpen={false}>
        <label className="sm-b-field">
          <span>Image URL</span>
          <input
            className="sm-b-input sm-b-input-mono"
            value={brand.logoUrl ?? ""}
            placeholder="https://…"
            onChange={(e) =>
              onChange({ ...brand, logoUrl: e.target.value || null })
            }
          />
        </label>
        <p className="sm-b-hint">
          Leave empty to show your store name as text. Upload images in the{" "}
          <a href="/dashboard/media" target="_blank" rel="noopener">
            media library
          </a>
          .
        </p>
      </Group>

      <Group title="Everything else" defaultOpen={false}>
        <p className="sm-b-hint">
          Your store name, contact details, social profiles and legal name are
          store identity — they also appear on invoices and in email, so they
          live in{" "}
          <a href="/dashboard/branding" target="_blank" rel="noopener">
            branding
          </a>
          .
        </p>
      </Group>
    </>
  );
}
