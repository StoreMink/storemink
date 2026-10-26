-- The general Mink guide (use-mink-ai-in-your-dashboard) describes Stop in two
-- sentences that the stop handshake (20261025_0244_mink_run_stop,
-- lib/mink/run-stop.ts, 25 Oct 2026) made untrue:
--   * "Select Stop to cancel the request in this browser." Stop now asks
--     StoreMink to stop the reply itself. Before Mink has started anything the
--     reply stops and nothing is created; once it has started something (a
--     proposal, a storefront redesign, an image) the stop is refused, Stop is
--     no longer offered and the reply finishes, so its card reaches the chat.
--   * "If Mink's reply fails or is stopped after it created a proposal,
--     StoreMink discards the unseen proposal ...": a Stop after a proposal
--     exists is refused now, so only a reply that fails still discards an
--     unseen proposal. The redesign exception after it stays true.
-- Each sentence is replaced in place in ONE statement that also moves
-- updated_at so the Help index re-embeds the guide; nothing is appended. The
-- first sentence was written by 20260829_0035 and kept by 20260910_0093, the
-- second written by 20261024_0239; each occurs once in the published guide
-- (checked against storemink_local's body before this was written).

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old$Select <strong>Stop</strong> to cancel the request in this browser.$old$,
        $new$Select <strong>Stop</strong> to stop Mink's reply. If Mink has not started anything yet, the reply stops and nothing is created. If it has already started something, such as a draft or a storefront redesign, the reply finishes instead and its card appears in the chat.$new$
      ),
      $old$If Mink's reply fails or is stopped after it created a proposal,$old$,
      $new$If Mink's reply fails after it created a proposal,$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';
