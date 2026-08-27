#!/usr/bin/env bash
# Fails if package.json's version and xenith.yml's version disagree.
# Pass a git tag (e.g. "v2.0.0") as $1 to also check it against both.
set -euo pipefail

cd "$(dirname "$0")/../.."

PKG_VERSION="$(node -p "require('./package.json').version")"
YML_VERSION="$(grep -m1 '^version:' xenith.yml | sed 's/^version:[[:space:]]*//')"

echo "package.json version: $PKG_VERSION"
echo "xenith.yml version:   $YML_VERSION"

status=0

if [ "$PKG_VERSION" != "$YML_VERSION" ]; then
  echo "::error::package.json version ($PKG_VERSION) and xenith.yml version ($YML_VERSION) disagree"
  status=1
fi

if [ "${1:-}" != "" ]; then
  TAG="$1"
  TAG_VERSION="${TAG#v}"
  echo "tag version:           $TAG_VERSION"
  if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
    echo "::error::tag ($TAG) does not match package.json version ($PKG_VERSION)"
    status=1
  fi
fi

exit $status
