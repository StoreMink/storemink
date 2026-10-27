import { currentAcceptanceBuildId } from "@/lib/theme-studio/acceptance";
import { THEME_IMAGE_PROBLEM_LABEL } from "@/lib/theme-studio/image-history";
import { THEME_STUDIO_MODELS } from "@/lib/theme-studio/models";
import type { ThemeStudioRunView } from "@/lib/theme-studio/repository";
import {
  activityActor,
  activityLine,
  plainText,
  stopText,
  studioDate,
} from "../studio-ui";
import { CopyDetailsButton } from "./checks-controls";
import type { StudioTabProps } from "./tab-types";
import { readStudioProject, readStudioReleaseState } from "./tab-reads";
import { CancelRunButton, RetryRunButton } from "./workspace";

// ---------------------------------------------------------------------------
// The Log tab (wave TS-2; builder 2B's round-1 tab, finished by 2C): the
// record behind the theme, kept off the main view (plan section 4 and
// section 8 row 2). The theme's ID, its model, who started it and today's
// StoreMink build; every run with its codes, attempts, tokens and costs
// (Cancel behind a confirm, Retry); Publish history with each attempt's
// reasons and the catalog audit; and Activity. Codes and costs appear here
// and in Checks, Technical details only.
//
// An async server component: only the theme page renders it, after its
// superadmin gate, and only while this tab is open.
// ---------------------------------------------------------------------------

const KIND_WORDS: Record<ThemeStudioRunView["kind"], string> = {
  generate: "Build",
  revise: "Change",
  images: "Pictures",
};

const STATUS_WORDS: Record<ThemeStudioRunView["status"], string> = {
  queued: "waiting",
  running: "running",
  succeeded: "finished",
  failed: "failed",
  cancelled: "cancelled",
};

const PUBLICATION_WORDS: Record<string, string> = {
  publishing: "Publishing",
  published: "Published",
  failed: "Didn't finish",
};

const AUDIT_WORDS: Record<string, string> = {
  hide: "Stopped offering it to new stores",
  show: "Offered it to new stores again",
  select_release: "Changed the release new stores get",
};

function cost(microUsd: number): string {
  return `about $${(microUsd / 1_000_000).toFixed(microUsd < 10_000 ? 4 : 2)}`;
}

function count(n: number): string {
  return n.toLocaleString("en-IN");
}

