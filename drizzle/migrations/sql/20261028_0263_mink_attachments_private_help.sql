-- The Media Library guide and the general Mink guide describe a picture
-- attached in Mink AI as an upload "under Media" that Mink keeps, and the
-- delete paragraph 20261026_0251 wrote says attached pictures are not deleted
-- with the conversation. Since 20261028_0262_mink_attachments_private
-- (lib/mink/attachments.ts) such a picture is kept privately with its chat,
-- only the person who attached it can open it, and it is deleted with the chat
-- (or 2 days after it was attached, if it was never sent). When Mink uses one
-- in a proposal for the store (a product photo, a page section, a category
-- image, a blog cover or a redesign's product photo), a copy is saved in the
-- Media Library as an ordinary upload, which stays until the merchant deletes
-- it.
-- Each sentence that is now wrong is replaced in place, in one statement per
-- guide that also moves updated_at so the Help index re-embeds it; nothing is
-- appended. Written against storemink_local's bodies of 26 Oct 2026 as
-- 20261026_0251 and 20261026_0252 left them; each old sentence occurs once
-- (checked before writing this). A sentence an operator has since edited is
-- not matched, and applyVerify then fails the migration rather than leave the
-- guide saying both things.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$Photos you attach to a Mink AI chat are not listed here, although Mink can still use them for what you asked.$old$,
      $new$Photos you attach to a Mink AI chat are not listed here: they are kept privately with the chat and deleted with it. When Mink uses one in a proposal for your store, such as a product photo, it saves a copy here.$new$
    ),
    updated_at = now()
WHERE slug = 'upload-and-manage-store-media' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      replace(
        replace(
          replace(
            replace(
              body,
              $old$Send saves your image under <strong>Media</strong> and Mink prepares the private page change in the same response.$old$,
              $new$Mink prepares the private page change in the same response and saves a copy of your image in your <strong>Media</strong> library for it.$new$
            ),
            $old$When your role can add Media, each selected image starts uploading immediately so it is ready in the conversation and can be used by the request; remove its preview before sending if you do not want to keep it.$old$,
            $new$When your role can add Media, each selected image starts uploading immediately so it is ready in the conversation and can be used by the request; remove its preview before sending if you do not want to keep it. Attached images are kept privately with the conversation: only you can open them, and they are deleted when the conversation is deleted. An image you never send is deleted after 2 days.$new$
          ),
          $old$Attached images are not listed in your Media Library; pictures Mink creates for you are, and the photos a storefront redesign uses are listed once you apply it.$old$,
          $new$Attached images are not listed in your Media Library. When Mink uses one in a proposal for your store, such as a product photo, a page section or a blog cover, it saves a copy in your Media Library, which stays there until you delete it. Pictures Mink creates for you are listed too, and the photos a storefront redesign uses are listed once you apply it.$new$
        ),
        $old$Saving an attached image to your Media library is your own upload: it changes nothing on your storefront, and putting that picture on a page is still a separate proposal you review and approve.$old$,
        $new$Attaching an image changes nothing on your storefront, and putting that picture on a page is still a separate proposal you review and approve.$new$
      ),
      $old$Pictures you attached to the conversation, and pictures Mink AI made in it, are not deleted with it: they stay with your store's files, and a picture Mink AI added to your Media Library stays there until you delete it.$old$,
      $new$Pictures Mink AI made in it are not deleted with it: they stay with your store's files, and a picture Mink AI added to your Media Library stays there until you delete it. Pictures you attached to it are deleted with it.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';
