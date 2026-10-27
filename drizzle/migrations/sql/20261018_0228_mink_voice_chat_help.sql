-- Voice chat is a spoken conversation now (owner's request, 2026-10-18): the
-- sound-wave button beside the microphone opens a full-screen voice view
-- where Mink answers out loud as it works, the merchant can interrupt it by
-- speaking, and the written answer and its cards still appear in the chat.
-- The Mink guide's dictation paragraph ended by saying dictation is not a
-- live voice conversation, which left the reader without the thing that is;
-- that one sentence is replaced in place.

UPDATE public.help_articles SET body=replace(body, $old$This is dictation, not a live voice conversation.$old$, $new$Dictation puts your words in the message box for you to edit and send. For a spoken conversation, choose Talk with Mink (the sound-wave button beside the microphone): Mink answers out loud as it works, you can interrupt it by speaking, and the written answer and any cards appear in the chat as usual. Press End, or Escape, to go back to typing.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
