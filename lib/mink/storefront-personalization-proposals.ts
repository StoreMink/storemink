import "server-only";

import { ThinkingLevel } from "@google/genai";
import { and, eq, inArray } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { mediaAssets, minkActionToolAccess } from "@/drizzle/schema";
import { EMPTY_DESIGN_OVERRIDES } from "@/lib/chrome/design";
import { withService } from "@/lib/db/client";
import { uploadRefusal } from "@/lib/moderation/copy";
import { isBlockedUploadError } from "@/lib/moderation/upload-guard";
import { logError, logInfo } from "@/lib/observability/logger";
import { sanitizeBlogContent } from "@/lib/sanitize";
import {
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { gcsConfigured, gcsDeletePaths } from "@/lib/storage/gcs";
import { writeStoreObject } from "@/lib/storage/store-objects";
import { getMinkConfig } from "./config";
import { createMinkDraftProposal } from "./drafts";
import { MinkRequestError, MinkToolInputError } from "./errors";
import {
  MINK_GENERATED_MEDIA_FOLDER,
  MINK_MEDIA_GENERATION_SCHEMA_VERSION,
  type MinkMediaPurpose,
} from "./media-generation-contract";
import {
  generateMinkMediaImage,
  isUnbilledImageFailure,
} from "./media-generation";
import { minkPrefillBodyToHtml } from "./prefill-html";
import {
  claimSpendLimits,
  MINK_IMAGE_GLOBAL_LIMIT,
  releaseSpendLimits,
  type SpendLimit,
} from "./spend-limits";
import { digestMinkStorefrontValue } from "./storefront-code-contract";
import {
  digestMinkStorefrontDesign,
  summarizeDesignChange,
  validateMinkStorefrontDesignPatch,
  MINK_STOREFRONT_DESIGN_SCHEMA_VERSION,
} from "./storefront-design-contract";
import {
  assertLayoutPreservesCustomCode,
  digestMinkStorefrontSections,
} from "./storefront-layout-contract";
import {
  assertLayoutMediaIsOwned,
  collectSectionMediaUrls,
} from "./storefront-media-policy";
import { readOwnedStorefrontImageUrls } from "./storefront-media-read";
import {
  MINK_PERSONALIZATION_MAX_CREDITS,
  MINK_PERSONALIZATION_MAX_PHOTOS,
  MINK_PERSONALIZATION_PRICES,
  MINK_PERSONALIZATION_SCHEMA_VERSION,
  PERSONALIZATION_PHOTO_ASPECT,
  applyPersonalizationToPage,
  buildPageInventory,
  categorySlugFromName,
  comparePhotos,
  newRefCounter,
  personalizationLiveChanges,
  planPersonalizationBudget,
  readPersonalizationRequest,
  type PersonalizationPageInventory,
  type PersonalizationPhotoRef,
  type PersonalizationRequest,
  type PersonalizationStoredCategory,
  type PersonalizationStoredPage,
  type PersonalizationStoredPlan,
} from "./storefront-personalization-contract";
import {
  assertBuilderAccess,
  eligiblePages,
  hasChromeText,
  readPersonalizationTarget,
  type PersonalizationTarget,
} from "./storefront-personalization-context";
import { writePersonalizationCopy } from "./storefront-personalization-writer";
import { MAX_RUN_BUDGET_MS } from "./tools/registry";
import type { MinkActorContext, MinkArtifact } from "./types";

// ---------------------------------------------------------------------------
// One charged, immutable proposal that personalises the whole storefront.
//
// ★★ EVERYTHING THAT CAN BE REFUSED IS REFUSED BEFORE A PAID CALL. The
//    request, the design's contrast, the categories, the permissions, the
//    tool gate and the store's credits are all checked first; only then does
//    the writer run and the image model draw. A merchant is never charged
//    for a proposal that could not have been approved.
//
// ★★ THE PHOTOS ARE DRAWN NOW, NOT AT APPROVAL, for 9E's reason: a card
//    that describes a picture asks a merchant to approve an image nobody has
//    looked at. Each one is saved to the Media Library as it is made (the
//    layout guard's ownership rule needs the row), so a proposal the
//    merchant discards still leaves its pictures in Media, as 9E's do.
//
// ★ THE CHARGE IS FOR WHAT WAS MADE: a page whose text changed, a photo that
//   came back, the look if it changed. A photo the image service refused is
//   not charged and its slot keeps the theme's picture, which the card says.
// ---------------------------------------------------------------------------

const APPLY_TOOL = "apply_storefront_personalization";
/** Everything (writer, photos) must be done by this, inside the run's budget. */
const PROPOSAL_DEADLINE_MS = 170_000;
const PHOTO_CONCURRENCY = 3;

type ProposalArtifact = Extract<
  MinkArtifact,
  { type: "storefront_personalization_proposal" }
>;

export async function createMinkStorefrontPersonalizationProposal(input: {
  actor: MinkActorContext;
  args: Record<string, unknown>;
}): Promise<ProposalArtifact> {
  const { actor } = input;
  assertBuilderAccess(actor, "manage");
  if (!actor.runId) {
    throw new MinkToolInputError("The draft run is not available. Try again.");
  }
  const parsed = readPersonalizationRequest(input.args);
  if (!parsed.ok) {
    throw new MinkToolInputError(
      `The personalisation request is incomplete: ${parsed.issues.join(" ")}`,
    );
  }
  const request = parsed.value;
  if (
    request.categories.length &&
    !can(actor.permissions, "categories", "manage", actor.isSuperadmin)
  ) {
    throw new MinkToolInputError(
      "Changing categories needs Categories manage permission. Leave categories out, or ask someone who has it.",
    );
  }
  if (
    request.unpublishSampleProducts &&
    !can(actor.permissions, "products", "manage", actor.isSuperadmin)
  ) {
    throw new MinkToolInputError(
      "Taking the sample products off the shop needs Products manage permission. Set unpublish_sample_products to false, or ask someone who has it.",
    );
  }
  await assertToolEnabled(actor.storeId, APPLY_TOOL);

  const target = await readPersonalizationTarget(actor);
  const pages = eligiblePages(target, request.pages, {
    photosOnly: request.photosOnly,
  });
  if (request.pages) {
    const known = new Set(pages.map((page) => page.slug));
    const missing = request.pages.filter((slug) => !known.has(slug));
    if (missing.length) {
      throw new MinkToolInputError(
        `These pages cannot be personalised: ${missing.join(", ")}. Use slugs from get_storefront_personalization_context; store policies are never rewritten.`,
      );
    }
  }
  if (!pages.length) {
    throw new MinkToolInputError(
      target.pages.some((page) => page.skipped === null)
        ? "Every page has been edited by the merchant, so none is personalised without their yes. Ask which pages to include (only the theme's own sections there change), then pass their slugs in pages."
        : "There is no page to personalise. Every page is a policy or has a Builder draft that needs fixing first.",
    );
  }

  const design = readDesign(request, target);
  const categoryPlan = planCategories(request, target);
  const sampleProducts =
    request.unpublishSampleProducts && target.sampleProducts
      ? target.sampleProducts.filter(
          (product) => product.status === "published",
        )
      : [];

  // ---- The inventory and the budget --------------------------------------
  const counter = newRefCounter();
  const inventories = new Map<string, PersonalizationPageInventory>();
  for (const page of pages) {
    inventories.set(
      page.slug,
      buildPageInventory(
        page.slug,
        page.title,
        page.sections,
        counter,
        new Set(page.themeSectionIds),
      ),
    );
  }
  const categoryPhotos: PersonalizationPhotoRef[] = categoryPlan.flatMap(
    (change, index) => {
      if (change.action === "hide" || !change.newPhoto) return [];
      counter.photo += 1;
      counter.order += 1;
      return [
        {
          ref: `p${counter.photo}`,
          pageSlug: "home",
          sectionId: `category:${index}`,
          sectionType: "shop_by_category" as const,
          path: ["image_url"],
          altPath: null,
          clears: [],
          label: `Photo for the ${change.name} category`,
          shape: "square" as const,
          current:
            change.action === "update" ? (change.before.imageUrl ?? "") : "",
          rank: 2,
          order: counter.order,
          categorySlug: change.slug,
        },
      ];
    },
  );
  const notes: Array<{ label: string; reason: string }> = [];
  const pagePhotos = [...inventories.values()].flatMap(
    (inventory) => inventory.photos,
  );
  let photoCandidates = target.photos.allowed
    ? [...pagePhotos, ...categoryPhotos]
    : [];
  if (!target.photos.allowed && (pagePhotos.length || categoryPhotos.length)) {
    notes.push({
      label: "New photos",
      reason:
        target.photos.reason ?? "New photos are not available for this store.",
    });
  }
  if (photoCandidates.length && !gcsConfigured) {
    photoCandidates = [];
    notes.push({
      label: "New photos",
      reason: "Media storage is not set up, so the theme's photos stay.",
    });
  }
  const chromeChanges =
    !request.photosOnly &&
    (hasChromeText(target.chrome.value) ||
      target.brand.tagline !== null ||
      target.brand.blurb !== null);
  if (request.photosOnly && !photoCandidates.length) {
    throw new MinkToolInputError(
      notes.length
        ? `No new photos can be made: ${notes[0].reason}`
        : "There are no theme photos left to replace on these pages. Every picture there is the merchant's own or one Mink already made.",
    );
  }
  const budget = planPersonalizationBudget({
    remaining: target.headroom.remaining,
    pages: pages.map((page) => page.slug),
    design: design !== null,
    chrome: chromeChanges,
    categoryCount: categoryPlan.length,
    categorySlugs: categoryPlan.map((change) => change.slug),
    photos: photoCandidates,
    photosOnly: request.photosOnly,
  });
  const includedPages = new Set(
    budget.included.flatMap((item) =>
      item.kind === "page" ? [item.pageSlug] : [],
    ),
  );
  const includedPhotoRefs = new Set(
    budget.included.flatMap((item) =>
      item.kind === "photo" ? [item.ref] : [],
    ),
  );
  if (request.photosOnly ? !includedPhotoRefs.size : !includedPages.size) {
    throw new MinkToolInputError(
      request.photosOnly
        ? "This store doesn't have enough Mink credits left for a new photo. Buy Mink credits or upgrade under Plans & Billing."
        : "This store doesn't have enough Mink credits left to personalise the storefront. Buy Mink credits or upgrade under Plans & Billing.",
    );
  }
  const photos = photoCandidates
    .filter((photo) => includedPhotoRefs.has(photo.ref))
    .sort(comparePhotos);
  const designIncluded = budget.included.some((item) => item.kind === "design");
  const chromeIncluded = budget.included.some((item) => item.kind === "chrome");
  const includedCategoryIndexes = new Set(
    budget.included.flatMap((item) =>
      item.kind === "category" ? [item.index] : [],
    ),
  );
  const categories = categoryPlan.filter((_, index) =>
    includedCategoryIndexes.has(index),
  );
  describeBudgetGaps(budget, pages, categoryPlan, notes);

  // ---- The attempt, claimed before any paid call -------------------------
  const attempt = attemptLimits(actor);
  const claim = await claimSpendLimits([attempt.running, attempt.daily]);
  if (!claim.ok) {
    throw new MinkRequestError(
      "personalization_rate_limit",
      claim.refusedKey === attempt.running.key
        ? "Mink is already personalising this storefront. Wait for that card to appear, then ask again if you still need to."
        : "This store has had six personalised storefront cards today. Ask again tomorrow, or change single things in Website Builder.",
      429,
    );
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), PROPOSAL_DEADLINE_MS);
  const created: Array<{ path: string }> = [];
  let proposalSaved = false;
  try {
    // ---- The writer -------------------------------------------------------
    // ★ A page whose words were not bought still has its photos described:
    //   the writer writes every scene, so a page left out of the copy but
    //   holding a bought photo goes in with its text fields taken away.
    const writerPages = pages.flatMap((page) => {
      const inventory = inventories.get(page.slug)!;
      if (includedPages.has(page.slug)) return [inventory];
      const hasPhoto = photos.some(
        (photo) => photo.pageSlug === page.slug && !photo.categorySlug,
      );
      return hasPhoto
        ? [{ ...inventory, texts: [], lists: [], hidden: [] }]
        : [];
    });
    const copy = await writePersonalizationCopy({
      config: getMinkConfig(),
      brief: request.brief,
      storeName: target.storeName,
      facts: target.facts,
      brandVoice: actor.brandVoice ?? null,
      pages: writerPages,
      photos,
      chrome: chromeIncluded
        ? {
            announcement: target.chrome.value.header.announcement.enabled
              ? { current: target.chrome.value.header.announcement.text }
              : null,
            newsletter: target.chrome.value.footer.newsletter.enabled
              ? {
                  heading: target.chrome.value.footer.newsletter.heading,
                  subtext: target.chrome.value.footer.newsletter.subtext,
                  buttonLabel:
                    target.chrome.value.footer.newsletter.buttonLabel,
                }
              : null,
            tagline: target.brand.tagline,
            blurb: target.brand.blurb,
          }
        : { announcement: null, newsletter: null, tagline: null, blurb: null },
      categories: categories.flatMap((change, index) =>
        change.action === "hide"
          ? []
          : [
              {
                ref: `c${index}`,
                name: change.name,
                description: change.description,
                writeDescription: !change.description,
              },
            ],
      ),
      abortSignal: deadline.signal,
    });

    // ---- The photos -------------------------------------------------------
    // ★ CLAIMED NOW, AFTER THE WRITER, and only for photos it described: a
    //   writer that failed used to spend the day's photo allowance on
    //   pictures nobody drew. All or none (spend-limits.ts).
    let toDraw = photos.filter((photo) => {
      if (copy.photos.has(photo.ref)) return true;
      notes.push({
        label: photo.label,
        reason:
          "No photo description came back, so it keeps the theme's picture.",
      });
      return false;
    });
    // The photo claim's own time: a give-back lands only in the windows that
    // counted it (spend-limits.ts).
    let photoClaimedAt: string | undefined;
    if (toDraw.length) {
      const photoClaim = await claimSpendLimits(
        photoLimits(actor, toDraw.length),
      );
      if (!photoClaim.ok) {
        if (request.photosOnly) {
          throw new MinkToolInputError(
            "Today's limit for new photos is reached. Ask again tomorrow for new ones.",
          );
        }
        notes.push({
          label: "New photos",
          reason:
            "Today's limit for new photos is reached, so the theme's photos stay. Ask again tomorrow for new ones.",
        });
        toDraw = [];
      } else {
        photoClaimedAt = photoClaim.claimedAt;
      }
    }
    const drawn = new Map<string, { url: string; alt: string; path: string }>();
    const photoWhere = new Map<string, string>();
    // ★★ A PHOTO GOOGLE NEVER DREW GIVES ITS SHARE BACK (robustness audit B3,
    //   the rule chat images and Refine follow). Counted per photo: every try
    //   it sent answered 429, or none was sent (`isUnbilledImageFailure`;
    //   `generateMinkMediaImage` throws those itself through
    //   `requestMinkImage`), or the proposal's time ran out before its turn.
    //   Never a timeout or a 5xx after sending, a filtered answer or a picture
    //   that came back: Google may have billed those, and the platform's hour
    //   is what bounds the bill. (Credits are charged only for drawn photos,
    //   at card save, so "Nothing was charged" stays true either way.)
    let unbilledPhotos = 0;
    await runPool(toDraw, PHOTO_CONCURRENCY, async (photo) => {
      const brief = copy.photos.get(photo.ref);
      if (!brief || deadline.signal.aborted) {
        unbilledPhotos += 1; // never sent
        return;
      }
      let drew = false;
      try {
        const image = await generateMinkMediaImage(
          getMinkConfig(),
          {
            schemaVersion: MINK_MEDIA_GENERATION_SCHEMA_VERSION,
            purpose: purposeForShape(photo.shape),
            prompt: brief.scene.slice(0, 600),
            referenceImageUrls: [],
            alt: brief.alt,
            slotAspectRatio: PERSONALIZATION_PHOTO_ASPECT[photo.shape],
          },
          [],
          {
            abortSignal: deadline.signal,
            rateLimitRetries: 2,
            // ★★ Owner, 25 Oct 2026: "2K", so a full-width banner stays
            //   sharp, with MINIMAL thinking.
            imageSize: "2K",
            thinkingLevel: ThinkingLevel.MINIMAL,
          },
        );
        drew = true;
        const extension = image.mimeType === "image/png" ? "png" : "jpg";
        const path = `stores/${actor.storeId}/${MINK_GENERATED_MEDIA_FOLDER}/${crypto.randomUUID()}.${extension}`;
        // Through the store's one writer (takedown design 5.7): bytes
        // StoreMink has blocked on this store are refused, nothing is written.
        const url = await writeStoreObject(path, image.bytes, image.mimeType, {
          storeId: actor.storeId,
          via: "mink_personalization",
          actor: actor.adminId,
        });
        created.push({ path });
        await withService((db) =>
          db.insert(mediaAssets).values({
            storeId: actor.storeId,
            url,
            path,
            filename: `storefront-${photo.shape}-${Date.now()}.${extension}`,
            contentType: image.mimeType,
            sizeBytes: image.bytes.length,
            createdBy: actor.adminId,
            source: "mink_generated",
          }),
        );
        drawn.set(photo.ref, { url, alt: brief.alt, path });
        photoWhere.set(photo.ref, photoLabel(photo, target));
      } catch (error) {
        if (!drew && isUnbilledImageFailure(error)) unbilledPhotos += 1;
        // A picture StoreMink has blocked (takedown design 7.4) is said in
        // the design's own words; the guard has already logged it.
        if (isBlockedUploadError(error)) {
          notes.push({
            label: photo.label,
            reason: uploadRefusal({
              told: error.told,
              kindWord: error.kindWord,
            }),
          });
          return;
        }
        if (
          !(
            error instanceof MinkRequestError ||
            error instanceof MinkToolInputError
          )
        ) {
          logError("mink.personalization: photo failed", error, {
            storeId: actor.storeId,
            ref: photo.ref,
          });
        }
        notes.push({
          label: photo.label,
          reason:
            error instanceof MinkToolInputError
              ? "The image service turned down this picture, so it keeps the theme's photo. Nothing was charged for it."
              : "The image service did not return this picture in time, so it keeps the theme's photo. Nothing was charged for it.",
        });
      }
    });
    // ★ Once, after the pool, in one call: the store's day of photos and the
    //   platform's image hour, one unit of each per unbilled photo, only in
    //   the windows the claim was counted in. Best effort: it never throws.
    if (unbilledPhotos > 0) {
      await releaseSpendLimits(
        photoLimits(actor, unbilledPhotos),
        photoClaimedAt ? { claimedAt: photoClaimedAt } : {},
      );
    }

    // ---- Apply to each page and re-validate --------------------------------
    // ★★ COUNTED AFTER VALIDATION. A section `validatePage` puts back to the
    //   theme's version takes its new words and its new photo with it, so
    //   only changes in the sections that survive are counted, charged and
    //   shown; a photo that went with a reverted section is used nowhere.
    const usedPhotoRefs = new Set<string>();
    const storedPages: PersonalizationStoredPage[] = [];
    let pagesCharged = 0;
    for (const page of pages) {
      const inventory = inventories.get(page.slug)!;
      const copyIncluded = includedPages.has(page.slug);
      const applied = applyPersonalizationToPage({
        sections: page.sections,
        inventory: copyIncluded
          ? inventory
          : { ...inventory, texts: [], lists: [], hidden: [] },
        texts: copy.texts,
        lists: copy.lists,
        photos: drawn,
        toHtml: (prose) => sanitizeBlogContent(minkPrefillBodyToHtml(prose)),
      });
      if (!applied.changedSectionIds.length) continue;
      const validated = await validatePage(
        actor.storeId,
        page.sections,
        applied.sections,
        new Set(applied.changedSectionIds),
        notes,
        page.title,
      );
      if (!validated) continue;
      const hiddenIds = new Set(
        applied.hiddenSectionIds.filter((id) => validated.changed.has(id)),
      );
      const textChanges = [...validated.changed].reduce(
        (sum, id) => sum + (applied.textChangesBySection[id] ?? 0),
        0,
      );
      const photosKept = applied.photosApplied.filter((photo) =>
        validated.changed.has(photo.sectionId),
      );
      for (const photo of photosKept) usedPhotoRefs.add(photo.ref);
      if (copyIncluded && (textChanges > 0 || hiddenIds.size > 0))
        pagesCharged += 1;
      storedPages.push({
        pageId: page.id,
        slug: page.slug,
        title: page.title,
        expectedVersion: page.updatedAt,
        expectedDigest: page.sectionsDigest,
        sections: validated.sections,
        proposedDigest: digestMinkStorefrontSections(validated.sections),
        textChanges,
        photoChanges: photosKept.length,
        hidden: [...hiddenIds].map((sectionId) => {
          const section = page.sections.find((entry) => entry.id === sectionId);
          const reason =
            inventory.hidden.find((entry) => entry.sectionId === sectionId)
              ?.reason ??
            "Nothing true to say here yet, so it is switched off.";
          return { sectionId, type: section?.type ?? "section", reason };
        }),
      });
    }

    // ---- Header, footer, store description ---------------------------------
    const chromeText = chromeIncluded ? copy.chrome : {};
    const announcementText =
      target.chrome.value.header.announcement.enabled &&
      chromeText.announcement &&
      chromeText.announcement !== target.chrome.value.header.announcement.text
        ? chromeText.announcement
        : null;
    const newsletterNow = target.chrome.value.footer.newsletter;
    const newsletter =
      newsletterNow.enabled && chromeText.newsletterHeading
        ? {
            heading: chromeText.newsletterHeading,
            subtext: chromeText.newsletterSubtext || newsletterNow.subtext,
            buttonLabel:
              chromeText.newsletterButton || newsletterNow.buttonLabel,
          }
        : null;
    const designChange = designIncluded ? design : null;
    const chromeChanged =
      announcementText !== null || newsletter !== null || designChange !== null;
    const tagline =
      chromeText.tagline && chromeText.tagline !== target.brand.tagline
        ? chromeText.tagline
        : null;
    const blurb =
      chromeText.blurb && chromeText.blurb !== target.brand.blurb
        ? chromeText.blurb
        : null;

    // ---- Categories --------------------------------------------------------
    const storedCategories: PersonalizationStoredCategory[] = categories.map(
      (change, index) => {
        const photoRef = categoryPhotos.find(
          (photo) => photo.categorySlug === change.slug,
        );
        const imageUrl = photoRef
          ? (drawn.get(photoRef.ref)?.url ?? null)
          : null;
        if (change.action === "hide") return change.stored;
        if (photoRef && imageUrl) usedPhotoRefs.add(photoRef.ref);
        const description =
          change.description ??
          copy.categoryDescriptions.get(`c${index}`) ??
          null;
        if (change.action === "update") {
          return {
            ...change.stored,
            name: change.name,
            description: description ?? change.before.description,
            imageUrl: imageUrl ?? change.before.imageUrl,
          };
        }
        return { ...change.stored, description, imageUrl };
      },
    );

    // ---- The charge: what was actually made -------------------------------
    const photosMade = usedPhotoRefs.size;
    const credits = {
      pages: pagesCharged * MINK_PERSONALIZATION_PRICES.page,
      photos: photosMade * MINK_PERSONALIZATION_PRICES.photo,
      design: designChange ? MINK_PERSONALIZATION_PRICES.design : 0,
      chrome:
        announcementText !== null ||
        newsletter !== null ||
        tagline !== null ||
        blurb !== null
          ? MINK_PERSONALIZATION_PRICES.chrome
          : 0,
      categories:
        storedCategories.length * MINK_PERSONALIZATION_PRICES.category,
      total: 0,
    };
    credits.total =
      credits.pages +
      credits.photos +
      credits.design +
      credits.chrome +
      credits.categories;
    if (credits.total < 1) {
      throw new MinkToolInputError(
        "Nothing on the storefront would change. Ask the merchant what they want different, then try again with their answers.",
      );
    }
    if (credits.total > MINK_PERSONALIZATION_MAX_CREDITS) {
      throw new Error("Personalisation charge is out of range");
    }

    const photosForCard = photos.flatMap((photo) => {
      const made = drawn.get(photo.ref);
      if (!made || !usedPhotoRefs.has(photo.ref)) return [];
      return [
        {
          url: made.url,
          path: made.path,
          alt: made.alt,
          where: photoWhere.get(photo.ref) ?? photo.label,
        },
      ];
    });
    const plan: PersonalizationStoredPlan = {
      schemaVersion: MINK_PERSONALIZATION_SCHEMA_VERSION,
      pages: storedPages,
      chrome: chromeChanged
        ? {
            expectedTextDigest: target.chrome.textDigest,
            expectedDesignDigest: target.chrome.designDigest,
            design: designChange,
            announcementText,
            newsletter,
          }
        : null,
      brand:
        tagline !== null || blurb !== null
          ? { expectedDigest: target.brand.digest, tagline, blurb }
          : null,
      categories: storedCategories,
      products: sampleProducts.map((product) => ({
        id: product.id,
        name: product.name,
        expectedUpdatedAt: product.updatedAt,
      })),
      photos: photosForCard,
      skipped: dedupeNotes(notes),
      explanation: request.explanation,
      credits,
    };
    const planJson = JSON.stringify(plan);
    const planDigest = digestMinkStorefrontValue(plan);

    const stored = await createMinkDraftProposal({
      actor,
      kind: "storefront_personalization",
      expectedCredits: credits.total,
      title: "Personalised storefront",
      destinationType: "storefront",
      destinationLabel: "Website Builder draft",
      destinationPath: "/dashboard/builder",
      content: {
        plan_json: planJson,
        plan_digest: planDigest,
        explanation: request.explanation,
      },
    });
    if (stored.type !== "proposal") {
      throw new Error("Personalisation persistence returned no proposal");
    }
    proposalSaved = true;
    // ★ A picture drawn for a section that was then put back is in no card:
    //   it was never charged, and it is removed rather than left in Media.
    const unused = [...drawn.entries()]
      .filter(([ref]) => !usedPhotoRefs.has(ref))
      .map(([, made]) => ({ path: made.path }));
    if (unused.length) await discardPhotos(actor.storeId, unused);
    logInfo("mink.personalization: proposed", {
      requestId: actor.requestId,
      storeId: actor.storeId,
      pages: storedPages.length,
      photos: photosMade,
      photoSlots: photoCandidates.length,
      categories: storedCategories.length,
      products: sampleProducts.length,
      skipped: plan.skipped.length,
      writerModel: copy.model,
      writerAttempts: copy.attempts,
    });
    return toArtifact(stored, plan, planDigest, target);
  } catch (error) {
    // ★ Pictures that belong to no proposal are removed. A picture that made
    //   it into a stored proposal is the merchant's (and stays in Media).
    if (created.length && !proposalSaved) {
      await discardPhotos(actor.storeId, created);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    // ★ The running claim is always given back, so a retry is never refused
    //   as though a card existed; the day's count only when this attempt
    //   ends without one (nothing was charged).
    await releaseSpendLimits(
      proposalSaved ? [attempt.running] : [attempt.running, attempt.daily],
    );
  }
}

// ---------------------------------------------------------------------------

function readDesign(
  request: PersonalizationRequest,
  target: PersonalizationTarget,
) {
  if (!request.design) return null;
  if (request.design.expectedDesignDigest !== target.chrome.designDigest) {
    throw new MinkToolInputError(
      "The store's look changed since you read it. Call get_storefront_personalization_context again and use its designDigest.",
    );
  }
  const fonts = request.design.fonts as { body?: unknown; display?: unknown };
  const validated = validateMinkStorefrontDesignPatch(
    {
      schemaVersion: MINK_STOREFRONT_DESIGN_SCHEMA_VERSION,
      operation: "replace_design_overrides",
      target: { expectedDesignDigest: request.design.expectedDesignDigest },
      design: {
        palette: request.design.palette ?? {},
        fonts: { body: fonts?.body ?? null, display: fonts?.display ?? null },
        shape: request.design.shape ?? {},
      },
    },
    target.themeDesign,
  );
  if (!validated.ok) {
    throw new MinkToolInputError(
      `The new look cannot be used: ${validated.issues.join(" ")}`,
    );
  }
  const next = validated.value.design;
  const current = target.chrome.value.design ?? EMPTY_DESIGN_OVERRIDES;
  return digestMinkStorefrontDesign(next) ===
    digestMinkStorefrontDesign(current)
    ? null
    : next;
}

type PlannedCategory =
  | {
      action: "update";
      slug: string;
      name: string;
      description: string | null;
      newPhoto: boolean;
      before: {
        name: string;
        description: string | null;
        imageUrl: string | null;
      };
      stored: Extract<PersonalizationStoredCategory, { action: "update" }>;
    }
  | {
      action: "create";
      slug: string;
      name: string;
      description: string | null;
      newPhoto: boolean;
      stored: Extract<PersonalizationStoredCategory, { action: "create" }>;
    }
  | {
      action: "hide";
      slug: string;
      name: string;
      stored: Extract<PersonalizationStoredCategory, { action: "hide" }>;
    };

function planCategories(
  request: PersonalizationRequest,
  target: PersonalizationTarget,
): PlannedCategory[] {
  if (!request.categories.length) return [];
  if (!target.categories) {
    throw new MinkToolInputError(
      "Changing categories needs Categories view permission.",
    );
  }
  const bySlug = new Map(
    target.categories.map((category) => [category.slug, category]),
  );
  const taken = new Set(target.categories.map((category) => category.slug));
  const touched = new Set<string>();
  const issues: string[] = [];
  const planned: PlannedCategory[] = [];
  for (const change of request.categories) {
    if (change.action === "create") {
      const slug = change.slug ?? categorySlugFromName(change.name);
      if (!slug) {
        // ★ A NAME WITH NO LATIN LETTERS MAKES NO ADDRESS ("मिठाई"): say so,
        //   rather than calling it taken, which sent the model to update a
        //   category that does not exist.
        issues.push(
          `A web address cannot be made from the name "${change.name}". Pass a slug for it in lowercase English letters, numbers and hyphens, such as "sweets".`,
        );
        continue;
      }
      if (taken.has(slug)) {
        issues.push(
          `A category with the address "${slug}" already exists: update that one, or choose another name.`,
        );
        continue;
      }
      taken.add(slug);
      planned.push({
        action: "create",
        slug,
        name: change.name,
        description: change.description,
        newPhoto: change.newPhoto,
        stored: {
          action: "create",
          slug,
          name: change.name,
          description: change.description,
          imageUrl: null,
        },
      });
      continue;
    }
    const existing = bySlug.get(change.slug);
    if (!existing) {
      issues.push(
        `There is no category "${change.slug}". Use slugs from the context.`,
      );
      continue;
    }
    if (touched.has(existing.slug)) {
      issues.push(`The category "${existing.slug}" is listed twice.`);
      continue;
    }
    touched.add(existing.slug);
    if (change.action === "hide") {
      planned.push({
        action: "hide",
        slug: existing.slug,
        name: existing.name,
        stored: {
          action: "hide",
          id: existing.id,
          slug: existing.slug,
          expectedUpdatedAt: existing.updatedAt,
          name: existing.name,
        },
      });
      continue;
    }
    const before = {
      name: existing.name,
      description: existing.description,
      imageUrl: existing.imageUrl,
    };
    planned.push({
      action: "update",
      slug: existing.slug,
      name: change.name ?? existing.name,
      description: change.description,
      newPhoto: change.newPhoto,
      before,
      stored: {
        action: "update",
        id: existing.id,
        slug: existing.slug,
        expectedUpdatedAt: existing.updatedAt,
        before,
        name: change.name ?? existing.name,
        description: change.description ?? existing.description,
        imageUrl: existing.imageUrl,
      },
    });
  }
  if (issues.length) throw new MinkToolInputError(issues.join(" "));
  return planned;
}

function describeBudgetGaps(
  budget: ReturnType<typeof planPersonalizationBudget>,
  pages: PersonalizationTarget["pages"],
  categories: readonly PlannedCategory[],
  notes: Array<{ label: string; reason: string }>,
) {
  const unaffordablePhotos = budget.unaffordable.filter(
    (item) => item.kind === "photo",
  ).length;
  for (const item of budget.unaffordable) {
    if (item.kind === "page") {
      const page = pages.find((entry) => entry.slug === item.pageSlug);
      notes.push({
        label: page?.title ?? item.pageSlug,
        reason: "Not enough Mink credits left for this page this time.",
      });
    } else if (item.kind === "design") {
      notes.push({
        label: "Colours and fonts",
        reason: "Not enough Mink credits left for the new look this time.",
      });
    } else if (item.kind === "chrome") {
      notes.push({
        label: "Header, footer and store description",
        reason: "Not enough Mink credits left for these this time.",
      });
    } else if (item.kind === "category") {
      notes.push({
        label: `Category: ${categories[item.index]?.name ?? ""}`,
        reason: "Not enough Mink credits left for this category this time.",
      });
    }
  }
  if (unaffordablePhotos) {
    notes.push({
      label: `${unaffordablePhotos} more photo${unaffordablePhotos === 1 ? "" : "s"}`,
      reason:
        "Not enough Mink credits left for these this time, so they keep the theme's pictures. The most visible ones were made first.",
    });
  }
  if (budget.overPhotoLimit.length) {
    const count = budget.overPhotoLimit.length;
    notes.push({
      label: `${count} more photo${count === 1 ? "" : "s"}`,
      reason: `One personalisation makes up to ${MINK_PERSONALIZATION_MAX_PHOTOS} new photos, the most visible first. Ask Mink to make the rest next.`,
    });
  }
}

/**
 * Validate a personalised page at the bar the Builder's Publish button sets,
 * for the sections this changes; every other section only has to be what it
 * already was. A section that fails goes back to the theme's version and is
 * named on the card, rather than failing the whole page.
 */
async function validatePage(
  storeId: string,
  original: readonly PageSectionItem[],
  proposed: PageSectionItem[],
  changed: Set<string>,
  notes: Array<{ label: string; reason: string }>,
  pageTitle: string,
): Promise<{ sections: PageSectionItem[]; changed: Set<string> } | null> {
  const originalById = new Map(
    original.map((section) => [section.id, section]),
  );
  const working = [...proposed];
  for (let attempt = 0; attempt <= working.length; attempt++) {
    const lenient = new Set(
      working
        .filter((section) => !changed.has(section.id))
        .map((section) => section.id),
    );
    const result = validateSections(working, {
      mode: "publish",
      lenientIds: lenient,
    });
    if (!("error" in result)) {
      if (
        assertLayoutPreservesCustomCode(result.sections, [...original]).length
      ) {
        return null;
      }
      const onPage = new Set(collectSectionMediaUrls([...original]));
      const candidates = collectSectionMediaUrls(result.sections).filter(
        (url) => !onPage.has(url),
      );
      const owned = await readOwnedStorefrontImageUrls(storeId, candidates);
      if (
        assertLayoutMediaIsOwned(result.sections, [...onPage, ...owned]).length
      ) {
        return null;
      }
      return changed.size ? { sections: result.sections, changed } : null;
    }
    const match = /^Section (\d+)/.exec(result.error);
    const index = match ? Number(match[1]) - 1 : -1;
    const failing = working[index];
    const fallback = failing ? originalById.get(failing.id) : undefined;
    if (!failing || !fallback || !changed.has(failing.id)) return null;
    working[index] = fallback;
    changed.delete(failing.id);
    notes.push({
      label: `${pageTitle}: a section`,
      reason:
        "The new text did not fit this section's rules, so it keeps the theme's version. Edit it in Website Builder.",
    });
  }
  return null;
}

function purposeForShape(
  shape: PersonalizationPhotoRef["shape"],
): MinkMediaPurpose {
  if (shape === "wide") return "hero";
  if (shape === "square") return "gallery";
  return "feature";
}

function photoLabel(
  photo: PersonalizationPhotoRef,
  target: PersonalizationTarget,
) {
  if (photo.categorySlug) return photo.label;
  const page = target.pages.find((entry) => entry.slug === photo.pageSlug);
  return `${page?.title ?? photo.pageSlug}: ${photo.label.toLowerCase()}`;
}

function dedupeNotes(notes: Array<{ label: string; reason: string }>) {
  const seen = new Set<string>();
  return notes
    .filter((note) => {
      const key = `${note.label}\u0000${note.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 30);
}

async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await work(item);
      }
    },
  );
  await Promise.all(runners);
}

async function discardPhotos(
  storeId: string,
  created: Array<{ path: string }>,
) {
  const paths = created.map((entry) => entry.path);
  await withService((db) =>
    db
      .delete(mediaAssets)
      .where(
        and(eq(mediaAssets.storeId, storeId), inArray(mediaAssets.path, paths)),
      ),
  ).catch(() => undefined);
  await gcsDeletePaths(paths).catch(() => []);
}

async function assertToolEnabled(storeId: string, toolName: string) {
  const rows = await withService((db) =>
    db
      .select({ enabled: minkActionToolAccess.enabled })
      .from(minkActionToolAccess)
      .where(
        and(
          eq(minkActionToolAccess.storeId, storeId),
          eq(minkActionToolAccess.toolName, toolName),
        ),
      )
      .limit(1),
  );
  if (!rows[0]?.enabled) {
    throw new MinkToolInputError(
      "StoreMink support has not enabled storefront personalisation for this store.",
    );
  }
}

/**
 * ★ A PERSONALISATION IS A SPEND EVENT IN ITS OWN RIGHT: up to twelve paid
 *   pictures and a long writer call.
 * ★★ ONE AT A TIME PER ADMIN, AS A RUNNING CLAIM, NOT A COOL-DOWN. A
 *   double-sent message or a retried turn is refused while the first attempt
 *   runs; the claim is given back when it ends, whatever the outcome, so a
 *   retry after a failure is never told to "review that card" when there is
 *   none. Its window (the longest a run may last) only matters if a process
 *   dies holding it. And at most six cards per store a day: the day's count is
 *   given back for an attempt that ends without a card.
 */
function attemptLimits(actor: MinkActorContext): {
  running: SpendLimit;
  daily: SpendLimit;
} {
  return {
    running: {
      key: `mink-personalize-running:${actor.storeId}:${actor.adminId}`,
      max: 1,
      windowSeconds: Math.ceil(MAX_RUN_BUDGET_MS / 1_000),
    },
    daily: {
      key: `mink-personalize-store:${actor.storeId}`,
      max: 6,
      windowSeconds: 86_400,
    },
  };
}

/** Photos count against the store's day and the platform's hour, together. */
function photoLimits(actor: MinkActorContext, count: number): SpendLimit[] {
  return [
    {
      key: `mink-personalize-images:${actor.storeId}`,
      max: 36,
      windowSeconds: 86_400,
      cost: count,
    },
    { ...MINK_IMAGE_GLOBAL_LIMIT, cost: count },
  ];
}

function toArtifact(
  stored: Extract<MinkArtifact, { type: "proposal" }>,
  plan: PersonalizationStoredPlan,
  planDigest: string,
  target: PersonalizationTarget,
): ProposalArtifact {
  const chrome: ProposalArtifact["chrome"] = [];
  if (plan.chrome?.announcementText) {
    chrome.push({
      label: "Announcement bar",
      before:
        target.chrome.value.header.announcement.text ||
        "The theme's announcement",
      after: plan.chrome.announcementText,
    });
  }
  if (plan.chrome?.newsletter) {
    chrome.push({
      label: "Newsletter heading",
      before: target.chrome.value.footer.newsletter.heading,
      after: plan.chrome.newsletter.heading,
    });
  }
  if (plan.brand?.tagline) {
    chrome.push({
      label: "Store tagline",
      before: target.brand.tagline ?? "",
      after: plan.brand.tagline,
    });
  }
  if (plan.brand?.blurb) {
    chrome.push({
      label: "Footer description",
      before: target.brand.blurb ?? "",
      after: plan.brand.blurb,
    });
  }
  return {
    type: "storefront_personalization_proposal",
    draftId: stored.draftId,
    title: stored.title,
    explanation: plan.explanation,
    planDigest,
    pages: plan.pages.map((page) => ({
      slug: page.slug,
      title: page.title,
      textChanges: page.textChanges,
      photoChanges: page.photoChanges,
      hidden: page.hidden.map((entry) => ({
        type: entry.type,
        reason: entry.reason,
      })),
    })),
    photos: plan.photos.map((photo) => ({
      url: photo.url,
      alt: photo.alt,
      where: photo.where,
    })),
    design: plan.chrome?.design
      ? summarizeDesignChange(
          plan.chrome.design,
          target.chrome.value.design ?? EMPTY_DESIGN_OVERRIDES,
          target.themeDesign,
        )
      : null,
    chrome,
    categories: plan.categories.map((change) => ({
      action: change.action,
      name: change.name,
      previousName:
        change.action === "update" && change.before.name !== change.name
          ? change.before.name
          : null,
      description: change.action === "hide" ? null : change.description,
      photoUrl:
        change.action === "hide"
          ? null
          : change.action === "update" &&
              change.imageUrl === change.before.imageUrl
            ? null
            : change.imageUrl,
    })),
    products: plan.products.map((product) => ({ name: product.name })),
    skipped: plan.skipped,
    live: personalizationLiveChanges(plan),
    status: "private_preview",
    expectedCredits: stored.expectedCredits,
    chargedCredits: stored.chargedCredits,
    creditSource: stored.creditSource,
  };
}
