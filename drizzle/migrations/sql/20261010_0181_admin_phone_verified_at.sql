-- Phone verification moves out of signup and into the go-live checklist, and
-- stops linking the number to the merchant's login.
--
-- Signup used to verify the owner's mobile by linking it to their Firebase
-- login (`updatePhoneNumber`). Shoppers sign in to StoreMink storefronts with
-- that same Firebase project by phone, so a merchant who had ever bought from
-- a StoreMink store could not verify the number they shop with: "That mobile
-- number is already linked to another StoreMink account", and no way past it.
-- The number is now proven with an isolated sign-in that never touches the
-- merchant's login, and the proof is recorded HERE rather than as a claim on
-- the login.
--
-- ★ A TIMESTAMP, NOT "phone IS NOT NULL". `admins.phone` is also written by
-- the invited-staff password screen from a typed value the server does not
-- check, so its presence proves nothing. Only the verification action and
-- store creation (from a login that already carries a verified number) set
-- this column.
--
-- ★ BACKFILL ONLY WHAT IS PROVABLY VERIFIED. A signup-created owner row
-- (`invited_by IS NULL`) got its phone from store creation, which until this
-- change refused to run without a verified number; that is the only row
-- shape whose phone is known to be verified. Owners created before store
-- creation began writing the number (2026-09-06) have no phone here and stay
-- unverified: if their store has not opened yet, the checklist asks them once.

ALTER TABLE public.admins
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

UPDATE public.admins
   SET phone_verified_at = created_at
 WHERE phone IS NOT NULL
   AND btrim(phone) <> ''
   AND invited_by IS NULL
   AND phone_verified_at IS NULL;
