import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import type { StorefrontImageUsage } from "./library-types";

// What in a store, besides its products, still shows a Media Library image,
// for the Library's delete guard (app/actions/media-actions.ts).
//
// ★★ A STOREFRONT REDESIGN PUTS 20 OR SO PHOTOS IN THE LIBRARY AT ONCE
//    (lib/mink/revamp/image-store.ts records each as "Made by Mink AI"), and
//    they are used by page sections, the header, categories and the card's
//    own plan, never by a product. The guard used to ask only about products,
//    so tidying the Library deleted them: a pending card's preview broke and
//    its Apply refused for ever (the photo is "no longer in this store's Media
//    Library"), and after Publish the live homepage lost its picture.
//
// ★ "IN USE" MEANS SOMETHING STILL SHOWS IT OR STILL WILL, never "a redesign
//   once made it". A redesign holds its photos only while it can still write
//   them: being made (queued or running), a card nobody applied (ready, not
//   applied, not undone, in a chat that still lists it), or the parent a
//   refinement being made may carry them over from. Once a card is applied its photos live in the Builder draft,
//   the live pages, the header and footer and the categories, which are read
//   directly, so a photo the merchant has since replaced everywhere can be
//   deleted. Holding every applied redesign's photos would make them
//   undeletable for ever behind a message that was no longer true.
//   A card a newer version replaced before anyone applied it holds nothing:
//   the newer card's own rows hold what it carried over.
// ★ TEXT SEARCH FAILS TOWARD KEEPING. Pages, chrome and a redesign's request,
//   plan and result are searched for the URL as text, which also finds it
//   inside rich text or custom code; a longer URL that contains this one can
//   only keep a file, never delete one in use.
// ★ EVERY READ IS THIS STORE'S, by an explicit predicate under withService:
//   another store's page or redesign naming the URL never counts.
// ★ THROWS ON A READ FAILURE: the caller refuses the delete, because a missing
//   photo cannot be undone and a retry can.

/** How many page and category names the answer carries; the message names one or two. */
const NAME_LIMIT = 20;

const NOTHING: StorefrontImageUsage = {
  redesignInProgress: false,
  redesignCard: false,
  pages: [],
  categories: [],
  headerFooter: false,
};

/** Where a Library image is shown, besides products, in one round trip. */
export async function storefrontImageUsage(
  storeId: string,
  image: { url: string; path: string },
): Promise<StorefrontImageUsage> {
  const url = typeof image.url === "string" ? image.url.trim() : "";
  const path = typeof image.path === "string" ? image.path.trim() : "";
  if (!url && !path) return { ...NOTHING };
  // ★ An empty URL would be "found" in every text by strpos.
  const searchable = url !== "";
  const rows = await withService((db) =>
    db.execute(sql`
      with redesign as (
        select r.id,
               r.status in ('queued', 'running')
                 or exists (
                   select 1 from public.mink_revamps child
                   where child.store_id = r.store_id
                     and child.parent_id = r.id
                     and child.status in ('queued', 'running')
                 ) as in_progress
        from public.mink_revamps r
        where r.store_id = ${storeId}
          and (
            r.status in ('queued', 'running')
            or (
              r.status = 'ready'
              and r.applied_at is null
              and r.undone_at is null
              -- ★ Only while its chat still lists it: the card is reached
              --   from its conversation alone, and one whose chat expired
              --   can no longer be applied.
              and exists (
                select 1 from public.mink_conversations c
                where c.id = r.conversation_id
                  and c.store_id = r.store_id
                  and c.status = 'active'
                  and c.expires_at > now()
              )
            )
            or exists (
              select 1 from public.mink_revamps child
              where child.store_id = r.store_id
                and child.parent_id = r.id
                and child.status in ('queued', 'running')
            )
          )
          and (
            exists (
              select 1 from public.mink_revamp_images i
              where i.revamp_id = r.id
                and i.store_id = r.store_id
                and (i.path = ${path}::text or i.url = ${url}::text)
            )
            or (
              ${searchable}::boolean
              and (
                strpos(r.request::text, ${url}::text) > 0
                or strpos(coalesce(r.plan::text, ''), ${url}::text) > 0
                or strpos(coalesce(r.result::text, ''), ${url}::text) > 0
              )
            )
          )
      )
      select 'in_progress' as kind, null::text as label
      where exists (select 1 from redesign where in_progress)
      union all
      select 'card', null::text
      where exists (select 1 from redesign where not in_progress)
      union all
      (
        select 'page',
               coalesce(
                 nullif(btrim(p.title), ''),
                 case when p.slug = '' then 'Home' else p.slug end
               )
        from public.store_pages p
        where p.store_id = ${storeId}
          and ${searchable}::boolean
          and (
            strpos(p.sections::text, ${url}::text) > 0
            or strpos(p.published_sections::text, ${url}::text) > 0
          )
        order by (p.slug = '') desc, p.title, p.slug
        limit ${NAME_LIMIT}
      )
      union all
      (
        select 'category', c.name
        from public.categories c
        where c.store_id = ${storeId}
          and ${searchable}::boolean
          and btrim(c.image_url) = ${url}::text
        order by c.name
        limit ${NAME_LIMIT}
      )
      union all
      select 'chrome', null::text
      from public.store_chrome sc
      where sc.store_id = ${storeId}
        and ${searchable}::boolean
        and (
          strpos(sc.draft::text, ${url}::text) > 0
          or strpos(coalesce(sc.published::text, ''), ${url}::text) > 0
        )
    `),
  );
  const usage: StorefrontImageUsage = { ...NOTHING, pages: [], categories: [] };
  for (const row of rows.rows as { kind: string; label: string | null }[]) {
    if (row.kind === "in_progress") usage.redesignInProgress = true;
    else if (row.kind === "card") usage.redesignCard = true;
    else if (row.kind === "page" && row.label) usage.pages.push(row.label);
    else if (row.kind === "category" && row.label) {
      usage.categories.push(row.label);
    } else if (row.kind === "chrome") usage.headerFooter = true;
  }
  return usage;
}
