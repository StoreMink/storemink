-- A weighted twin of check_rate_limit: the same fixed-window counter in
-- public.rate_limits, but each call adds p_cost instead of 1.
--
-- Read-aloud for Mink voice chat is free to the merchant and paid by
-- StoreMink per character, so its allowance is a character budget rather than
-- a request count. Voice chat sends a sentence or two per request, so it needs
-- many more requests than read-aloud did when it read whole answers; counting
-- requests alone let 1.2 times the old characters through per store. With a
-- character budget the request limits can stay generous while the spend
-- ceiling stays exactly where it was.
--
-- Additive: a new function only, so the revision being replaced (which never
-- calls it) is unaffected. Service-only like the rest of the Mink limits.

CREATE OR REPLACE FUNCTION public.check_rate_limit_cost(
  p_key TEXT,
  p_max INTEGER,
  p_window_seconds INTEGER,
  p_cost INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now   TIMESTAMPTZ := NOW();
  v_count INTEGER;
BEGIN
  IF p_cost IS NULL OR p_cost < 1 THEN
    RAISE EXCEPTION 'check_rate_limit_cost: p_cost must be at least 1';
  END IF;
  INSERT INTO public.rate_limits AS rl (key, count, window_start)
    VALUES (p_key, p_cost, v_now)
  ON CONFLICT (key) DO UPDATE
    SET
      -- A window that has elapsed starts again at this call's cost;
      -- otherwise the cost is added to the current window.
      count = CASE
        WHEN rl.window_start < v_now - make_interval(secs => p_window_seconds)
          THEN p_cost
        ELSE rl.count + p_cost
      END,
      window_start = CASE
        WHEN rl.window_start < v_now - make_interval(secs => p_window_seconds)
          THEN v_now
        ELSE rl.window_start
      END
  RETURNING rl.count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit_cost(text, integer, integer, integer)
  FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_cost(text, integer, integer, integer)
  TO app_service;
