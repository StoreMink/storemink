import { getThemeStudioConfig } from "@/lib/theme-studio/config";
import { CAPTURED_LICENSE_NOTE } from "@/lib/theme-studio/capture-core";
import { redrawEstimate } from "@/lib/theme-studio/image-history";
import {
  IMAGE_LIST_PRICE_USD,
  IMAGE_REVIEW_LIST_PRICE_USD,
  imageRunEstimate,
} from "@/lib/theme-studio/image-generation-core";
import { listThemeStudioSlots } from "@/lib/theme-studio/slot-images";
import type { StudioActionKind } from "../studio-status";
import { designLabel } from "../studio-words";
import { redrawSlotIds, studioChecksModel } from "./checks-model";
import type { StudioTabProps } from "./tab-types";
import {
  newestPictureRun,
  pictureDrawBlockedReason,
  pictureEditBlockedReason,
  pictureRetryBlockedReason,
} from "./tab-rules";
import {
  readStudioCheckRuns,
  readStudioDesignReview,
  readStudioProject,
} from "./tab-reads";
import {
  CatalogPictures,
  type CatalogSlotSummary,
} from "./versions/[versionId]/images/capture-panel";
import {
  GenerateImagesButton,
  PictureIntentFallback,
  RedrawPicturesButton,
  RetryPicturesButton,
} from "./versions/[versionId]/images/generate-images-button";
import { pictureName } from "./versions/[versionId]/images/picture-names";
import { SlotImagesEditor } from "./versions/[versionId]/images/slot-images-editor";

// ---------------------------------------------------------------------------
// The Pictures tab (wave TS-2, builder 2C; plan section 4): every picture the
// design shows, and the three ways to fix one.
//
// - "Redraw" draws exactly the pictures the checks flagged (a missing, too
//   small or wrongly stored picture, a photo with a hard problem, one not
//   checked yet; or, when nothing is serious, the photos flagged for
//   something small), after a confirm that names how many.
// - "Draw missing pictures" draws every placeholder; "Retry" picks up a
//   picture run that stopped. One click and a small confirm each, instead of
//   today's "Generate images" then "Draw N images".
// - The picture list: upload a replacement, or tick pictures to redraw;
//   "Show only slots with a placeholder" and "What the image model is asked
//   for" keep their home here.
//
// No "Capture catalogue pictures" button: every final check takes the
// catalogue card and screenshots (capture-panel.tsx says so).
// ★ The address's `do=redraw`, `draw_missing_pictures` and `retry_pictures`
// open the matching confirm; with nothing to act on they only move focus to
// the picture list.
//
// An async server component: only the theme page renders it, after its
// superadmin gate, and only while this tab is open.
// ---------------------------------------------------------------------------

const PICTURE_LIST_ID = "studio-pictures-list";

