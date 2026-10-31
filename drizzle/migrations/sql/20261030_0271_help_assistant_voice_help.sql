-- The Help Centre's Mink AI now takes a spoken question two ways: the
-- microphone in the message box (dictation, edited before sending) and Talk
-- with Mink AI (a spoken back-and-forth). The guide's opening steps are
-- edited in place; the new section sits right after them, where a visitor
-- learning to ask a question reads it. No schema changes.
UPDATE public.help_articles
SET body = replace(replace(replace(body,
  $old$<li>Select <strong>Ask Mink AI</strong> in the top-right header, beside <strong>Create your store</strong>.</li>$old$,
  $new$<li>Select <strong>Ask Mink AI</strong> in the top-right header, beside <strong>Create your store</strong>, or on the Help Centre home page. On a phone, the header button shows only the Mink AI face.</li>$new$),
  $old$<li>Type what you want to do or describe the screen where you are stuck.</li>$old$,
  $new$<li>Type what you want to do or describe the screen where you are stuck. You can also select the microphone and say it: your words appear in the message box so you can check them before sending.</li>$new$),
  $old$<p>You can also select one of the example questions to begin.</p>$old$,
  $new$<p>You can also select one of the example questions to begin.</p>
<h2>Talk with Mink AI</h2>
<p>Select <strong>Talk with Mink AI</strong> to ask out loud instead of typing. Mink AI listens until you pause, answers aloud in your browser's voice, and shows the same answer and guides in the chat. Then it listens for your next question.</p>
<ul><li>Select <strong>Skip</strong> to stop the spoken answer and ask the next question.</li><li>Select <strong>End</strong> to stop talking and go back to typing.</li><li>The voice chat ends by itself when it hears nothing for a while or when you switch to another tab.</li></ul>
<p>The first time, your browser asks whether this site may use your microphone; choose <strong>Allow</strong>. StoreMink turns your recording into text and does not keep the recording. If the microphone or Talk buttons do not appear, your browser does not support voice here, so type your question instead.</p>$new$),
  updated_at = now()
WHERE slug = 'use-storemink-help-assistant' AND status = 'published';
