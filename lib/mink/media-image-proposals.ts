import "server-only";

import { and, eq } from "drizzle-orm";
import { mediaAssets, minkActionToolAccess } from "@/drizzle/schema";
import { can } from "@/app/dashboard/lib/permissions";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  gcsConfigured,
  gcsDeletePaths,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { createMinkDraftProposal } from "./drafts";
import { MinkRequestError, MinkToolInputError } from "./errors";
import {
  MINK_GENERATED_MEDIA_FOLDER,
  MINK_GENERATED_PRODUCT_PHOTO_FOLDER,
  MINK_MEDIA_PURPOSE_SPECS,
  aspectRatioFor,
  isMinkAiMadePhotoUrl,
  validateMinkMediaGenerationRequest,
  type MinkMediaPurpose,
} from "./media-generation-contract";
import {
  generateMinkMediaImage,
  reserveMinkImageGeneration,
} from "./media-generation";
import { getMinkConfig } from "./config";
import { getStoreChrome } from "@/lib/chrome/queries";
import { IMAGE_EDIT_CREDITS, productPhotoSpec } from "@/lib/media/image-specs";
import type { MinkDraftContent } from "./draft-types";
import type { MinkActorContext, MinkArtifact } from "./types";
import { resolveMinkMediaReferenceImages } from "./media-reference-images";

// ---------------------------------------------------------------------------
// Phase 9E - one charged, immutable proposal that IS an image.
//
// ★★ THE IMAGE IS GENERATED WHEN THE PROPOSAL IS CREATED, NOT WHEN IT IS
// APPROVED, and that inverts 9B/9C's ordering deliberately. Those two propose
// a CHANGE to something the merchant can already see, so a card describing the
// change is reviewable. Here the artefact is a picture: a card describing a
// prompt asks a merchant to approve an image nobody has looked at, which is
// the one thing a review must never be. 9C's own rule -- the card shows the
// COLOURS, not a description of them -- read one step further.
//
// ★ THE CONSEQUENCE, ACCEPTED: a proposal the merchant discards has already
// cost a provider call. That is the right way round. The alternative spends
// the same money after an approval, and spends it on an image that may be
// wrong, which is a charge AND a disappointment rather than just a charge.
//
// ★★ SAVING IT IS PART OF GENERATION, NOT ANOTHER APPROVAL OR ANOTHER JOB
// for the merchant. The provider call has already created a public object; a
// `media_assets` row only makes that object manageable and eligible for the
// separately approved layout proposal. Stopping between those two private
// writes made a request such as "make a homepage banner" require a manual Save,
// a second chat message and another model run before Mink could finish the
// outcome the merchant originally asked for. An uploaded ATTACHMENT still has
// its explicit Save button because the merchant did not ask Mink to create it.
// ---------------------------------------------------------------------------

/**
 * The operator switch for image generation.
 *
 * ★★ IT GATES THE GENERATION, NOT THE SAVE, WHICH IS THE OPPOSITE OF EVERY
 * OTHER TOOL GATE HERE -- and it has to be. Everywhere else the expensive,
 * irreversible half is the write, so the gate sits on the action. Here the
 * write is a private library row and the PROVIDER CALL is the part that spends
 * real per-image money, so a gate on the save would leave the only thing worth
 * switching off ungated.
 */
const MEDIA_TOOL = "generate_media_image";

export interface MinkMediaProposalInput {
  actor: MinkActorContext;
  purpose: unknown;
  prompt: unknown;
  referenceImageUrls: unknown;
  alt: unknown;
}

