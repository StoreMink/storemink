-- Paid plans stop lapsing after their first cycle, and the overdue downgrade
-- starts working. Both halves have to land together.
--
-- ★★ THE DEFECT. Enrolment stamped the FIRST cycle's end into
-- `stores.plan_expires_at` and nothing ever moved it: the renewal worker advanced
-- `billing_subscriptions` only. So every paying store read as Free after 30 or
-- 365 days (`effectivePlan` treats a past expiry as Free), and the daily
-- plan-expiry job then wrote `plan = 'free'`, renewal paid or not.
--
-- ★★ AND THAT EXPIRY WAS THE ONLY THING DOWNGRADING NON-PAYERS. The claim below
-- checked the invoice for `current_cycle_seq` — but the cycle only advances once
-- the NEXT invoice is paid, so the current cycle's invoice is always the one
-- already paid and the claim never matched. Extending the expiry without fixing
-- this would hand every non-payer their plan indefinitely.
--
-- The application half (lib/billing/renewal-worker.ts, lib/billing/enrol.ts):
-- a paid plan carries no `plan_expires_at`; every cycle turn writes the plan the
-- subscription pays for onto `stores`; a cancellation and a post-grace downgrade
-- take it away explicitly.

-- 1. The downgrade claim looks at the invoice grace is ABOUT: the next cycle's.
--    And it closes that invoice, so a payment arriving after the downgrade
--    cannot be taken for a plan that will not come back (lib/billing/manual-pay.ts
--    refuses an uncollectible invoice).
CREATE OR REPLACE FUNCTION public.billing_claim_downgrade(
  p_store uuid,
  p_now timestamp with time zone DEFAULT now()
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
declare
  v_store uuid;
  v_seq integer;
begin
  update public.billing_subscriptions s
     set state            = 'downgraded',
         plan             = 'free',
         billed_locations = 0,
         scheduled_plan   = null,
         scheduled_period = null,
         scheduled_locations = null,
         grace_started_at = null,
         grace_ends_at    = null,
         downgraded_at    = p_now,
         updated_at       = p_now
   where s.store_id = p_store
     and s.state in ('past_due','grace')
     and s.grace_ends_at is not null
     -- Strictly past the deadline: at exactly grace_ends_at the merchant still
     -- has the full 48 hours they were promised (lib/billing/cycle.ts).
     and s.grace_ends_at < p_now
     -- The payment check, on the invoice for the cycle being entered. The
     -- cycle advances only once that invoice is paid, so the current cycle's
     -- own invoice is always settled and says nothing about grace.
     and not exists (
       select 1 from public.billing_invoices i
        where i.store_id = s.store_id
          and i.kind = 'subscription'
          and i.cycle_seq = s.current_cycle_seq + 1
          and i.status in ('paid','processing')
     )
  returning s.store_id, s.current_cycle_seq into v_store, v_seq;

  if v_store is null then
    return false;
  end if;

  update public.billing_invoices
     set status = 'uncollectible',
         updated_at = p_now
   where store_id = v_store
     and kind = 'subscription'
     and cycle_seq = v_seq + 1
     and status = 'open';

  return true;
end; $function$;

-- 2. Repair stores already hit. A store whose subscription is live (active, or
--    still inside its grace window) gets back the plan it pays for, with no
--    expiry. Only stores billing set (`plan_source = 'paid'`): an operator's
--    grant is left exactly as it is. A subscription whose grace has already run
--    out is left to the worker, which now downgrades it properly.
--    Audited in plan_events where the plan actually changes.
WITH live AS (
  SELECT b.store_id, b.plan
    FROM public.billing_subscriptions b
   WHERE b.plan <> 'free'
     AND (
       b.state = 'active'
       OR (b.state IN ('past_due', 'grace') AND b.grace_ends_at > now())
     )
),
before AS (
  SELECT st.id, st.plan AS from_plan, live.plan AS to_plan
    FROM public.stores st
    JOIN live ON live.store_id = st.id
   WHERE st.plan_source = 'paid'
     AND (st.plan IS DISTINCT FROM live.plan OR st.plan_expires_at IS NOT NULL)
),
repaired AS (
  UPDATE public.stores st
     SET plan = before.to_plan,
         plan_expires_at = NULL
    FROM before
   WHERE st.id = before.id
  RETURNING st.id
)
INSERT INTO public.plan_events (store_id, from_plan, to_plan, source, actor, note)
SELECT before.id, before.from_plan, before.to_plan, 'system',
       'migration-0192',
       'restored: a paid renewal had lapsed to Free through the first-cycle expiry'
  FROM before
  JOIN repaired ON repaired.id = before.id
 WHERE before.from_plan IS DISTINCT FROM before.to_plan;
