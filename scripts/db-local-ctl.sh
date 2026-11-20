#!/usr/bin/env bash
# Start/stop/status the local dev Postgres cluster.
#
# Paths, port and superuser come from scripts/db-local-env.sh (macOS Homebrew
# postgresql@17, or the Windows portable binaries in %USERPROFILE%\pgsql).
# `init` creates the Windows cluster once; Homebrew creates the Mac one.
#
# LC_ALL is load-bearing on macOS: without a valid locale the postmaster dies
# with "postmaster became multithreaded during startup".
set -euo pipefail
export LC_ALL=${LC_ALL:-en_US.UTF-8} LANG=${LANG:-en_US.UTF-8}
# shellcheck source=scripts/db-local-env.sh
. "$(dirname "$0")/db-local-env.sh"
PORT=$LOCAL_PG_PORT
DATA=$PG_DATA
LOG=$PG_LOG

case "${1:-status}" in
  init)
    if [ "$LOCAL_PG_PLATFORM" != windows ]; then
      echo "init is for Windows. On a Mac, Homebrew creates the cluster:"
      echo "  brew install postgresql@17 pgvector"
      echo "then add 'port = $PORT' to $DATA/postgresql.conf and run: npm run db:local:start"
      exit 1
    fi
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
