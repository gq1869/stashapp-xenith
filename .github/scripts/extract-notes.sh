#!/usr/bin/env bash
# Extracts one version's section from CHANGELOG.md for use as a GitHub
# release body. Pass a git tag (e.g. "v3.0.0") as $1 and an output path
# as $2.
#
# Exits non-zero (with no output written) if the tag's version has no
# matching "## <version>" heading in CHANGELOG.md, so callers can fall
# back to `gh release create --generate-notes`.
set -Eeuo pipefail

cd "$(dirname "$0")/../.."

TAG="${1:?usage: extract-notes.sh <tag> <outfile>}"
OUTFILE="${2:?usage: extract-notes.sh <tag> <outfile>}"
VERSION="${TAG#v}"

awk -v version="$VERSION" '
  /^## / {
    if (found) exit
    if ($0 == "## " version) { found = 1; next }
    next
  }
  found { print }
' CHANGELOG.md > "$OUTFILE"

if [ ! -s "$OUTFILE" ]; then
  echo "::notice::no CHANGELOG.md section for version $VERSION" >&2
  rm -f "$OUTFILE"
  exit 1
fi

echo "Wrote $OUTFILE"
