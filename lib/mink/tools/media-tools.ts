import "server-only";

import {
  MINK_MEDIA_ALT_MAX_CHARS,
  MINK_MEDIA_PROMPT_MAX_CHARS,
  MINK_MEDIA_PROMPT_MIN_CHARS,
  MINK_MEDIA_PURPOSES,
  MINK_MEDIA_PURPOSE_SPECS,
  MINK_MEDIA_REFERENCE_MAX,
} from "../media-generation-contract";
import { createMinkMediaImageProposal } from "../media-image-proposals";
import type { MinkActorContext, MinkArtifact } from "../types";
import { TOOL_COMMIT_GRACE_MS, type MinkTool } from "./registry";

const available = (actor: MinkActorContext) => actor.draftingEnabled === true;

/**
 * ★★ THE IMAGE TOOL'S DEADLINE, AND THE CHAIN STOPS AT IT (B6, B10,
 *    2026-10-23). It was 50 s around a 45 s drawing, so a picture that came
 *    back at 46 s was stored and charged while the chat said it took too
 *    long. Now a 429 is asked again twice (`MINK_CHAT_IMAGE_RETRY`), and
 *    rather than stretch this to cover the longest chain (three 45 s tries
 *    and two waits, nearly three minutes of a merchant watching), the chain
 *    reads this deadline: each try's clock is cut to what is left, no try
 *    starts without room to finish, and the last write goes through the
 *    registry's `commit`. Two quick refusals and a full try (about 80 s) still
 *    fit. ★ The draw must end `POST_DRAW_RESERVE_MS` before it, so the upload,
 *    the Media row and the draft fit too (media-image-proposals.ts).
 */
export const MEDIA_TOOL_TIMEOUT_MS = 100_000;

/**
 * ★ THE RUN WAITS FOR IT: the stream route pushes the run's deadline
 *   (MINK_RUN_TIMEOUT_SECONDS, 180 by default) out to at least this far ahead
 *   when the tool starts, so the run can never be cut off while a picture is
 *   being drawn, and the model still has a minute to answer after it, even
 *   when the charged write ran into the registry's commit grace.
 */
const MEDIA_TOOL_RUN_BUDGET_MS =
  MEDIA_TOOL_TIMEOUT_MS + TOOL_COMMIT_GRACE_MS + 60_000;

/**
 * ★★ THE ASPECT RATIO IS NOT A PARAMETER, AND THAT IS THE POINT OF `purpose`.
 * A model asked for "a hero image" will cheerfully pick 9:16, and the hero
 * renderer then crops that through the middle of its subject. The purpose is a
 * statement about WHERE the image goes, which is something the model genuinely
 * knows; the shape follows from it, which is something the renderer knows.
 *
 * ★ SO IS THE GENERATION CONTRACT. The detailed instruction stays in the
 * validated Markdown prompt; this declaration makes the model resolve exact
 * store-owned source images before it spends the merchant's credits.
 */
