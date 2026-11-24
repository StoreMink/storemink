import "server-only";

import { eq } from "drizzle-orm";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { analyticsTimeZoneFromSettings } from "./range";

export async function getStoreAnalyticsTimeZone(
  storeId: string,
): Promise<string> {
  const [store] = await withService((db) =>
    db
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  return analyticsTimeZoneFromSettings(store?.settings);
}
