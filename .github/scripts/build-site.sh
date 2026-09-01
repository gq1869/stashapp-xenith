#!/usr/bin/env bash
# Builds a Stash plugin source repository for Xenith.
# Outputs to $1 (default _site/stable) with:
#   index.yml
#   xenith.zip   <- flat: xenith.yml sits at the zip root, so Stash's
#                   installer extracts it straight into plugins/xenith/
#
# $2 selects the release channel ("stable" or "canary", default "stable").
# The channel only ever changes the manifest's/staged yml's `name`,
# `version`, and `description` - `id` stays "xenith" for both. That's
# deliberate: Stash installs a package by id into plugins/<id>/, so a shared
# id is what keeps the two channels from ever being installed side by side.
# Don't "fix" this into two ids - that would let both load into Stash at
# once (duplicate nav buttons, doubled badge/tooltip injection).
#
# One catch: Stash's own Available Plugins UI hides a source's package row
# entirely once ANY source has that package id installed (it filters by id
# across all sources, not per-source - see PluginPackageManager.tsx's
# `loadSource`/`installedPackageIds` in stashapp/stash). So switching
# channels isn't a one-click "install the other one and it replaces this" -
# the user has to uninstall the current build first, then the other
# channel's row reappears to install. The description text below exists to
# surface that in Stash's own UI, since it's not discoverable otherwise.
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
  description="CANARY (latest main, unreleased). $description"
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
  sed -i.bak "s/^description:.*/description: \"$description\"/" "$stage/xenith.yml"
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
