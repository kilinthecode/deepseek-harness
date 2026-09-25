#!/bin/bash
# Build an ad-hoc signed Portal.app on this macOS host without release credentials (README.md).
# Usage: DSH_DESKTOP_BUILD_VERSION=<confirmed version> apps/desktop/scripts/portal-local/run.sh <step>...
# Steps, in sequence order: build pack runtime packages dsh builder smoke inspect; `all` runs every step.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"

: "${DSH_DESKTOP_BUILD_VERSION:?set DSH_DESKTOP_BUILD_VERSION to the confirmed Desktop version}"
[ "$(uname -s)" = Darwin ] || { echo "portal-local: requires a macOS build host" >&2; exit 2; }
case "${DSH_DESKTOP_TARGET_ARCH:-$(uname -m)}" in
  arm64) ARCH=arm64 ;;
  x64 | x86_64) ARCH=x64 ;;
  *) echo "portal-local: unsupported architecture ${DSH_DESKTOP_TARGET_ARCH:-$(uname -m)}" >&2; exit 2 ;;
esac
TARGET="mac-$ARCH"
TARGET_ROOT="$ROOT/apps/desktop/.desktop-build/targets/$TARGET"

# Every step reads and writes Harness state under fresh scratch homes, never the user's ~/.dsh or ~/.agents.
DSH_HOME="$(mktemp -d /tmp/portal-local-dsh-home.XXXXXX)"
DSH_AGENTS_HOME="$(mktemp -d /tmp/portal-local-agents-home.XXXXXX)"
export DSH_HOME DSH_AGENTS_HOME
cleanup() {
  # A credential file a step may have created is deleted unread before its home is removed.
  find "$DSH_HOME" "$DSH_AGENTS_HOME" -name .credentials.yaml -type f -delete || true
  rm -rf "$DSH_HOME" "$DSH_AGENTS_HOME"
}
trap cleanup EXIT

export DSH_DESKTOP_BUILD_VERSION
export DSH_DESKTOP_TARGET_PLATFORM=darwin
export DSH_DESKTOP_TARGET_ARCH="$ARCH"
export DSH_ADHOC_SIGN=1
export DSH_DESKTOP_APP_ID="${DSH_DESKTOP_APP_ID:-local.deepseek.harness}"
export CSC_IDENTITY_AUTO_DISCOVERY=false
# Signing, notarization, update-feed, and policy settings are removed without being read.
unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID \
  APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE \
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN DSH_DESKTOP_MANDATORY_UPDATE_CONFIG \
  DOWNLOAD_TEST_ORIGIN DOWNLOAD_TEST_RELEASE_ID DSH_DESKTOP_AUTO_UPDATE_ENV
echo "portal-local: $TARGET, build version $DSH_DESKTOP_BUILD_VERSION, DSH_HOME=$DSH_HOME DSH_AGENTS_HOME=$DSH_AGENTS_HOME"

step() { echo "=== $(date +%H:%M:%S) $*"; }

run_build() { step "build (portal client profile)"; DSH_BUILD_CLIENT_PROFILE=portal pnpm run build; }
run_pack() {
  step "pack dsh family (portal client build record)"
  pnpm exec tsx apps/desktop/scripts/portal-local/pack-dsh-portal.ts "$TARGET_ROOT/packed/dsh"
  step "pack Desktop Host"
  pnpm --dir apps/desktop-host pack --pack-destination "$TARGET_ROOT/packed/dsh"
  step "pack vendor family"
  pnpm run release:pack --family vendor --out "$TARGET_ROOT/packed/vendor"
  step "pack native system entry"
  rm -rf "$TARGET_ROOT/packed/landlock"
  mkdir -p "$TARGET_ROOT/packed/landlock"
  pnpm --dir native/system run build:ts
  pnpm --dir native/system/packages/entry pack --pack-destination "$TARGET_ROOT/packed/landlock"
}
run_runtime() { step "prepare:runtime"; pnpm --dir apps/desktop run prepare:runtime; }
run_packages() { step "prepare:packages"; pnpm --dir apps/desktop run prepare:packages; }
run_dsh() { step "prepare:dsh"; pnpm --dir apps/desktop run prepare:dsh; }
run_builder() {
  step "electron-builder (local configuration)"
  rm -rf "$TARGET_ROOT/local-artifacts"
  (cd apps/desktop && pnpm exec electron-builder --config electron-builder.config.local.mjs --mac "--$ARCH" --publish never --dir)
}
run_smoke() { step "packaged runtime smoke"; pnpm --dir apps/desktop exec tsx scripts/portal-local/smoke-portal.ts; }
run_inspect() { step "inspect Portal.app"; pnpm --dir apps/desktop exec tsx scripts/portal-local/inspect-portal-app.ts; }

[ "$#" -gt 0 ] || { echo "portal-local: name at least one step" >&2; exit 2; }
for name in "$@"; do
  case "$name" in
    build) run_build ;;
    pack) run_pack ;;
    runtime) run_runtime ;;
    packages) run_packages ;;
    dsh) run_dsh ;;
    builder) run_builder ;;
    smoke) run_smoke ;;
    inspect) run_inspect ;;
    all) run_build; run_pack; run_runtime; run_packages; run_dsh; run_builder; run_smoke; run_inspect ;;
    *) echo "portal-local: unknown step $name" >&2; exit 2 ;;
  esac
done
step "done"
