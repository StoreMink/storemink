import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { themeStudioMessages, themeStudioProjects } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import {
  getThemeStudioConfig,
  isImplementedProvider,
} from "@/lib/theme-studio/config";
import {
  THEME_STUDIO_CATALOG_SIZES,
  THEME_STUDIO_FEATURES,
  THEME_STUDIO_INDUSTRIES,
  THEME_STUDIO_LIMITS,
} from "@/lib/theme-studio/contracts";
import {
  parseThemeStudioModelKey,
  themeStudioModelOptions,
} from "@/lib/theme-studio/models";
import {
  readThemeStudioBuildTimeRange,
  type ThemeStudioBuildTimeRange,
} from "@/lib/theme-studio/progress";
import { isUuid } from "@/lib/theme-studio/repository";
import { isBundledThemeId } from "@/lib/themes";
import {
  THEME_META,
  type ThemeCatalogSize,
  type ThemeFeature,
  type ThemeIndustry,
} from "@/lib/themes/meta";
import { requireOperator } from "../../../require-operator";
import { SuperadminOnly } from "../studio-ui";
import { buildTimeWords } from "../studio-words";
import { NewProjectForm, type NewThemeInitial } from "./new-project-form";
import { nextThemeName } from "./new-theme-helpers";

export const metadata = { title: "New theme · StoreMink Admin" };

// ---------------------------------------------------------------------------
// New theme (wave TS-2, builder 2D; plan section 4, "New theme").
//
// ★ SUPERADMIN ONLY, BEFORE ANY READ (require-operator.ts explains why the
// layout's redirect is not enough; access.ts why a member is refused). A
// member sees today's notice and nothing is read for them.
//
// ★ "START FROM A THEME" OFFERS ONLY WHAT THE SERVER ACCEPTS: the bundled
// themes (repository.ts validateProjectInput takes `isBundledThemeId` only).
// The runtime catalogue also lists published Studio themes, which the server
// refuses as a starting point, so it is not read here.
//
// ★ "START A NEW THEME FROM THIS BRIEF" ARRIVES AS `?from=<projectId>`, and
// the brief is read here, on the server, after the gate: an address never
// carries brief text. The read is narrow (one project row, its first brief
// message); everything it fills in is re-checked against today's lists.
// ---------------------------------------------------------------------------

/** "Usually 35 to 75 minutes": the 4 Oct 2026 benchmark, used until this
 * deployment has 10 finished builds, or when the measured range can't be
 * read (progress.ts readThemeStudioBuildTimeRange). */
const DEFAULT_BUILD_TIME: ThemeStudioBuildTimeRange = {
  fromMinutes: 35,
  toMinutes: 75,
  basedOn: 0,
  source: "default",
};

async function buildTimeRange(): Promise<ThemeStudioBuildTimeRange> {
  try {
    return await withService((db) => readThemeStudioBuildTimeRange(db));
  } catch (error) {
    logError("theme studio: build time range read failed", error);
    return DEFAULT_BUILD_TIME;
  }
}

interface SourceTheme {
  name: string;
  brief: string;
  industries: string[];
  catalogSizes: string[];
  requiredFeatures: string[];
  baseThemeId: string | null;
  modelKey: string;
}

/** The theme a new one starts from: its name, its settings and the brief
 * it was first built from (its first `brief` message, or its saved draft
 * brief when nothing was ever sent). Null when there is no such theme. */
async function readSourceTheme(projectId: string): Promise<SourceTheme | null> {
  try {
    return await withService(async (db) => {
      const [project] = await db
        .select({
          name: themeStudioProjects.name,
          industries: themeStudioProjects.industries,
          catalogSizes: themeStudioProjects.catalogSizes,
          requiredFeatures: themeStudioProjects.requiredFeatures,
          baseThemeId: themeStudioProjects.baseThemeId,
          modelKey: themeStudioProjects.modelKey,
          draftBrief: themeStudioProjects.draftBrief,
        })
        .from(themeStudioProjects)
        .where(eq(themeStudioProjects.id, projectId))
        .limit(1);
      if (!project) return null;
      const [first] = await db
        .select({ body: themeStudioMessages.body })
        .from(themeStudioMessages)
        .where(
          and(
            eq(themeStudioMessages.projectId, projectId),
            eq(themeStudioMessages.kind, "brief"),
          ),
        )
        .orderBy(asc(themeStudioMessages.createdAt))
        .limit(1);
      const { draftBrief, ...rest } = project;
      return { ...rest, brief: first?.body ?? draftBrief };
    });
  } catch (error) {
    logError("theme studio: source theme read failed", error, { projectId });
    return null;
  }
}

function onlyFrom<T extends string>(
  values: readonly string[],
  allowed: readonly T[],
): T[] {
  return [...new Set(values)].filter((value): value is T =>
    (allowed as readonly string[]).includes(value),
  );
}