export async function createMinkMediaImageProposal(
  input: MinkMediaProposalInput,
): Promise<Extract<MinkArtifact, { type: "media_image_proposal" }>> {
  await assertMediaGenerationAuthority(input.actor);
  if (!gcsConfigured) {
    throw new MinkRequestError(
      "image_storage_not_configured",
      "Image generation needs media storage (GCS_BUCKET).",
      503,
    );
  }

  const validation = validateMinkMediaGenerationRequest({
    purpose: input.purpose,
    prompt: input.prompt,
    referenceImageUrls: input.referenceImageUrls,
    alt: input.alt,
  });
  if (!validation.ok) {
    throw new MinkToolInputError(
      `The image request is invalid: ${validation.issues.join(" ")}`,
    );
  }
  const request = validation.value;
  const references = await resolveMinkMediaReferenceImages(
    input.actor,
    request.referenceImageUrls,
  );
  if (request.purpose === "product") {
    // ★★ A PRODUCT PHOTO STARTS FROM A REAL PHOTO OF THE ITEM, or it is a
    //    picture of goods that may not exist. The product's own image or one
    //    the merchant attached (a Media row) qualifies; a category image, a
    //    picture Mink drew earlier, or nothing does not. An earlier AI photo
    //    may come along to continue its scene, but never instead of the real
    //    one. Refused BEFORE the spend ceiling and the charge.
    if (
      !references.some(
        (reference) =>
          (reference.source === "product" || reference.source === "media") &&
          !isMinkAiMadePhotoUrl(reference.url),
      )
    ) {
      throw new MinkToolInputError(
        "A product photo must start from a real photo of the item. Pass the product's own image URL from search_products or get_current_product, or the exact Media URL of a photo the merchant attached, as a reference; to change a photo Mink made, pass that photo AND the real one. Mink does not invent a product from a description.",
      );
    }
    // The card shape is the store's, read here so the model cannot choose it.
    request.productPhotoShape =
      productPhotoSpec(
        (await getStoreChrome(input.actor.storeId)).appearance.cardPhoto,
      ) === "product_square"
        ? "square"
        : "portrait";
  }

  // ★ THE SPEND CEILING IS CLAIMED BEFORE THE PROVIDER CALL AND BEFORE THE
  //   CREDIT CHARGE. Charging first and then refusing would bill a merchant
  //   for a picture they never received.
  if (!input.actor.runId) {
    throw new MinkToolInputError("The draft run is not available. Try again.");
  }
  await reserveMinkImageGeneration(input.actor, input.actor.runId);

  const image = await generateMinkMediaImage(
    getMinkConfig(),
    request,
    references,
  );

  const extension = image.mimeType === "image/png" ? "png" : "jpg";
  // ★ A catalogue photo lives in its own folder: that path is what lets the
  //   product-photo proposal accept it while still refusing campaign art.
  const folder =
    request.purpose === "product"
      ? MINK_GENERATED_PRODUCT_PHOTO_FOLDER
      : MINK_GENERATED_MEDIA_FOLDER;
  const path = `stores/${input.actor.storeId}/${folder}/${crypto.randomUUID()}.${extension}`;
  let url: string;
  try {
    url = await gcsUploadObject(path, image.bytes, image.mimeType);
  } catch (error) {
    logError("mink generated image upload failed", error, { path });
    throw new MinkRequestError(
      "image_storage_failed",
      "The image was created but could not be stored. Try again.",
      503,
    );
  }

  const spec = MINK_MEDIA_PURPOSE_SPECS[request.purpose];
  const filename = `${request.purpose}-${Date.now()}.${extension}`;

  // ★★ GENERATED MEANS KEPT. This row changes nothing shopper-visible, but
  // it closes the hand-off between creation and placement: the URL returned to
  // the model is now immediately accepted by the ordinary store-ownership
  // guard if the same request also asks for a layout proposal.
  try {
    await withService((db) =>
      db.insert(mediaAssets).values({
        storeId: input.actor.storeId,
        url,
        path,
        filename,
        contentType: image.mimeType,
        sizeBytes: image.bytes.length,
        createdBy: input.actor.adminId,
        source: "mink_generated",
      }),
    );
  } catch (error) {
    await gcsDeletePaths([path]).catch(() => []);
    logError("mink generated image media save failed", error, { path });
    throw new MinkRequestError(
      "image_media_save_failed",
      "The image was created but could not be saved to Media. Nothing was kept; try again.",
      503,
    );
  }

  let stored;
  try {
    stored = await createMinkDraftProposal({
      actor: input.actor,
      kind: "media_image",
      // ★ A product photo is priced like the photo editor's scene photo
      //   (IMAGE_EDIT_CREDITS, the owner's price for one Flash image call), so
      //   the same picture costs the same from either place.
      expectedCredits:
        request.purpose === "product" ? IMAGE_EDIT_CREDITS : undefined,
      title: spec.label,
      destinationType: "media_asset",
      destinationLabel: `Media Library · ${spec.label}`,
      destinationPath: "/dashboard/media",
      content: draftContent({
        url,
        path,
        filename,
        contentType: image.mimeType,
        sizeBytes: image.bytes.length,
        purpose: request.purpose,
        prompt: request.prompt,
        referenceImageUrls: request.referenceImageUrls,
        alt: request.alt,
      }),
    });
    if (stored.type !== "proposal") {
      throw new Error("Generated image persistence returned no proposal");
    }
  } catch (error) {
    // ★ The library row and object form one logical generated asset. If the
    // conversation artefact cannot be stored, remove both best-effort instead
    // of leaving a library item the run reports as failed.
    await withService((db) =>
      db
        .delete(mediaAssets)
        .where(
          and(
            eq(mediaAssets.storeId, input.actor.storeId),
            eq(mediaAssets.path, path),
          ),
        ),
    ).catch(() => undefined);
    await gcsDeletePaths([path]).catch(() => []);
    throw error;
  }

  return {
    type: "media_image_proposal",
    draftId: stored.draftId,
    title: stored.title,
    destinationLabel: stored.destinationLabel,
    destinationPath: "/dashboard/media",
    url,
    alt: request.alt,
    prompt: request.prompt,
    referenceImageCount: references.length,
    purpose: request.purpose,
    aspectRatio: aspectRatioFor(request.purpose, request.productPhotoShape),
    placement: spec.placement,
    saved: true,
    status: "private_preview",
    expectedCredits: stored.expectedCredits,
    chargedCredits: stored.chargedCredits,
    creditSource: stored.creditSource,
  };
}

