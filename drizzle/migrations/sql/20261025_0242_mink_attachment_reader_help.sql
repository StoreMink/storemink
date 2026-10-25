-- The general Mink guide (use-mink-ai-in-your-dashboard) describes reading an
-- attached image or PDF in two sentences that the robustness audit's first
-- wave made untrue (B12, lib/mink/input-provider.ts readWithFailover):
--   * "It does not automatically retry." A busy answer (429), a server error
--     (5xx) or a dropped connection now gets one more try on the main reader,
--     then the Mink fallback model reads the file, all inside the route's one
--     45-second deadline; a main reader that refuses (403 or 404) goes
--     straight to the fallback;
--   * "Permission, capacity, safety and provider failures never silently fall
--     back to another model": capacity and provider failures do fall back.
--     What stays true is that the reader's own verdict about the input (a
--     safety block, an input too large to read, an unreadable answer) is
--     final and is reported, never sent to a second model, and a missing
--     dashboard permission is refused before any reading starts.
-- The 0238 Help gate (bp1-docs) missed both. Each sentence is replaced in
-- place, in the merchant's words and without naming a model, in ONE
-- statement that also moves updated_at so the Help index re-embeds the guide;
-- nothing is appended. The first quote was written by 20260909_0090 and kept
-- by 20260910_0093, the second written by 20260910_0093; each occurs once in
-- the guide (checked against storemink_local's body before this was written).

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old$Processing has a 45-second deadline and rejects overly complex inputs or incomplete responses. It does not automatically retry.$old$,
        $new$Processing has a 45-second deadline and rejects overly complex inputs or incomplete responses. If the AI service is busy or briefly unavailable, Mink tries again and may read the file with a backup AI model, all within those 45 seconds.$new$
      ),
      $old$Permission, capacity, safety and provider failures never silently fall back to another model, so a refusal is reported rather than answered from a weaker source.$old$,
      $new$Mink uses a backup AI model only when the AI service is busy or unavailable: a file refused for safety reasons, or one too complex to read, is reported to you as it is.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';
