"use server";

import { and, count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { analyticsSavedReports } from "@/drizzle/schema";
import { isUniqueViolation } from "@/lib/db/errors";
import {
  MAX_SAVED_REPORTS,
  cleanReportName,
  normalizeExploreConfig,
} from "@/lib/analytics/explore";
import { storeHasAnalyticsFeature } from "@/lib/analytics/store-entitlement";
import { withService } from "@/lib/db/client";

// Saved custom reports. Basic and above (the drill-down reports entitlement,
// so the operator switch for reports covers these too). Saving needs
// Analytics "manage"; anyone who can view Analytics can open a saved report.
// The stored config is the NORMALIZED one: a saved row can never hold a
// measure or grouping the builder would not accept.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SavedReportResult {
  success?: boolean;
  id?: string;
  error?: string;
}

async function reportContext() {
  const viewer = await getViewerContext();
  if (viewer?.dbError) {
    return {
      ok: false as const,
      error: "Couldn't reach the database. Try again.",
    };
  }
  if (!viewer?.profile)
    return { ok: false as const, error: "Not authenticated." };
  if (!can(viewer.permissions, "analytics", "manage", viewer.isSuperadmin)) {
    return {
      ok: false as const,
      error: "You don't have permission to save reports.",
    };
  }
  const [allowed, trafficAllowed] = await Promise.all([
    storeHasAnalyticsFeature(viewer.storeId, "drilldownReports"),
    storeHasAnalyticsFeature(viewer.storeId, "storefrontConversion"),
  ]);
  if (!allowed) {
    return {
      ok: false as const,
      error: "Custom reports are available on Basic and Pro.",
    };
  }
  return {
    ok: true as const,
    storeId: viewer.storeId,
    userId: viewer.userId,
    trafficAllowed,
  };
}

export async function saveAnalyticsReport(input: {
  id?: string | null;
  name: unknown;
  config: unknown;
}): Promise<SavedReportResult> {
  const ctx = await reportContext();
  if (!ctx.ok) return { error: ctx.error };
  const name = cleanReportName(input.name);
  if (!name) return { error: "Give the report a name of up to 80 characters." };
  if (input.id && !UUID.test(input.id))
    return { error: "That report isn't valid." };
  const raw =
    input.config && typeof input.config === "object"
      ? (input.config as Record<string, unknown>)
      : {};
  const config = normalizeExploreConfig(
    {
      dataset: raw.dataset,
      metrics: raw.metrics,
      dimension: raw.dimension,
      chart: raw.chart,
    },
    { trafficAllowed: ctx.trafficAllowed },
  );

  try {
    const result = await withService(async (db): Promise<SavedReportResult> => {
      if (input.id) {
        const updated = await db
          .update(analyticsSavedReports)
          .set({ name, config, updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(analyticsSavedReports.id, input.id),
              eq(analyticsSavedReports.storeId, ctx.storeId),
            ),
          )
          .returning({ id: analyticsSavedReports.id });
        return updated[0]
          ? { success: true, id: updated[0].id }
          : { error: "That report no longer exists." };
      }
      const [existing] = await db
        .select({ total: count() })
        .from(analyticsSavedReports)
        .where(eq(analyticsSavedReports.storeId, ctx.storeId));
      if (Number(existing?.total ?? 0) >= MAX_SAVED_REPORTS) {
        return {
          error: `A store can save up to ${MAX_SAVED_REPORTS} reports. Delete one first.`,
        };
      }
      const [created] = await db
        .insert(analyticsSavedReports)
        .values({ storeId: ctx.storeId, name, config, createdBy: ctx.userId })
        .returning({ id: analyticsSavedReports.id });
      return { success: true, id: created?.id };
    });
    if (result.success) revalidatePath("/dashboard/analytics/reports");
    return result;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { error: "A report with that name already exists." };
    }
    console.error("saveAnalyticsReport:", error);
    return { error: "Couldn't save the report. Please try again." };
  }
}

export async function deleteAnalyticsReport(
  id: unknown,
): Promise<SavedReportResult> {
  const ctx = await reportContext();
  if (!ctx.ok) return { error: ctx.error };
  if (typeof id !== "string" || !UUID.test(id)) {
    return { error: "That report isn't valid." };
  }
  try {
    await withService((db) =>
      db
        .delete(analyticsSavedReports)
        .where(
          and(
            eq(analyticsSavedReports.id, id),
            eq(analyticsSavedReports.storeId, ctx.storeId),
          ),
        ),
    );
    revalidatePath("/dashboard/analytics/reports");
    return { success: true };
  } catch (error) {
    console.error("deleteAnalyticsReport:", error);
    return { error: "Couldn't delete the report. Please try again." };
  }
}
