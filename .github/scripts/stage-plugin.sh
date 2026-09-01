#!/usr/bin/env bash
# Copies Xenith's plugin payload into $1. Single source of truth for what
# ships, shared by build-site.sh (installer zip) and release.yml (release
# asset zip) so the file list can't drift between the two.
#
# This does not zip - callers zip from the staged directory themselves,
# because the two consumers need different layouts:
#   - build-site.sh zips flat (xenith.yml at the zip root), since Stash's
#     installer extracts straight into plugins/xenith/.
#   - release.yml zips nested (a top-level xenith/ dir), since a human
#     unzips the release asset into their own plugins/ directory.

set -euo pipefail

cd "$(dirname "$0")/../.."

outdir="${1:?usage: stage-plugin.sh <outdir>}"

mkdir -p "$outdir"
cp -r dist backend xenith.yml requirements.txt README.md LICENSE "$outdir/"
find "$outdir" -depth -name '__pycache__' -type d -exec rm -rf {} +
