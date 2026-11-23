-- Changing a published theme (2026-11-22, owner).
--
-- Until now a Theme Studio project that had published was finished: the only
-- move left to it was `archived`, and it could publish exactly once. A
-- problem found after publishing (a picture, a heading, a section) meant
-- building the whole theme again under a new name.
--
-- A published project may now take a change. The change is built and checked
-- as any other, and publishing it stores the theme's NEXT release (1.1.0
-- after 1.0.0). Releases are immutable and every store pins the exact release
-- it installed, so a store already using the theme keeps the release it has;
-- only the catalogue pointer, which new installs read, moves.
--
-- What changes here:
--   1. The project guard admits the moves a live theme now makes:
--        published  -> generating  a change, or pictures being drawn
--        published  -> ready       a picture replaced, or another design made
--                                  current
--        generating -> published   the change did not finish and the design
--                                  is still the published one
--        ready, candidate, blocked -> published
--                                  the published design made current again
--      The rule that matters is unchanged and still enforced below: a project
--      is `published` only while its CURRENT version has a published
--      publication. Every other check is as 0151 wrote it.
--   2. One published publication per DESIGN, not per project. The index keeps
--      its name (0134's manifest entry names it) and gains `version_id`.
--
-- Backward compatible: the revision running before this deploys never asks
-- for any of the new moves and never publishes a project twice, so it
-- behaves exactly as before against this schema.
CREATE OR REPLACE FUNCTION public.theme_studio_project_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.theme_id <> OLD.theme_id
     OR NEW.created_by_email <> OLD.created_by_email
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'theme studio project identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('generating', 'archived')) OR
    (OLD.status = 'generating' AND NEW.status IN ('ready', 'failed', 'blocked', 'published')) OR
    (OLD.status = 'ready' AND NEW.status IN ('generating', 'candidate', 'blocked', 'archived', 'published')) OR
    (OLD.status = 'candidate' AND NEW.status IN ('generating', 'ready', 'approved', 'blocked', 'archived', 'published')) OR
    (OLD.status = 'approved' AND NEW.status IN ('generating', 'published', 'blocked', 'archived')) OR
    (OLD.status = 'published' AND NEW.status IN ('generating', 'ready', 'archived')) OR
    (OLD.status = 'failed' AND NEW.status IN ('generating', 'archived')) OR
    (OLD.status = 'blocked' AND NEW.status IN ('generating', 'ready', 'archived', 'published'))
  ) THEN
    RAISE EXCEPTION 'illegal theme studio transition % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status IN ('candidate', 'approved')
     AND OLD.status = NEW.status
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    RAISE EXCEPTION 'a theme studio % cannot change its version', NEW.status;
  END IF;
  -- A published project's current version is the published design: it moves
  -- only by leaving `published` (the moves above).
  IF NEW.status = 'published' AND OLD.status = 'published'
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    RAISE EXCEPTION 'a theme studio published project cannot change its version';
  END IF;
  -- Candidate: on every write, as 0131/0134 did. Approved: on entry.
  IF NEW.status = 'candidate'
     OR (NEW.status = 'approved' AND OLD.status <> 'approved') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.theme_studio_acceptance_runs a
      JOIN public.theme_studio_versions v
        ON v.id = a.version_id AND v.project_id = a.project_id
      WHERE a.project_id = NEW.id
        AND a.version_id = NEW.current_version_id
        AND a.status = 'passed'
        AND a.package_digest = v.package_digest
    ) THEN
      RAISE EXCEPTION 'a theme studio % needs passing acceptance evidence', NEW.status;
    END IF;
  END IF;
  -- Whatever state it comes from, a project is published only while the
  -- design it shows is one a publication published.
  IF NEW.status = 'published' AND OLD.status <> 'published' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.theme_studio_publications p
      WHERE p.project_id = NEW.id
        AND p.version_id = NEW.current_version_id
        AND p.status = 'published'
    ) THEN
      RAISE EXCEPTION 'a theme studio project is published only by a publication';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- One success per design. It was one per project: a project published one
-- release line and then stopped. Same name, so nothing that names the index
-- loses it; the table holds a handful of rows, so the rebuild is instant.
DROP INDEX public.theme_studio_publications_one_published;
CREATE UNIQUE INDEX theme_studio_publications_one_published
  ON public.theme_studio_publications (project_id, version_id)
  WHERE status = 'published';
