import { NextResponse } from "next/server";
import { deleteMediaAsset } from "@/app/actions/media-actions";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { discardUnsentMinkAttachment } from "@/lib/mink/attachments";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Discard an image the composer uploaded but never sent.
 *
 * ★★ IT EXISTS ONLY BECAUSE A SERVER ACTION CANNOT BE `keepalive`. An image is
 * uploaded the moment it is selected, so a private copy exists before the
 * merchant has committed to anything, and the cleanup ran as a fire-and-forget
 * action from React's unmount effect, which the browser cancels when the page
 * is actually unloading. Pick a photo, close the tab, and the copy survived
 * until the nightly purge took it. `navigator.sendBeacon` survives unload; the
 * action protocol has no way to ask for that.
 *
 * ★ IT GRANTS NOTHING NEW. The attachment discard is scoped to the actor's own
 * store and admin and to a picture never sent and not yet marked
 * (lib/mink/attachments.ts); `deleteMediaAsset` is a `"use server"` export,
 * so it is ALREADY a publicly reachable endpoint, already gated on `media`
 * manage and already scoped to the acting store. This adds a transport, not
 * authority.
 *
 * ★ THE ATTACHMENT FIRST, THE MEDIA LIBRARY ROW AS THE FALLBACK. This route's
 * address is the same in every build, so a tab opened before the deploy,
 * holding a picture it uploaded the old way (a Media Library row), still
 * reaches it when the tab closes; that tab's server action calls cannot, since
 * an action's id changes with every build. The fallback goes in the release
 * after next, once production reports no such row left (design 8).
 *
 * ★ SAME-ORIGIN AND ACTOR-RESOLVED like every sibling Mink route, so a
 * cross-site page cannot spend a merchant's session deleting their pictures.
 */
export async function POST(request: Request) {
  const foreign = rejectForeignMinkOrigin(request);
  if (foreign) return foreign;
  try {
    const actor = await getMinkActorContext(crypto.randomUUID());
    const body = await readMinkBoundedJson(
      request,
      1024,
      AbortSignal.timeout(5_000),
    );
    const id = (body as { id?: unknown }).id;
    if (typeof id !== "string" || !UUID.test(id))
      return NextResponse.json({ error: "Invalid item." }, { status: 400 });
    const discarded = await discardUnsentMinkAttachment({
      storeId: actor.storeId,
      adminId: actor.adminId,
      id: id.toLowerCase(),
    });
    if (discarded) return answer(true);
    // ⚠ A failed discard is reported, never retried here: the caller is a page
    //   that is already unloading and has nowhere to show an error. A private
    //   copy left behind is purged two days after upload; a Media Library row
    //   stays visible in the Library, which is recoverable by hand.
    const result = await deleteMediaAsset(id);
    return answer(result.success === true);
  } catch {
    return NextResponse.json({ error: "Unavailable." }, { status: 503 });
  }
}

function answer(discarded: boolean) {
  return NextResponse.json(
    { discarded },
    { status: 200, headers: { "Cache-Control": "no-store, private" } },
  );
}
