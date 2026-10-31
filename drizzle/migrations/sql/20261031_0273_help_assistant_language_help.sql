-- The Help Centre's Mink AI chat gained a language menu, recent chats saved
-- in the browser, thumbs up and down on answers, and a phone layout where
-- the header menu opens Mink AI and dictation is not offered. The public
-- guide is edited sentence by sentence where it is now wrong; nothing is
-- appended. No schema changes.
UPDATE public.help_articles
SET body = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(body,
  $old$On a phone, the header button shows only the Mink AI face.</li>$old$,
  $new$On a phone, open the menu and select <strong>Mink AI</strong>.</li>$new$),
  $old$You can also select the microphone and say it:$old$,
  $new$On a computer or tablet, you can also select the microphone and say it:$new$),
  $old$then select <strong>Restore drawer</strong> to return to the side panel.$old$,
  $new$then select <strong>Restore drawer</strong> to return to the side panel. On a computer, the full window lists your recent chats down the left. <strong>Mink AI</strong> in the Help Centre menu and <strong>Ask Mink AI</strong> on the home page open it in the full window.$new$),
  $old$its steps, important notes, verified guides, and suggested questions.$old$,
  $new$its steps, important notes, source guides, and suggested questions.$new$),
  $old$<li><strong>Verified guides</strong> link to$old$,
  $new$<li><strong>Source guides</strong> link to$new$),
  $old$<li><strong>Suggested questions</strong> help you continue with a related task.</li>$old$,
  $new$<li><strong>Suggested questions</strong> help you continue with a related task.</li>
<li>Under an answer, select the copy button to copy it, or the speaker button to hear it read aloud. Select thumbs up or thumbs down to tell StoreMink whether the answer helped: this sends your question and the answer to StoreMink so the guides can be improved, without your name or contact details.</li>$new$),
  $old$explain published StoreMink behaviour, and guide you through documented tasks.$old$,
  $new$explain published StoreMink behaviour, and guide you through documented tasks. Use the language menu in the Mink AI header to choose English, Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada or Punjabi: the chat's buttons and Mink AI's answers then use that language. Until you choose one, Mink AI answers in the language you type in. The guides it links to are written in English.$new$),
  $old$Select <strong>New conversation</strong> in the Mink AI header to clear the visible conversation and begin another topic.$old$,
  $new$Select <strong>New chat</strong> in the Mink AI header to begin another topic. Your chats are listed under <strong>Recent chats</strong>, where you can open one again or delete it; on a phone, <strong>New chat</strong> is there too. They are saved in this browser only, so another browser or device does not show them, and clearing the browser's site data removes them.$new$),
  $old$or select the header button again to close it.$old$,
  $new$or select the header button again to close it. On a phone, select the back arrow.$new$),
  $old$<li>Open the verified guides shown in the answer$old$,
  $new$<li>Open the source guides shown in the answer$new$),
  updated_at = now()
WHERE slug = 'use-storemink-help-assistant' AND status = 'published';
