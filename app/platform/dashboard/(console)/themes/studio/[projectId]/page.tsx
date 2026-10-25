import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { getThemeStudioConfig } from "@/lib/theme-studio/config";
import {
  THEME_STUDIO_LIMITS,
  THEME_STUDIO_VIEWPORTS,
} from "@/lib/theme-studio/contracts";
import {
  readThemeStudioBuildTimeRange,
  readThemeStudioProgress,
} from "@/lib/theme-studio/progress";
import { withService } from "@/lib/db/client";
import { requireOperator } from "../../../require-operator";
import { STUDIO_RELEASE_ROWS, studioStatus } from "../studio-status";
import { SuperadminOnly } from "../studio-ui";
import { ChangesTab } from "./changes-tab";
import { ChecksTab } from "./checks-tab";
import { LogTab } from "./log-tab";
import { PicturesTab } from "./pictures-tab";
import { ReleaseControls } from "./release-controls";
import { readStudioProject } from "./tab-reads";
import {
  STUDIO_PAGE_PARAMS,
  studioPageHref,
  studioTabFromParam,
  type StudioTabKey,
  type StudioTabProps,
} from "./tab-types";
import { ProjectWorkspace } from "./workspace";

export const metadata = { title: "Theme Studio · StoreMink Admin" };

// ---------------------------------------------------------------------------
// The theme page (wave TS-2, plan section 4; contract in
// revamp-handoff/scratchpad/progress/ts2-contract.md, section 6).
// /dashboard/themes/studio/[projectId]?tab=&version=&do=
//
// ★ THE GATE COMES FIRST. requireOperator() and getThemeStudioActor() run
// before any read: everything below is superadmin data read under service
// scope, which bypasses RLS, so this check is the whole of the access
// control (access.ts).
//
// ★ ONE TAB IS RENDERED, THE OPEN ONE. The tab files are async server
// components that read their own data, so opening a tab loads its data and
// one refresh never loads every tab. The Preview tab is the workspace's own
// and stays mounted while another tab is open.
//
// ★ `?version=` THAT IS NOT A DESIGN OF THIS THEME shows the current design,
// never an error page: a hidden version, another theme's, garbage.
// `?repairAcceptance=` (today's Checks page's "Describe a fix") is retired:
// its replacement is the Checks tab with `do=describe_fix`.
// ---------------------------------------------------------------------------

type SearchParams = Record<string, string | string[] | undefined>;

function back() {
  return (
    <Link href="/dashboard/themes/studio" className="studio-crumb">
      <ChevronLeft aria-hidden="true" className="h-4 w-4" /> Themes
    </Link>
  );
}

function first(value: string | string[] | undefined): string | null {
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" && one ? one : null;
}

export default async function ThemeStudioProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requireOperator();
  const actor = await getThemeStudioActor();
  if (!actor) {
    return (
      <div className="studio-root grid w-full max-w-6xl gap-6">
        {back()}
        <SuperadminOnly />
      </div>
    );
  }
  const { projectId } = await params;
  const query = await searchParams;

  if (first(query.repairAcceptance)) {
    const kept = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      const one = first(value);
      if (one && key !== "repairAcceptance") kept.set(key, one);
    }
    redirect(
      studioPageHref(projectId, kept, {
        tab: "checks",
        intent: "describe_fix",
      }),
    );
  }

  const reads = await withService(async (db) => {
    // One after the other on purpose: they share one client.
    const progress = await readThemeStudioProgress(db, { projectId });
    const buildTime = await readThemeStudioBuildTimeRange(db);
    return { progress, buildTime };
  });
  let progress = reads.progress;
  const buildTime = reads.buildTime;
  if (!progress) notFound();
  // ★ ONE PROJECT READ PER REQUEST. The open tab and the release controls
  // read the project through the same React cache (tab-reads.ts), keyed by
  // the id as the database writes it, so the whole project (every design's
  // theme file and every run) is read once, not twice.
  const project = await readStudioProject(progress.projectId);
  if (!project) notFound();
  // A write between the two reads made the project newer than the progress:
  // read the progress once more (narrow and cheap), so the buttons shown
  // never describe an older state than the revision every action sends.
  if (project.revision > progress.revision) {
    progress =
      (await withService((db) =>
        readThemeStudioProgress(db, { projectId: project.id }),
      )) ?? progress;
  }

  const status = studioStatus(progress.status);
  const tab: StudioTabKey = studioTabFromParam(query[STUDIO_PAGE_PARAMS.tab]);
  const asked = first(query[STUDIO_PAGE_PARAMS.version]);
  const packaged = [...project.versions]
    .filter((version) => version.hasPackage)
    .sort((a, b) => b.versionNumber - a.versionNumber);
  const versionId =
    project.versions.find((version) => version.id === asked)?.id ??
    (project.currentVersionId &&
    project.versions.some((version) => version.id === project.currentVersionId)
      ? project.currentVersionId
      : (packaged[0]?.id ?? null));
  const tabProps: StudioTabProps = {
    projectId: project.id,
    versionId,
    revision: project.revision,
  };
  const tabContent =
    tab === "checks" ? (
      <ChecksTab {...tabProps} />
    ) : tab === "pictures" ? (
      <PicturesTab {...tabProps} />
    ) : tab === "changes" ? (
      <ChangesTab {...tabProps} />
    ) : tab === "log" ? (
      <LogTab {...tabProps} />
    ) : null;
  const releaseControls = (STUDIO_RELEASE_ROWS as readonly number[]).includes(
    status.row,
  ) ? (
    <ReleaseControls {...tabProps} status={status} />
  ) : null;
  const config = getThemeStudioConfig();

  return (
    <ProjectWorkspace
      key={project.id}
      project={project}
      initialProgress={progress}
      serverRow={status.row}
      buildTime={buildTime}
      tab={tab}
      explicitTab={first(query[STUDIO_PAGE_PARAMS.tab]) !== null}
      versionId={versionId}
      tabContent={tabContent}
      releaseControls={releaseControls}
      viewports={THEME_STUDIO_VIEWPORTS}
      testProvider={config.provider === "fake"}
      referenceLimit={THEME_STUDIO_LIMITS.referenceImages}
      notifiesViewer={
        actor.email.trim().toLowerCase() ===
        project.createdByEmail.trim().toLowerCase()
      }
      // The draft layout (plan section 5, optimisation 1) needs the hidden
      // version whose layout check passed; the progress read does not name
      // it yet (TS-2 handoff), so the preview shows the newest design.
      draftLayout={null}
    />
  );
}
