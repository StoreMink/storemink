-- Old and new web revisions overlap during deployment. Legacy jobs remain
-- claimable by either. A bounded job requires the new claim protocol, and
-- its absolute deadline survives even a checkpoint written by older code.
CREATE OR REPLACE FUNCTION public.mink_revamp_preserve_deadline()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.status IN ('queued', 'running')
     AND jsonb_typeof(OLD.result -> 'finishBy') = 'number' THEN
    IF NEW.status = 'running'
       AND NEW.lease_token IS NOT NULL
       AND NEW.lease_token IS DISTINCT FROM OLD.lease_token
       AND (NEW.result ->> 'deadlineLeaseToken') IS DISTINCT FROM NEW.lease_token::text THEN
      RAISE EXCEPTION 'Bounded redesign requires a compatible worker'
        USING ERRCODE = '55000';
    END IF;
    NEW.result := coalesce(NEW.result, '{}'::jsonb)
      || jsonb_build_object('finishBy', OLD.result -> 'finishBy');
    IF NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
       AND OLD.result ? 'deadlineLeaseToken' THEN
      NEW.result := NEW.result
        || jsonb_build_object('deadlineLeaseToken', OLD.result -> 'deadlineLeaseToken');
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER mink_revamps_deadline_guard
BEFORE UPDATE ON public.mink_revamps
FOR EACH ROW EXECUTE FUNCTION public.mink_revamp_preserve_deadline();
