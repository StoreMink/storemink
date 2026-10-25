import {
  STUDIO_ACTION_KINDS,
  type StudioActionKind,
  type StudioStatus,
} from "../studio-status";

// ---------------------------------------------------------------------------
// The theme page's tabs and the slots 2C fills (wave TS-2; contract in
// revamp-handoff/scratchpad/progress/ts2-contract.md). Types, constants and
// the pure address helpers at the end (server-safe and client-safe: the page
// reads the address on the server, the tabs write it in the browser).
//
// ★ THE FOUR TAB FILES (checks-tab.tsx, pictures-tab.tsx, changes-tab.tsx,
// log-tab.tsx) AND release-controls.tsx ARE ASYNC SERVER COMPONENTS. 2B
// creates them as thin stubs in round 1 and 2C fills them in round 2. Only
// [projectId]/page.tsx renders them, after its superadmin gate: a tab only
// while it is the open one (so it loads its own data the first time it
// opens, and one refresh never loads every tab), the release controls only
// on the status rows that need them (STUDIO_RELEASE_ROWS). They read on the
// server, like today's sub-pages: server actions are for changes and run one
// at a time per browser.
//
// ★ THE PREVIEW TAB is 2B's own client view (preview-frame.tsx). It stays
// loaded while another tab is open.
// ---------------------------------------------------------------------------

/** The theme page's tabs, in display order. */
export const STUDIO_TAB_KEYS = [
  "preview",
  "checks",
  "pictures",
  "changes",
  "log",
] as const;

export type StudioTabKey = (typeof STUDIO_TAB_KEYS)[number];

/** The theme page's address: /dashboard/themes/studio/[projectId]?tab=&version=&do=
 * `tab`: the open tab (default "preview"). `version`: the design shown (an
 * operator-visible version id; default the current version). `do`: one
 * StudioActionKind the page acts on once (it opens that control's dialog or
 * confirm, never runs paid work by itself), then removes from the address. */
export const STUDIO_PAGE_PARAMS = {
  tab: "tab",
  version: "version",
  intent: "do",
} as const;

/** What every tab file and the release controls receive. */
export interface StudioTabProps {
  projectId: string;
  /** The design being viewed (the Design list, `?version=`); null when the
   * theme has no design yet. */
  versionId: string | null;
  /** theme_studio_projects.revision as the page rendered it: every action a
   * tab starts sends it as `expectedRevision`. */
  revision: number;
}

/** What [projectId]/release-controls.tsx (2C) receives: the tab props and
 * the page's status, so it renders the controls of its row (live panel,
 * publishing steps, "Publish didn't finish" with its reasons, Publish). */
export interface ReleaseControlsProps extends StudioTabProps {
  status: StudioStatus;
}

/**
 * What the theme page offers the components inside it (2B provides it with
 * `useStudioPage()` from [projectId]/studio-tabs.tsx; 2C's client parts call
 * it).
 */
export interface StudioPageApi {
  /** Put text in the chat composer for the operator to read and send; opens
   * the chat if it is folded. Never sends. */
  putInChat(text: string): void;
  /** Open a tab (the preview stays loaded), optionally on another design
   * and with an intent for that tab to act on (`do`). */
  openTab(
    tab: StudioTabKey,
    options?: { versionId?: string | null; intent?: StudioActionKind | null },
  ): void;
  /** Put an intent in the address (`do`) without changing tab, for a
   * control on the page that owns it (for example the phone bar's Publish
   * for the release controls). */
  requestIntent(kind: StudioActionKind): void;
  /** The release controls say why Publish waits (the sentence written under
   * their button), or null when it can go ahead, so the phone bar's Publish
   * holds back with the same sentence instead of opening a dialog the
   * server would refuse. Optional: only the theme page listens. */
  reportPublishWait?(reason: string | null): void;
}

// ------------------------------------------------------------- the address

/** A search parameter as Next.js hands it to a page: absent, once, or
 * repeated (the first value counts). */
type ParamValue = string | string[] | undefined | null;

function first(value: ParamValue): string | null {
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" && one.length > 0 ? one : null;
}

/** The open tab from `?tab=`: an unknown or missing value is the Preview. */
export function studioTabFromParam(value: ParamValue): StudioTabKey {
  const tab = first(value);
  return (STUDIO_TAB_KEYS as readonly string[]).includes(tab ?? "")
    ? (tab as StudioTabKey)
    : "preview";
}

/** The intent from `?do=`, or null for a missing or unknown one (an intent
 * is a closed list: a made-up `do` does nothing). */
export function studioIntentFromParam(
  value: ParamValue,
): StudioActionKind | null {
  const intent = first(value);
  return (STUDIO_ACTION_KINDS as readonly string[]).includes(intent ?? "")
    ? (intent as StudioActionKind)
    : null;
}

/**
 * The theme page's address with some of its parameters changed: a value sets
 * the parameter, null removes it, and a parameter not named keeps its value.
 * Every other parameter is kept as it was. The result is a path plus query,
 * always under /dashboard/themes/studio/<projectId>.
 */
export function studioPageHref(
  projectId: string,
  current: URLSearchParams | string,
  changes: {
    tab?: StudioTabKey | null;
    versionId?: string | null;
    intent?: StudioActionKind | null;
  },
): string {
  const params = new URLSearchParams(current);
  const set = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null) params.delete(key);
    else params.set(key, value);
  };
  set(STUDIO_PAGE_PARAMS.tab, changes.tab);
  set(STUDIO_PAGE_PARAMS.version, changes.versionId);
  set(STUDIO_PAGE_PARAMS.intent, changes.intent);
  const query = params.toString();
  const path = `/dashboard/themes/studio/${encodeURIComponent(projectId)}`;
  return query ? `${path}?${query}` : path;
}
