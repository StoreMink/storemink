import "server-only";

import { eq } from "drizzle-orm";
import { themeStudioProjects } from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import type { EventKey } from "@/lib/notifications/events";
import { recordEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// The notice an operator gets when a theme they started needs them (TS-3B).
//
// ★ A theme takes half an hour or more to design, draw and check, and nobody
//   watches it (owner's decision 8, 24 Oct 2026). So when it is ready to
//   publish, needs a fix, or Theme Studio has questions about the brief, the
//   operator who STARTED it (the project's created_by_email) gets a bell
//   notice in the operator console and an email. Nobody else: the operators
//   audience reaches every platform admin, so the notice is narrowed with
//   `restrictToOperatorEmails`, which can only ever remove people (record.ts).
// ★ The email rides the existing notification queue and its `notification`
//   mail type; nothing here sends mail itself.
// ★ IT NEVER BREAKS THE WORK IT REPORTS ON. Every failure is logged (ids and
//   the kind only, never the brief or the theme's name) and swallowed.
// ★ ONE WAY IN: `sendThemeStudioNotice(...)`, called with no transaction
//   open. It reads the project in one short transaction and records the
//   notice in the next, never one inside the other. Every notice goes this
//   way after the transaction that settled the work has committed: the
//   worker sends `questions` (the AI asks about a brief) and `needs_fix` (a
//   step stopped a theme), and the design review sends `ready` and
//   `needs_fix` through automatic-work.ts's after-commit outbox
//   (`withServiceAndNotices`, TS-3A).
// ⚠ `notifyThemeStudioOperator(db, ...)` has NO caller (only its test) and is
//   listed for the TS-4C clean-up. It reads with the caller's `db` and then
//   records in its OWN transaction (recordEvent, which also kicks the email
//   worker, up to 5 s), so inside a transaction it needs a second pooled
//   connection while the first is held: on a pool of one (the private
//   workers' DB_POOL_MAX=1) that waits the pool's 5 s and fails. Never call
//   it inside a transaction; use `sendThemeStudioNotice` after the commit.
// ---------------------------------------------------------------------------

export type ThemeStudioNoticeKind = "ready" | "needs_fix" | "questions";

/** The registry event each notice is (lib/notifications/events.ts). */
export const THEME_STUDIO_NOTICE_EVENTS = {
  ready: "platform.theme_studio_ready",
  needs_fix: "platform.theme_studio_needs_fix",
  questions: "platform.theme_studio_questions",
} as const satisfies Record<ThemeStudioNoticeKind, EventKey>;

type NoticeInput = { projectId: string; kind: ThemeStudioNoticeKind };
type NoticeProject = { name: string; starter: string };

/** Who to tell and what to call the theme; null when nobody is to be told:
 * the project is gone, removed from the list, or has no starting operator. */
async function noticeProject(
  db: Db,
  projectId: string,
): Promise<NoticeProject | null> {
  const [project] = await db
    .select({
      name: themeStudioProjects.name,
      createdByEmail: themeStudioProjects.createdByEmail,
      status: themeStudioProjects.status,
    })
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, projectId))
    .limit(1);
  if (!project || project.status === "archived") return null;
  const starter = project.createdByEmail.trim().toLowerCase();
  return starter ? { name: project.name, starter } : null;
}

async function recordNotice(input: NoticeInput, project: NoticeProject) {
  await recordEvent({
    type: THEME_STUDIO_NOTICE_EVENTS[input.kind],
    storeId: null,
    actor: { type: "system", label: "Theme Studio" },
    subject: {
      type: "theme_studio_project",
      id: input.projectId,
      label: project.name,
    },
    restrictToOperatorEmails: [project.starter],
  });
}

function logFailure(error: unknown, input: NoticeInput) {
  logError("theme_studio.operator_notice_failed", error, {
    projectId: input.projectId,
    kind: input.kind,
  });
}

export async function notifyThemeStudioOperator(
  db: Db,
  input: NoticeInput,
): Promise<void> {
  try {
    if (!THEME_STUDIO_NOTICE_EVENTS[input.kind]) return;
    const project = await noticeProject(db, input.projectId);
    if (project) await recordNotice(input, project);
  } catch (error) {
    logFailure(error, input);
  }
}

/** The same notice for a caller with no transaction open (see the header). */
export async function sendThemeStudioNotice(input: NoticeInput): Promise<void> {
  try {
    if (!THEME_STUDIO_NOTICE_EVENTS[input.kind]) return;
    const project = await withService((db) =>
      noticeProject(db, input.projectId),
    );
    if (project) await recordNotice(input, project);
  } catch (error) {
    logFailure(error, input);
  }
}