/** One line about a picture run: what came back and what it cost. */
function imageRunLine(images: NonNullable<ThemeStudioRunView["images"]>) {
  return [
    `${images.generated + (images.pendingReview ?? 0)} drawn`,
    images.pendingReview
      ? `${images.pendingReview} saved, waiting for their picture check`
      : null,
    images.rejected > 0
      ? `${images.rejected} failed the check and kept the placeholder`
      : null,
    images.failed > 0 ? `${images.failed} not drawn (refused or failed)` : null,
    images.skipped > 0 ? `${images.skipped} not reached` : null,
    images.redrawn > 0 ? `${images.redrawn} redrawn after a check` : null,
    images.flagged > 0 ? `${images.flagged} kept with a minor problem` : null,
    images.unreviewed > 0 ? `${images.unreviewed} unchecked` : null,
    `pictures ${cost(images.imageCostMicroUsd)}, checks ${cost(images.reviewCostMicroUsd)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export async function LogTab({ projectId }: StudioTabProps) {
  const project = await readStudioProject(projectId);
  if (!project) {
    return <p className="studio-muted">This theme no longer exists.</p>;
  }
  const release = await readStudioReleaseState(projectId);
  const latest = project.runs[0] ?? null;
  const model =
    THEME_STUDIO_MODELS.find((m) => m.key === project.modelKey)?.label ??
    project.modelKey;
  const versionNumber = new Map(
    project.versions.map((v) => [v.id, v.versionNumber]),
  );
  const publications = release?.publications ?? [];
  const audit = release?.audit ?? [];
  return (
    <div className="grid max-w-4xl gap-5">
      <section className="dash-card" aria-labelledby="studio-log-theme">
        <div className="dash-card-header">
          <h2 id="studio-log-theme" className="dash-card-title">
            This theme
          </h2>
        </div>
        <div className="dash-card-body">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex flex-wrap gap-x-2">
              <dt className="studio-muted">Theme ID</dt>
              <dd className="studio-code">{project.themeId}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="studio-muted">Model</dt>
              <dd>{model}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="studio-muted">Started by</dt>
              <dd>
                {project.createdByEmail} on {studioDate(project.createdAt)}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="studio-muted">StoreMink build</dt>
              <dd className="studio-code">{currentAcceptanceBuildId()}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="dash-card" aria-labelledby="studio-log-runs">
        <div className="dash-card-header">
          <h2 id="studio-log-runs" className="dash-card-title">
            Runs
          </h2>
        </div>
        <div className="dash-card-body">
          {project.runs.length === 0 ? (
            <p className="studio-muted text-sm">Nothing has run yet.</p>
          ) : (
            <ul className="grid gap-4">
              {project.runs.map((run) => {
                const retryable =
                  run.id === latest?.id &&
                  (run.status === "failed" || run.status === "cancelled") &&
                  (project.status === "failed" || project.status === "ready");
                const base = run.baseVersionId
                  ? (versionNumber.get(run.baseVersionId) ?? null)
                  : null;
                return (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-start justify-between gap-3 text-sm"
                  >
                    <div className="grid min-w-0 gap-0.5">
                      <p className="font-medium">
                        {KIND_WORDS[run.kind]}, {STATUS_WORDS[run.status]}
                        {run.cancelRequested && run.status === "running"
                          ? " (stopping)"
                          : ""}
                      </p>
                      <p className="studio-muted text-xs">
                        {run.provider === "fake"
                          ? "Test provider"
                          : "Gemini on Vertex AI"}{" "}
                        · attempt {run.attemptCount} of {run.maxAttempts} ·
                        queued {studioDate(run.createdAt)}
                        {run.finishedAt
                          ? ` · finished ${studioDate(run.finishedAt)}`
                          : ""}{" "}
                        · <span className="studio-code">{run.id}</span>
                      </p>
                      {run.status === "queued" && run.retryNotBefore ? (
                        <p className="text-xs">
                          {run.kind === "images"
                            ? `The pictures are saved. Their check tries again after ${studioDate(run.retryNotBefore)} (retry ${run.imageReviewDeferrals ?? 0} of 2); finished pictures are reused.`
                            : `Waiting for the model provider to have room. It tries again after ${studioDate(run.retryNotBefore)} (retry ${run.rateLimitDeferrals ?? 0} of 4); finished stages are saved.`}
                        </p>
                      ) : null}
                      {run.kind === "images" ? (
                        <p className="text-xs">
                          {run.imageSlotIds.length > 0
                            ? `Redraw of ${run.imageSlotIds.length} picture${run.imageSlotIds.length === 1 ? "" : "s"}`
                            : "Every placeholder"}
                          {run.images ? ` · ${imageRunLine(run.images)}` : ""}
                        </p>
                      ) : null}
                      {run.usage && run.kind !== "images" ? (
                        <p className="studio-muted text-xs">
                          {count(run.usage.inputTokens)} tokens in ·{" "}
                          {count(run.usage.outputTokens)} out
                          {run.usage.thinkingTokens > 0
                            ? ` · ${count(run.usage.thinkingTokens)} thinking`
                            : ""}
                          {run.usage.cachedTokens > 0
                            ? ` · ${count(run.usage.cachedTokens)} cached`
                            : ""}{" "}
                          · {cost(run.usage.estimatedCostMicroUsd)}
                          {run.usage.repairs > 0
                            ? ` · ${run.usage.repairs} repair${run.usage.repairs === 1 ? "" : "s"}`
                            : ""}
                        </p>
                      ) : null}
                      {run.errorCode ? (
                        <p className="text-xs">
                          {plainText(stopText(run.errorCode, "run"))}{" "}
                          <span className="studio-code">({run.errorCode})</span>
                          {run.refusalCategory
                            ? ` · category ${run.refusalCategory}`
                            : ""}
                        </p>
                      ) : null}
                      {run.images?.anchorRejection ? (
                        <p className="text-xs">
                          The check found:{" "}
                          {run.images.anchorRejection.problems
                            .map((p) => THEME_IMAGE_PROBLEM_LABEL[p])
                            .join(", ") || "a problem"}
                          {run.images.anchorRejection.note
                            ? `: ${plainText(run.images.anchorRejection.note)}`
                            : ""}
                        </p>
                      ) : null}
                      {run.declineReason ? (
                        <p className="text-xs">
                          Reason: {plainText(run.declineReason)}
                        </p>
                      ) : null}
                      {run.questions.length > 0 ? (
                        <p className="text-xs">
                          Asked {run.questions.length} question
                          {run.questions.length === 1 ? "" : "s"}.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-start gap-2">
                      {(run.status === "queued" || run.status === "running") &&
                      !run.cancelRequested ? (
                        <CancelRunButton
                          projectId={project.id}
                          runId={run.id}
                          pictures={run.kind === "images"}
                        />
                      ) : null}
                      {retryable ? (
                        <RetryRunButton
                          projectId={project.id}
                          runId={run.id}
                          small
                        />
                      ) : null}
                      {run.errorCode ? (
                        <CopyDetailsButton
                          details={{
                            themeName: project.name,
                            themeId: project.themeId,
                            what: stopText(run.errorCode, "run"),
                            check: `${KIND_WORDS[run.kind].toLowerCase()} run ${run.id}`,
                            code: run.errorCode,
                            versionNumber: base,
                            build: null,
                            at: run.finishedAt ?? run.createdAt,
                          }}
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="dash-card" aria-labelledby="studio-log-publish">
        <div className="dash-card-header">
          <h2 id="studio-log-publish" className="dash-card-title">
            Publish history
          </h2>
        </div>
        <div className="dash-card-body">
          {publications.length === 0 && audit.length === 0 ? (
            <p className="studio-muted text-sm">
              This theme has not been published.
            </p>
          ) : (
            <ul className="grid gap-3 text-sm">
              {publications.map((p) => {
                const design = versionNumber.get(p.versionId);
                return (
                  <li key={p.id} className="grid gap-1">
                    <p>
                      <span className="font-medium">
                        Publish v{p.releaseVersion}
                      </span>
                      {design ? ` of Design ${design}` : ""}:{" "}
                      {PUBLICATION_WORDS[p.status] ?? "Didn't finish"}
                      <span className="studio-muted">
                        {" "}
                        · {p.createdByEmail} · {studioDate(p.createdAt)}
                        {p.completedAt
                          ? ` · finished ${studioDate(p.completedAt)}`
                          : ""}
                      </span>
                    </p>
                    {p.failure.length > 0 ? (
                      <>
                        <ul className="list-disc pl-5 text-xs">
                          {p.failure.map((reason) => (
                            <li key={reason}>{plainText(reason)}</li>
                          ))}
                        </ul>
                        <CopyDetailsButton
                          details={{
                            themeName: project.name,
                            themeId: project.themeId,
                            what: `Publish didn't finish: ${p.failure[0]}`,
                            check: `publish ${p.id}`,
                            code: p.status,
                            versionNumber: design ?? null,
                            build: null,
                            at: p.completedAt ?? p.createdAt,
                          }}
                        />
                      </>
                    ) : null}
                  </li>
                );
              })}
              {audit.map((row) => (
                <li key={row.id}>
                  <span className="font-medium">
                    {AUDIT_WORDS[row.action] ?? "Changed the catalog record"}
                  </span>
                  <span className="studio-muted">
                    {" "}
                    · {row.releaseVersion ? `v${row.releaseVersion} · ` : ""}
                    {row.createdByEmail} · {studioDate(row.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="dash-card" aria-labelledby="studio-log-activity">
        <div className="dash-card-header">
          <h2 id="studio-log-activity" className="dash-card-title">
            Activity
          </h2>
        </div>
        <div className="dash-card-body">
          <ul className="grid gap-1.5 text-xs">
            {project.events.map((event) => {
              const line = activityLine(event);
              if (!line) return null;
              return (
                <li key={event.id} className="flex flex-wrap gap-x-2">
                  <span className="studio-muted">
                    {studioDate(event.createdAt)}
                  </span>
                  <span className="font-medium">{line.text}</span>
                  <span>{activityActor(event)}</span>
                  {line.note ? <span>{line.note}</span> : null}
                  {line.stop ? (
                    <span>
                      {plainText(line.stop.sentence)}{" "}
                      <span className="studio-code">({line.stop.code})</span>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}
