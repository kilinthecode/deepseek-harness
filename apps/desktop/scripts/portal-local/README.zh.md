# 本地 Portal 构建

[English](README.md) | 中文

这些脚本在运行它们的 macOS 主机上构建临时签名的 `Portal.app`，不需要 Apple 签名或公证凭据。构建顺序与 [package-target.ts](../package-target.ts) 执行带 `--build-version` 的 `--dir` 构建相同，只有三处不同。客户端使用 `portal` 配置构建，而不是 `build:official`。dsh 发布族按 Portal 客户端构建记录打包，`release:pack` 会拒绝这份记录。electron-builder 使用 [electron-builder.config.local.mjs](../../electron-builder.config.local.mjs) 运行：它为 App 做临时签名、跳过公证、不嵌入更新 feed，并输出到 `.desktop-build/targets/<target>/local-artifacts`。该配置还同时声明 `CFBundleLocalizations` 和 `NSMicrophoneUsageDescription`；发布配置工厂重复声明了 `mac.extendInfo` 键，只会保留第二个。它的麦克风用途说明使用 Portal 名称。

## 版本

先与用户确认完整版本号，这是[发布版本](../../README.zh.md#release-versions)的要求，再通过 `DSH_DESKTOP_BUILD_VERSION` 传入。缺少该变量，或它没有按规则扩展 manifest（元数据清单）中的产品版本时，本地配置拒绝加载。与 `--build-version` 相同，App 的 `CFBundleShortVersionString`、`CFBundleVersion` 和打包后的 manifest 使用构建版本，捆绑的 dsh 运行时、Desktop Host 和客户端保持产品版本。任何 manifest 都不会被改写。

## 运行

在仓库根目录、工作树无改动时运行；客户端构建记录和打包后的 manifest 会记录提交以及工作树是否有改动。

```sh
DSH_DESKTOP_BUILD_VERSION=0.1.7-rc.2.20260926.1 apps/desktop/scripts/portal-local/run.sh all
```

`all` 按下表顺序运行全部步骤；指定步骤时按给出的顺序运行，第一个失败即终止。

| 步骤 | 运行内容 |
|---|---|
| `build` | `DSH_BUILD_CLIENT_PROFILE=portal pnpm run build` |
| `pack` | [pack-dsh-portal.ts](pack-dsh-portal.ts)，然后打包 Desktop Host、vendor 发布族和原生 system 入口包 |
| `runtime`、`packages`、`dsh` | 在 `apps/desktop` 中运行 `prepare:runtime`、`prepare:packages` 和 `prepare:dsh` |
| `builder` | 使用本地配置运行 electron-builder，参数为 `--mac --<arch> --publish never --dir` |
| `smoke` | [smoke-portal.ts](smoke-portal.ts)，对本地 App 执行 `smoke-packaged-runtime.ts` 的检查 |
| `inspect` | [inspect-portal-app.ts](inspect-portal-app.ts)，打印并检查 Info.plist、签名和捆绑的版本 |

每次运行都把新的 `mktemp -d` 目录导出为 `DSH_HOME` 和 `DSH_AGENTS_HOME`，退出时删除这两个目录，其中的 `.credentials.yaml` 不经读取直接删除。脚本设置 `DSH_ADHOC_SIGN=1`、`DSH_DESKTOP_APP_ID`（默认 `local.deepseek.harness`）和 `CSC_IDENTITY_AUTO_DISCOVERY=false`，并在不读取的情况下清除签名、公证、更新 feed 和强制更新策略变量。构建目标跟随主机架构；构建 `mac-x64` 时设置 `DSH_DESKTOP_TARGET_ARCH=x64`。

## 输出

App 位于 `apps/desktop/.desktop-build/targets/<target>/local-artifacts/<mac-arm64 或 mac>/Portal.app`。它未经公证，Gatekeeper 会拒绝它；本地构建的 App 没有隔离属性，因此构建机器可以启动它。启动时它将自己注册为 `dsh://` 处理程序。它的 Desktop Host 监听 `127.0.0.1:19387`，因此启动构建前先退出正在运行的 Portal。
