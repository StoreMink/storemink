import "server-only";
import type { Db } from "@/lib/db/client";

export interface MinkStoreAccessState {
  enabled: boolean;
  draftingEnabled: boolean;
}

// Compatibility entry points for actor and worker callers. Store invitations
// no longer determine availability; authentication and staff authority still do.
export async function getMinkStoreAccess(
  _storeId: string,
  _existingDb?: Db,
): Promise<MinkStoreAccessState> {
  void [_storeId, _existingDb];
  return { enabled: true, draftingEnabled: true };
}
export async function isMinkStoreInvited(_storeId: string): Promise<boolean> {
  void _storeId;
  return true;
}
export async function requireMinkStoreInvite(
  _storeId: string,
  _requireInvite: boolean,
): Promise<MinkStoreAccessState> {
  void [_storeId, _requireInvite];
  return { enabled: true, draftingEnabled: true };
}
