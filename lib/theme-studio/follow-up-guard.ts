import type { ThemePackageV2 } from "./contracts";
import { repairTargets } from "./targeted-repair";

// ---------------------------------------------------------------------------
// An automatic fix never undoes what the operator just asked for (owner,
// 23 Nov 2026: "ai theme builder should be capable of understanding the
// follow ups the operator gives").
//
// WHY. After an operator's change, the checks and the design review may queue
// automatic fix rounds ("Fixing what the review found"). Each round used to
// see only the review's findings: its message is the findings, never the
// operator's request. So a round could tidy a finding by setting back the
// very setting the operator's change made (a menu moved back behind the menu
// button, a colour back to the one they asked to replace), and nothing
// stopped it.
//
// Now a fix round that follows an operator's change carries that change:
//   * `request`: the operator's words, given to the fix as a requirement;
//   * `before`: every scalar setting the change moved, with the value it had
//     BEFORE the change. A fix may still change such a setting (a contrast
//     fix may need a different colour); it may not set it back to that
//     earlier value, which is what undoing the request means.
// The worker finds the change by walking back from the version being fixed
// through automatic runs to the last run the operator asked for
// (worker.ts loadFollowUp). Pure: no database, no provider.
// ---------------------------------------------------------------------------

/** The operator's change a fix round must not undo. */
export interface FollowUp {
  /** The operator's request, as they wrote it (bounded). */
  request: string;
  /** Setting path to the value it had before the operator's change (null
   *  when the change added it). */
  before: Readonly<Record<string, unknown>>;
}

/** The longest request handed to a fix round. */
export const FOLLOW_UP_REQUEST_LIMIT = 2_000;

function settingValues(pkg: ThemePackageV2): Map<string, unknown> {
  return new Map(repairTargets(pkg).map((t) => [t.path, t.current ?? null]));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Every scalar setting a change moved, each with its value before it. */
export function changedSettings(
  base: ThemePackageV2,
  result: ThemePackageV2,
): Record<string, unknown> {
  const was = settingValues(base);
  const now = settingValues(result);
  const before: Record<string, unknown> = {};
  for (const path of new Set([...was.keys(), ...now.keys()])) {
    if (!same(was.get(path), now.get(path)))
      before[path] = was.get(path) ?? null;
  }
  return before;
}

/** The operator's change, ready for a fix round. */
export function followUpOf(
  request: string,
  base: ThemePackageV2,
  result: ThemePackageV2,
): FollowUp {
  return {
    request: request.slice(0, FOLLOW_UP_REQUEST_LIMIT),
    before: changedSettings(base, result),
  };
}

/**
 * The settings a fix would set back to their value before the operator's
 * change. `changed` are the paths the fix wrote; `repaired` the package it
 * made.
 */
export function undoneSettings(
  followUp: FollowUp,
  changed: readonly string[],
  repaired: ThemePackageV2,
): string[] {
  const after = settingValues(repaired);
  return changed.filter(
    (path) =>
      Object.hasOwn(followUp.before, path) &&
      same(after.get(path), followUp.before[path]),
  );
}

/** Appended to the repair's system prompt when a follow-up is carried. */
export const FOLLOW_UP_REPAIR_RULE =
  " operatorRequest is the operator's latest change to this theme, and the theme must keep meeting it: never undo it. A setting that change made may not be set back to its earlier value; resolve a finding that touches it another way.";

/** What a fix round is told when it tried to undo the request. */
export function undoneIssue(path: string): string {
  return `${path}: the operator's latest request set this. Keep it, and resolve the finding another way (another value, or another setting).`;
}
