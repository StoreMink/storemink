// ---------------------------------------------------------------------------
// A picture's shape comes from the frame it is shown in (owner, 22 Nov 2026:
// "product photos, the nav bar design and all are the things which are
// important in every theme, so these should be in the params").
//
// WHY. A picture's aspect ratio used to be whatever the planning stage wrote
// in its brief, before the build stage had chosen where the picture goes or
// how that section frames it. Nothing compared the two. The first live v34
// theme asked for 4:3 product photography and every portrait card showed it
// as a small rectangle; a portrait story picture in a landscape frame, or the
// reverse, fails the same way.
//
// The storefront already knows every frame: a product card is portrait, a
// category tile is square, a slideshow fills a wide band, and a section with
// a ratio setting (portrait / square / landscape) draws exactly that. So once
// the build stage has placed the pictures, StoreMink reads each frame and
// sets the brief's shape to it. A model is never asked.
//
// ★ ORIENTATION IS WHAT IS HELD. A brief already in its frame's orientation
//   keeps its own ratio (a 3:2 picture in a landscape frame is fine); one in
//   the wrong orientation takes the frame's canonical ratio, the one the
//   storefront's own CSS uses.
// ★ NEW THEMES ONLY. A revision keeps the shapes it has: changing one would
//   throw away a photograph that was already drawn and paid for.
// Pure.
// ---------------------------------------------------------------------------

import type { ThemeIntent } from "./contracts";

export type FrameOrientation = "portrait" | "square" | "landscape" | "wide";

/** The ratio the storefront's own frames use for each orientation. */
export const FRAME_RATIO: Record<FrameOrientation, string> = {
  portrait: "4:5",
  square: "1:1",
  landscape: "4:3",
  wide: "21:9",
};
/** A wide band shows at least this much width for its height. */
const WIDE_MIN = 16 / 9;

const SLOT = /^theme-asset:\/\/([a-z][a-z0-9-]{0,79})$/;
const isRec = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const SETTINGS = ["image_ratio", "media_ratio", "aspect_ratio"] as const;
/** Sections whose picture fills the whole band behind their copy. */
const WIDE_SECTIONS = new Set(["hero_carousel", "promo_banner"]);

export function orientationOf(ratio: string): FrameOrientation | null {
  const [width, height] = ratio.split(":").map(Number);
  if (!(width > 0) || !(height > 0)) return null;
  if (width / height >= WIDE_MIN) return "wide";
  return width > height ? "landscape" : width < height ? "portrait" : "square";
}

function declared(node: Record<string, unknown>): FrameOrientation | null {
  for (const key of SETTINGS) {
    const value = node[key];
    if (value === "portrait" || value === "square" || value === "landscape")
      return value;
  }
  return null;
}

/**
 * The frame each picture slot is shown in, from the built pages. A slot used
 * in two frames keeps the first, in page order.
 */
export function frameOrientations(
  pages: ReadonlyArray<{
    sections: ReadonlyArray<{ type: string; config: unknown }>;
  }>,
): Map<string, FrameOrientation> {
  const frames = new Map<string, FrameOrientation>();
  const note = (slot: string, frame: FrameOrientation | null) => {
    if (frame && !frames.has(slot)) frames.set(slot, frame);
  };
  const walk = (
    node: unknown,
    type: string,
    inherited: FrameOrientation | null,
  ): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, type, inherited);
      return;
    }
    if (!isRec(node)) return;
    const own = declared(node) ?? inherited;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        const slot = SLOT.exec(value)?.[1];
        if (!slot || !key.endsWith("_url")) continue;
        note(
          slot,
          key === "mobile_image_url"
            ? "portrait"
            : WIDE_SECTIONS.has(type)
              ? "wide"
              : type === "shop_by_category"
                ? "square"
                : own,
        );
      } else walk(value, type, own);
    }
  };
  for (const page of pages)
    for (const section of page.sections)
      walk(section.config, section.type, null);
  return frames;
}

/**
 * The briefs with each picture's shape set to its frame. `isProduct` says
 * which briefs are product photography, whose frame is the product card.
 */
export function briefsInFrameShapes(
  intent: ThemeIntent,
  pages: Parameters<typeof frameOrientations>[0],
  isProduct: (briefId: string) => boolean,
): ThemeIntent["assetBriefs"] {
  const frames = frameOrientations(pages);
  return intent.assetBriefs.map((brief) => {
    const frame = isProduct(brief.id) ? "portrait" : frames.get(brief.id);
    const now = orientationOf(brief.aspectRatio);
    if (!frame || !now) return brief;
    const fits =
      frame === now ||
      // A product card and a square tile both show a square whole.
      (frame === "portrait" && now === "square" && isProduct(brief.id)) ||
      // A wide picture is a landscape one, and fills a landscape frame.
      (frame === "landscape" && now === "wide");
    return fits ? brief : { ...brief, aspectRatio: FRAME_RATIO[frame] };
  });
}

