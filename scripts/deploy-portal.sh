#!/usr/bin/env bash
# Deploy the client portal, rebuilding its help artifacts first.
#
#   ./scripts/deploy-portal.sh
#
# WHY THIS EXISTS: the portal's knowledge base is generated from the help/ pages, and deploying was
# a bare `wrangler pages deploy portal`. Twice the knowledge base shipped a generation behind, once
# serving 186 articles against the site's 172, including 14 that had been merged away months
# earlier. The assistant answered clients from articles that no longer existed. Rebuilding here
# means a deploy cannot ship stale help content, because it is not a separate step anyone can skip.
set -e
cd "$(dirname "$0")/.."

echo "Rebuilding the portal's help artifacts..."
node scripts/build-help-kb.js

# The service worker serves the precached files cache-first, so a changed file behind an unchanged
# cache name is served from the old cache forever. That is not hypothetical: help-index.js shipped
# correct and the portal kept showing the previous day's help text. Stamping the cache name with a
# hash of what is in it means a deploy cannot leave a stale copy behind, for the same reason this
# script rebuilds the knowledge base rather than trusting anyone to remember.
STAMP=$(cat portal/index.html portal/help-index.js portal/status.js portal/updates.js 2>/dev/null | shasum | cut -c1-10)
if [ -n "$STAMP" ]; then
  STAMP="$STAMP" perl -pi -e 's/^const CACHE = .*;/const CACHE = "wz-static-$ENV{STAMP}";/' portal/sw.js
  echo "Service worker cache stamped: wz-static-$STAMP"
else
  echo "WARNING: could not stamp the service worker cache; clients may keep an old copy." >&2
fi

echo
echo "Deploying..."
npx --yes wrangler@4.120.0 pages deploy portal --project-name=portal --commit-dirty=true
