#!/usr/bin/env bash
# Start/stop/status the local dev Postgres cluster.
#
#   macOS:   Homebrew postgresql@17, cluster in /opt/homebrew/var/postgresql@17.
#   Windows: the PostgreSQL 17 portable binaries unpacked to %USERPROFILE%\pgsql,
#            cluster in %USERPROFILE%\pgsql-data. Runs from Git Bash (npm's
#            script-shell). `init` creates that cluster once.
#
# Override any path with PG_HOME (binaries), PG_DATA (cluster) or PG_LOG.
#
# Runs on port 5544, NOT 5432: the first Mac this was set up on already had EDB
# PostgreSQL 15/16/17 servers on 5432-5434 as the system `postgres` user. A
# dedicated port means the dev database can never collide with those or need
# their password.
#
# LC_ALL is load-bearing on macOS: without a valid locale the postmaster dies
# with "postmaster became multithreaded during startup".
set -euo pipefail
export LC_ALL=${LC_ALL:-en_US.UTF-8} LANG=${LANG:-en_US.UTF-8}
PORT=5544

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    PG_HOME=${PG_HOME:-$HOME/pgsql}
    DATA=${PG_DATA:-$HOME/pgsql-data}
    LOG=${PG_LOG:-$HOME/pgsql-log/postgres.log}
    PATH="$PG_HOME/bin:$PATH"
    # `init` below names the superuser `postgres`; the Windows user name is not
    # a role in this cluster.
    export PGUSER=${PGUSER:-postgres}
    ;;
  *)
    DATA=${PG_DATA:-/opt/homebrew/var/postgresql@17}
    LOG=${PG_LOG:-/opt/homebrew/var/log/postgresql@17.log}
    ;;
esac

case "${1:-status}" in
  init)
    if [ -f "$DATA/PG_VERSION" ]; then
      echo "cluster already exists at $DATA"
      exit 0
    fi
    # trust auth: the cluster listens on 127.0.0.1 only. ICU en-US matches the
    # en_US.UTF8 sort order of the Cloud SQL instance the dump comes from.
    initdb -D "$DATA" -U postgres -A trust -E UTF8 \
      --locale-provider=icu --icu-locale=en-US --locale=en-US
    printf "\nport = %s\nlisten_addresses = '127.0.0.1'\n" "$PORT" >>"$DATA/postgresql.conf"
    echo "created $DATA on port $PORT. Next: npm run db:local:start"
    ;;
  start)
    pg_ctl -D "$DATA" -l "$LOG" status >/dev/null 2>&1 && { echo "already running"; exit 0; }
    mkdir -p "$(dirname "$LOG")"
    pg_ctl -D "$DATA" -l "$LOG" start
    sleep 3
    psql -w -h 127.0.0.1 -p "$PORT" -d postgres -tAc 'select version()' | head -1
    ;;
  stop)   pg_ctl -D "$DATA" stop ;;
  status)
    pg_ctl -D "$DATA" status || true
    psql -w -h 127.0.0.1 -p "$PORT" -d storemink_local -tAc \
      "select 'storemink_local: '||(select count(*) from information_schema.tables where table_schema='public')||' public tables'" 2>/dev/null \
      || echo "storemink_local not reachable (run: npm run db:local:sync)"
    ;;
  psql)   shift; exec psql -w -h 127.0.0.1 -p "$PORT" -d storemink_local "$@" ;;
  *) echo "usage: $0 {init|start|stop|status|psql}"; exit 1 ;;
esac
