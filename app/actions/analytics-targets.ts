"use server";

import { and, count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { analyticsTargets } from "@/drizzle/schema";
import { storeHasAnalyticsFeature } from "@/lib/analytics/store-entitlement";
import {
  MAX_TARGETS_PER_STORE,
  validateTargetInput,
} from "@/lib/analytics/targets";
import { withService } from "@/lib/db/client";

// Store-wide analytics targets. Basic and above (the dashboard customisation
// entitlement, so an operator switch turns both off together); traffic metrics
// additionally need Pro storefront analytics. Creating or changing a target
// needs Analytics "manage"; the store owner has it, other roles when granted.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AnalyticsTargetResult {
  success?: boolean;
  error?: string;
}

async function targetContext(): Promise<
  | { ok: true; storeId: string; userId: string; trafficAllowed: boolean }
  | { ok: false; error: string }
> {
  const viewer = await getViewerContext();
  if (viewer?.dbError) {
    return { ok: false, error: "Couldn't reach the database. Try again." };
  }
  if (!viewer?.profile) return { ok: false, error: "Not authenticated." };
  if (!can(viewer.permissions, "analytics", "manage", viewer.isSuperadmin)) {
    return {
      ok: false,
      error: "You don't have permission to manage analytics targets.",
    };
  }
  const [allowed, trafficAllowed] = await Promise.all([
    storeHasAnalyticsFeature(viewer.storeId, "dashboardCustomization"),
    storeHasAnalyticsFeature(viewer.storeId, "storefrontConversion"),
  ]);
  if (!allowed) {
    return { ok: false, error: "Targets are available on Basic and Pro." };
  }
  return {
    ok: true,
    storeId: viewer.storeId,
    userId: viewer.userId,
    trafficAllowed,
  };
}

export async function saveAnalyticsTarget(
  raw: unknown,
): Promise<AnalyticsTargetResult> {
  const ctx = await targetContext();
  if (!ctx.ok) return { error: ctx.error };
  const parsed = validateTargetInput(raw, {
    trafficAllowed: ctx.trafficAllowed,
  });
  if (!parsed.ok) return { error: parsed.error };
  const rawId =
    raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
  if (
    rawId !== undefined &&
    rawId !== null &&
    (typeof rawId !== "string" || !UUID.test(rawId))
  ) {
    return { error: "That target isn't valid." };
  }
  const id = typeof rawId === "string" ? rawId : null;
  const values = {
    metric: parsed.value.metric,
    periodStart: parsed.value.periodStart,
    periodEnd: parsed.value.periodEnd,
    targetValue: String(parsed.value.targetValue),
  };

  try {
    const result = await withService(async (db) => {
      if (id) {
        // Store-scoped update: a target id from another store matches nothing.
        const updated = await db
          .update(analyticsTargets)
          .set({ ...values, updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(analyticsTargets.id, id),
              eq(analyticsTargets.storeId, ctx.storeId),
            ),
          )
          .returning({ id: analyticsTargets.id });
        return updated.length
          ? { success: true }
          : { error: "That target no longer exists." };
      }
      const [existing] = await db
        .select({ total: count() })
        .from(analyticsTargets)
        .where(eq(analyticsTargets.storeId, ctx.storeId));
      if (Number(existing?.total ?? 0) >= MAX_TARGETS_PER_STORE) {
        return {
          error: `A store can have up to ${MAX_TARGETS_PER_STORE} targets. Delete an old one first.`,
        };
      }
      await db.insert(analyticsTargets).values({
        ...values,
        storeId: ctx.storeId,
        createdBy: ctx.userId,
      });
      return { success: true };
    });
    if (result.success) revalidatePath("/dashboard/analytics");
    return result;
  } catch (error) {
    console.error("saveAnalyticsTarget:", error);
    return { error: "Couldn't save the target. Please try again." };
  }
}

export async function deleteAnalyticsTarget(
  id: unknown,
): Promise<AnalyticsTargetResult> {
  const ctx = await targetContext();
  if (!ctx.ok) return { error: ctx.error };
  if (typeof id !== "string" || !UUID.test(id)) {
    return { error: "That target isn't valid." };
  }
  try {
    await withService((db) =>
      db
        .delete(analyticsTargets)
        .where(
          and(
            eq(analyticsTargets.id, id),
            eq(analyticsTargets.storeId, ctx.storeId),
          ),
        ),
    );
    revalidatePath("/dashboard/analytics");
    return { success: true };
  } catch (error) {
    console.error("deleteAnalyticsTarget:", error);
    return { error: "Couldn't delete the target. Please try again." };
  }
}
