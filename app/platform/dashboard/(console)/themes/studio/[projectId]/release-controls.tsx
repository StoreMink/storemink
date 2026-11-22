import { getThemeStudioActor } from "@/lib/theme-studio/access";
import type { GateFinding } from "@/lib/theme-studio/acceptance-gates";
import type { PublicationWarning } from "@/lib/theme-studio/publication";
import type { ReviewFinding } from "@/lib/theme-studio/scorecard";
import { subdomainOrigin } from "@/lib/store/host";
import { isStudioMenuKind, type StudioAction } from "../studio-status";
import { plainText } from "../studio-ui";
import {
  clockWords,
  findingWords,
  placeWords,
  reviewFindingWords,
  slotPlace,
} from "../studio-words";
import {
  ReleasePanel,
  type ReleaseLiveFacts,
  type ReleasePublishFacts,
} from "./release/release-workspace";
import type { ReleaseControlsProps } from "./tab-types";
import { readStudioProject, readStudioReleaseState } from "./tab-reads";

// ---------------------------------------------------------------------------
// The release controls in the theme page's header (wave TS-2, builder 2C;
// contract section 6.4): on the release rows (STUDIO_RELEASE_ROWS: live,
// publishing, publish didn't finish, Ready to publish) they render the row's
// main button and its visible secondary actions. This server part reads the
// facts (publication.ts getThemeStudioReleaseState, the project) and words
// them; release/release-workspace.tsx acts.
//
// ★ THE WORDS COME FROM THE STATUS FUNCTION'S ACTIONS. Which buttons show is
// studioStatus's answer (studio-status.ts); the "..." menu's kinds stay in
// the header's menu. Warnings are worded by studio-words.ts, as on the
// Checks tab, never by their stored codes.
//
// An async server component: only the theme page renders it, after its
// superadmin gate.
// ---------------------------------------------------------------------------

const INDIA = "Asia/Kolkata";

/** A day in words, India time: "1 Oct", with the year when it is not this
 * year's ("1 Oct 2025"). */
export function dayWords(
  iso: string | null | undefined,
  now: string,
): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const year = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: INDIA,
      year: "numeric",
    }).format(d);
  const today = new Date(now);
  const withYear =
    !Number.isFinite(today.getTime()) || year(at) !== year(today);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA,
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(at);
}

/** A design-review warning's place back as its finding: a slot, a row and
 * its score, or the total (publication-core.ts reviewWhere). */
function reviewFindingAt(
  code: string,
  where: string | undefined,
): ReviewFinding {
  if (!where) return { code };
  const row = /^([a-zA-Z]+) (\d+(?:\.\d+)?) of 5$/.exec(where);
  if (row)
    return {
      code,
      row: row[1] as ReviewFinding["row"],
      score: Number(row[2]),
    };
  const total = /^(\d+(?:\.\d+)?) of 40$/.exec(where);
  if (total) return { code, score: Number(total[1]) };
  return { code, slotId: where };
}

/** One warning that goes live, in plain words, for the Publish dialog. */
export function publishWarningLine(warning: PublicationWarning): string {
  if (warning.source === "review" || !warning.gate) {
    const places = warning.where.length ? warning.where : [undefined];
    return places
      .slice(0, 3)
      .map(
        (where) =>
          reviewFindingWords(reviewFindingAt(warning.code, where), false).text,
      )
      .filter((text, index, all) => all.indexOf(text) === index)
      .join(" ");
  }
  const finding: GateFinding = {
    code: warning.code,
    message: warning.message ?? "",
    ...(warning.where[0] ? { where: warning.where[0] } : {}),
  };
  const words = findingWords(warning.gate, finding);
  const places = warning.where
    .map((where) =>
      warning.gate?.startsWith("assets.")
        ? slotPlace(where)
        : placeWords(where),
    )
    .filter((place): place is string => Boolean(place))
    .slice(0, 3);
  const where = places.length ? ` (${places.join(", ")})` : "";
  const shared =
    warning.platform && !words.storeMink
      ? " This is in StoreMink's shared storefront code; StoreMink has been told."
      : "";
  return plainText(`${words.heading}${where}: ${words.text}${shared}`);
}

const RECHECK_REASON = {
  old_build: "StoreMink was updated since these checks.",
  no_review: "These checks have no design review on today's build yet.",
  none: "No passing check covers this design as it stands.",
} as const;

export async function ReleaseControls({
  projectId,
  versionId,
  revision,
  status,
}: ReleaseControlsProps) {
  const actions = [status.primary, ...status.secondary].filter(
    (action): action is StudioAction =>
      action !== null && !isStudioMenuKind(action.kind),
  );
  const project = await readStudioProject(projectId);
  if (!project) return null;
  const demoOrigin = subdomainOrigin(`demo-${project.themeId}`);
  const common = {
    projectId: project.id,
    name: project.name,
    revision,
    row: status.row,
    actions,
    demoOrigin,
  };
  if (status.row === 2)
    return <ReleasePanel {...common} live={null} publish={null} />;

  const release = await readStudioReleaseState(projectId);
  if (!release) return null;
  const now = new Date().toISOString();

  if (status.row === 1) {
    const published = release.publications.find(
      (p) => p.status === "published",
    );
    const live: ReleaseLiveFacts = {
      offered: release.catalog?.visibility === "public",
      version:
        release.catalog?.releaseVersion ?? published?.releaseVersion ?? null,
      since: dayWords(published?.completedAt ?? published?.createdAt, now),
    };
    return <ReleasePanel {...common} live={live} publish={null} />;
  }

  const current =
    project.versions.find((v) => v.id === project.currentVersionId) ?? null;
  const viewed =
    versionId && versionId !== project.currentVersionId
      ? (project.versions.find((v) => v.id === versionId) ?? null)
      : null;
  const lastFailed =
    status.row === 3
      ? release.publications.find((p) => p.status === "failed")
      : undefined;
  const actor = await getThemeStudioActor();
  const blocker = release.blockers[0];
  const waitReason = blocker
    ? `This theme can't be published as it is: ${plainText(blocker)}${release.blockers.length > 1 ? ` (and ${release.blockers.length - 1} more)` : ""}`
    : !release.evidence.ok && !release.recheckOnPublish
      ? plainText(release.evidence.reason)
      : null;
  const publish: ReleasePublishFacts = {
    designNumber: release.versionNumber ?? current?.versionNumber ?? null,
    madeAt: current ? clockWords(current.createdAt, now) : null,
    viewingNumber: viewed?.versionNumber ?? null,
    warnings: release.recheckOnPublish
      ? []
      : release.warnings.map(publishWarningLine),
    recheck: release.recheckOnPublish,
    recheckReason: release.evidenceGap
      ? RECHECK_REASON[release.evidenceGap]
      : null,
    waitReason,
    lastReasons: (lastFailed?.failure ?? []).slice(0, 3).map(plainText),
    notifies:
      !!actor &&
      actor.email.trim().toLowerCase() ===
        project.createdByEmail.trim().toLowerCase(),
    // A theme that already has a release: this publish is its next version.
    replaces:
      release.catalog?.releaseVersion ??
      release.publications.find((p) => p.status === "published")
        ?.releaseVersion ??
      null,
  };
  return <ReleasePanel {...common} live={null} publish={publish} />;
}
