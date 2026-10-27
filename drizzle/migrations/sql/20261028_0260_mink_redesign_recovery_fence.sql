-- Old and new web revisions overlap during a rolling deployment. A full
-- redesign created by the new revision carries recovery policy 2
-- (result.recoveryVersion = 2): its waits park it without counting, its
-- paid candidates are stored before review, and its ceiling is longer than
-- the legacy four hours. The revision before it would claim such a job and
-- save a result without the policy (turning it back into a legacy job half
-- way), or fail it at the legacy ceiling from its sweep or status poll.
--
-- This fence lets only a transaction that declares the protocol
-- (set_config('app.mink_revamp_recovery', '2', true), which jobs.ts does
-- for every write) change an unfinished recoverable job. An undeclared
-- transaction may still record Stop (cancel_requested_at, updated_at) and
-- nothing else: its claim is refused, and any other write is skipped. A
-- declared claim stamps its lease token in result.recoveryLeaseToken, and
-- the policy fields survive every checkpoint. Legacy jobs and refinements
-- (no recoveryVersion) are untouched; finished jobs are untouched.
--
-- The bounded-deadline guard from 0259 protects a finishBy protocol no code
-- writes any more, so it fires for no row; it stays in place because 0259's
-- durable verification names it.
CREATE OR REPLACE FUNCTION public.mink_revamp_recovery_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  parked constant uuid := '00000000-0000-4000-8000-000000000000';
  declared boolean := coalesce(current_setting('app.mink_revamp_recovery', true), '') = '2';
BEGIN
  IF OLD.result -> 'recoveryVersion' IS DISTINCT FROM '2'::jsonb
     OR OLD.status NOT IN ('queued', 'running') THEN
    RETURN NEW;
  END IF;

  IF NOT declared THEN
    -- An older revision may record Stop and nothing else.
    IF (to_jsonb(NEW) - 'cancel_requested_at' - 'updated_at')
       = (to_jsonb(OLD) - 'cancel_requested_at' - 'updated_at') THEN
      RETURN NEW;
    END IF;
    IF NEW.lease_token IS NOT NULL
       AND NEW.lease_token IS DISTINCT FROM OLD.lease_token
       AND NEW.lease_token <> parked THEN
      RAISE EXCEPTION 'Recoverable redesign requires a compatible worker'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;

  -- A compatible claim stamps the lease it takes.
  IF NEW.status = 'running'
     AND NEW.lease_token IS NOT NULL
     AND NEW.lease_token IS DISTINCT FROM OLD.lease_token
     AND NEW.lease_token <> parked
     AND (NEW.result ->> 'recoveryLeaseToken') IS DISTINCT FROM NEW.lease_token::text THEN
    RAISE EXCEPTION 'Recoverable redesign claim must stamp its lease'
      USING ERRCODE = '55000';
  END IF;

  -- The policy survives every checkpoint, whatever the write carried.
  NEW.result := coalesce(NEW.result, '{}'::jsonb)
    || jsonb_build_object('recoveryVersion', OLD.result -> 'recoveryVersion');
  IF jsonb_typeof(OLD.result -> 'targetReadyAt') = 'number' THEN
    NEW.result := NEW.result
      || jsonb_build_object('targetReadyAt', OLD.result -> 'targetReadyAt');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS mink_revamps_recovery_fence ON public.mink_revamps;
CREATE TRIGGER mink_revamps_recovery_fence
BEFORE UPDATE ON public.mink_revamps
FOR EACH ROW EXECUTE FUNCTION public.mink_revamp_recovery_fence();
