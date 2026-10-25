import "server-only";

// ---------------------------------------------------------------------------
// The revamp runner's actor, rebuilt from the database
// (docs/mink-storefront-revamp.md section 4; build spec section 3.7).
//
// A revamp runs in a background route with no session, for up to half an
// hour after the merchant asked for it. Everything the steps may do is decided
// by a `MinkActorContext`, so this rebuilds every authority-bearing field at
// each claim, the way `revalidateWorkflowAuthority` re-checks a queued
// workflow before every step: a role narrowed, an admin suspended, a platform
// operator removed or a plan lapsed in the meantime takes effect on the next
// invocation, never "after this job".
//
// ★★ NOTHING ON THE JOB ROW IS TRUSTED FOR AUTHORITY except the ids and the
//   requester's email, which were captured from the verified session when the
//   job was created. Role, permissions, suspension, plan, location bindings,
//   time zone and the saved brand voice are all read again here.
//
// ★ NULL MEANS "NO LONGER HAS ACCESS", AND A DATABASE ERROR IS NOT THAT. Every
//   read throws on failure (the runner then hands over and tries later), as
//   `getViewerContext` treats an unreachable database: an outage must never
//   read as "this admin may do nothing" and fail a merchant's paid build.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { can, SUPERADMIN_SLUG } from "@/app/dashboard/lib/permissions";
import type { RolePermissions } from "@/app/dashboard/lib/permissions";
import {
  adminLocations,
  admins,
  platformAdmins,
  storeBrandProfiles,
  stores,
} from "@/drizzle/schema";
import { normalizeAnalyticsTimeZone } from "@/lib/analytics/range";
import { withService } from "@/lib/db/client";
import { effectivePlan } from "@/lib/plans";
import { readRolePermissionsWith } from "@/lib/roles/platform-roles";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { getMinkStoreAccess } from "../access";
import type { MinkActorContext, MinkPlan } from "../types";
import type { RevampJobRow } from "./jobs";

const MAX_BRAND_VOICE = 6_000;

/**
 * The requester as they are NOW, or null when they no longer have access to
 * this store's dashboard (suspended, removed, the store gone or not active).
 * A role without Website Builder manage still gets an actor: the runner fails
 * that job with `not_allowed`, which is the sentence the card shows.
 */