const generateStorefrontImage: MinkTool = {
  declaration: {
    name: "generate_storefront_image",
    description:
      "Create one charged, high-resolution AI storefront campaign image or blog cover, save it immediately in this store's Media Library, and return its exact URL. A request to create a blog includes one blog cover by default unless the merchant supplied or explicitly chose an existing image. BEFORE every generation, read the source that matches the request: search_products/get_current_product for a named or selected product, search_storefront_categories for a named category, and list_storefront_media for a particular saved image or for general store visual context. Pass up to four exact relevant URLs from those results in reference_image_urls; pass [] only after the relevant read found no suitable image. The image model receives those files, not merely their URLs. A named product or category must be grounded in its authentic images rather than replaced with an invented stand-in; a specific saved image must guide the new composition exactly as the user requested. Infer purpose from the requested destination: hero for the top/lead area, gallery for a square tile, feature for an image beside text, banner for a full-width promo strip, blog_cover for a 16:9 editorial article cover, and product for a PRODUCT PHOTO of one existing item, in the shape of this store's product cards: a clean studio photograph when the merchant named no setting, otherwise the item photographed the way they describe it (for example hanging from a tree in a garden, folded on a marble counter, or worn by a model in a forest). A product purpose is refused unless reference_image_urls carries a real photo of that item: the product's own image from search_products or get_current_product, or the exact Media URL of a photo the merchant attached; Mink never invents a product from a description. When the merchant asks to change a product photo made earlier in this conversation ('now on a model in a forest', 'make it a close-up'), call this again with purpose product, passing the item's real photo FIRST and the earlier photo's exact URL second, and describe the complete new scene in prompt. A person may appear only in a product photo and only when the merchant asked for one (a model wearing or holding it): an adult, never a real or famous person. Write a complete creative brief in prompt: central idea, visual hierarchy, subject placement, setting, supporting props, background, depth, lighting, palette, mood and crop-safe negative space. A blog cover must express the article's central idea as one coherent editorial scene and must not contain the title in the pixels. For a sale or offer, visually communicate the occasion with an original, catchy campaign composition (for example paired product rhythm for buy-one-get-one) rather than pasting a cutout onto a plain background; keep all offer wording editable outside the image. A hero, gallery, feature, banner or blog_cover result is AI-generated campaign/editorial artwork and cannot be written to a product's catalogue images. A product result can: when the merchant asked for the product's photo, continue in the same run with propose_product_images and the exact returned URL (replace_primary unless they asked to add to the gallery), which is still a private proposal they approve. If the request also asks for a blog, immediately use the returned URL as cover_image_url in propose_blog_draft in the same run; stopping here or asking the merchant to attach it manually is incomplete. If it names a page destination, use the returned URL in propose_storefront_layout in the same run when available. Do not add new text, watermarks or signatures, and add people only to a product photo whose merchant asked for a model. Do not pass arbitrary web URLs, guessed URLs, unrelated products, or references the read tools did not return.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        purpose: {
          type: "string",
          enum: [...MINK_MEDIA_PURPOSES],
          description: MINK_MEDIA_PURPOSES.map(
            (purpose) =>
              `${purpose}: ${MINK_MEDIA_PURPOSE_SPECS[purpose].placement} (${MINK_MEDIA_PURPOSE_SPECS[purpose].aspectRatio}).`,
          ).join(" "),
        },
        prompt: {
          type: "string",
          minLength: MINK_MEDIA_PROMPT_MIN_CHARS,
          maxLength: MINK_MEDIA_PROMPT_MAX_CHARS,
          description:
            "A complete creative brief in plain English: central idea, visual hierarchy, full-subject placement, setting, supporting props, depth, lighting, palette, mood and crop-safe negative space. For a product photo (purpose product), name the product and describe the setting, presentation, model, angle and light the merchant asked for (a plain studio background when they named none); the item itself comes from the real reference photo and must not be restyled. For a blog cover, translate the article's theme into one coherent editorial scene without title text. For an offer, describe an original promotional composition that communicates its energy visually without putting offer text in the pixels. Never request a simple pasted cutout unless the merchant explicitly asked for one.",
        },
        reference_image_urls: {
          type: "array",
          minItems: 0,
          maxItems: MINK_MEDIA_REFERENCE_MAX,
          uniqueItems: true,
          description:
            "Exact relevant PNG, JPEG or WebP URLs returned by search_products, get_current_product, search_storefront_categories or list_storefront_media immediately before this call. Preserve relevance order. Use [] only when the relevant reads returned no suitable image.",
          items: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
          },
        },
        alt: {
          type: "string",
          minLength: 1,
          maxLength: MINK_MEDIA_ALT_MAX_CHARS,
          description:
            "Alt text describing what a shopper would see, for screen readers and for search. Required: nothing else in the dashboard will ask for it later.",
        },
      },
      required: ["purpose", "prompt", "reference_image_urls", "alt"],
      additionalProperties: false,
    },
  },
  // ★ MEDIA MANAGE, NOT BUILDER. The artefact is saved to the Media Library;
  //   placing it is a separate layout proposal with its own Builder gate.
  permission: { section: "media", action: "manage" },
  available,
  timeoutMs: MEDIA_TOOL_TIMEOUT_MS,
  runBudgetMs: MEDIA_TOOL_RUN_BUDGET_MS,
  // ★ The run claims it has acted inside `commit`, just before the Media row
  //   and the charged draft (run-stop.ts): a stop during the draw still wins,
  //   the draw is abandoned and nothing is stored or charged. StoreMink keeps
  //   the cost of a draw Google billed (owner's decision, 25 Oct 2026).
  effect: "commit",
  artifact(output) {
    const proposal = output.proposal as MinkArtifact | undefined;
    return proposal?.type === "media_image_proposal" ? proposal : undefined;
  },
  async execute(actor, args, context) {
    const proposal = await createMinkMediaImageProposal({
      actor,
      purpose: args.purpose,
      prompt: args.prompt,
      referenceImageUrls: args.reference_image_urls,
      alt: args.alt,
      // ★ The deadline and the stop: the provider call is aborted when it
      //   fires, and nothing is stored, saved or charged after it.
      context,
    });
    return {
      proposal,
      authority: {
        savedToMediaLibrary: true,
        canUseInLayoutProposal: true,
        canUseInBlogProposal: true,
        canPlaceDirectlyOnStorefront: false,
        canUseAsProductPhoto: proposal.purpose === "product",
        canCreateFromOwnedReferences: true,
        canOverwriteReferenceImages: false,
      },
    };
  },
};

export const minkMediaTools = [generateStorefrontImage];
