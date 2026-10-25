-- Generate with AI gives back the Mink credit it took when the model fails,
-- and its failure messages say nothing was charged (robustness audit B1,
-- migration 0237). Two sentences of the AI usage and credits guide no longer
-- tell a merchant what they will see:
--   * the activity sentence names purchases, grants and spends, so a top-up
--     credit given back, which Plans & Billing lists as a Grant with the note
--     "Refund: an AI request failed", would read as a gift from StoreMink;
--   * the troubleshooting line says to read the message before changing the
--     plan or buying credits, and not that a busy or unavailable AI writing
--     tool charges nothing, which is what the message now says.
-- Both sentences are replaced in place in ONE statement that also moves
-- updated_at, so the Help index re-embeds the guide; nothing is appended.
-- The quoted text comes from 0114 (activity) and 0019 (troubleshooting), each
-- occurs once in the guide, and both were checked against storemink_local's
-- body before this was written.

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old$<strong>Recent Mink credit activity</strong> shows purchases, operator grants, and tasks that spent credits.$old$,
        $new$<strong>Recent Mink credit activity</strong> shows purchases, credits granted by StoreMink, top-up credits given back when an AI writing task failed (listed as a Grant with the note "Refund: an AI request failed"), and tasks that spent credits.$new$
      ),
      $old$An AI provider error and an allowance error are different. Read the message before changing the plan or buying credits.$old$,
      $new$An AI provider error and an allowance error are different. When an AI writing tool is busy or unavailable, it gives back the credit it used and its message says nothing was charged: wait a minute and try again rather than changing the plan or buying credits.$new$
    ),
    updated_at = now()
WHERE slug = 'understand-ai-usage-and-credits';
