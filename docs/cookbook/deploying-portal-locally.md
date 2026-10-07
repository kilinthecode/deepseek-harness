# Cookbook: deploy the local Portal interface

English | [中文](deploying-portal-locally.zh.md)

## Summary

Update the Portal interface installed on this Mac, retain a complete application backup, and reopen the same workspace. This procedure transfers compatible styles and Portal artwork into the existing local runtime. Runtime upgrades use the separate [desktop packaging workflow](../../apps/desktop/README.md).

## Table of Contents

- [1. Select the destination](#select-destination)
- [2. Build and stage the interface](#stage-interface)
- [3. Install and reopen Portal](#install-interface)
- [4. Restore the previous application](#restore-application)
- [Release environments](#release-targets)

<a id="select-destination"></a>
## 1. Select the destination

The local installation uses these identifiers. The staging helper checks them before modifying its candidate copy.

| Setting | Local Portal |
|---|---|
| Application | `/Applications/Portal.app` |
| Bundle ID | `local.deepseek.harness` |
| Architecture | `arm64` |
| Edition and client build profile | `portal` |
| Harness data | `~/.dsh`, unless `DSH_HOME` overrides it |
| Signing | Ad hoc |
| Update feed | Absent |

Read the installed identity from the repository root:

```sh
plutil -extract CFBundleIdentifier raw /Applications/Portal.app/Contents/Info.plist
plutil -extract CFBundleShortVersionString raw /Applications/Portal.app/Contents/Info.plist
```

Use a fresh staging directory for each update. Preserve that directory until the update is accepted; it holds the report and rollback application.

Use `/Applications/Portal.app` as the canonical launch target. Historical packages under worktree `.desktop-build` directories are build outputs; archive and unregister them when consolidating local copies. Recoverable archives under `.artifacts/portal-app-archives` retain their original versions and record their original paths and archive digests in `recovery-manifest.json`. A `Portal.app.saved` directory becomes an application again when restored to its recorded `Portal.app` path.

Build Web, Portal, and Portal Dev from the same chosen source revision and repository base version. Desktop build suffixes identify packaged builds and may differ from the base version. Portal Dev keeps its separate application identity, data directory, and update channel. A runtime upgrade requires a complete package; changing a displayed version does not upgrade its contents.

<a id="stage-interface"></a>
## 2. Build and stage the interface

Run the [staging helper](../../apps/desktop/scripts/refresh-local-portal.mjs) from the repository root with dependencies installed:

```sh
node --import tsx/esm apps/desktop/scripts/refresh-local-portal.mjs \
  --build \
  --application /Applications/Portal.app \
  --output /private/tmp/portal-ui-candidate
```

`--build` creates the `portal` client artifacts and records their profile. Omit it only when those artifacts are already built from the intended source. The helper stages a complete `Portal.app`, remaps compatible CSS classes to the installed renderer, updates the main Portal mark and icon, records changed runtime file hashes and Electron archive integrity, and preserves the installed opening animation and signing permissions. A missing CSS export, unsupported artwork, release mismatch, or signature failure stops staging.

To restore opening colors from a retained application, add `--opening-from /absolute/path/to/previous/Portal.app` while staging a fresh candidate. The source must have the same application identity and release; the helper rejects opening styles that differ beyond the logo foreground and background.

Staging requires a clean committed checkout and client artifacts recorded for its current revision. The report records that source commit, the dependency-lock SHA-256, Node version, package-manager pin, and client profile separately from the installed runtime commit. Preserve the report with its candidate and original application; refreshed assets do not change the runtime source identity. Recreate the source from the recorded Git revision and use the frozen dependency lock before rebuilding.

Inspect `report.json` and the candidate signature:

```sh
cat /private/tmp/portal-ui-candidate/report.json
codesign --verify --deep --strict /private/tmp/portal-ui-candidate/Portal.app
```

Staging leaves the running installation available. The installer checks the original archive digest again before replacement, so a concurrent application update requires a new candidate.

<a id="install-interface"></a>
## 3. Install and reopen Portal

Finish active tasks and save drafts, then quit Portal through its application menu. Its quit dialog identifies tasks or reminders that a restart would interrupt. The [installer](../../apps/desktop/scripts/install-local-portal.mjs) refuses replacement while Portal processes are running.

```sh
node apps/desktop/scripts/install-local-portal.mjs \
  --stage /private/tmp/portal-ui-candidate
```

The installer verifies the candidate, retains the original at `previous/Portal.app` under the staging directory, and replaces the application through filesystem renames. The staging directory and application must be on the same filesystem. Installation may require host permission to write `/Applications`.

Open `/Applications/Portal.app` explicitly through Finder or the application launcher. Check the compact sidebar, selected session rows, conversation tabs, composer, and theme-adaptive tesseract. The desktop icon has a white background and black tesseract; the opening animation keeps its installed appearance. The application retains its installed version and existing data because this procedure changes presentation assets. The local operator owns this visual acceptance check.

<a id="restore-application"></a>
## 4. Restore the previous application

Quit Portal, then restore the retained application:

```sh
node apps/desktop/scripts/install-local-portal.mjs \
  --stage /private/tmp/portal-ui-candidate \
  --rollback
```

Reopen `/Applications/Portal.app`. Rollback also checks the installed archive digest and retains the displaced candidate at `replaced/Portal.app`. A later application update causes the digest check to fail; retain both copies and inspect that update before replacing it.

<a id="release-targets"></a>
## Release environments

Published releases use [file-owned desktop settings](../../apps/desktop/README.md) and the [Portal channel procedure](../../FORK.md#dev-channel--promoting-a-change-through-portal-dev). Edition and publication environment select different things:

| Selector | Effect |
|---|---|
| `DSH_DESKTOP_EDITION=portal` | Portal identity, `portal` client, `~/.dsh`, `nightly` channel |
| `DSH_DESKTOP_EDITION=portal-dev` | Portal Dev identity, `portal-dev` client, `~/.dsh-dev`, `dev` channel |
| `DSH_DESKTOP_AUTO_UPDATE_ENV=test` | Configured HTTPS origin, release batch ID, and test COS bucket |
| `DSH_DESKTOP_AUTO_UPDATE_ENV=production` | Fixed upstream `https://download.deepseek.com` origin and production COS bucket |

Packaging and upload load release settings from ignored `apps/desktop/.env.macos` or `.env.windows`; shell values cannot replace those settings. The example application ID differs from the local Portal ID. macOS packaging requires signing, notarization, and policy configuration; `DSH_ADHOC_SIGN=1` alone does not supply them. A Portal release operator must qualify a Portal-owned feed and credentials before publication. Uploading an artifact does not configure an update feed in this local installation.

Git publication stores source independently of app installation. Inspect the branch tracking and remote URLs before a source push; this checkout's `fork` remote carries the Portal fork branch, `portal` carries the separate Portal repository, and `origin` carries upstream.
