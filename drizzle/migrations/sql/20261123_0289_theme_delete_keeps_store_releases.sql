-- Deleting a Theme Studio theme that stores use (owner, 23 Nov 2026: "i
-- should be able to delete a theme. store which uses this theme should remain
-- as it is").
--
-- Until now theme_studio_delete_project (0161) refused while any store used
-- the theme: "A store is using this theme. Switch its theme before permanently
-- deleting it." A store cannot switch themes (a theme is chosen once), so a
-- theme any store had installed could never be deleted.
--
-- Now it deletes the theme and keeps exactly what those stores render. Every
-- store pins the release it installed (settings.theme.presetId and
-- presetVersion, written by lib/themes/apply.ts and lib/themes/switch.ts), and
-- a pinned store renders that release by theme id and version straight from
-- theme_releases (resolveInstalledThemeDefinition), never through the
-- catalogue. So the release row is all such a store needs.
--
-- What a deletion does now:
--   * as before: erases the project and its whole history (chat, designs,
--     runs, checks, previews, publications), the catalogue entry and its
--     audit, and the demo store, so no new store can choose the theme and the
--     themes page no longer lists it;
--   * keeps every release a remaining store is pinned to, and deletes the
--     theme's other releases (all of them when no store uses it, as before);
--   * still refuses, and deletes nothing, when a store uses the theme WITHOUT
--     a pinned release (only a legacy `template` setting, or no valid
--     presetVersion): such a store renders the catalogue's current release
--     and would lose its theme. No store installed through StoreMink's
--     install paths is in that state;
--   * never writes to a store that keeps the theme.
-- The answer gains `storesKept`: how many stores keep the theme.
--
-- The install guard (0161) refused a store moving to a deleted theme only
-- while none of the theme's releases remained. Releases can remain now, so it
-- refuses whenever the theme id is in the deletion receipt. A store already on
-- the theme is untouched, as before: the guard looks only at a new store or a
-- store whose theme id changes. A Theme Studio project never takes a bundled
-- theme's id or one that has releases (createThemeStudioProject), so the
-- receipt never names a theme another release line still offers.
--
-- Backward compatible: the revision running before this deploys calls the
-- function with the same arguments and reads only `ok`, `error` and
-- `themeId`. Operator-only: no Help Centre edit.

CREATE OR REPLACE FUNCTION public.theme_studio_delete_project(
  p_project uuid, p_revision integer, p_confirmation text, p_actor uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET lock_timeout = '5s' AS $$
DECLARE project public.theme_studio_projects%ROWTYPE; actor_email text;
  has_releases boolean; demo_id uuid; stores_kept integer := 0;
BEGIN
  SELECT email INTO actor_email FROM public.platform_admins
    WHERE id=p_actor AND role='superadmin';
  IF actor_email IS NULL THEN RAISE EXCEPTION 'Only a platform superadmin can delete themes.'; END IF;
  SELECT * INTO project FROM public.theme_studio_projects WHERE id=p_project FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.theme_studio_deletion_audit
        WHERE project_id=p_project AND theme_id=p_confirmation) THEN
      SELECT count(*)::integer INTO stores_kept FROM public.stores s
        WHERE s.settings#>>'{theme,presetId}'=p_confirmation;
      RETURN jsonb_build_object('ok',true,'themeId',p_confirmation,'storesKept',stores_kept);
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
  -- creation. The store trigger below also refuses delayed cached installs.
  LOCK TABLE public.stores IN SHARE ROW EXCLUSIVE MODE;
  SELECT id INTO demo_id FROM public.stores
    WHERE slug='demo-' || project.theme_id AND settings->>'demo'='true'
      AND coalesce(settings#>>'{theme,presetId}',settings->>'template')=project.theme_id;
  IF has_releases THEN
    -- The stores that keep the theme: every store on it except its demo store
    -- and this project's private previews, which are deleted below.
    -- ★ A store with no pinned release renders the catalogue's current
    --   release, which this deletion removes: refuse rather than change it.
    --   Pinned means what readThemeSelection and resolveRuntimeDefinition
    --   accept: settings.theme.presetId is the theme and presetVersion is a
    --   major.minor.patch string.
    IF EXISTS (SELECT 1 FROM public.stores s
        WHERE coalesce(s.settings#>>'{theme,presetId}',s.settings->>'template')=project.theme_id
          AND s.id IS DISTINCT FROM demo_id
          AND NOT EXISTS (SELECT 1 FROM public.theme_studio_previews v
            WHERE v.project_id=p_project AND v.store_id=s.id
              AND s.settings->>'demo'='true' AND s.settings ? 'studioPreview')
          AND NOT (s.settings#>>'{theme,presetId}' IS NOT DISTINCT FROM project.theme_id
            AND jsonb_typeof(s.settings#>'{theme,presetVersion}')='string'
            AND s.settings#>>'{theme,presetVersion}' ~ '^[0-9]+\.[0-9]+\.[0-9]+$')) THEN
      RETURN jsonb_build_object('ok',false,'error','A store uses this theme without a fixed release, so deleting it would change how that store looks. Nothing was deleted.');
    END IF;
    SELECT count(*)::integer INTO stores_kept FROM public.stores s
      WHERE s.settings#>>'{theme,presetId}'=project.theme_id
        AND s.id IS DISTINCT FROM demo_id
        AND NOT EXISTS (SELECT 1 FROM public.theme_studio_previews v
          WHERE v.project_id=p_project AND v.store_id=s.id
            AND s.settings->>'demo'='true' AND s.settings ? 'studioPreview');
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
    -- ★ Keep each release a remaining store is pinned to: it is what that
    --   store renders. The demo store and the previews are gone by now, so
    --   they keep nothing.
    DELETE FROM public.theme_releases r WHERE r.theme_id=project.theme_id
      AND NOT EXISTS (SELECT 1 FROM public.stores s
        WHERE s.settings#>>'{theme,presetId}'=project.theme_id
          AND s.settings#>>'{theme,presetVersion}'=r.version);
  END IF;
  PERFORM set_config('app.theme_delete_project','',true);
  PERFORM set_config('app.theme_delete_theme','',true);
  RETURN jsonb_build_object('ok',true,'themeId',project.theme_id,'storesKept',stores_kept);
END;
$$;

-- A request may have resolved a cached catalogue before deletion took the
-- store lock. Never let it install a deleted theme on a new store, or move a
-- store to one, whether or not some of the theme's releases remain.
CREATE OR REPLACE FUNCTION public.theme_studio_deleted_install_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE target_theme_id text;
BEGIN
  target_theme_id := coalesce(NEW.settings#>>'{theme,presetId}',NEW.settings->>'template');
  IF (TG_OP='INSERT' OR target_theme_id IS DISTINCT FROM coalesce(OLD.settings#>>'{theme,presetId}',OLD.settings->>'template'))
      AND EXISTS (SELECT 1 FROM public.theme_studio_deletion_audit a WHERE a.theme_id=target_theme_id) THEN
    RAISE EXCEPTION 'This theme was permanently deleted. Choose another theme.';
  END IF;
  RETURN NEW;
END;
$$;