export async function PicturesTab({
  projectId,
  versionId,
  revision,
}: StudioTabProps) {
  if (!versionId) {
    return (
      <p className="studio-muted">
        There are no pictures yet. Theme Studio draws them while it builds the
        first design.
      </p>
    );
  }
  const project = await readStudioProject(projectId);
  const version = project?.versions.find((v) => v.id === versionId) ?? null;
  if (!project || !version?.hasPackage) {
    return (
      <p className="studio-muted">
        This design has no pictures. Choose another design in the list at the
        top.
      </p>
    );
  }
  const listing = await listThemeStudioSlots(projectId, versionId);
  if (!listing) {
    return (
      <p className="studio-muted">
        The pictures of this design could not be read. Reload the page or choose
        another design.
      </p>
    );
  }
  const design = designLabel(version.versionNumber);
  const config = getThemeStudioConfig();
  const free = config.provider === "fake";
  const editReason = pictureEditBlockedReason(project);
  const drawReason = pictureDrawBlockedReason(project, config);

  // What the checks ask of the pictures: the same lists the Checks tab and
  // the status words use.
  const runs = (await readStudioCheckRuns(projectId)).filter(
    (run) => run.versionId === versionId,
  );
  const review = await readStudioDesignReview(projectId, versionId);
  const model = studioChecksModel({
    run: runs[0] ?? null,
    review: review?.severity ?? null,
  });
  const redrawable = new Set(
    listing.slots.filter((slot) => slot.redrawable).map((slot) => slot.id),
  );
  const serious = redrawSlotIds(model.mustFix, redrawable);
  const flagged = redrawSlotIds(model.warnings, redrawable);
  const toRedraw = serious.length ? serious : flagged;
  const prices = free
    ? null
    : {
        imageUsd: IMAGE_LIST_PRICE_USD,
        reviewUsd: IMAGE_REVIEW_LIST_PRICE_USD,
      };
  const redrawCost =
    prices && toRedraw.length
      ? redrawEstimate(toRedraw.length, listing.anchorReusable, prices)
      : null;

  const pictureRun = newestPictureRun(project, version);
  const retryable =
    pictureRun &&
    (pictureRun.status === "failed" || pictureRun.status === "cancelled")
      ? pictureRun
      : null;

  const catalog: CatalogSlotSummary[] = listing.slots
    .filter((slot) => slot.catalogPreview || slot.catalogScreenshot)
    .map((slot) => ({
      id: slot.id,
      label: slot.catalogPreview
        ? "Catalogue card"
        : slot.id.includes("mobile")
          ? "Phone screenshot"
          : "Desktop screenshot",
      url: slot.url,
      placeholder: slot.placeholder,
      captured: slot.licenseNote === CAPTURED_LICENSE_NOTE,
    }));
  // With the browser job deployed the checks take the catalogue pictures, so
  // the list leaves them out; without it they are uploaded there.
  const editable = config.captureEnabled
    ? listing.slots.filter(
        (slot) => !slot.catalogPreview && !slot.catalogScreenshot,
      )
    : listing.slots;
  const artwork = editable.filter((slot) => slot.placeholder).length;

  const handled = new Set<StudioActionKind>();
  if (toRedraw.length) handled.add("redraw");
  if (listing.generatable > 0) handled.add("draw_missing_pictures");
  if (retryable) handled.add("retry_pictures");
  const fallback = (
    ["redraw", "draw_missing_pictures", "retry_pictures"] as const
  ).filter((kind) => !handled.has(kind));

  return (
    <div className="grid max-w-5xl gap-5">
      <div className="grid gap-2">
        <p className="text-sm">
          Every picture {design} shows. Upload a replacement or tick one to
          redraw it; saving makes a new design and {design} stays as it is.
        </p>
        <p className="studio-muted text-sm">
          {artwork > 0
            ? `${artwork} of ${editable.length} pictures ${artwork === 1 ? "is" : "are"} still a placeholder.`
            : "No placeholders remain."}
        </p>
      </div>

      {toRedraw.length || listing.generatable > 0 || retryable ? (
        <section
          className="dash-card"
          aria-labelledby="studio-pictures-fix-title"
        >
          <div className="dash-card-header">
            <h2 id="studio-pictures-fix-title" className="dash-card-title">
              What the pictures need
            </h2>
          </div>
          <div className="dash-card-body grid gap-4">
            {toRedraw.length ? (
              <div className="grid gap-2">
                <p className="text-sm">
                  {serious.length
                    ? `The checks found ${serious.length === 1 ? "a picture" : `${serious.length} pictures`} that must be drawn again before publishing: ${toRedraw.map(pictureName).join(", ")}.`
                    : `The picture check flagged ${flagged.length === 1 ? "a photo" : `${flagged.length} photos`} for something small: ${toRedraw.map(pictureName).join(", ")}. You can publish as they are, or redraw them.`}
                </p>
                <RedrawPicturesButton
                  projectId={projectId}
                  versionId={versionId}
                  versionNumber={version.versionNumber}
                  revision={revision}
                  packageDigest={listing.packageDigest}
                  slotIds={toRedraw}
                  slotNames={toRedraw.map(pictureName)}
                  estimate={redrawCost}
                  blockedReason={drawReason}
                  intent="redraw"
                  primary={serious.length > 0}
                />
              </div>
            ) : null}
            {listing.generatable > 0 ? (
              <div className="grid gap-2">
                <p className="text-sm">
                  {listing.generatable === 1
                    ? "One picture is still a placeholder that Theme Studio can draw."
                    : `${listing.generatable} pictures are still placeholders that Theme Studio can draw.`}
                </p>
                <GenerateImagesButton
                  projectId={projectId}
                  versionId={versionId}
                  versionNumber={version.versionNumber}
                  revision={revision}
                  packageDigest={listing.packageDigest}
                  slots={listing.generatable}
                  estimate={free ? null : imageRunEstimate(listing.generatable)}
                  blockedReason={drawReason}
                  intent="draw_missing_pictures"
                  primary={!serious.length}
                />
              </div>
            ) : null}
            {retryable ? (
              <div className="grid gap-2">
                <p className="text-sm">
                  {retryable.status === "cancelled"
                    ? "The last picture run was stopped before it finished."
                    : "The last picture run didn't finish."}{" "}
                  Pictures it already drew are kept.
                </p>
                <RetryPicturesButton
                  projectId={projectId}
                  runId={retryable.id}
                  drawn={
                    retryable.images
                      ? retryable.images.generated +
                        (retryable.images.pendingReview ?? 0)
                      : null
                  }
                  blockedReason={pictureRetryBlockedReason(
                    project,
                    retryable,
                    config,
                  )}
                  intent="retry_pictures"
                  primary={!serious.length && listing.generatable === 0}
                />
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <CatalogPictures slots={catalog} captureEnabled={config.captureEnabled} />

      <section aria-labelledby={PICTURE_LIST_ID} className="grid gap-3">
        <h2
          id={PICTURE_LIST_ID}
          tabIndex={-1}
          className="text-base font-semibold"
        >
          The pictures of {design}
        </h2>
        <SlotImagesEditor
          key={`${versionId}:${revision}`}
          projectId={projectId}
          versionId={versionId}
          versionNumber={version.versionNumber}
          packageDigest={listing.packageDigest}
          revision={revision}
          canEdit={editReason === null}
          blockedReason={editReason}
          drawBlockedReason={drawReason}
          slots={editable}
          anchorReusable={listing.anchorReusable}
          prices={prices}
        />
      </section>

      {fallback.length ? (
        <PictureIntentFallback kinds={fallback} focusId={PICTURE_LIST_ID} />
      ) : null}
    </div>
  );
}
