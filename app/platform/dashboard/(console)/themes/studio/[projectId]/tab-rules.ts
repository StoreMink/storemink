import type { ThemeStudioConfig } from "@/lib/theme-studio/config";
import type {
  ThemeStudioProjectDetail,
  ThemeStudioRunView,
  ThemeStudioVersionView,
} from "@/lib/theme-studio/repository";
import { questionsOpen } from "../studio-ui";

// ---------------------------------------------------------------------------
// When the tabs' buttons can act, and the sentence written under them when
// they cannot (wave TS-2, builder 2C). No tooltips: a disabled button always
// says why underneath it.
//
// ★ CLIENT COPIES OF THE SERVER'S RULES. The server decides
// (repository.ts reviseThemeStudioVersion, queueThemeStudioImages,
// retryThemeStudioRun; slot-images.ts replaceThemeStudioSlotImages); these
// only keep a button from offering what the server would refuse, and its
// refusal is still shown if the two ever disagree. Pure: the tabs compute
// them on the server.
// ---------------------------------------------------------------------------

type Switches = Pick<ThemeStudioConfig, "generationEnabled" | "disabledModels">;
type Project = Pick<
  ThemeStudioProjectDetail,
  "status" | "modelKey" | "runs" | "events"
>;

/** Why a change described in the chat can't be sent now (Describe a fix,
 * Describe a change), or null when it can. */
export function changeBlockedReason(
  project: Project,
  config: Switches,
): string | null {
  if (!config.generationEnabled)
    return "Building is switched off on this deployment, so a change can't be sent now.";
  if (config.disabledModels.has(project.modelKey))
    return "This theme's model is switched off on this deployment, so a change can't be sent until it is switched on again.";
  switch (project.status) {
    case "generating":
      return "Theme Studio is working on this theme. You can send a change when it finishes.";
    // A live theme takes a change (migration 0288): publishing the result
    // is the theme's next release, and stores keep the one they installed.
    case "archived":
      return "This theme was removed from the list, so it can't be changed.";
    case "draft":
    case "failed":
      return "This theme has no design to change yet.";
    case "blocked":
      return questionsOpen(project)
        ? "Answer the questions in the chat first."
        : null;
    default:
      return null;
  }
}

/** Why the pictures of a design can't be changed now (uploads, Save), or
 * null when they can: the server takes picture changes on a theme that is
 * ready, Ready to publish or live. */
export function pictureEditBlockedReason(project: Project): string | null {
  switch (project.status) {
    case "ready":
    case "candidate":
    // A live theme's pictures can be changed too (migration 0288).
    case "published":
      return null;
    case "generating":
      return "Theme Studio is working on this theme. Change the pictures once it finishes.";
    case "approved":
      return "A publish that didn't finish holds the theme: try it again first.";
    case "archived":
      return "This theme was removed from the list, so it can't be changed.";
    case "blocked":
      return "This theme needs your answer or a fix first; then its pictures can be changed.";
    default:
      return "This theme has no finished design yet, so its pictures can't be changed.";
  }
}

/** Why pictures can't be drawn now (Draw missing pictures, Redraw), or null
 * when they can: as for any picture change, and building must be on. */
export function pictureDrawBlockedReason(
  project: Project,
  config: Switches,
): string | null {
  if (!config.generationEnabled)
    return "Building is switched off on this deployment, so pictures can't be drawn now.";
  return pictureEditBlockedReason(project);
}

/** The newest picture run of one design: one drawing on it, or the one
 * that made it (progress.ts reads the same for the status words). */
export function newestPictureRun(
  project: Pick<ThemeStudioProjectDetail, "runs">,
  version: Pick<ThemeStudioVersionView, "id" | "runId">,
): ThemeStudioRunView | null {
  const runs = project.runs.filter(
    (run) =>
      run.kind === "images" &&
      (run.baseVersionId === version.id || run.id === version.runId),
  );
  runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return runs[0] ?? null;
}

/** Why a stopped picture run can't be tried again now, or null when it can
 * (repository.ts retryThemeStudioRun: the run failed or was cancelled, and
 * the theme is ready, or failed with no design). */
export function pictureRetryBlockedReason(
  project: Project,
  run: Pick<ThemeStudioRunView, "status">,
  config: Switches,
): string | null {
  if (run.status !== "failed" && run.status !== "cancelled")
    return "Only a picture run that stopped can be tried again.";
  if (!config.generationEnabled)
    return "Building is switched off on this deployment, so pictures can't be drawn now.";
  if (project.status === "ready" || project.status === "failed") return null;
  if (project.status === "generating")
    return "Theme Studio is working on this theme. Try again once it finishes.";
  return "This theme moved on since that run stopped, so draw the pictures again instead.";
}
