import "server-only";

import {
  DESIGN_PALETTE_TOKENS,
  DESIGN_PILL_MAX,
  DESIGN_RADIUS_MAX,
  DESIGN_SHAPE_KEYS,
} from "@/lib/chrome/design";
import {
  MINK_PERSONALIZATION_MAX_CATEGORY_CHANGES,
  MINK_PERSONALIZATION_MAX_PAGES,
} from "../storefront-personalization-contract";
import {
  readPersonalizationTarget,
  summarizePersonalizationTarget,
} from "../storefront-personalization-context";
import { createMinkStorefrontPersonalizationProposal } from "../storefront-personalization-proposals";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

const available = (actor: MinkActorContext) => actor.draftingEnabled === true;

export const PERSONALIZATION_PROPOSAL_TOOL =
  "propose_storefront_personalization";

const getPersonalizationContext: MinkTool = {
  declaration: {
    name: "get_storefront_personalization_context",
    description:
      "Read what a storefront personalisation would change: the store's pages with how much theme text and how many theme photos each has, the sample sections that would be hidden, the header and footer copy, the current look with the theme's colours and the font pairings, the categories (and which came with the theme), the theme's sample products, the store's own delivery, returns, pickup and payment facts, and how many new photos fit this time. Call it before interviewing the merchant about personalising their storefront, and again for a fresh designDigest if the look changed. Read-only.",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  permission: { section: "builder", action: "view" },
  available,
  timeoutMs: 15_000,
  repeatSafe: true,
  async execute(actor) {
    const target = await readPersonalizationTarget(actor);
    return { context: summarizePersonalizationTarget(target) };
  },
};

/**
 * ★ KEPT SMALL ON PURPOSE: a declaration is re-sent on every model step, and
 * `prompt-budget.test.ts` holds each one under 6,000 characters. The design
 * vocabulary (font keys, pairings, the theme's colours) comes back from the
 * context read rather than living here, and the validator names any value it
 * refuses.
 */
const proposeStorefrontPersonalization: MinkTool = {
  declaration: {
    name: PERSONALIZATION_PROPOSAL_TOOL,
    description:
      "Create ONE charged private proposal that personalises the merchant's whole storefront from their interview answers. StoreMink rewrites every page's theme text for their business (store policies never), draws new photos for the most visible theme photos that fit their credits (their own uploads and photos Mink made are kept), applies the look you choose, rewrites the announcement, newsletter, tagline and footer description, makes only the category changes the merchant CONFIRMED, and can take the theme's sample products off the shop. Sample quotes, press logos, countdowns and other sample claims are switched off, not rewritten. Call get_storefront_personalization_context first and interview the merchant; call this only once you know what they sell and how the store should look. It takes a minute or two and saves nothing: the merchant reviews one card and applies it to the Website Builder draft.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        brief: {
          type: "object",
          properties: {
            business_name: { type: "string", maxLength: 120 },
            what_you_sell: {
              type: "string",
              minLength: 3,
              maxLength: 600,
              description: "What the store sells, in the merchant's words.",
            },
            look_and_feel: {
              type: "string",
              minLength: 3,
              maxLength: 400,
              description: "How the merchant wants the store to look and feel.",
            },
            audience: { type: "string", maxLength: 300 },
            tone: { type: "string", maxLength: 200 },
            story: {
              type: "string",
              maxLength: 1_200,
              description: "The shop's story, only as the merchant told it.",
            },
            facts: {
              type: "array",
              maxItems: 15,
              items: { type: "string", maxLength: 200 },
              description:
                "True statements the merchant gave (where they are, how things are made). Never your guesses.",
            },
            avoid: { type: "string", maxLength: 300 },
            language: {
              type: "string",
              maxLength: 40,
              description:
                "English unless the merchant asked for another language.",
            },
          },
          required: ["what_you_sell", "look_and_feel"],
          additionalProperties: false,
        },
        photo_direction: {
          type: "string",
          maxLength: 500,
          description:
            "One photographic style for every new photo: setting, light, colours, props. Goods and settings only, never people.",
        },
        pages: {
          type: ["array", "null"],
          maxItems: MINK_PERSONALIZATION_MAX_PAGES,
          items: { type: "string", maxLength: 60 },
          description:
            "Page slugs, or null for the default set (the homepage and every page the merchant has not edited). Name an edited page only after they agreed.",
        },
        design: {
          type: ["object", "null"],
          properties: {
            expected_design_digest: {
              type: "string",
              minLength: 64,
              maxLength: 64,
            },
            palette: {
              type: "object",
              properties: Object.fromEntries(
                DESIGN_PALETTE_TOKENS.map((token) => [
                  token,
                  { type: ["string", "null"] },
                ]),
              ),
              additionalProperties: false,
            },
            fonts: {
              type: "object",
              properties: {
                body: { type: ["string", "null"] },
                display: { type: ["string", "null"] },
              },
              additionalProperties: false,
            },
            shape: {
              type: "object",
              properties: Object.fromEntries(
                DESIGN_SHAPE_KEYS.map((key) => [
                  key,
                  {
                    type: ["integer", "null"],
                    minimum: 0,
                    maximum:
                      key === "pill" ? DESIGN_PILL_MAX : DESIGN_RADIUS_MAX,
                  },
                ]),
              ),
              additionalProperties: false,
            },
          },
          required: ["expected_design_digest"],
          additionalProperties: false,
          description:
            "The new look, or null to keep it. expected_design_digest is look.designDigest unchanged. Palette values are hex colours such as #1a1a1a (cream is the page background, surface a card, ink body text, inkSoft muted text, inkFaint the faintest, border a hairline, accent the brand colour); fonts are keys from look.fonts, and a look.fontPairings pair suits most briefs; shape values are corner radii in pixels. null keeps the theme's value. Text must keep 4.5:1 contrast, or the failing pairs come back.",
        },
        categories: {
          type: ["array", "null"],
          maxItems: MINK_PERSONALIZATION_MAX_CATEGORY_CHANGES,
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["update", "create", "hide"] },
              slug: { type: "string", maxLength: 80 },
              name: { type: "string", maxLength: 80 },
              description: { type: "string", maxLength: 500 },
              new_photo: { type: "boolean" },
              merchant_confirmed: { type: "boolean" },
            },
            required: ["action", "merchant_confirmed"],
            additionalProperties: false,
          },
          description:
            "Only category changes the merchant agreed to, each with merchant_confirmed true; null for none. slug names an existing category (update, hide) or the new one's address (create, optional); new_photo draws a photo for it.",
        },
        unpublish_sample_products: {
          type: "boolean",
          description:
            "true to take the theme's published sample products (named '(Sample)') off the shop.",
        },
        photos_only: {
          type: "boolean",
          description:
            "true to make new photos for the theme photos still left and change nothing else: 'make the rest of the photos' after an earlier personalisation was applied.",
        },
        explanation: {
          type: "string",
          minLength: 1,
          maxLength: 1_000,
          description:
            "One or two plain sentences on what this changes. Never claim it was saved or published.",
        },
      },
      required: ["brief", "unpublish_sample_products", "explanation"],
      additionalProperties: false,
    },
  },
  permission: { section: "builder", action: "manage" },
  available,
  // ★ LONG ON PURPOSE: the writer and up to twelve photos run inside this
  //   call. The proposal holds its own deadline below this, and the stream
  //   route extends the run's budget while it runs.
  timeoutMs: 200_000,
  // The tool's own 200 s, then a minute for the model to write its answer.
  runBudgetMs: 260_000,
  stepLimitCompletionText:
    "Your personalised storefront is ready. Review the card below and apply it to your Website Builder draft when you are happy with it.",
  artifact(output) {
    const proposal = output.proposal as MinkArtifact | undefined;
    return proposal?.type === "storefront_personalization_proposal"
      ? proposal
      : undefined;
  },
  async execute(actor, args) {
    const proposal = await createMinkStorefrontPersonalizationProposal({
      actor,
      args,
    });
    // ★ THE MODEL GETS A SUMMARY, NEVER THE PLAN OR A CREDIT FIGURE: what
    //   changed, what was left out and why, and what is live at once.
    return {
      proposal,
      summary: {
        pages: proposal.pages.map((page) => ({
          page: page.title,
          textChanges: page.textChanges,
          newPhotos: page.photoChanges,
          hiddenSampleSections: page.hidden.length,
        })),
        newPhotos: proposal.photos.length,
        lookChanged: proposal.design !== null,
        headerFooterChanges: proposal.chrome.map((entry) => entry.label),
        categoryChanges: proposal.categories.length,
        sampleProductsToUnpublish: proposal.products.length,
        notDoneThisTime: proposal.skipped,
        liveAtOnceWhenApplied: proposal.live,
      },
      authority: {
        canPreview: true,
        canSaveBuilderDraft: false,
        canPublish: false,
      },
    };
  },
};

export const minkStorefrontPersonalizationTools = [
  getPersonalizationContext,
  proposeStorefrontPersonalization,
];
