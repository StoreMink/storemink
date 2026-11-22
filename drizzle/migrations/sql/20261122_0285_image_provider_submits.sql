-- Finding an image job whose answer was lost (owner, 22 Nov 2026: "fix it").
--
-- ElevenLabs' Image API takes no idempotency key. When a submit gets no
-- answer (a dropped connection, a 5xx, a clock), a job may have been made
-- and paid for, and nobody holds its id; 0284's record cannot help, because
-- it is written from the id. The next try then paid for the same picture a
-- second time.
--
-- Their job list does not show a job's prompt, but it is ordered by creation
-- time and its paging cursor carries that time. So a lost job can be found
-- by WHEN it was made, provided we know exactly when each of our requests
-- was out:
--
-- image_provider_submits: one row per submit, written BEFORE the request
-- leaves. A submit that is answered deletes its row in the statement that
-- records the job. One that gets no answer stays, as `lost`, with the
-- window it was out for. A job in the provider's list that was made inside
-- that window, that 0284's record does not hold, and that no other
-- unanswered submit could have made, is that submit's job (`found`).
--
-- Expand only. Service access only; no merchant reads the table.

CREATE TABLE public.image_provider_submits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  -- As in image_provider_generations: whose picture, and which picture.
  scope          text NOT NULL,
  request_digest text NOT NULL,
  -- sending:  the request is out and unanswered.
  -- lost:     no answer came; a job may exist.
  -- found:    its job was found in the provider's list (generation_id).
  -- given_up: looked for with a clear view, and no job was there.
  state          text NOT NULL DEFAULT 'sending',
  sent_at        timestamptz NOT NULL,
  lost_at        timestamptz,
  generation_id  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT image_provider_submits_provider_check
    CHECK (provider = 'elevenlabs'),
  CONSTRAINT image_provider_submits_state_check
    CHECK (state = ANY (ARRAY['sending'::text, 'lost'::text, 'found'::text, 'given_up'::text])),
  CONSTRAINT image_provider_submits_digest_check
    CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT image_provider_submits_found_check
    CHECK ((state = 'found') = (generation_id IS NOT NULL)),
  CONSTRAINT image_provider_submits_lost_check
    CHECK (state = 'sending' OR lost_at IS NOT NULL)
);

-- The submits that may still have made a job nobody holds: read by every
-- search, to rule out a job that another unanswered submit could have made.
CREATE INDEX image_provider_submits_open_idx
  ON public.image_provider_submits (provider, sent_at)
  WHERE state <> 'found';

CREATE INDEX image_provider_submits_picture_idx
  ON public.image_provider_submits (provider, scope, request_digest, sent_at)
  WHERE state = ANY (ARRAY['sending'::text, 'lost'::text]);

CREATE INDEX image_provider_submits_created_idx
  ON public.image_provider_submits (created_at);

ALTER TABLE public.image_provider_submits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.image_provider_submits FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.image_provider_submits TO app_service;
