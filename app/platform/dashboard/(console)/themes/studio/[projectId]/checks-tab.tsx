import type { ThemeStudioAcceptanceRunView } from "@/lib/theme-studio/acceptance";
import { describeFixDraft } from "@/lib/theme-studio/acceptance-repair";
import { getThemeStudioConfig } from "@/lib/theme-studio/config";
import { redrawEstimate } from "@/lib/theme-studio/image-history";
import {
  IMAGE_LIST_PRICE_USD,
  IMAGE_REVIEW_LIST_PRICE_USD,
  imageRunEstimate,
} from "@/lib/theme-studio/image-generation-core";
import { listThemeStudioSlots } from "@/lib/theme-studio/slot-images";
import {
  checksOutcome,
  plainText,
  publishRunningFromEvents,
  questionsOpen,
  stopNeedsThemeChange,
  stopText,
  stoppedNextStep,
  studioDate,
} from "../studio-ui";
import {
  checkCoverageWords,
  designLabel,
  type StudioCopyDetails,
} from "../studio-words";
import { CheckScreenshots } from "./check-screenshots";
import {
  hasPlaceholderItem,
  redrawSlotIds,
  studioChecksModel,
  type StudioCheckItem,
} from "./checks-model";
import {
  ChecksIntent,
  CopyDetailsButton,
  DescribeChangeButton,
  DescribeFixButton,
} from "./checks-controls";
import type { StudioTabProps } from "./tab-types";
import { changeBlockedReason, pictureDrawBlockedReason } from "./tab-rules";
import {
  readStudioCheckRuns,
  readStudioCheckScreenshots,
  readStudioDesignReview,
  readStudioProject,
  type StudioDesignReview,
} from "./tab-reads";
import {
  AcceptanceEvidence,
  AcceptanceRunBadge,
  runSummary,
} from "./versions/[versionId]/acceptance/acceptance-evidence";
import { AcceptanceRunner } from "./versions/[versionId]/acceptance/acceptance-runner";
import {
  GenerateImagesButton,
  RedrawPicturesButton,
} from "./versions/[versionId]/images/generate-images-button";
import { pictureName } from "./versions/[versionId]/images/picture-names";
import { CheckAgainButton } from "./workspace";
import { DesignPlanCard } from "./design-plan-card";

// ---------------------------------------------------------------------------
// The Checks tab (wave TS-2, builder 2C; plan section 4, "Theme page, ready
// to publish" and "needs a fix"; the owner-approved screenshots of 24 Oct
// 2026). For the design shown:
//
//   what the checks covered (one sentence), then Must fix before publishing,
//   Warnings (you can still publish), Passed (Show all), Screenshots, and
//   Technical details (codes, versions, the build, Copy details, the AI's
//   assumptions, earlier runs and the in-browser runner as a fallback).
//
// ★ "FIX IT" BY KIND, never a one-click paid revision: a theme setting or a
// security problem gets "Describe a fix" (a draft in the chat, serious
// findings only); a picture gets "Redraw" (exactly those pictures, after a
// confirm that names how many) or "Draw missing pictures"; StoreMink's own
// code gets no fix button, only "StoreMink has been told" and "Copy details
// for an engineer". A matter of taste gets "Describe a change", which opens
// the chat.
// ★ WORDS: the main view is plain sentences (studio-words.ts); codes, the
// build and digests appear in Technical details only.
// ★ `do=describe_fix` puts the draft in the chat; `do=copy_details` opens
// Technical details at the first Copy details button (checks-controls.tsx).
//
// An async server component: only the theme page renders it, after its
// superadmin gate, and only while this tab is open.
// ---------------------------------------------------------------------------

const MUST_FIX_ID = "studio-checks-must-fix";
const TECHNICAL_ID = "studio-checks-technical";
const STOREMINK_COPY_ID = "studio-copy-storemink";
const RUN_COPY_ID = "studio-copy-run";
/** Sentences a kind shows on the main view before "and N more". */
const LINES_SHOWN = 3;

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function linesOf(item: StudioCheckItem) {
  return item.lines.slice(0, LINES_SHOWN);
}

/** One kind of problem or warning on the main view: its check's name, its
 * sentences and where each was found. */
