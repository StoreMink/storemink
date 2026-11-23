# Where the local dev Postgres cluster lives and who connects to it. Sourced by
# scripts/db-local-ctl.sh and scripts/db-local-sync.sh, so the two can never
# disagree about the binaries, the data folder, the superuser or the port.
#
#   macOS:   Homebrew postgresql@17, cluster in /opt/homebrew/var/postgresql@17,
#            superuser = your macOS user name.
#   Windows: the EDB portable PostgreSQL 17 binaries in %USERPROFILE%\pgsql,
#            cluster in %USERPROFILE%\pgsql-data, superuser `postgres` (made by
#            `npm run db:local:init`). Runs in Git Bash, which npm must be told to
#            use (docs/local-dev-performance.md, "Setting it up on Windows").
#
# Override any path with PG_HOME (binaries), PG_DATA (cluster) or PG_LOG. On
# Windows they may be written either way (C:\tools\pgsql or /c/tools/pgsql).

# Port 5544, NOT 5432: the first Mac this was set up on already had EDB
# PostgreSQL 15/16/17 servers on 5432-5434 as the system `postgres` user. A
# dedicated port means the dev database can never collide with those or need
# their password.
LOCAL_PG_PORT=5544

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    LOCAL_PG_PLATFORM=windows
    # Git Bash converts PATH on startup but leaves other variables alone, so a
    # Windows-style C:\tools\pgsql must be converted, or PATH splits at the colon.
    PG_HOME=$(cygpath -u "${PG_HOME:-$HOME/pgsql}")
    PG_DATA=$(cygpath -u "${PG_DATA:-$HOME/pgsql-data}")
    PG_LOG=$(cygpath -u "${PG_LOG:-$HOME/pgsql-log/postgres.log}")
    # `init` names the superuser `postgres`; the Windows user name is not a role
    # in this cluster.
    export PGUSER=${PGUSER:-postgres}
    ;;
  *)
    LOCAL_PG_PLATFORM=other
    PG_HOME=${PG_HOME:-/opt/homebrew/opt/postgresql@17}
    PG_DATA=${PG_DATA:-/opt/homebrew/var/postgresql@17}
    PG_LOG=${PG_LOG:-/opt/homebrew/var/log/postgresql@17.log}
    ;;
esac

# Only when the folder exists: a Mac whose PostgreSQL 17 is elsewhere on PATH
# keeps working as before.
if [ -d "$PG_HOME/bin" ]; then
  PATH="$PG_HOME/bin:$PATH"
fi
