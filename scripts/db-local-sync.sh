#!/usr/bin/env bash
# Rebuild the LOCAL dev database from staging.
#
# Why a dump rather than replaying SQL: drizzle/migrations/manifest.json's
# baseline is a VERIFICATION baseline (it asserts tables/columns exist), not a
# constructive one, so `db:migrate` cannot build a database from scratch, and
# the schema before that baseline was applied by hand outside any ledger.
# A dump is provably the real schema.
#
# Usage:  npm run db:local:sync           # schema + data
#         npm run db:local:sync -- --schema-only
set -euo pipefail

# Binaries, port and the local superuser: shared with db-local-ctl.sh. Every
# STAGING call below passes -U explicitly, so PGUSER only affects the local
# cluster.
# shellcheck source=scripts/db-local-env.sh
. "$(dirname "$0")/db-local-env.sh"
LOCAL_PORT=$LOCAL_PG_PORT
LOCAL_DB=storemink_local
PROXY_PORT=6543
STAGING_DB=storemink_staging
SCHEMA_ONLY=0
[ "${1:-}" = "--schema-only" ] && SCHEMA_ONLY=1

export LC_ALL=${LC_ALL:-en_US.UTF-8}
cd "$(dirname "$0")/.."
say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# ★★ NO PASSWORD IS READ FROM .env, and none is needed. This used to require
# DB_PASSWORD there and export it as PGPASSWORD, which failed the script
# outright once local dev moved that value into .env.local — for a variable
# nothing here ever used:
#
#   * every STAGING call sets PGPASSWORD="$ADMIN_PW" explicitly, from
#     CLOUDSQL_PROD_POSTGRES_PW via Secret Manager (step 2 below);
#   * every LOCAL call is `-w` (never prompt) against :5544, which is a
#     trust-auth cluster (Homebrew, or the Windows one `db:local:init` makes)
#     — it connects with the wrong password and with no password at all.
#
# So the gate could only ever refuse to run; it could not make anything work.

say "1/8 checking Application Default Credentials"
gcloud auth application-default print-access-token >/dev/null 2>&1 \
  || die "ADC expired. Run: gcloud auth application-default login"
echo "ADC ok (used by the Cloud SQL Auth Proxy)"

say "2/8 obtaining the staging admin login"
# The dump MUST run as a superuser, not as `app`. Migration 0018 removed the
# app login's grants on schema_migrations, so an `app` dump dies with
# "permission denied for table schema_migrations" — and skipping the ledger
# would leave `db:migrate:local status` reporting 95 applied migrations as
# pending against a schema that already has them. A superuser also bypasses RLS
# outright, including the FORCE ROW LEVEL SECURITY tables, so no --role is needed
# (as `app` it would be: rolbypassrls=false means zero rows from every
# service-only table, silently).
ADMIN_USER=${DB_ADMIN_USER:-postgres}
ADMIN_PW=${DB_ADMIN_PASSWORD:-}
if [ -z "$ADMIN_PW" ]; then
  # Prefer the ADC token over `gcloud secrets`: the gcloud CLI login is a
  # SEPARATE credential from ADC and is commonly the expired one. ADC carries
  # cloud-platform scope, so the REST endpoint works when the CLI does not.
  TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null || true)
  if [ -n "$TOKEN" ]; then
    ADMIN_PW=$(curl -s -H "Authorization: Bearer $TOKEN" \
      "https://secretmanager.googleapis.com/v1/projects/storemink-prod/secrets/CLOUDSQL_PROD_POSTGRES_PW/versions/latest:access" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(Buffer.from(JSON.parse(d).payload.data,'base64').toString())}catch(e){}})" \
      || true)
  fi
fi
if [ -z "$ADMIN_PW" ]; then
  ADMIN_PW=$(gcloud secrets versions access latest \
    --secret=CLOUDSQL_PROD_POSTGRES_PW --project=storemink-prod 2>/dev/null || true)
fi
[ -n "$ADMIN_PW" ] || die "could not read CLOUDSQL_PROD_POSTGRES_PW.
  Try:  gcloud auth application-default login
  or:   export DB_ADMIN_PASSWORD=... (if you already have the password)"
echo "admin credentials ok ($ADMIN_USER)"

say "3/8 checking the Cloud SQL Auth Proxy on :$PROXY_PORT"
if ! PGPASSWORD="$ADMIN_PW" psql -w -h 127.0.0.1 -p "$PROXY_PORT" -U "$ADMIN_USER" \
      -d "$STAGING_DB" -tAc 'select 1' >/dev/null 2>&1; then
  die "proxy not answering as $ADMIN_USER. Restart it (an expired-ADC proxy keeps LISTENING and resets every query): npm run db:proxy"
