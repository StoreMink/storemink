-- The Help Centre's Mink AI chat was redesigned to a minimal layout: the
-- header is "Mink AI" (a menu), New chat and Close, and the menu holds
-- Recent chats, the language and the full window. The microphone is shown
-- on phones too. The public guide is edited sentence by sentence where it
-- is now wrong; nothing is appended. No schema changes.
UPDATE public.help_articles
SET body = replace(replace(replace(replace(body,
  $old$On a computer or tablet, you can also select the microphone and say it:$old$,
  $new$You can also select the microphone and say it:$new$),
  $old$Select <strong>Maximize</strong> in the Mink AI header to use the full browser window, then select <strong>Restore drawer</strong> to return to the side panel.$old$,
  $new$To use the full browser window, select <strong>Mink AI</strong> at the top of the chat and choose <strong>Maximize</strong>; choose <strong>Restore drawer</strong> from the same menu to return to the side panel.$new$),
  $old$Use the language menu in the Mink AI header to choose$old$,
  $new$Select <strong>Mink AI</strong> at the top of the chat and use <strong>Language</strong> to choose$new$),
  $old$Your chats are listed under <strong>Recent chats</strong>, where you can open one again or delete it; on a phone, <strong>New chat</strong> is there too.$old$,
  $new$To open an earlier chat again or delete it, select <strong>Mink AI</strong> at the top of the chat and choose <strong>Recent chats</strong>.$new$),
  updated_at = now()
WHERE slug = 'use-storemink-help-assistant' AND status = 'published';
