-- The Mink guides describe chat history as 0248 to 0250 build it (owner's
-- decision, 25 Oct 2026): each chat is kept 90 days after it was last used,
-- then deleted; only its owner sees it; older chats load as the sidebar
-- scrolls, Search chats finds one, and a long chat shows its earlier messages
-- on request; deleting a chat deletes its messages and every proposal in it
-- that was not approved or published, and never undoes an approved or
-- published change, whose record StoreMink keeps while the store exists,
-- with the run details of the reply that made it (and, for an applied
-- storefront redesign, the merchant's answers for it); pictures attached to a
-- chat or made in it are not deleted with it; the chat that holds a
-- storefront redesign card can be deleted except while the redesign, or a new
-- version of it, is being made; and a question the merchant stopped stays in
-- its conversation, unanswered, and is never sent to Mink again unless the
-- merchant asks it again. Four sentences of the dashboard guide are rewritten
-- where they stand, two are removed, the Stop sentence 0246 wrote gains one
-- clause, and the credit sentence beside the privacy line loses its promise
-- of a rate shown before confirming (the dashboard never shows what an action
-- costs in credits); one sentence of the website guide is rewritten; no
-- section is appended. Every quoted string occurs once (checked against the
-- local database before writing this).

UPDATE public.help_articles SET body = replace(body,
  $old$Mink AI keeps the 10 most recent conversations for each admin in each store.$old$,
  $new$Mink AI keeps each of your conversations for 90 days after you last use it, then deletes it. Sending a message in a conversation or opening it counts as using it. Only you can see your conversations; other people who work in your store cannot.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$Mink AI keeps the 10 most recent conversations for each admin in each store.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$Select a title to continue it.$old$,
  $new$Select a title to continue it. Scroll down the sidebar for older conversations, or type a word in <strong>Search chats</strong> at the top of the sidebar to find a conversation by its title or by something you or Mink AI wrote in it. In a long conversation, select <strong>Show earlier messages</strong> at the top to read its older messages.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$Select a title to continue it.$old$) > 0
  AND strpos(body, $new$<strong>Show earlier messages</strong>$new$) = 0;

UPDATE public.help_articles SET body = replace(body,
  $old$This permanently removes its messages, run records, tool records and token record.$old$,
  $new$This permanently deletes its messages and any proposal in it that you did not approve or publish. It does not undo anything you approved or published from that conversation, and StoreMink keeps the record of what Mink AI proposed and what you approved for as long as your store exists. Pictures you attached to the conversation, and pictures Mink AI made in it, are not deleted with it: they stay with your store's files, and a picture Mink AI added to your Media Library stays there until you delete it.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$This permanently removes its messages, run records, tool records and token record.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$ Starting a new conversation keeps the newest ten visible. Ordinary overflow is removed automatically; an older conversation tied to a retained publication or completed action stays safely outside the recent list instead of blocking the new conversation.$old$,
  $new$$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$ Starting a new conversation keeps the newest ten visible.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$StoreMink keeps up to 10 recent conversations per admin and store, including messages, run status, tool names and token counts, for continuity, reliability and cost monitoring.$old$,
  $new$StoreMink keeps each conversation, with its messages, run status, tool names and token counts, for 90 days after you last use it, for continuity, reliability and cost monitoring. The record of a change you approved or published also keeps the run status, tool names and token counts of the reply that made it, and, for a storefront redesign you applied, the answers you gave Mink for it.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$StoreMink keeps up to 10 recent conversations per admin and store$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$ Asking Mink to draft or propose something does, at the rate shown before you confirm it.$old$,
  $new$ Asking Mink to draft or propose something does.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$ Asking Mink to draft or propose something does, at the rate shown before you confirm it.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$If Mink has not started anything yet, the reply stops and nothing is created.$old$,
  $new$If Mink has not started anything yet, the reply stops and nothing is created; your question stays in the conversation, and Mink answers it only if you ask again.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$If Mink has not started anything yet, the reply stops and nothing is created.$old$) > 0
  AND strpos(body, $new$your question stays in the conversation$new$) = 0;

UPDATE public.help_articles SET body = replace(body,
  $old$<p>The dashboard keeps the 10 most recent conversations. For longer follow-ups,$old$,
  $new$<p>For longer follow-ups,$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$<p>The dashboard keeps the 10 most recent conversations.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$The chat that holds a redesign's card cannot be deleted while the redesign is being made or once its card is ready.$old$,
  $new$You can delete the chat that holds a redesign's card, except while the redesign or a new version of it is being made. Deleting that chat, or leaving it unused for 90 days, removes the card, so you can no longer apply or undo that redesign from Mink AI; anything you already applied or published stays in your store.$new$),
  updated_at = now()
WHERE slug = 'manage-your-website-with-mink-ai' AND status = 'published'
  AND strpos(body, $old$The chat that holds a redesign's card cannot be deleted while the redesign is being made or once its card is ready.$old$) > 0;