function ItemWords({ item }: { item: StudioCheckItem }) {
  const lines = linesOf(item);
  const more = item.lines.length - lines.length;
  if (item.lines.length === 1) {
    const [line] = item.lines;
    return (
      <p className="text-sm">
        <span className="font-semibold">{item.heading}:</span>{" "}
        {plainText(line.text)}
        {line.places.length ? (
          <span className="studio-muted"> {line.places.join(", ")}.</span>
        ) : null}
      </p>
    );
  }
  return (
    <div className="grid gap-1 text-sm">
      <p className="font-semibold">
        {item.heading} ({count(item.count, "place", "places")})
      </p>
      <ul className="grid list-disc gap-1 pl-5">
        {lines.map((line) => (
          <li key={line.text}>
            {plainText(line.text)}
            {line.places.length ? (
              <span className="studio-muted"> {line.places.join(", ")}.</span>
            ) : null}
          </li>
        ))}
        {more > 0 ? (
          <li className="studio-muted">
            And {more} more, under Technical details.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export async function ChecksTab({
  projectId,
  versionId,
  revision,
}: StudioTabProps) {
  if (!versionId) {
    return (
      <p className="studio-muted">
        There is no design to check yet. The checks run by themselves when the
        first design is ready.
      </p>
    );
  }
  const project = await readStudioProject(projectId);
  const version = project?.versions.find((v) => v.id === versionId) ?? null;
  if (!project || !version?.hasPackage) {
    return (
      <p className="studio-muted">
        This design has no theme to check. Choose another design in the list at
        the top.
      </p>
    );
  }
  const config = getThemeStudioConfig();
  const autoChecks = config.autoQaEnabled;
  const design = designLabel(version.versionNumber);
  const isCurrent = version.id === project.currentVersionId;
  const runs = (await readStudioCheckRuns(projectId)).filter(
    (run) => run.versionId === version.id,
  );
  const latest: ThemeStudioAcceptanceRunView | null = runs[0] ?? null;
  const review: StudioDesignReview | null = await readStudioDesignReview(
    projectId,
    version.id,
  );
  const shots = await readStudioCheckScreenshots(projectId, version.id);
  const model = studioChecksModel({
    run: latest,
    review: review?.severity ?? null,
  });

  // ---------------------------------------------------- what can be done
  const changeReason = changeBlockedReason(project, config);
  const drawReason = pictureDrawBlockedReason(project, config);
  // A design review from before severity-v1 recorded no split, only a stop
  // code and its own words: when the code asks for a change to the theme,
  // it is shown as one problem and described from those words.
  const legacyReview =
    review !== null &&
    review.status === "failed" &&
    review.severity === null &&
    stopNeedsThemeChange(review.errorCode);
  const legacyLines = legacyReview
    ? [stopText(review.errorCode, "review"), ...(version.qaFindings ?? [])].map(
        (text) => plainText(text),
      )
    : [];
  const mustFix: StudioCheckItem[] = legacyReview
    ? [
        ...model.mustFix,
        {
          key: "review|legacy",
          source: "review",
          check: null,
          code: review.errorCode ?? "failed",
          heading: "Design review",
          lines: legacyLines.map((text) => ({ text, places: [] })),
          count: 1,
          storeMink: false,
          picture: false,
          slotIds: [],
          measured: null,
        },
      ]
    : model.mustFix;
  const draft = describeFixDraft({
    run: latest,
    version,
    review: review?.severity ?? null,
    notes: legacyLines,
  });
  const pictureItems = [...model.mustFix, ...model.warnings].some(
    (item) => item.picture,
  );
  const listing = pictureItems
    ? await listThemeStudioSlots(projectId, version.id)
    : null;
  const redrawable = new Set(
    (listing?.slots ?? [])
      .filter((slot) => slot.redrawable)
      .map((slot) => slot.id),
  );
  const prices =
    config.provider === "fake"
      ? null
      : {
          imageUsd: IMAGE_LIST_PRICE_USD,
          reviewUsd: IMAGE_REVIEW_LIST_PRICE_USD,
        };
  const estimateFor = (slots: number) =>
    prices && listing
      ? redrawEstimate(slots, listing.anchorReusable, prices)
      : null;
  const seriousSlots = redrawSlotIds(model.mustFix, redrawable);
  const drawMissing =
    listing && listing.generatable > 0 && hasPlaceholderItem(model.mustFix)
      ? listing.generatable
      : 0;

  // --------------------------------------------------------- the situation
  const publishing =
    project.status === "approved" && publishRunningFromEvents(project.events);
  const outcome = checksOutcome(version.id, project.events);
  const stopped =
    outcome && !outcome.passed && project.status !== "generating"
      ? outcome
      : null;
  const canCheckAgain =
    autoChecks &&
    isCurrent &&
    !publishing &&
    (project.status === "ready" ||
      project.status === "candidate" ||
      project.status === "approved");
  const runnerReason = !isCurrent
    ? `Only the current design can be checked. Make ${design} current first.`
    : project.status === "generating"
      ? "Theme Studio is working on this theme. Wait for it to finish, or stop it from the ... menu."
      : project.status === "blocked"
        ? questionsOpen(project)
          ? "Answer the questions in the chat first, or make another design current."
          : "The security check failed. Describe a fix, or make another design current."
        : project.status !== "ready" && project.status !== "candidate"
          ? "This theme can't be checked in its current state."
          : null;
  const distinct = version.distinctness;
  const firstStoreMink =
    mustFix.find((item) => item.storeMink) ??
    model.warnings.find((item) => item.storeMink) ??
    null;

  const copyFor = (item: StudioCheckItem): StudioCopyDetails => ({
    themeName: project.name,
    themeId: project.themeId,
    what: item.lines[0]?.text ?? item.heading,
    check: item.check ?? "design review",
    code: item.code,
    versionNumber: version.versionNumber,
    build:
      item.source === "checks"
        ? (latest?.buildId ?? null)
        : (review?.build ?? null),
    at:
      item.source === "checks"
        ? (latest?.completedAt ?? latest?.createdAt ?? null)
        : (review?.finishedAt ?? review?.createdAt ?? null),
  });

  const nothingYet = !latest && !review;
  // A check that could not finish is never a pass: a stop, a check run that
  // errored or expired, or a design review that failed without a verdict.
  // Checks that stopped before they finished are never a pass: with nothing
  // listed, Must fix says it is not known yet (the notice above says why and
  // what to do next), never "none".
  const unfinished =
    stopped !== null ||
    latest?.status === "error" ||
    latest?.status === "expired" ||
    (review?.status === "failed" && review.severity === null && !legacyReview);

  return (
    <div className="grid max-w-4xl gap-5">
      <ChecksIntent
        draft={draft}
        blocked={changeReason !== null}
        mustFixId={MUST_FIX_ID}
        technicalId={TECHNICAL_ID}
        copyTargetId={
          firstStoreMink ? STOREMINK_COPY_ID : latest ? RUN_COPY_ID : null
        }
      />

      <div className="grid gap-3">
        <p className="text-sm">
          {shots && shots.samples.length
            ? checkCoverageWords(shots.coverage)
            : nothingYet
              ? `${design} has not been checked yet. The checks cover every page at five screen widths.`
              : `Every page of ${design} at five screen widths: links, readable text, pictures, menus and the cart, security, and the design review.`}
        </p>
        {project.status === "generating" && isCurrent ? (
          <p className="studio-notice" data-tone="info">
            Theme Studio is working on this theme. These are the newest finished
            checks.
          </p>
        ) : null}
        {stopped ? (
          <p className="studio-notice" data-tone="warning">
            The automatic checks stopped on {design}:{" "}
            {plainText(stopText(stopped.code, stopped.kind))}{" "}
            {stoppedNextStep(stopped.code, stopped.kind)}
          </p>
        ) : null}
        {!stopped &&
        !legacyReview &&
        review?.status === "failed" &&
        !review.severity ? (
          <p className="studio-notice" data-tone="warning">
            The design review of {design} didn&apos;t finish:{" "}
            {plainText(stopText(review.errorCode, "review"))}
          </p>
        ) : null}
        {!stopped &&
        (latest?.status === "error" || latest?.status === "expired") ? (
          <p className="studio-notice" data-tone="warning">
            The newest check of {design} didn&apos;t finish, so it doesn&apos;t
            count as passed.
          </p>
        ) : null}
        {latest && !latest.currentBuild ? (
          <p className="studio-notice" data-tone="warning">
            {autoChecks
              ? "These checks ran on an earlier StoreMink build. Publish checks this design again on today's build first."
              : "These checks ran on an earlier StoreMink build. Run them again before publishing."}
          </p>
        ) : null}
        {distinct?.status === "similar" && distinct.score !== null ? (
          <p className="studio-notice" data-tone="warning">
            {design} still looks like a theme already in the catalogue (
            {Math.round(distinct.score * 100)}% different; at least{" "}
            {Math.round(distinct.threshold * 100)}% counts as distinct). This is
            a warning; it does not stop Publish.
          </p>
        ) : null}
        {version.designPlan ? (
          <DesignPlanCard plan={version.designPlan} distinctness={distinct} />
        ) : null}
        {canCheckAgain ? (
          <div className="flex flex-wrap items-start gap-3">
            <CheckAgainButton
              projectId={project.id}
              versionId={version.id}
              versionNumber={version.versionNumber}
              revision={revision}
            />
            <p className="studio-muted max-w-xl text-sm">
              Measures {design} again on today&apos;s build, about 3 to 5
              minutes. Nothing is redrawn.
            </p>
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------- Must fix */}
      <section className="dash-card" aria-labelledby={MUST_FIX_ID}>
        <div className="dash-card-header">
          <h2 id={MUST_FIX_ID} tabIndex={-1} className="dash-card-title">
            Must fix before publishing:{" "}
            {nothingYet
              ? "not checked yet"
              : mustFix.length || (unfinished ? "not known yet" : "none")}
          </h2>
        </div>
        <div className="dash-card-body grid gap-4">
          {latest &&
          (latest.status === "running" ||
            latest.status === "awaiting_browser") ? (
            <p className="studio-muted text-sm">
              The checks are still running. What they find appears here.
            </p>
          ) : null}
          {review &&
          (review.status === "queued" || review.status === "running") ? (
            <p className="studio-muted text-sm">
              The design review is still running. What it finds appears here.
            </p>
          ) : null}
          {mustFix.length === 0 ? (
            <p className="studio-muted text-sm">
              {nothingYet
                ? "Nothing to show until the first check finishes."
                : unfinished
                  ? "The checks stopped before they finished, so they don't count as passed."
                  : "Nothing stops Publish in these checks."}
            </p>
          ) : (
            <ul className="grid gap-3">
              {mustFix.map((item) => (
                <li key={item.key} className="grid gap-2">
                  <ItemWords item={item} />
                  {item.storeMink ? (
                    <div className="grid gap-1">
                      <p className="studio-muted text-sm">
                        Publish waits until StoreMink&apos;s code is fixed; no
                        change to the theme can fix this.
                      </p>
                      <CopyDetailsButton
                        id={
                          item === firstStoreMink
                            ? STOREMINK_COPY_ID
                            : undefined
                        }
                        label="Copy details for an engineer"
                        details={copyFor(item)}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {mustFix.length && version.qaIteration > 0 ? (
            <p className="studio-muted text-sm">
              Theme Studio already tried{" "}
              {count(version.qaIteration, "automatic fix", "automatic fixes")}{" "}
              before showing you this.
            </p>
          ) : null}
          {draft || seriousSlots.length || drawMissing ? (
            <div className="flex flex-wrap items-start gap-3">
              {draft ? (
                <DescribeFixButton draft={draft} blockedReason={changeReason} />
              ) : null}
              {seriousSlots.length && listing ? (
                <RedrawPicturesButton
                  projectId={project.id}
                  versionId={version.id}
                  versionNumber={version.versionNumber}
                  revision={revision}
                  packageDigest={listing.packageDigest}
                  slotIds={seriousSlots}
                  slotNames={seriousSlots.map(pictureName)}
                  estimate={estimateFor(seriousSlots.length)}
                  blockedReason={drawReason}
                  primary={!draft}
                />
              ) : null}
              {drawMissing && listing ? (
                <GenerateImagesButton
                  projectId={project.id}
                  versionId={version.id}
                  versionNumber={version.versionNumber}
                  revision={revision}
                  packageDigest={listing.packageDigest}
                  slots={drawMissing}
                  estimate={prices ? imageRunEstimate(drawMissing) : null}
                  blockedReason={drawReason}
                  primary={!draft && !seriousSlots.length}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* ------------------------------------------------- Warnings */}
      <section className="dash-card" aria-labelledby="studio-checks-warnings">
        <div className="dash-card-header">
          <h2 id="studio-checks-warnings" className="dash-card-title">
            Warnings (you can still publish): {model.warnings.length || "none"}
          </h2>
        </div>
        <div className="dash-card-body">
          {model.warnings.length === 0 ? (
            <p className="studio-muted text-sm">
              {nothingYet
                ? "Nothing to show until the first check finishes."
                : "No warnings in these checks."}
            </p>
          ) : (
            <ul className="grid gap-3">
              {model.warnings.map((item) => {
                const slots = redrawSlotIds([item], redrawable);
                return (
                  <li key={item.key} className="grid gap-2">
                    <ItemWords item={item} />
                    <div className="flex flex-wrap items-start gap-3">
                      {item.storeMink ? (
                        <CopyDetailsButton
                          id={
                            item === firstStoreMink
                              ? STOREMINK_COPY_ID
                              : undefined
                          }
                          details={copyFor(item)}
                        />
                      ) : null}
                      {slots.length && listing ? (
                        <RedrawPicturesButton
                          projectId={project.id}
                          versionId={version.id}
                          versionNumber={version.versionNumber}
                          revision={revision}
                          packageDigest={listing.packageDigest}
                          slotIds={slots}
                          slotNames={slots.map(pictureName)}
                          estimate={estimateFor(slots.length)}
                          blockedReason={drawReason}
                          label="Redraw"
                          small
                        />
                      ) : null}
                      {item.source === "review" && !item.picture ? (
                        <DescribeChangeButton blockedReason={changeReason} />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ------------------------------------------------- Passed */}
      <section className="dash-card" aria-labelledby="studio-checks-passed">
        <details>
          <summary className="dash-card-header cursor-pointer">
            <span id="studio-checks-passed" className="dash-card-title">
              Passed: {model.passed.length}
            </span>
            <span className="studio-muted text-sm">Show all</span>
          </summary>
          <div className="dash-card-body">
            {model.passed.length === 0 ? (
              <p className="studio-muted text-sm">No check has passed yet.</p>
            ) : (
              <ul className="grid gap-1 text-sm sm:grid-cols-2">
                {model.passed.map((check) => (
                  <li key={check.id}>
                    {check.heading}
                    {check.withWarnings ? (
                      <span className="studio-muted"> (with warnings)</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </section>

      {/* ------------------------------------------------- Screenshots */}
      <section
        className="dash-card"
        aria-labelledby="studio-checks-screenshots"
      >
        <div className="dash-card-header">
          <h2 id="studio-checks-screenshots" className="dash-card-title">
            Screenshots
          </h2>
        </div>
        <div className="dash-card-body">
          <CheckScreenshots
            projectId={project.id}
            samples={shots?.samples ?? []}
            takenAt={shots?.capturedAt ? studioDate(shots.capturedAt) : null}
          />
        </div>
      </section>

      {/* ------------------------------------------------- Technical details */}
      <section
        className="dash-card"
        aria-labelledby="studio-checks-technical-title"
      >
        <details id={TECHNICAL_ID}>
          <summary className="dash-card-header cursor-pointer">
            <span
              id="studio-checks-technical-title"
              className="dash-card-title"
            >
              Technical details
            </span>
            <span className="studio-muted text-sm">Show</span>
          </summary>
          <div className="dash-card-body grid gap-5">
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <div className="flex flex-wrap gap-x-2">
                <dt className="studio-muted">Design</dt>
                <dd>
                  {design} (version {version.versionNumber}
                  {isCurrent ? ", current" : ""})
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="studio-muted">Version id</dt>
                <dd className="studio-code">{version.id}</dd>
              </div>
              {shots?.build ? (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="studio-muted">Screenshots build</dt>
                  <dd className="studio-code">{shots.build}</dd>
                </div>
              ) : null}
              {stopped?.code ? (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="studio-muted">Stop code</dt>
                  <dd className="studio-code">
                    {stopped.kind}: {stopped.code}
                  </dd>
                </div>
              ) : null}
            </dl>

            {latest ? (
              <div className="grid gap-3">
                <CopyDetailsButton
                  id={RUN_COPY_ID}
                  details={{
                    themeName: project.name,
                    themeId: project.themeId,
                    what: runSummary(latest, autoChecks),
                    check: stopped ? stopped.kind : null,
                    code: stopped?.code ?? latest.status,
                    versionNumber: version.versionNumber,
                    build: latest.buildId,
                    at: latest.completedAt ?? latest.createdAt,
                  }}
                />
                <AcceptanceEvidence run={latest} autoChecks={autoChecks} />
              </div>
            ) : (
              <p className="studio-muted text-sm">
                No check run of {design} yet.
              </p>
            )}

            <div className="grid gap-1 text-sm">
              <h3 className="font-semibold">Design review</h3>
              {review ? (
                <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="studio-muted">Review</dt>
                    <dd className="studio-code">{review.id}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="studio-muted">State</dt>
                    <dd className="studio-code">
                      {review.status}
                      {review.severity ? `, ${review.severity.outcome}` : ""}
                      {review.errorCode ? `, ${review.errorCode}` : ""}
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="studio-muted">Judged check run</dt>
                    <dd className="studio-code">
                      {review.checkRunId ?? "none"}
                      {review.checkRunId && latest
                        ? review.checkRunId === latest.id
                          ? " (the run above)"
                          : " (an earlier run)"
                        : ""}
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="studio-muted">Build</dt>
                    <dd className="studio-code">{review.build ?? "none"}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="studio-muted">Finished</dt>
                    <dd>
                      {review.finishedAt
                        ? studioDate(review.finishedAt)
                        : "not yet"}
                    </dd>
                  </div>
                  {review.severity ? (
                    <div className="flex flex-wrap gap-x-2 sm:col-span-2">
                      <dt className="studio-muted">Findings</dt>
                      <dd className="studio-code">
                        {[
                          ...review.severity.serious.map(
                            (f) =>
                              `serious ${f.code}${f.row ? ` ${f.row} ${f.score ?? ""}` : ""}${f.slotId ? ` ${f.slotId}` : ""}`,
                          ),
                          ...review.severity.warnings.map(
                            (f) =>
                              `warning ${f.code}${f.row ? ` ${f.row} ${f.score ?? ""}` : ""}${f.slotId ? ` ${f.slotId}` : ""}`,
                          ),
                        ].join(", ") || "none"}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <p className="studio-muted text-xs">
                  No design review of {design} yet.
                </p>
              )}
            </div>

            {version.assumptions.length ||
            (version.packageSummary?.gaps ?? []).some((g) => !g.blocking) ? (
              <div className="grid gap-2 text-sm">
                <h3 className="font-semibold">The AI&apos;s plan</h3>
                {version.assumptions.length ? (
                  <div>
                    <p className="studio-muted text-xs">What it assumed</p>
                    <ul className="list-disc pl-5">
                      {version.assumptions.map((item) => (
                        <li key={item}>{plainText(item)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {(version.packageSummary?.gaps ?? []).some(
                  (g) => !g.blocking,
                ) ? (
                  <div>
                    <p className="studio-muted text-xs">
                      What it left out (none of it stops Publish)
                    </p>
                    <ul className="list-disc pl-5">
                      {(version.packageSummary?.gaps ?? [])
                        .filter((g) => !g.blocking)
                        .map((g) => (
                          <li key={g.requestedCapability}>
                            {plainText(g.requestedCapability)}
                          </li>
                        ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            {version.qaRepairs?.length || version.qaDiagnosis ? (
              <div className="grid gap-2 text-sm">
                <h3 className="font-semibold">The automatic fixes</h3>
                {version.qaDiagnosis ? (
                  <p>{plainText(version.qaDiagnosis)}</p>
                ) : null}
                {version.qaRepairs?.length ? (
                  <ul className="list-disc pl-5 text-xs">
                    {version.qaRepairs.map((repair, index) => (
                      <li key={`${repair.kind}-${index}`}>
                        <span className="studio-code">{repair.kind}</span>{" "}
                        {repair.target ? (
                          <span className="studio-code">
                            {plainText(repair.target)}
                          </span>
                        ) : null}{" "}
                        {plainText(repair.reason)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {runs.length > 1 ? (
              <div className="grid gap-2 text-sm">
                <h3 className="font-semibold">
                  Earlier check runs of {design}
                </h3>
                <ul className="grid gap-2">
                  {runs.slice(1).map((run) => (
                    <li
                      key={run.id}
                      className="flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <AcceptanceRunBadge status={run.status} />
                        {runSummary(run, autoChecks)}
                      </span>
                      <span className="studio-muted">
                        {run.createdByEmail}, {studioDate(run.createdAt)}, build{" "}
                        <span className="studio-code">{run.buildId}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid gap-2 text-sm">
              <h3 className="font-semibold">
                Check the pages in this browser instead
              </h3>
              <p className="studio-muted">
                {autoChecks
                  ? "Measures the pages in this tab, which must stay open. It skips the design review, so Publish still checks the design first."
                  : "The automatic checks are off on this deployment, so the pages are measured in this tab, which must stay open."}
              </p>
              <AcceptanceRunner
                projectId={project.id}
                versionId={version.id}
                canRun={runnerReason === null}
                blockedReason={runnerReason}
              />
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}
