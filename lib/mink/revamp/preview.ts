import { assembleRevampPlan, type RevampAssembleInput } from "./assemble";
import { toRevampReview } from "./review";

export const REVAMP_PHOTO_PLACEHOLDER = "/mink/photo-on-its-way.svg";

/** Presentation only. This plan is never saved, charged, applied or published. */
export function buildRevampDesignPreview(input: RevampAssembleInput) {
  const images = input.images.filter(
    (image) => image.role === "slot" && image.review === "passed",
  );
  return {
    review: toRevampReview(
      assembleRevampPlan({
        ...input,
        images,
        standIn: REVAMP_PHOTO_PLACEHOLDER,
      }),
    ),
    photosIn: new Set(
      images
        .filter((image) => !image.slotId.includes("~"))
        .map((image) => image.slotId),
    ).size,
    photosTotal: input.plan.shots.length,
  };
}