/** Today's form values for a new theme from `source`: anything that is no
 * longer offered (a switched-off model, a value that left a list, a base
 * theme that is not bundled) is left out rather than refused at Create. */
function initialFrom(
  source: SourceTheme,
  enabledModels: ReadonlySet<string>,
): NewThemeInitial {
  const modelKey = parseThemeStudioModelKey(source.modelKey);
  const sizes = onlyFrom<ThemeCatalogSize>(
    source.catalogSizes,
    THEME_STUDIO_CATALOG_SIZES,
  );
  return {
    name: nextThemeName(source.name),
    brief: source.brief.slice(0, THEME_STUDIO_LIMITS.promptChars),
    industries: onlyFrom<ThemeIndustry>(
      source.industries,
      THEME_STUDIO_INDUSTRIES,
    ).slice(0, 5),
    catalogSizes: sizes.length > 0 ? sizes : ["small"],
    requiredFeatures: onlyFrom<ThemeFeature>(
      source.requiredFeatures,
      THEME_STUDIO_FEATURES,
    ).slice(0, 10),
    baseThemeId: isBundledThemeId(source.baseThemeId)
      ? source.baseThemeId
      : null,
    modelKey: modelKey && enabledModels.has(modelKey) ? modelKey : null,
  };
}

export default async function NewThemeStudioProjectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const actor = await getThemeStudioActor();

  return (
    <div className="studio-root w-full max-w-3xl space-y-6">
      <Link
        href="/dashboard/themes/studio"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--dash-text-2)] transition hover:text-[var(--dash-text)] max-md:min-h-11 pointer-coarse:min-h-11"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" /> Theme Studio
      </Link>
      {!actor ? (
        <>
          <header className="dash-page-header">
            <h1>New theme</h1>
          </header>
          <SuperadminOnly />
        </>
      ) : (
        <NewTheme from={(await searchParams).from} />
      )}
    </div>
  );
}

async function NewTheme({ from }: { from: string | string[] | undefined }) {
  const config = getThemeStudioConfig();
  const allModels = themeStudioModelOptions();
  // A model switched off in this deployment is not offered, rather than
  // offered and then refused when the build is queued.
  const enabledModels = allModels.filter(
    (m) => !config.disabledModels.has(m.key),
  );
  const buildingOffReason = !config.generationEnabled
    ? "Building is switched off on this deployment."
    : !isImplementedProvider(config.provider)
      ? "No model provider is set up on this deployment."
      : enabledModels.length === 0
        ? "Every model is switched off on this deployment."
        : null;
  const range = await buildTimeRange();
  const sourceId = typeof from === "string" && isUuid(from) ? from : null;
  const source = sourceId ? await readSourceTheme(sourceId) : null;
  const initial = source
    ? initialFrom(source, new Set(enabledModels.map((m) => m.key)))
    : null;
  // Only the bundled themes, as names: never the definitions themselves.
  const baseThemes = THEME_META.filter((theme) =>
    isBundledThemeId(theme.id),
  ).map(({ id, name }) => ({ id, name }));

  return (
    <>
      <header className="dash-page-header">
        <h1>New theme</h1>
        <p>
          Theme Studio designs the theme, draws its pictures and checks every
          page. {buildTimeWords(range)}
        </p>
      </header>
      {source ? (
        <p className="studio-notice" data-tone="info">
          Filled in from {source.name}. Check the name and the brief, then
          create.
        </p>
      ) : sourceId || from !== undefined ? (
        <p className="studio-notice" data-tone="neutral">
          That theme could not be found, so the form starts empty.
        </p>
      ) : null}
      {/* The browser gets model KEYS and labels, never provider ids, and
          vocabularies from the contract, so the form offers only what
          validateProjectInput accepts. A form opened from another brief is
          keyed by it, so its starting values are never stale. */}
      <NewProjectForm
        key={sourceId ?? "new"}
        models={enabledModels.length > 0 ? enabledModels : [...allModels]}
        baseThemes={baseThemes}
        industries={[...THEME_STUDIO_INDUSTRIES]}
        catalogSizes={[...THEME_STUDIO_CATALOG_SIZES]}
        features={[...THEME_STUDIO_FEATURES]}
        briefMax={THEME_STUDIO_LIMITS.promptChars}
        limits={{
          files: THEME_STUDIO_LIMITS.referenceImages,
          fileBytes: THEME_STUDIO_LIMITS.referenceImageBytes,
          totalBytes: THEME_STUDIO_LIMITS.referenceTotalBytes,
        }}
        buildingOff={buildingOffReason !== null}
        buildingOffReason={buildingOffReason}
        initial={initial}
      />
    </>
  );
}