export async function rebuildRevampActor(
  job: Pick<
    RevampJobRow,
    "storeId" | "adminId" | "requesterEmail" | "originRunId"
  >,
  requestId: string,
): Promise<MinkActorContext | null> {
  if (!job.storeId || !job.adminId) return null;
  const requesterEmail = normalizeEmail(job.requesterEmail);

  const authority = await withService(async (db) => {
    const storeRows = await db
      .select({
        status: stores.status,
        plan: stores.plan,
        planExpiresAt: stores.planExpiresAt,
        compPlan: stores.compPlan,
        compExpiresAt: stores.compExpiresAt,
        settings: stores.settings,
      })
      .from(stores)
      .where(eq(stores.id, job.storeId))
      .limit(1);
    const store = storeRows[0];
    // A suspended or deleted store builds nothing, whoever asked.
    if (!store || store.status !== "active") return null;

    // ★ A platform operator has no admins row for the store they are working
    //   in; the verified email captured at the start is how they are found,
    //   exactly as `revalidateWorkflowAuthority` finds one. Exact match on the
    //   lowercased address, never a pattern (access.ts explains why).
    let isOperator = false;
    if (requesterEmail) {
      const operatorRows = await db
        .select({ id: platformAdmins.id })
        .from(platformAdmins)
        .where(eq(platformAdmins.email, requesterEmail))
        .limit(1);
      isOperator = Boolean(operatorRows[0]);
    }

    let roleSlug = SUPERADMIN_SLUG;
    let isSuperadmin = true;
    let permissions: RolePermissions = {};
    let email = requesterEmail;
    if (!isOperator) {
      const adminRows = await db
        .select({
          role: admins.role,
          email: admins.email,
          isSuspended: admins.isSuspended,
        })
        .from(admins)
        .where(and(eq(admins.id, job.adminId), eq(admins.storeId, job.storeId)))
        .limit(1);
      const admin = adminRows[0];
      // ★ A suspended admin has no access (getViewerContext's rule), and an
      //   admin removed from the store is simply gone.
      if (!admin || admin.isSuspended === true) return null;
      roleSlug = admin.role ?? "";
      isSuperadmin = roleSlug === SUPERADMIN_SLUG;
      email = normalizeEmail(admin.email) ?? requesterEmail;
      if (!isSuperadmin) {
        // The platform's role list, read on this transaction's connection.
        permissions = await readRolePermissionsWith(db, roleSlug);
      }
    }
    // Mink AI is a dashboard feature: without dashboard access the requester
    // could not ask for this revamp today, so it does not run for them either.
    if (!can(permissions, "dashboard", "view", isSuperadmin)) return null;

    let locationIds: string[] | null = null;
    if (!isSuperadmin) {
      const bindings = await db
        .select({ locationId: adminLocations.locationId })
        .from(adminLocations)
        .where(
          and(
            eq(adminLocations.adminId, job.adminId),
            eq(adminLocations.storeId, job.storeId),
          ),
        );
      // No rows means unrestricted (CODEBASE section 23), never "no locations".
      locationIds = bindings.length
        ? bindings.map((binding) => binding.locationId)
        : null;
    }
    // ★★ THE BRAND VOICE IS THE ONE THE MERCHANT SAVED, OR NONE (B17). The
    //    planner reads it as data for tone. `getBrandSoulForStore`'s
    //    stand-in for a store with no saved guide is built from the store's
    //    tagline and blurb, which a theme install writes with the theme's
    //    sample shop, so it would hand the redesign the very identity it
    //    replaces; and that reader swallows a database error, where this
    //    transaction's reads throw (an outage is not "no voice").
    const voiceRows = await db
      .select({ content: storeBrandProfiles.contentMd })
      .from(storeBrandProfiles)
      .where(eq(storeBrandProfiles.storeId, job.storeId))
      .limit(1);
    const savedVoice = voiceRows[0]?.content?.trim() ?? "";
    return {
      store,
      roleSlug,
      isSuperadmin,
      permissions,
      email,
      locationIds,
      savedVoice,
    };
  });
  if (!authority) return null;

  const { store } = authority;
  // ★ The plan every gate reads, comp overlay and timed grants included:
  //   `effectivePlan`, never the stored column alone.
  const plan = effectivePlan({
    plan: store.plan,
    plan_expires_at: store.planExpiresAt,
    comp_plan: store.compPlan,
    comp_expires_at: store.compExpiresAt,
  }) as MinkPlan;
  const rawSettings = record(store.settings) ?? {};
  const settings = resolveStoreSettings(rawSettings, plan);
  const business = record(rawSettings.business) ?? {};
  // Universal access today; read through the shared entry point so a future
  // per-store switch reaches the runner without a change here.
  const access = await getMinkStoreAccess(job.storeId);
  const brandVoice = authority.savedVoice
    ? sanitizeBrandVoice(authority.savedVoice)
    : "";
  const lowStock = settings["inventory.lowStockThreshold"];

  return {
    storeId: job.storeId,
    adminId: job.adminId,
    email: authority.email,
    roleSlug: authority.roleSlug,
    permissions: authority.permissions,
    isSuperadmin: authority.isSuperadmin,
    effectivePlan: plan,
    locationIds: authority.locationIds,
    analyticsTimeZone: normalizeAnalyticsTimeZone(business.timeZone),
    currency: "INR",
    defaultLowStockThreshold:
      typeof lowStock === "number" && Number.isFinite(lowStock) ? lowStock : 5,
    currentPath: null,
    selectedResource: null,
    // ★ The chat run that started the revamp: the card's draft belongs to it.
    ...(job.originRunId ? { runId: job.originRunId } : {}),
    draftingEnabled: access.draftingEnabled === true,
    ...(brandVoice ? { brandVoice } : {}),
    requestId,
  };
}

/**
 * The brand voice as actor-context prepares it: bounded, angle brackets
 * defused (it is store-authored text placed in a model's context) and control
 * characters removed.
 */
function sanitizeBrandVoice(value: string): string {
  let out = "";
  for (const char of value.slice(0, MAX_BRAND_VOICE)) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "<") out += "‹";
    else if (char === ">") out += "›";
    else if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    )
      out += " ";
    else out += char;
  }
  return out.trim();
}

function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email ? email : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
