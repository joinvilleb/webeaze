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

echo
echo "Deploying..."
npx --yes wrangler@4.120.0 pages deploy portal --project-name=portal --commit-dirty=true
