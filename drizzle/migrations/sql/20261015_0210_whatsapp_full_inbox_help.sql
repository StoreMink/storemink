-- The inbox guide, edited in place for the full inbox (slice 6): photos and
-- PDFs can be sent from the dashboard, the search box also finds a word
-- inside a conversation, and a team can assign, label, note, use saved
-- replies and quote a message. Three sentences are replaced where they
-- stand; one section is added where the team features belong, above the
-- STOP section. The timestamp moves so the Help index re-embeds the guide.

UPDATE public.help_articles
   SET body = replace(
         replace(
           replace(
             body,
             $old$and search by name or phone number.$old$,
             $new$and search by name, phone number or a word from any message. A match inside a conversation shows the line it was found in, and opening it jumps to that message.$new$
           ),
           $old$<p>Anything a customer sends is shown in the conversation and kept with it. Replies from the dashboard are text; to send a photo or file, reply from your phone.</p>$old$,
           $new$<p>Anything a customer sends is shown in the conversation and kept with it. To send a photo or a PDF yourself, use the paperclip beside the message box within the 24 hours after the customer last wrote: a photo can be up to 5 MB and a PDF up to 16 MB, and anything you type with it goes out as the caption. Voice notes, videos and other kinds of file are still sent from your phone.</p>$new$
         ),
         $old$<h2>When a customer writes STOP</h2>$old$,
         $new$<h2>Work on conversations as a team</h2>
<p><strong>Assign</strong> a conversation to a colleague from the list above the chat; they get a notification in their dashboard, and the <strong>Mine</strong> filter shows each person what is theirs. Anyone who can see the inbox can still read and answer an assigned conversation. <strong>Labels</strong> tag a conversation with whatever your store finds useful, such as Wholesale or VIP: create them with the <strong>Labels</strong> button above the inbox, add them to a chat from its <strong>Label</strong> button, and filter the list by one. A <strong>note</strong> is for your team only: switch the message box to <strong>Note</strong>, and what you write appears in the conversation in yellow, visible to anyone who can see the inbox and never to the customer.</p>
<p><strong>Saved replies</strong> are the sentences you type every day. Create them with the <strong>Saved replies</strong> button above the inbox, each with a short name, then type <strong>/</strong> in the message box to pick one; write <code>{{name}}</code> in a saved reply where the customer's first name should go. To answer one particular message, use <strong>Reply</strong> on it: your reply quotes that message on the customer's phone, as replies do in WhatsApp. Order updates sent from your number appear in the conversation as well, so you can see what a customer is replying to.</p>
<h2>When a customer writes STOP</h2>$new$
       ),
       updated_at = now()
 WHERE slug = 'reply-to-whatsapp-messages';
