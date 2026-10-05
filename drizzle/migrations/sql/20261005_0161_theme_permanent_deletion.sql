-- Operator-only permanent removal. Ordinary edits and deletes still obey
-- all existing immutability guards; the narrowly scoped function is the only
-- application path that can remove a project's protected history.
CREATE TABLE public.theme_studio_deletion_audit (
  project_id uuid PRIMARY KEY,
  theme_id text NOT NULL,
  project_name text NOT NULL,
  actor_id uuid NOT NULL,
  actor_email text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX theme_studio_deletion_audit_theme_idx ON public.theme_studio_deletion_audit(theme_id);
ALTER TABLE public.theme_studio_deletion_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.theme_studio_deletion_audit FROM PUBLIC, app_user, app_service;
GRANT SELECT ON public.theme_studio_deletion_audit TO app_service;

CREATE FUNCTION public.theme_studio_deletion_audit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'theme deletion audit is immutable';
END;
$$;
CREATE TRIGGER theme_studio_deletion_audit_immutable
BEFORE UPDATE OR DELETE ON public.theme_studio_deletion_audit
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_deletion_audit_guard();
REVOKE ALL ON FUNCTION public.theme_studio_deletion_audit_guard() FROM PUBLIC, app_user, app_service;

CREATE FUNCTION public.theme_studio_delete_project(
  p_project uuid, p_revision integer, p_confirmation text, p_actor uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET lock_timeout = '5s' AS $$
DECLARE project public.theme_studio_projects%ROWTYPE; actor_email text;
  has_releases boolean; demo_id uuid;
BEGIN
  SELECT email INTO actor_email FROM public.platform_admins
    WHERE id=p_actor AND role='superadmin';
  IF actor_email IS NULL THEN RAISE EXCEPTION 'Only a platform superadmin can delete themes.'; END IF;
  SELECT * INTO project FROM public.theme_studio_projects WHERE id=p_project FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.theme_studio_deletion_audit
        WHERE project_id=p_project AND theme_id=p_confirmation) THEN
      RETURN jsonb_build_object('ok',true,'themeId',p_confirmation);
    END IF;
    RETURN jsonb_build_object('ok',false,'error','That project no longer exists.');
  END IF;
  IF project.revision IS DISTINCT FROM p_revision THEN
    RETURN jsonb_build_object('ok',false,'error','This project changed in another tab. Reload before deleting.');
  END IF;
  IF p_confirmation IS DISTINCT FROM project.theme_id THEN
    RETURN jsonb_build_object('ok',false,'error','Type the exact theme ID to confirm permanent deletion.');
  END IF;
  IF project.status='generating'
      OR EXISTS (SELECT 1 FROM public.theme_studio_runs WHERE project_id=p_project AND status IN ('queued','running'))
      OR EXISTS (SELECT 1 FROM public.theme_studio_captures WHERE project_id=p_project AND status IN ('queued','running'))
      OR EXISTS (SELECT 1 FROM public.theme_studio_visual_qa_runs WHERE project_id=p_project AND status IN ('queued','running'))
      OR EXISTS (SELECT 1 FROM public.theme_studio_acceptance_runs WHERE project_id=p_project AND status IN ('running','awaiting_browser'))
      OR EXISTS (SELECT 1 FROM public.theme_studio_publications WHERE project_id=p_project AND status='publishing') THEN
    RETURN jsonb_build_object('ok',false,'error','Wait for active work to finish or cancel it before deleting this theme.');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('theme-publication:' || project.theme_id));
  SELECT EXISTS (SELECT 1 FROM public.theme_studio_publications
    WHERE project_id=p_project AND release_id IS NOT NULL) INTO has_releases;
  IF has_releases AND EXISTS (SELECT 1 FROM public.theme_studio_projects
      WHERE theme_id=project.theme_id AND id<>p_project) THEN
    RETURN jsonb_build_object('ok',false,'error','Another project shares this theme ID. Delete that project first.');
  END IF;
  IF has_releases AND EXISTS (SELECT 1 FROM public.theme_releases
      WHERE theme_id=project.theme_id AND source<>'theme-studio') THEN
    RETURN jsonb_build_object('ok',false,'error','Bundled themes cannot be permanently deleted from Theme Studio.');
  END IF;

  -- Serialize the check with all installations/settings writes and preview
  -- creation. A store trigger below also refuses delayed cached installs.
  LOCK TABLE public.stores IN SHARE ROW EXCLUSIVE MODE;
  SELECT id INTO demo_id FROM public.stores
    WHERE slug='demo-' || project.theme_id AND settings->>'demo'='true'
      AND coalesce(settings#>>'{theme,presetId}',settings->>'template')=project.theme_id;
  IF has_releases AND EXISTS (SELECT 1 FROM public.stores s
      WHERE coalesce(s.settings#>>'{theme,presetId}',s.settings->>'template')=project.theme_id
        AND s.id IS DISTINCT FROM demo_id
        AND NOT EXISTS (SELECT 1 FROM public.theme_studio_previews v
          WHERE v.project_id=p_project AND v.store_id=s.id
            AND s.settings->>'demo'='true' AND s.settings ? 'studioPreview')) THEN
    RETURN jsonb_build_object('ok',false,'error','A store is using this theme. Switch its theme before permanently deleting it.');
  END IF;

  PERFORM set_config('app.theme_delete_project',p_project::text,true);
  -- Only a project that owns published/allocated releases may remove them.
  PERFORM set_config('app.theme_delete_theme',CASE WHEN has_releases THEN project.theme_id ELSE '' END,true);
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO public.theme_studio_deletion_audit(project_id,theme_id,project_name,actor_id,actor_email)
    VALUES(p_project,project.theme_id,project.name,p_actor,actor_email);
  DELETE FROM public.stores s WHERE s.settings->>'demo'='true' AND s.settings ? 'studioPreview'
    AND EXISTS (SELECT 1 FROM public.theme_studio_previews v WHERE v.project_id=p_project AND v.store_id=s.id);
  IF has_releases THEN
    DELETE FROM public.theme_catalog_audit WHERE theme_id=project.theme_id;
    DELETE FROM public.theme_catalog_entries WHERE theme_id=project.theme_id;
    DELETE FROM public.stores WHERE id=demo_id AND settings->>'demo'='true';
  END IF;
  DELETE FROM public.theme_studio_previews WHERE project_id=p_project;
  DELETE FROM public.theme_studio_publications WHERE project_id=p_project;
  DELETE FROM public.theme_studio_reviews WHERE project_id=p_project;
  DELETE FROM public.theme_studio_acceptance_runs WHERE project_id=p_project;
  DELETE FROM public.theme_studio_visual_qa_runs WHERE project_id=p_project;
  DELETE FROM public.theme_studio_captures WHERE project_id=p_project;
  DELETE FROM public.theme_studio_events WHERE project_id=p_project;
  DELETE FROM public.theme_studio_versions WHERE project_id=p_project;
  DELETE FROM public.theme_studio_runs WHERE project_id=p_project;
  DELETE FROM public.theme_studio_messages WHERE project_id=p_project;
  DELETE FROM public.theme_studio_assets WHERE project_id=p_project;
  DELETE FROM public.theme_studio_projects WHERE id=p_project;
  IF has_releases THEN
    DELETE FROM public.theme_releases WHERE theme_id=project.theme_id;
  END IF;
  PERFORM set_config('app.theme_delete_project','',true);
  PERFORM set_config('app.theme_delete_theme','',true);
  RETURN jsonb_build_object('ok',true,'themeId',project.theme_id);
END;
$$;
REVOKE ALL ON FUNCTION public.theme_studio_delete_project(uuid,integer,text,uuid) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.theme_studio_delete_project(uuid,integer,text,uuid) TO app_service;

-- A service caller can set arbitrary GUCs, but cannot impersonate the owner
-- of the SECURITY DEFINER removal function. Both checks are required. This
-- helper is SECURITY INVOKER so it sees that function's effective role.
CREATE FUNCTION public.theme_studio_deletion_allowed(p_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT current_user = pg_get_userbyid((SELECT proowner FROM pg_proc
    WHERE oid = 'public.theme_studio_delete_project(uuid,integer,text,uuid)'::regprocedure))
    AND (
      (p_row->>'project_id' IS NOT NULL AND p_row->>'project_id' =
        current_setting('app.theme_delete_project', true)) OR
      (p_row->>'project_id' IS NULL AND p_row->>'theme_id' IS NOT NULL
        AND p_row->>'theme_id' = current_setting('app.theme_delete_theme', true))
    );
$$;
REVOKE ALL ON FUNCTION public.theme_studio_deletion_allowed(jsonb) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.theme_studio_deletion_allowed(jsonb) TO app_service;

-- Preserve each guard's complete existing UPDATE logic. Add an exact-scope
-- DELETE exception to its body rather than disabling any trigger or role.
DO $migration$
DECLARE fn text; body text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'prevent_theme_release_mutation', 'theme_studio_forbid_mutation',
    'theme_studio_version_qa_guard', 'theme_studio_capture_guard',
    'theme_studio_visual_qa_guard', 'theme_studio_acceptance_guard',
    'theme_studio_publication_guard'
  ] LOOP
    SELECT pg_get_functiondef(to_regprocedure('public.' || fn || '()')) INTO body;
    IF body IS NULL THEN RAISE EXCEPTION 'Missing Theme Studio guard %', fn; END IF;
    body := regexp_replace(body, '\mBEGIN\M',
      'BEGIN
  IF TG_OP = ''DELETE'' AND public.theme_studio_deletion_allowed(to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;');
    EXECUTE body;
  END LOOP;
END;
$migration$;

-- Runs, versions and projects form intentional history cycles. Deferral
-- keeps every FK enforced at commit while allowing complete removal in one
-- transaction; all ordinary operations keep immediate checks.
DO $migration$
DECLARE fk record;
BEGIN
  FOR fk IN SELECT c.conname, c.conrelid::regclass AS tab
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_class r ON r.oid=c.confrelid
    WHERE c.contype='f' AND t.relnamespace='public'::regnamespace
      AND t.relname LIKE 'theme_studio_%'
      AND r.relname LIKE 'theme_studio_%'
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', fk.tab, fk.conname);
  END LOOP;
END;
$migration$;

-- A request may have resolved a cached release before deletion acquired the
-- store lock. Never let that stale request create a dangling installation.
CREATE FUNCTION public.theme_studio_deleted_install_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE target_theme_id text;
BEGIN
  target_theme_id := coalesce(NEW.settings#>>'{theme,presetId}',NEW.settings->>'template');
  IF (TG_OP='INSERT' OR target_theme_id IS DISTINCT FROM coalesce(OLD.settings#>>'{theme,presetId}',OLD.settings->>'template'))
      AND EXISTS (SELECT 1 FROM public.theme_studio_deletion_audit a WHERE a.theme_id=target_theme_id)
      AND NOT EXISTS (SELECT 1 FROM public.theme_releases r WHERE r.theme_id=target_theme_id) THEN
    RAISE EXCEPTION 'This theme was permanently deleted. Choose another theme.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER theme_studio_deleted_install_guard BEFORE INSERT OR UPDATE OF settings ON public.stores
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_deleted_install_guard();
REVOKE ALL ON FUNCTION public.theme_studio_deleted_install_guard() FROM PUBLIC, app_user, app_service;

-- Deleted identities remain reserved by the audit receipt. Reusing one would
-- reuse release versions and make delayed cached installations ambiguous.
CREATE FUNCTION public.theme_studio_deleted_project_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.theme_studio_deletion_audit WHERE theme_id=NEW.theme_id) THEN
    RAISE EXCEPTION 'This theme ID was permanently deleted. Choose a new theme ID.'
      USING ERRCODE='23505', CONSTRAINT='theme_studio_deleted_theme_id';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER theme_studio_deleted_project_guard BEFORE INSERT ON public.theme_studio_projects
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_deleted_project_guard();
REVOKE ALL ON FUNCTION public.theme_studio_deleted_project_guard() FROM PUBLIC, app_user, app_service;
