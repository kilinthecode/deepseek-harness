# Local Portal build

English | [中文](README.zh.md)

These scripts build an ad-hoc signed `Portal.app` for the macOS host that runs them, without Apple signing or notarization credentials. The sequence is the one [package-target.ts](../package-target.ts) runs for a `--dir` build with `--build-version`, with three differences. The client is built under the `portal` profile instead of `build:official`. The dsh family is packed against the Portal client build record, which `release:pack` refuses. electron-builder runs with [electron-builder.config.local.mjs](../../electron-builder.config.local.mjs), which signs the App ad-hoc, skips notarization, embeds no update feed, and writes to `.desktop-build/targets/<target>/local-artifacts`. That configuration also declares both `CFBundleLocalizations` and `NSMicrophoneUsageDescription`, which the release factory's duplicated `mac.extendInfo` key reduces to the second, and its microphone usage description names Portal.

## Version

Confirm the complete version with the user first, as [Release versions](../../README.md#release-versions) requires, and pass it as `DSH_DESKTOP_BUILD_VERSION`. The local configuration refuses to load when the variable is missing or does not extend the product version in the manifests. As with `--build-version`, the App's `CFBundleShortVersionString`, `CFBundleVersion`, and packaged manifest carry the build version, while the bundled dsh runtime, Desktop Host, and client keep the product version. No manifest is rewritten.

## Run

Run from the repository root on a clean tree; the client build record and the packaged manifest record the commit and whether the tree had changes.

```sh
DSH_DESKTOP_BUILD_VERSION=0.1.7-rc.2.20260926.1 apps/desktop/scripts/portal-local/run.sh all
```

`all` runs every step in the order below; named steps run in the order given, and the first failure stops the run.

| Step | What it runs |
|---|---|
| `build` | `DSH_BUILD_CLIENT_PROFILE=portal pnpm run build` |
| `pack` | [pack-dsh-portal.ts](pack-dsh-portal.ts), then packs the Desktop Host, the vendor family, and the native system entry package |
| `runtime`, `packages`, `dsh` | `prepare:runtime`, `prepare:packages`, and `prepare:dsh` in `apps/desktop` |
| `builder` | electron-builder with the local configuration, `--mac --<arch> --publish never --dir` |
| `smoke` | [smoke-portal.ts](smoke-portal.ts), the `smoke-packaged-runtime.ts` checks on the local App |
| `inspect` | [inspect-portal-app.ts](inspect-portal-app.ts), which prints and checks the Info.plist, signature, and bundled versions |

Each run exports fresh `mktemp -d` directories as `DSH_HOME` and `DSH_AGENTS_HOME` and removes them on exit, deleting any `.credentials.yaml` inside unread. It sets `DSH_ADHOC_SIGN=1`, `DSH_DESKTOP_APP_ID` (default `local.deepseek.harness`), and `CSC_IDENTITY_AUTO_DISCOVERY=false`, and unsets the signing, notarization, update-feed, and mandatory-update policy variables without reading them. The target follows the host architecture; set `DSH_DESKTOP_TARGET_ARCH=x64` for `mac-x64`.

## Output

The App is `apps/desktop/.desktop-build/targets/<target>/local-artifacts/<mac-arm64 or mac>/Portal.app`. Gatekeeper rejects it because it is not notarized; the build machine launches it because a locally built App carries no quarantine attribute. On launch it registers itself as the `dsh://` handler. Its Desktop Host listens on `127.0.0.1:19387`, so quit any running Portal before launching the build.
