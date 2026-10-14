-- Platform-managed staff roles. Every store picks from ONE list that StoreMink
-- operators own (lib/roles/catalog.ts for the defaults, lib/roles/
-- platform-roles.ts for the reads, the console's /dashboard/roles to edit):
-- Owner (superadmin), Admin (admin) and Staff (member) on the dashboard,
-- Manager and Cashier at the register, plus whatever an operator adds. A
-- merchant cannot create or edit a role, and cashiers and managers are invited
-- from the one Staff page with everyone else rather than from a separate
-- Point of Sale screen.
--
-- 1. `platform_roles` — platform-global (no store_id), service-only, seeded
--    with the five standard roles. `slug` is what admins.role and
--    pos_staff.role store; it never changes. ON CONFLICT DO NOTHING, so an
--    operator's later edits to a seeded role survive a re-run.
--
-- 2. admins.role becomes a FOREIGN KEY to platform_roles.slug. The old CHECK
--    had only ever allowed superadmin and member (no migration since the
--    Phase-5 snapshot touched it), which is also why no row can hold a custom
--    slug today: the UPDATE below is a guard and is expected to change
--    nothing. ON DELETE RESTRICT is what makes "a role in use cannot be
--    deleted" true at the database as well as in the console. The revision
--    being replaced writes only superadmin/member, both seeded, so the swap
--    is additive for it.
--
-- 3. The per-store `roles` table is no longer READ by any code path, but it is
--    left in place: the revision being replaced still reads it during the
--    rollout (expand/contract, docs/migrations.md). A later migration drops
--    it together with supabase/roles_table.sql.
--
-- 4. Help: the guides that told a merchant to create a role, to choose
--    between Admin and Superadmin, or to invite till staff from Point of
--    Sale → Staff are edited in place. The roles guide keeps its address.
--
-- 5. is_store_admin()/is_store_superadmin() admit every dashboard role on the
--    list, and no suspended admin (below the foreign key).

CREATE TABLE IF NOT EXISTS public.platform_roles (
  slug text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'grey',
  kind text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT platform_roles_slug_check CHECK (slug ~ '^[a-z][a-z0-9-]{1,39}$'),
  CONSTRAINT platform_roles_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT platform_roles_kind_check CHECK (kind = ANY (ARRAY['dashboard'::text, 'pos'::text])),
  CONSTRAINT platform_roles_color_check CHECK (color = ANY (ARRAY['grey'::text, 'blue'::text, 'green'::text, 'amber'::text, 'violet'::text])),
  CONSTRAINT platform_roles_permissions_check CHECK (jsonb_typeof(permissions) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_roles_name_lower_key
  ON public.platform_roles (lower(name));

-- Service-only, the mink_plan_allowances posture: a role is platform policy,
-- and app_user has no business reading or writing one.
ALTER TABLE public.platform_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_roles FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_roles TO app_service;

-- The five standard roles. The permission maps mirror lib/roles/catalog.ts's
-- DEFAULT_STAFF_ROLES exactly (lib/roles/catalog.test.ts reads this file and
-- fails if the two drift). The two register roles hold an EMPTY dashboard
-- map by design: their capabilities are the code table in
-- lib/pos/permissions.ts, and proxy.ts keeps them out of /dashboard.
INSERT INTO public.platform_roles
  (slug, name, description, color, kind, permissions, is_system, position)
VALUES
  ('superadmin', 'Owner', 'Full access to everything, including staff, roles, the plan and billing.', 'violet', 'dashboard', '{"dashboard":["view"],"orders":["view","manage"],"products":["view","manage"],"categories":["view","manage"],"colors":["view","manage"],"inventory":["view","manage"],"users":["view","manage"],"enquiries":["view","manage"],"analytics":["view","manage"],"locations":["view","manage"],"pos":["view","manage"],"themes":["view","manage"],"builder":["view","manage"],"navigation":["view","manage"],"blogs":["view","manage"],"branding":["view","manage"],"media":["view","manage"],"marketing":["view","manage"],"promotions":["view","manage"],"settings":["view","manage"],"admins":["view","manage"],"roles":["view"],"ai":["view","manage"],"channels":["view","manage"],"billing":["view","manage"],"notifications":["view","manage"],"activity":["view"]}'::jsonb, true, 0),
  ('admin', 'Admin', 'Runs the whole store: orders, catalogue, storefront, locations, POS and settings. Cannot invite staff or change the plan.', 'blue', 'dashboard', '{"dashboard":["view"],"orders":["view","manage"],"products":["view","manage"],"categories":["view","manage"],"colors":["view","manage"],"inventory":["view","manage"],"users":["view","manage"],"enquiries":["view","manage"],"analytics":["view","manage"],"locations":["view","manage"],"pos":["view","manage"],"themes":["view","manage"],"builder":["view","manage"],"navigation":["view","manage"],"blogs":["view","manage"],"branding":["view","manage"],"media":["view","manage"],"marketing":["view","manage"],"promotions":["view","manage"],"settings":["view","manage"],"admins":["view"],"roles":["view"],"channels":["view","manage"],"billing":["view","manage"],"notifications":["view","manage"],"activity":["view"]}'::jsonb, true, 1),
  ('member', 'Staff', 'Day-to-day work: orders, products, inventory, customers, enquiries, offers, blogs and media.', 'green', 'dashboard', '{"dashboard":["view"],"orders":["view","manage"],"products":["view","manage"],"categories":["view","manage"],"colors":["view","manage"],"inventory":["view","manage"],"users":["view"],"enquiries":["view","manage"],"analytics":["view"],"blogs":["view","manage"],"marketing":["view","manage"],"promotions":["view","manage"],"media":["view","manage"]}'::jsonb, true, 2),
  ('manager', 'Manager', 'Works the register at their shops: sells, takes returns, moves stock, runs the cash drawer and approves cashier discounts.', 'amber', 'pos', '{}'::jsonb, true, 3),
  ('cashier', 'Cashier', 'Works the register at their shops: rings up sales, takes payments and hands over pickup orders.', 'grey', 'pos', '{}'::jsonb, true, 4)
ON CONFLICT (slug) DO NOTHING;

-- admins.role: from a two-value CHECK to a foreign key on the role list.
ALTER TABLE public.admins DROP CONSTRAINT IF EXISTS profiles_role_check;

UPDATE public.admins
   SET role = 'member'
 WHERE role NOT IN (SELECT slug FROM public.platform_roles WHERE kind = 'dashboard');

ALTER TABLE public.admins DROP CONSTRAINT IF EXISTS admins_role_fkey;
ALTER TABLE public.admins
  ADD CONSTRAINT admins_role_fkey
  FOREIGN KEY (role) REFERENCES public.platform_roles (slug)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── RLS: every dashboard role is a store admin ───────────────────────────
-- is_store_admin() admitted role IN ('superadmin','member'), which was every
-- value the old CHECK allowed. With roles now a list (Admin is seeded and
-- operators add more), that pair would let an Admin past getManagerIdentity
-- and then return nothing under RLS: an empty Orders page, refused product
-- writes. It now admits any DASHBOARD-kind role; a register slug never acts on
-- the dashboard. Neither helper admits a suspended admin, so suspension is
-- enforced by the database as well as by app/dashboard/lib/access.ts.
CREATE OR REPLACE FUNCTION public.is_store_admin(target_store uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN public.is_platform_admin() OR EXISTS (
    SELECT 1
      FROM public.admins a
      JOIN public.platform_roles r ON r.slug = a.role AND r.kind = 'dashboard'
     WHERE a.id = auth.uid()
       AND a.store_id = target_store
       AND coalesce(a.is_suspended, false) = false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_store_superadmin(target_store uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.admins
    WHERE id = auth.uid() AND role = 'superadmin' AND store_id = target_store
      AND coalesce(is_suspended, false) = false
  );
END;
$$;

-- ── Help: roles are fixed ─────────────────────────────────────────────────

UPDATE public.help_articles
SET body = replace(
      replace(
      replace(
      replace(
      body,
      $old$<p>Roles decide which dashboard jobs a staff member can see or change. Location access separately decides which shops are included in location-shaped data.</p>
<p><strong>Plan availability:</strong> Creating and editing custom roles requires Basic or Pro. After a move to Free, existing roles and assignments remain stored and an unused custom role can still be deleted after its staff are reassigned.</p><h2>Create a role</h2>
<ol><li>Open <strong>Roles &amp; Permissions</strong>.</li><li>Select <strong>New role</strong>.</li><li>Enter a short name and useful description.</li><li>Choose a colour so the role is easy to recognise.</li><li>For each dashboard section, tick <strong>View</strong>, <strong>Manage</strong>, both, or neither.</li><li>Save the role.</li></ol>
<p>Granting Manage also grants View. Removing View removes Manage because a person cannot safely change a page they cannot open.</p>
<h2>System and custom roles</h2>
<ul><li><strong>Superadmin</strong> is a system role with full access. Its permissions and location scope cannot be narrowed.</li><li>Other system roles provide a safe starting point.</li><li>Custom roles can be edited or deleted. Reassign every user before deleting a role that is in use.</li></ul>$old$,
      $new$<p>Every store uses the same roles, set by StoreMink. A role decides which dashboard jobs a staff member can see or change, or whether they work the register instead. Location access separately decides which shops are included in location-shaped data.</p>
<h2>The standard roles</h2>
<ul><li><strong>Owner</strong> has full access to everything, including staff, roles, the plan and billing. Its access and location scope cannot be narrowed.</li><li><strong>Admin</strong> runs the whole store: orders, catalogue, storefront, locations, Point of Sale and settings. An Admin cannot invite staff or change the plan.</li><li><strong>Staff</strong> does the day-to-day work: orders, products, inventory, customers, enquiries, offers, blogs and media.</li><li><strong>Manager</strong> works the register: sells, takes returns, moves stock, runs the cash drawer and approves cashier discounts.</li><li><strong>Cashier</strong> works the register: rings up sales, takes payments and hands over pickup orders.</li></ul>
<p>Managers and cashiers sign in at the register on an authorised device and never see the dashboard. StoreMink may add roles or adjust what a role can reach; the Roles &amp; permissions page always shows the current list. Roles cannot be created or edited from your dashboard: choose the closest role, then use location access to limit a person to their shops.</p>
<h2>See what a role can do</h2>
<ol><li>Open <strong>Settings</strong>, then <strong>Roles &amp; permissions</strong>.</li><li>The dashboard table shows, page by page, whether Owner, Admin and Staff can view or manage it. Manage includes View.</li><li>The register table shows what a Manager and a Cashier can do at the counter.</li></ol>$new$),
      $old$<li>Choose the saved role and confirm.</li>$old$,
      $new$<li>Choose the role and confirm. A dashboard user can move between Owner, Admin and Staff; a register user between Manager and Cashier. To move someone between the dashboard and the register, remove them from Staff first, then invite them again with the new role.</li>$new$),
      $old$<p>The Locations action appears only when the store has more than one location and the user is not a superadmin. For non-superadmins, no shops ticked means unrestricted access to all shops.$old$,
      $new$<p>The Locations action appears only when the store has more than one location and the user is not the owner. No shops ticked means every shop: unrestricted access for a dashboard user, and an assignment to every location for a register user.$new$),
      $old$<li>If a page is missing, check the role's section permission.</li><li>If the page opens but actions are disabled, check whether the role has Manage, not only View.</li>$old$,
      $new$<li>If a page is missing, check which role the person has on the Roles &amp; permissions page.</li><li>If the page opens but actions are disabled, their role has View but not Manage for that page. Admin manages everything except staff and billing.</li>$new$),
    title = 'Roles, permissions, and location access',
    excerpt = 'See what each of the five roles can do, assign a role to dashboard or register staff, and restrict people to selected shops.',
    seo_title = 'StoreMink roles and location access',
    seo_description = 'Understand the five StoreMink staff roles, assign them to dashboard and register staff, and restrict access to selected locations.',
    updated_at = now()
WHERE slug = 'create-roles-permissions-and-location-access' AND status = 'published'
  AND strpos(body, $old$<p>Roles decide which dashboard jobs a staff member can see or change. Location access separately decides which shops are included in location-shaped data.</p>
<p><strong>Plan availability:</strong> Creating and editing custom roles requires Basic or Pro. After a move to Free, existing roles and assignments remain stored and an unused custom role can still be deleted after its staff are reassigned.</p><h2>Create a role</h2>
<ol><li>Open <strong>Roles &amp; Permissions</strong>.</li><li>Select <strong>New role</strong>.</li><li>Enter a short name and useful description.</li><li>Choose a colour so the role is easy to recognise.</li><li>For each dashboard section, tick <strong>View</strong>, <strong>Manage</strong>, both, or neither.</li><li>Save the role.</li></ol>
<p>Granting Manage also grants View. Removing View removes Manage because a person cannot safely change a page they cannot open.</p>
<h2>System and custom roles</h2>
<ul><li><strong>Superadmin</strong> is a system role with full access. Its permissions and location scope cannot be narrowed.</li><li>Other system roles provide a safe starting point.</li><li>Custom roles can be edited or deleted. Reassign every user before deleting a role that is in use.</li></ul>$old$) > 0
  AND strpos(body, $old$<li>Choose the saved role and confirm.</li>$old$) > 0
  AND strpos(body, $old$<p>The Locations action appears only when the store has more than one location and the user is not a superadmin. For non-superadmins, no shops ticked means unrestricted access to all shops.$old$) > 0
  AND strpos(body, $old$<li>If a page is missing, check the role's section permission.</li><li>If the page opens but actions are disabled, check whether the role has Manage, not only View.</li>$old$) > 0;

-- ── Help: one invite for every role ──────────────────────────────────────

UPDATE public.help_articles
SET body = replace(
      replace(
      replace(
      replace(
      replace(
      replace(
      replace(
      body,
      $old$Only a superadmin can invite new dashboard users.$old$,
      $new$Only the owner can invite staff, and everyone, including the cashiers and managers who work the register, is invited from the same list.$new$),
      $old$<li>Choose <strong>Admin</strong> or <strong>Superadmin</strong>.</li><li>For a non-superadmin in a multi-location store, tick the shops they should see.</li>$old$,
      $new$<li>Choose a role: <strong>Owner</strong>, <strong>Admin</strong> or <strong>Staff</strong> for the dashboard, or <strong>Manager</strong> or <strong>Cashier</strong> for the register. The register roles can be chosen once Point of Sale is switched on.</li><li>In a multi-location store, tick the shops they should see or work at.</li>$new$),
      $old$<p>StoreMink creates a secure temporary password and sends it to the email address when delivery is configured. The user signs in on the store dashboard and must set a new password on the first visit. Never forward the temporary password through an insecure public channel.</p>$old$,
      $new$<p>For a dashboard role, StoreMink creates a secure temporary password and sends it to the email address when delivery is configured. The user signs in on the store dashboard and must set a new password on the first visit. Never forward the temporary password through an insecure public channel. For a register role, the email carries a registration link: the person sets a password, verifies their phone and chooses an 8-digit PIN, then signs in at the register.</p>$new$),
      $old$<ul><li>A superadmin has full, unrestricted dashboard and location access.</li><li>An Admin starts with the built-in member role and can later be moved to another saved role.</li><li>For a non-superadmin, ticking shops restricts location-shaped data to those shops.</li><li>Leaving every location unticked means access to every location. It does not mean access to none.</li></ul>$old$,
      $new$<ul><li>An Owner has full, unrestricted dashboard and location access.</li><li>An Admin runs everything except staff, roles and the plan. Staff do the day-to-day work. Managers and cashiers sign in at the register only and never see the dashboard.</li><li>For anyone other than the owner, ticking shops restricts location-shaped data, or register work, to those shops.</li><li>Leaving every location unticked means every location. It does not mean none.</li></ul>$new$),
      $old$<li>Choose <strong>Change role</strong>, <strong>Locations</strong>, <strong>Suspend user</strong>, or <strong>Remove user</strong>.</li>$old$,
      $new$<li>Choose <strong>Change role</strong>, <strong>Locations</strong>, <strong>Suspend user</strong> (or <strong>Deactivate</strong> for register staff), or <strong>Remove user</strong>. A register invitation that has not been used yet can also be resent from the same menu.</li>$new$),
      $old$<li>Confirm the inviter is a superadmin and the plan has room for another staff account.</li>$old$,
      $new$<li>Confirm the inviter is the owner and the plan has room for another staff account. Register roles need Point of Sale switched on.</li>$new$),
      $old$<p>For finer access, see <a href="/help/account/create-roles-permissions-and-location-access">Create roles, permissions, and location access</a>.</p>$old$,
      $new$<p>For what each role can do, see <a href="/help/account/create-roles-permissions-and-location-access">Roles, permissions, and location access</a>.</p>$new$),
    title = 'Invite and manage staff',
    excerpt = 'Invite a dashboard admin or register staff member, deliver first-login details, change roles or locations, suspend access, or remove a user.',
    updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$Only a superadmin can invite new dashboard users.$old$) > 0
  AND strpos(body, $old$<li>Choose <strong>Admin</strong> or <strong>Superadmin</strong>.</li><li>For a non-superadmin in a multi-location store, tick the shops they should see.</li>$old$) > 0
  AND strpos(body, $old$<p>StoreMink creates a secure temporary password and sends it to the email address when delivery is configured. The user signs in on the store dashboard and must set a new password on the first visit. Never forward the temporary password through an insecure public channel.</p>$old$) > 0
  AND strpos(body, $old$<ul><li>A superadmin has full, unrestricted dashboard and location access.</li><li>An Admin starts with the built-in member role and can later be moved to another saved role.</li><li>For a non-superadmin, ticking shops restricts location-shaped data to those shops.</li><li>Leaving every location unticked means access to every location. It does not mean access to none.</li></ul>$old$) > 0
  AND strpos(body, $old$<li>Choose <strong>Change role</strong>, <strong>Locations</strong>, <strong>Suspend user</strong>, or <strong>Remove user</strong>.</li>$old$) > 0
  AND strpos(body, $old$<li>Confirm the inviter is a superadmin and the plan has room for another staff account.</li>$old$) > 0
  AND strpos(body, $old$<p>For finer access, see <a href="/help/account/create-roles-permissions-and-location-access">Create roles, permissions, and location access</a>.</p>$old$) > 0;

-- ── Help: till staff are invited from Settings → Staff ───────────────────

UPDATE public.help_articles
SET body = replace(
      replace(
      body,
      $old$<ol><li>Open <strong>Point of Sale → Staff</strong>.</li><li>Select <strong>Invite staff</strong>.</li><li>Enter the person's name and email.</li><li>Choose <strong>Cashier</strong> or <strong>Manager</strong>.</li><li>Choose the locations where they may work.</li><li>Send the invitation.</li></ol>$old$,
      $new$<ol><li>Open <strong>Settings</strong>, then <strong>Staff</strong>.</li><li>Select <strong>Invite user</strong>.</li><li>Enter the person's name and email.</li><li>Choose <strong>Cashier</strong> or <strong>Manager</strong>. These two roles work the register; the dashboard roles are listed above them.</li><li>Tick the locations where they may work, or leave them all unticked to assign every location.</li><li>Send the invitation.</li></ol>$new$),
      $old$Deactivating a staff member ends their POS access on the next request.$old$,
      $new$Deactivating a staff member from <strong>Settings</strong>, then <strong>Staff</strong>, ends their POS access on the next request.$new$),
    updated_at = now()
WHERE slug = 'set-up-pos-staff-and-pins' AND status = 'published'
  AND strpos(body, $old$<ol><li>Open <strong>Point of Sale → Staff</strong>.</li><li>Select <strong>Invite staff</strong>.</li><li>Enter the person's name and email.</li><li>Choose <strong>Cashier</strong> or <strong>Manager</strong>.</li><li>Choose the locations where they may work.</li><li>Send the invitation.</li></ol>$old$) > 0
  AND strpos(body, $old$Deactivating a staff member ends their POS access on the next request.$old$) > 0;

-- ── Help: custom roles are no longer a plan feature ──────────────────────

UPDATE public.help_articles
SET body = replace(
      replace(
      body,
      $old$<td>Customer groups, custom roles, custom-code page sections, Shiprocket, dashboard customization, detailed reports, CSV and Search Console analytics</td>$old$,
      $new$<td>Customer groups, custom-code page sections, Shiprocket, dashboard customization, detailed reports, CSV and Search Console analytics</td>$new$),
      $old$<li>Existing customer groups and memberships remain editable below Basic, but creating another group is paused. An unused custom role may still be deleted, while creating or editing roles waits for Basic or Pro.</li>$old$,
      $new$<li>Existing customer groups and memberships remain editable below Basic, but creating another group is paused.</li>$new$),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$<td>Customer groups, custom roles, custom-code page sections, Shiprocket, dashboard customization, detailed reports, CSV and Search Console analytics</td>$old$) > 0
  AND strpos(body, $old$<li>Existing customer groups and memberships remain editable below Basic, but creating another group is paused. An unused custom role may still be deleted, while creating or editing roles waits for Basic or Pro.</li>$old$) > 0;
