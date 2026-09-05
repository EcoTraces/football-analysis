#!/usr/bin/env bash
# Applies every supabase/migrations/*.sql file, in filename order, against
# $DATABASE_URL. Used by CI's db-migrations job (.github/workflows/ci.yml)
# to verify the migration set is valid SQL from a clean database — run
# twice back to back there, to catch a non-idempotent migration the same
# way 0005-0013's missing "if not exists" clauses should have been caught
# before they broke a real deployment (see Changelog.md's "Make migrations
# 0005-0013 safely re-runnable"). Also runnable locally against any
# throwaway Postgres:
#
#   DATABASE_URL=postgres://user:pass@localhost:5432/some_test_db \
#     ./supabase/ci/apply_migrations.sh
#
# Does NOT apply auth_stub.sql itself — run that first (see ci.yml) if
# you're pointing this at a bare Postgres rather than a real Supabase
# project, which already has its own real `auth` schema.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="$script_dir/../migrations"

for file in "$migrations_dir"/*.sql; do
  echo "Applying $(basename "$file")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$file"
done
