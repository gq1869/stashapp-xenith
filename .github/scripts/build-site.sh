#!/usr/bin/env bash
# Builds a Stash plugin source repository for Xenith.
# Outputs to $1 (default _site/stable) with:
#   index.yml
#   xenith.zip   <- flat: xenith.yml sits at the zip root, so Stash's
#                   installer extracts it straight into plugins/xenith/
#
# $2 selects the release channel ("stable" or "canary", default "stable").
# The channel only ever changes the manifest's/staged yml's `name` and
# `version` - `id` stays "xenith" for both. That's deliberate: Stash installs
# a package by id into plugins/<id>/, so a shared id is what makes the two
# channels mutually exclusive on disk (installing one replaces the other).
# Don't "fix" this into two ids - that would let both channels be installed
# side by side.
#
# Assumes `npm run build` (or `npm run build:canary`) has already produced
# dist/xenith.js and dist/xenith.css - this script does not build the
# frontend itself.

set -euo pipefail

cd "$(dirname "$0")/../.."

outdir="${1:-_site/stable}"
channel="${2:-stable}"

case "$channel" in
  stable | canary) ;;
  *)
    echo "::error::unknown channel '$channel' - expected 'stable' or 'canary'" >&2
    exit 1
    ;;
esac

if [ ! -f dist/xenith.js ] || [ ! -f dist/xenith.css ]; then
  echo "::error::dist/xenith.js and dist/xenith.css must exist - run 'npm run build' first" >&2
  exit 1
fi

rm -rf "$outdir"
mkdir -p "$outdir"

plugin_id="xenith"

name=$(grep -m1 '^name:' xenith.yml | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
description=$(grep -m1 '^description:' xenith.yml | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
yml_version=$(grep -m1 '^version:' xenith.yml | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')

commit=$(git log -n 1 --pretty=format:%h -- xenith.yml src dist backend requirements.txt README.md LICENSE)
updated=$(TZ=UTC0 git log -n 1 --date="format-local:%F %T" --pretty=format:%ad -- xenith.yml src dist backend requirements.txt README.md LICENSE)

if [ "$channel" = "canary" ]; then
  name="$name (Canary)"
  version="$yml_version-canary.$commit"
else
  version="$yml_version-$commit"
fi

# Stage the plugin contents flat (no wrapping xenith/ dir) and zip from
# inside the staging dir, so xenith.yml is at the zip root.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
bash .github/scripts/stage-plugin.sh "$stage"

# The Settings -> Plugins page in Stash renders its version text from the
# *installed* xenith.yml, not from index.yml - so the channel label has to
# land in the staged copy too, not just the manifest below.
if [ "$channel" = "canary" ]; then
  sed -i.bak "s/^name:.*/name: \"$name\"/" "$stage/xenith.yml"
  sed -i.bak "s/^version:.*/version: $version/" "$stage/xenith.yml"
  rm -f "$stage/xenith.yml.bak"
fi

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
