-- Give the Inbox section to the roles that run the whole store, and correct
-- the inbox guide's sentence about who can see it.
--
-- dev added the Inbox dashboard section (WhatsApp conversations) while main
-- moved staff roles onto the platform list (0207). Stored roles are data, so a
-- section added after that seed reaches nobody but owners until a migration
-- grants it; lib/roles/catalog.test.ts fails until one does.
--
-- Owner and Admin get it with view and manage, as they hold every other
-- section. Staff does not: the old per-store member role never had it either,
-- because nothing ever granted it. An operator can add it to Staff, or to a
-- role of their own, in the platform roles console.
--
-- A role that already lists "inbox" is left alone, so an operator's own choice
-- is never overwritten.
UPDATE public.platform_roles
   SET permissions = permissions || '{"inbox":["view","manage"]}'::jsonb,
       updated_at = now()
 WHERE slug IN ('superadmin', 'admin')
   AND NOT (permissions ? 'inbox');

-- 0178 told merchants to give a role Inbox access under Settings, Staff,
-- Roles. A store can no longer edit a role, so that sentence is replaced in
-- place; the rest of the guide is unchanged. The timestamp moves so the Help
-- index re-embeds the guide (help:lint rule index-timestamp).
UPDATE public.help_articles
   SET body = replace(
         body,
         $old$<p>Inbox is its own permission. Under <strong>Settings → Staff → Roles</strong>, give a role <strong>Inbox: view</strong> to read conversations and <strong>Inbox: manage</strong> to reply and close them.</p>$old$,
         $new$<p>Owners and Admins can read conversations, reply to them and close them. <strong>Settings</strong>, then <strong>Roles &amp; permissions</strong> shows every role that includes Inbox; to give someone one of those roles, change it under <strong>Settings</strong>, then <strong>Staff</strong>.</p>$new$
       ),
       updated_at = now()
 WHERE slug = 'reply-to-whatsapp-messages';
