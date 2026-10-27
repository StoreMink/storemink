-- Replace the existing voice instructions in place. No schema changes.
UPDATE public.help_articles
SET body = replace(body,
  $old$Dictation puts your words in the message box for you to edit and send. For a spoken conversation, choose Talk with Mink (the sound-wave button beside the microphone): Mink answers out loud as it works, you can interrupt it by speaking, and the written answer and any cards appear in the chat as usual. Press End, or Escape, to go back to typing.$old$,
  $new$Dictation puts your words in the message box for you to edit and send. For a spoken conversation, choose Talk (the sound-wave button beside the microphone): Mink answers out loud as it works, you can interrupt it by speaking, and the written answer and any cards appear in the chat as usual. Choose Mute microphone to stop listening without ending the conversation; unfinished speech is discarded and replies continue. Choose Unmute microphone when you are ready to speak again. Open Captions to read the full spoken sentence. Press End, or Escape, to go back to typing.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';
