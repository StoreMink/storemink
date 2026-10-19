-- How Mink AI chats continue, how a page link opens and how attachments are
-- sent, as the merchant now experiences them (owner's request, 2026-10-19:
-- "the UX should be same as other bots like sidekick of shopify ... claude and
-- chatgpt").
--
-- Three behaviours changed, and the Mink guide described the old ones:
--   1. Which chat a message goes into. Every dashboard load used to reopen the
--      newest conversation in every tab, and deleting the open chat opened the
--      next one. A tab now continues its own chat until it has been quiet for
--      two hours; a new tab, a question from Home or an Ask Mink button starts
--      a new one; deleting the open chat leaves an empty one; and the header
--      gains a New chat button.
--   2. A page Mink finds is a link card that opens only when clicked. The
--      panel used to navigate as soon as such an answer arrived, which on a
--      phone also closed the chat.
--   3. Pressing Send with attachments moves the message and its files into
--      the chat at once and Mink reads them as its first step; a file that
--      cannot be read sends the message back to the box with the reason. The
--      composer used to keep the photo under a second spinner while it read.
--
-- Each sentence that is now wrong is replaced where it stands; nothing is
-- appended. Every quoted sentence occurs once in the guide (checked against
-- the local database before writing this).

UPDATE public.help_articles SET body=replace(body, $old$<strong>New conversation</strong> starts a separate topic.$old$, $new$<strong>New chat</strong> at the top of Mink AI, or <strong>New conversation</strong> in the conversation sidebar, starts a separate topic.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$Mink AI opens the next recent thread when the active thread is deleted.$old$, $new$Deleting the conversation you are in leaves a new, empty one; the others stay in the sidebar.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$The newest remaining conversation is restored after a dashboard refresh.$old$, $new$Refreshing the page, or closing and reopening Mink AI, continues the conversation you were in. A new browser tab starts a new conversation, and so does coming back after two hours without a message; a question asked from Home or with an <strong>Ask Mink</strong> button also starts a new one. Earlier conversations stay in the sidebar.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$<li>Open a dashboard page for me, such as a product, an order or Inventory; show me where a control is, so the page opens with that control pointed out; or open a form (a new product, offer, category or blog post, or delivery settings) already filled in from our conversation, which you review and save yourself.</li>$old$, $new$<li>Find a dashboard page for me, such as a product, an order or Inventory; show me where a control is; or start a form (a new product, offer, category or blog post, or delivery settings) already filled in from our conversation. Mink AI puts a link in its answer and nothing opens until you select it; the page then opens with that control pointed out, and you review and save any filled-in form yourself.</li>$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$For other image or document questions, press Send once; Mink processes the visible attachments with your request and shows them with the sent message.$old$, $new$For other image or document questions, press Send once: your message and its attachments appear in the chat straight away, and Mink reads them as its first step.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$Press <strong>Send</strong> once to process the visible attachments with your request.$old$, $new$Press <strong>Send</strong> once: the message and its attachments move into the chat at once while Mink reads them, and a photo or file can be sent without any words.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$After a failure, wait and press Send again when you are ready to retry; provider work from a timed-out request might still have incurred usage.$old$, $new$If a file cannot be read, your message and its attachments go back to the message box with the reason; press Send again when you are ready to retry. Provider work from a timed-out request might still have incurred usage.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$Closing, discarding or changing conversations cancels pending local work; the microphone is stopped and local previews are released.$old$, $new$Starting a new chat while Mink AI is still reading your files abandons that message; closing Mink AI does not, and the answer is waiting when you reopen it. Closing stops the microphone and releases the previews still in the message box.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
