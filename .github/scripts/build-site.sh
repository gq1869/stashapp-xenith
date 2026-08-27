#!/usr/bin/env bash
# Builds a Stash plugin source repository for Xenith.
# Outputs to $1 (default _site/stable) with:
#   index.yml
#   xenith.zip   <- flat: xenith.yml sits at the zip root, so Stash's
#                   installer extracts it straight into plugins/xenith/
#
# Assumes `npm run build` has already produced dist/xenith.js and
# dist/xenith.css - this script does not build the frontend itself.

set -euo pipefail

cd "$(dirname "$0")/../.."

outdir="${1:-_site/stable}"

if [ ! -f dist/xenith.js ] || [ ! -f dist/xenith.css ]; then
  echo "::error::dist/xenith.js and dist/xenith.css must exist - run 'npm run build' first" >&2
  exit 1
fi

rm -rf "$outdir"
mkdir -p "$outdir"

# Xenith's plugin id is hardcoded in src/stash-log.js and src/plugin-config.js
# - it must match this id, and the zip's contents must land at plugins/xenith/.
plugin_id="xenith"

name=$(grep -m1 '^name:' xenith.yml | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
description=$(grep -m1 '^description:' xenith.yml | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
yml_version=$(grep -m1 '^version:' xenith.yml | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')

commit=$(git log -n 1 --pretty=format:%h -- xenith.yml src dist backend requirements.txt README.md LICENSE)
updated=$(TZ=UTC0 git log -n 1 --date="format-local:%F %T" --pretty=format:%ad -- xenith.yml src dist backend requirements.txt README.md LICENSE)
version="$yml_version-$commit"

# Stage the plugin contents flat (no wrapping xenith/ dir) and zip from
# inside the staging dir, so xenith.yml is at the zip root.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -r dist backend xenith.yml requirements.txt README.md LICENSE "$stage/"

zipfile="$(realpath "$outdir")/$plugin_id.zip"
( cd "$stage" && zip -r "$zipfile" . -x "*__pycache__*" > /dev/null )

if command -v sha256sum > /dev/null; then
  sha256=$(sha256sum "$zipfile" | cut -d' ' -f1)
else
  sha256=$(shasum -a 256 "$zipfile" | cut -d' ' -f1)
fi

cat > "$outdir/index.yml" <<EOF
- id: $plugin_id
  name: $name
  metadata:
    description: $description
  version: $version
  date: $updated
  path: $plugin_id.zip
  sha256: $sha256
EOF

echo "Wrote $outdir/index.yml and $zipfile"