fi
SRV=$(PGPASSWORD="$ADMIN_PW" psql -w -h 127.0.0.1 -p "$PROXY_PORT" -U "$ADMIN_USER" -d "$STAGING_DB" \
        -tAc "select current_setting('server_version_num')::int/10000")
CLI=$(pg_dump --version | sed -E 's/.* ([0-9]+).*/\1/')
echo "staging server major=$SRV, pg_dump client major=$CLI"
[ "$CLI" -ge "$SRV" ] || die "pg_dump $CLI is older than the server $SRV; install PostgreSQL $SRV (Mac: brew install postgresql@$SRV)"

# ★★ Cloud SQL's `postgres` is NOT a real superuser (rolsuper=false,
# rolbypassrls=false). It owns every public table, and an owner IS exempt from
# ordinary RLS — but NOT from FORCE ROW LEVEL SECURITY, where policies apply to
# the owner too. pg_dump ERRORS on such a table ("query would be affected by
# row-level security policy") rather than silently emptying it, so data cannot be
# lost quietly. We skip their DATA below, which is only lossless while they are
# empty — so prove that here, and refuse loudly if it ever stops being true.
FORCED=$(PGPASSWORD="$ADMIN_PW" psql -w -h 127.0.0.1 -p "$PROXY_PORT" -U "$ADMIN_USER" -d "$STAGING_DB" -tAc \
  "select coalesce(string_agg(relname||' (pages='||relpages||')', ', '), '')
     from pg_class where relforcerowsecurity and relpages > 0;")
if [ -n "$FORCED" ]; then
  die "FORCE RLS table(s) now hold data, which this dump would skip: $FORCED
  Fix: GRANT app_service TO postgres on staging, then add --role=app_service to
  the pg_dump call below (app_service has rolbypassrls=true)."
fi
# Skip data for every FORCE RLS table (all proven empty above). --exclude-table-data
# keeps the table DEFINITION, unlike --exclude-table which would drop it entirely.
FORCE_RLS_TABLES=$(PGPASSWORD="$ADMIN_PW" psql -w -h 127.0.0.1 -p "$PROXY_PORT" -U "$ADMIN_USER" -d "$STAGING_DB" -tAc \
  "select coalesce(string_agg('--exclude-table-data=public.'||relname, ' '), '')
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relforcerowsecurity and n.nspname='public';")
echo "no FORCE RLS table holds data; skipping their data: ${FORCE_RLS_TABLES:-none}"

say "4/8 checking the local cluster on :$LOCAL_PORT"
psql -w -h 127.0.0.1 -p "$LOCAL_PORT" -d postgres -tAc 'select 1' >/dev/null 2>&1 \
  || die "local cluster down. Start it: npm run db:local:start"
echo "local cluster ok"

# Every extension staging uses must be installable here, checked BEFORE the
# local database is dropped. Without it the restore's CREATE EXTENSION fails,
# every column and index of that type fails after it, and the copy is unusable
# (pgvector is the one to watch on Windows: it is built by hand).
STAGING_EXTS=$(PGPASSWORD="$ADMIN_PW" psql -w -h 127.0.0.1 -p "$PROXY_PORT" -U "$ADMIN_USER" -d "$STAGING_DB" -tAc \
  "select coalesce(string_agg(extname, ' ' order by extname), '') from pg_extension where extname <> 'plpgsql';")
MISSING_EXTS=""
for ext in $STAGING_EXTS; do
  psql -w -h 127.0.0.1 -p "$LOCAL_PORT" -d postgres -tAc \
    "select 1 from pg_available_extensions where name = '$ext'" | grep -q 1 \
    || MISSING_EXTS="$MISSING_EXTS $ext"
done
[ -z "$MISSING_EXTS" ] || die "this cluster cannot install:$MISSING_EXTS (staging uses them).
  pgvector on Windows: step 2 of \"Setting it up on Windows\" in docs/local-dev-performance.md
  (build it with PGROOT set to this cluster's folder, $PG_HOME).
  pgvector on a Mac: brew install pgvector
  Your local database was not touched."
echo "extensions available: ${STAGING_EXTS:-none}"

# pg_dump does not dump roles, but the dump's GRANTs and policies name them, so
# a fresh cluster (a new laptop, `db:local:init`) needs them first. Every role
# staging has (apart from Postgres's and Cloud SQL's built-in ones, keeping
# cloudsqlsuperuser) is copied with staging's LOGIN and BYPASSRLS and staging's
# memberships between them, read here rather than written down, so local can
# never drift from what dev and production run. app_service must have BYPASSRLS
# or withService silently returns nothing; app_user's memberships decide which
# `TO authenticated` policies apply under withUser. A membership local has and
# staging does not is revoked. cloudsqlsuperuser matters too: pg_restore runs
# the schema's three GRANTs as ONE command, so a missing cloudsqlsuperuser also
# skipped USAGE for app_user and app_service. All idempotent.
ROLE_DATA=$(PGPASSWORD="$ADMIN_PW" psql -w -h 127.0.0.1 -p "$PROXY_PORT" -U "$ADMIN_USER" -d "$STAGING_DB" \
  -tA -v ON_ERROR_STOP=1 <<'SQL'
with managed as (
  select oid, rolname, rolcanlogin, rolbypassrls from pg_roles
   where (rolname !~ '^(pg_|cloudsql)' or rolname = 'cloudsqlsuperuser')
     and rolname <> 'postgres'
)
select format('INSERT INTO managed VALUES (%L, %L, %L);', rolname, rolcanlogin, rolbypassrls)
  from managed
union all
select format('INSERT INTO wanted VALUES (%L, %L);', g.rolname, m.rolname)
  from pg_auth_members a
  join managed g on g.oid = a.roleid
  join managed m on m.oid = a.member;
SQL
)
for core in app app_user app_service anon authenticated service_role cloudsqlsuperuser; do
  grep -q "INSERT INTO managed VALUES ('$core'," <<<"$ROLE_DATA" \
    || die "staging has no role $core; refusing to guess its rights"
done
psql -w -h 127.0.0.1 -p "$LOCAL_PORT" -d postgres -q -v ON_ERROR_STOP=1 <<SQL
-- Homebrew's initdb makes the macOS user the only superuser; the database is
-- created OWNER postgres and restored as postgres below.
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres SUPERUSER LOGIN;
  END IF;
END \$\$;
CREATE TEMP TABLE managed (name text, login boolean, bypass boolean);
CREATE TEMP TABLE wanted (role text, member text);
$ROLE_DATA
DO \$\$
DECLARE x record;
BEGIN
  FOR x IN SELECT * FROM managed LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = x.name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', x.name);
    END IF;
    EXECUTE format('ALTER ROLE %I %s %s', x.name,
      CASE WHEN x.login THEN 'LOGIN' ELSE 'NOLOGIN' END,
      CASE WHEN x.bypass THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END);
  END LOOP;
  FOR x IN
    SELECT g.rolname AS role, m.rolname AS member, gr.rolname AS grantor
      FROM pg_auth_members a
      JOIN pg_roles g ON g.oid = a.roleid
      JOIN pg_roles m ON m.oid = a.member
      JOIN pg_roles gr ON gr.oid = a.grantor
     WHERE g.rolname IN (SELECT name FROM managed)
       AND m.rolname IN (SELECT name FROM managed)
       AND NOT EXISTS (SELECT 1 FROM wanted w
                        WHERE w.role = g.rolname AND w.member = m.rolname)
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', x.role, x.member, x.grantor);
  END LOOP;
  FOR x IN SELECT * FROM wanted LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members a
                     JOIN pg_roles g ON g.oid = a.roleid
                     JOIN pg_roles m ON m.oid = a.member
                    WHERE g.rolname = x.role AND m.rolname = x.member) THEN
      EXECUTE format('GRANT %I TO %I', x.role, x.member);
    END IF;
  END LOOP;
END \$\$;
SQL
echo "roles ok"

say "5/8 dumping staging (as $ADMIN_USER)"
DUMP=$(mktemp -t storemink-staging-XXXX).dump
PGPASSWORD="$ADMIN_PW" pg_dump -h 127.0.0.1 -p "$PROXY_PORT" -U "$ADMIN_USER" -d "$STAGING_DB" \
  --format=custom --compress=6 \
  $([ "$SCHEMA_ONLY" = "1" ] && echo --schema-only) \
  $FORCE_RLS_TABLES \
  -f "$DUMP"
echo "dumped $(du -h "$DUMP" | cut -f1) -> $DUMP"

say "6/8 recreating $LOCAL_DB"
psql -w -h 127.0.0.1 -p "$LOCAL_PORT" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = '$LOCAL_DB' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS $LOCAL_DB;
CREATE DATABASE $LOCAL_DB OWNER postgres;
SQL
echo "recreated"

say "7/8 restoring"
# Not ON_ERROR_STOP: a Cloud SQL dump carries GRANTs to roles that exist only
# there (cloudsqladmin & co, which are deliberately not stubbed). Those lines
# failing is expected and harmless. Every other role is created above, so any
# other error is real (a missing extension type, a failed index) and stops the
# run before .env.local points the app at a broken copy.
pg_restore -h 127.0.0.1 -p "$LOCAL_PORT" -U postgres -d "$LOCAL_DB" \
  --no-owner --role=postgres --jobs=2 "$DUMP" 2>"$DUMP.err" || true
ALL_ERRS=$(grep -c "^pg_restore: error" "$DUMP.err" 2>/dev/null || true)
OTHER_ERRS=$(grep "^pg_restore: error" "$DUMP.err" 2>/dev/null | grep -v 'role "cloudsql' || true)
echo "restore finished; ${ALL_ERRS:-0} error lines (see $DUMP.err)"
if [ -n "$OTHER_ERRS" ]; then
  printf '%s\n' "$OTHER_ERRS" | head -20
  die "the restore failed on more than Cloud SQL's own roles (above; full log $DUMP.err).
  .env.local was not written or changed."
fi

say "8/8 verifying"
psql -w -h 127.0.0.1 -p "$LOCAL_PORT" -d "$LOCAL_DB" -x -tA <<'SQL'
select
  (select count(*) from information_schema.tables where table_schema='public')      as public_tables,
  (select count(*) from pg_extension)                                              as extensions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='auth' and p.proname in ('uid','email'))                       as auth_shim_fns,
  (select count(*) from pg_class where relrowsecurity)                             as rls_tables,
  (select count(*) from pg_policies)                                               as policies;
SQL
echo "--- auth.uid() reads the GUC? ---"
psql -w -h 127.0.0.1 -p "$LOCAL_PORT" -d "$LOCAL_DB" -tAc \
  "begin; select set_config('app.current_user_id','probe-uid',true); select 'auth.uid() = '||coalesce(auth.uid()::text,'NULL'); rollback;" \
  2>&1 | tail -1
echo "--- migration ledger ---"
psql -w -h 127.0.0.1 -p "$LOCAL_PORT" -d "$LOCAL_DB" -tAc \
  "select count(*)||' rows, newest '||max(id) from schema_migrations;" 2>&1 | tail -1
echo "--- shop content ---"
psql -w -h 127.0.0.1 -p "$LOCAL_PORT" -d "$LOCAL_DB" -tAc \
  "select 'stores='||(select count(*) from stores)||'  products='||(select count(*) from products)||'  admins='||(select count(*) from admins)||'  orders='||(select count(*) from orders);" 2>&1 | tail -1

rm -f "$DUMP"

# Flip the app over only now that the database is real. Writing .env.local any
# earlier would point the dev server at an empty database and break every query.
if [ -f .env.local ]; then
  echo ".env.local already present, leaving it alone"
else
  # The local cluster is trust-auth, so the password is never checked. The
  # default exists because DB_PASSWORD is no longer read from .env (see the top
  # of this file), and under `set -u` the bare variable stopped the script here
  # on any machine without it exported.
  LOCAL_PW=${DB_PASSWORD:-local-dev-trust}
  cat > .env.local <<ENVEOF
# Local Postgres override (StoreMink dev). Next.js loads .env.local ABOVE .env,
# so these win while this file exists. Delete or rename it to go back to the
# Mumbai staging database over the Cloud SQL Auth Proxy.
#
# Written by scripts/db-local-sync.sh. See docs/local-dev-performance.md.
DB_HOST=127.0.0.1
DB_PORT=$LOCAL_PORT
DB_NAME=$LOCAL_DB
DB_USER=app
DB_PASSWORD=$LOCAL_PW

# npm run db:migrate needs an admin login; it never falls back to the app login.
DB_ADMIN_USER=postgres
DB_ADMIN_PASSWORD=$LOCAL_PW
ENVEOF
  chmod 600 .env.local
  echo "wrote .env.local (0600) -> app now uses the local database"
fi

printf '\n\033[32mLocal database ready on 127.0.0.1:%s/%s\033[0m\n' "$LOCAL_PORT" "$LOCAL_DB"
echo "Restart the dev server with:  npm run dev     (not dev:all - no proxy needed)"
