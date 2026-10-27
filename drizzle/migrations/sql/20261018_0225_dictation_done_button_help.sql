-- Dictation is finished with a Done button now, the way ChatGPT and Claude
-- dictate (owner's request, 2026-10-18): the message box shows a live sound
-- wave, a timer, Cancel and Done while it listens, and a pause no longer ends
-- the recording. Hands-free voice chat still ends a turn on a pause. The two
-- sentences in the Mink guide that told merchants to pause are replaced in
-- place.

UPDATE public.help_articles SET body=replace(replace(body, $old$Speak normally, then pause briefly; StoreMink detects that you have finished and puts one editable transcript in the message box.$old$, $new$Speak normally, then select <strong>Done</strong> (the tick) and StoreMink puts one editable transcript in the message box.$new$), $old$After you speak, pause briefly and StoreMink automatically converts the recording into one editable transcript in the message box.$old$, $new$While you speak, the message box shows a live sound wave and a timer, and pausing to think does not stop the recording. When you have finished, select <strong>Done</strong> (the tick) and StoreMink converts the recording into one editable transcript in the message box. A recording stops on its own after 30 seconds.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