function draftContent(input: {
  url: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  purpose: MinkMediaPurpose;
  prompt: string;
  referenceImageUrls: string[];
  alt: string;
}): MinkDraftContent {
  return {
    url: input.url,
    storage_path: input.path,
    filename: input.filename,
    content_type: input.contentType,
    size_bytes: String(input.sizeBytes),
    purpose: input.purpose,
    prompt: input.prompt,
    reference_image_urls: JSON.stringify(input.referenceImageUrls),
    alt: input.alt,
  };
}

/** Drafting, Media manage, and the store's own image-generation gate. */
export async function assertMediaGenerationAuthority(
  actor: MinkActorContext,
): Promise<void> {
  if (actor.draftingEnabled !== true) {
    throw new MinkToolInputError("Mink AI drafting is not enabled.");
  }
  // ★ `media:manage`, NOT `builder:manage`. The artefact lands in the Media
  //   Library; putting it on a page is a separate 9B layout proposal with its
  //   own Builder gate, so requiring Builder here would withhold image
  //   generation from the person whose job the media actually is.
  if (!can(actor.permissions, "media", "manage", actor.isSuperadmin)) {
    throw new MinkToolInputError(
      "You need Media manage permission to create an image.",
    );
  }
  const rows = await withService((db) =>
    db
      .select({ enabled: minkActionToolAccess.enabled })
      .from(minkActionToolAccess)
      .where(
        and(
          eq(minkActionToolAccess.storeId, actor.storeId),
          eq(minkActionToolAccess.toolName, MEDIA_TOOL),
        ),
      )
      .limit(1),
  );
  if (!rows[0]?.enabled) {
    throw new MinkToolInputError(
      "Image generation is not enabled for this store.",
    );
  }
}