// ---------------------------------------------------------------------------
// A phone photograph for every opening slide (same owner direction).
//
// A homepage opens with a photograph filling a wide band (opening.ts), drawn
// 21:9. On a phone that band is taller than it is wide, so the same picture
// shows about a third of its frame: the first live v34 theme was held at
// "responsive composition 3 of 5" for exactly that, and the only repair the
// reviewer could name (a shorter band) is one the opening rule refuses.
// The storefront has had the answer all along: a slide's `mobile_image_url`,
// a separate photograph shown below 768px. Premium themes all carry one. A
// model was told it "may" add one and never did, so it is no longer a choice:
// every opening slide of a NEW theme gets a portrait brief of the same scene,
// and the slide points at it.
// ---------------------------------------------------------------------------

/** Appended to a phone brief's art direction. */
export const PHONE_BRIEF_DIRECTION =
  "Composed for a tall phone screen: the same scene, light and products as the wide photograph, the subject whole and centred, with calm space for a heading.";
const PHONE_SUFFIX = "-phone";

interface DraftSection {
  type?: unknown;
  enabled?: unknown;
  configJson?: unknown;
}

/**
 * The draft and the intent with a portrait phone photograph on every slide of
 * the homepage's opening slideshow (or its single full-band hero). A slide
 * that already names one keeps it. `maxBriefs` is the intent's own ceiling:
 * a theme that has no room for another brief is left as it is.
 */
export function withPhoneOpening(
  draft: unknown,
  intent: ThemeIntent,
  maxBriefs: number,
): { draft: unknown; intent: ThemeIntent } {
  if (!isRec(draft) || !Array.isArray(draft.pages)) return { draft, intent };
  const homeIndex = draft.pages.findIndex(
    (page) => isRec(page) && (page.slug === "" || page.slug === undefined),
  );
  const home = draft.pages[homeIndex];
  if (!isRec(home) || !Array.isArray(home.sections)) return { draft, intent };
  const sectionIndex = (home.sections as DraftSection[]).findIndex(
    (section) => isRec(section) && section.enabled !== false,
  );
  const opening = home.sections[sectionIndex] as DraftSection | undefined;
  if (
    !opening ||
    (opening.type !== "hero_carousel" && opening.type !== "hero") ||
    typeof opening.configJson !== "string"
  )
    return { draft, intent };
  let config: unknown;
  try {
    config = JSON.parse(opening.configJson);
  } catch {
    return { draft, intent };
  }
  if (!isRec(config)) return { draft, intent };

  const briefs = [...intent.assetBriefs];
  const frames = (
    opening.type === "hero_carousel" && Array.isArray(config.slides)
      ? config.slides
      : [config]
  ).filter(isRec);
  let changed = false;
  for (const frame of frames) {
    const slot =
      typeof frame.image_url === "string"
        ? SLOT.exec(frame.image_url)?.[1]
        : undefined;
    if (!slot || frame.mobile_image_url) continue;
    const wide = briefs.find((brief) => brief.id === slot);
    if (!wide) continue;
    const id = `${slot.slice(0, 80 - PHONE_SUFFIX.length)}${PHONE_SUFFIX}`;
    if (!briefs.some((brief) => brief.id === id)) {
      if (briefs.length >= maxBriefs) continue;
      briefs.push({
        ...wide,
        id,
        purpose: `${wide.purpose} (phone)`.slice(0, 240),
        aspectRatio: FRAME_RATIO.portrait,
        // The phone instruction first, so a long direction cannot cut it off.
        artDirection: `${PHONE_BRIEF_DIRECTION} ${wide.artDirection}`.slice(
          0,
          800,
        ),
      });
    }
    frame.mobile_image_url = `theme-asset://${id}`;
    changed = true;
  }
  if (!changed) return { draft, intent };
  const sections = [...home.sections];
  sections[sectionIndex] = { ...opening, configJson: JSON.stringify(config) };
  const pages = [...draft.pages];
  pages[homeIndex] = { ...home, sections };
  return {
    draft: { ...draft, pages },
    intent: { ...intent, assetBriefs: briefs },
  };
}
