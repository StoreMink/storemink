-- The storefront password of a store that has not opened yet.
--
-- A new store is created `settings.launched = false` and stays closed until
-- its owner completes the go-live checklist and presses Go live. While it is
-- closed, visitors see a password page; the password lives here.
--
-- ★ ITS OWN SERVICE-ONLY TABLE, NOT A KEY IN stores.settings. That column is
-- anon-readable by the "Read stores" policy (CODEBASE.md §5.9), so a password
-- stored there would be readable by exactly the visitors it keeps out.
--
-- ★ password_version IS WHAT A GRANT COOKIE IS BOUND TO. Regenerating the
-- password bumps it, and every cookie minted against the old value stops
-- working on the next request without any cookie being touched.
--
-- Service-only (RLS on, no policies, app_user has no grants), like every
-- other table the storefront's anonymous client must never read.

CREATE TABLE IF NOT EXISTS public.store_access (
  store_id uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  password text NOT NULL,
  password_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_access_password_check
    CHECK (length(password) BETWEEN 4 AND 64),
  CONSTRAINT store_access_version_check
    CHECK (password_version >= 1)
);

ALTER TABLE public.store_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_access FROM PUBLIC;
REVOKE ALL ON public.store_access FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_access TO app_service;

-- ★★ A SHOP THAT HAS ALREADY TAKEN AN ORDER IS OPEN, WHATEVER THE FLAG SAYS.
-- Until now `launched` only governed search indexing and flipped on the first
-- publish, so a store created closed could legitimately be trading with the
-- flag still false (its owner published a product, which launched it — but a
-- store whose product import or theme save never ran the launch hook could
-- not). From this migration the same flag puts a PASSWORD PAGE in front of the
-- storefront, and a trading shop must never wake up behind one. Any order is
-- proof the shop is open to the public; nothing else about the row changes.
UPDATE public.stores s
SET settings = COALESCE(s.settings, '{}'::jsonb) || '{"launched":true}'::jsonb
WHERE s.settings->>'launched' = 'false'
  AND EXISTS (SELECT 1 FROM public.orders o WHERE o.store_id = s.id);
