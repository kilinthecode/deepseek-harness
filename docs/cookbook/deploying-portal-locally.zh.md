# Cookbook：部署本地 Portal 界面

[English](deploying-portal-locally.md) | 中文

## 概述

更新本机已安装的 Portal 界面，保留完整的应用备份，并重新打开同一工作区。此流程将兼容的样式和 Portal 图案转入现有本地运行时。运行时升级使用单独的[桌面打包流程](../../apps/desktop/README.zh.md)。

## 目录

- [1. 选择目标](#select-destination)
- [2. 构建并暂存界面](#stage-interface)
- [3. 安装并重新打开 Portal](#install-interface)
- [4. 恢复之前的应用](#restore-application)
- [发布环境](#release-targets)

<a id="select-destination"></a>
## 1. 选择目标

本地安装使用以下标识。暂存脚本在修改候选副本之前检查这些标识。

| 设置 | 本地 Portal |
|---|---|
| 应用 | `/Applications/Portal.app` |
| Bundle ID | `local.deepseek.harness` |
| 架构 | `arm64` |
| 版本类型和客户端构建配置 | `portal` |
| Harness 数据 | `~/.dsh`，除非 `DSH_HOME` 覆盖此路径 |
| 签名 | Ad hoc |
| 更新源 | 无 |

从仓库根目录读取已安装应用的标识：

```sh
plutil -extract CFBundleIdentifier raw /Applications/Portal.app/Contents/Info.plist
plutil -extract CFBundleShortVersionString raw /Applications/Portal.app/Contents/Info.plist
```

每次更新使用新的暂存目录。在接受更新之前保留该目录；它保存报告和回滚应用。

将 `/Applications/Portal.app` 作为统一的启动目标。工作树 `.desktop-build` 目录下的历史软件包属于构建产物；整合本地副本时，应将其归档并取消注册。`.artifacts/portal-app-archives` 下的可恢复归档保留原始版本，并在 `recovery-manifest.json` 中记录原始路径和归档摘要。将 `Portal.app.saved` 目录恢复到记录的 `Portal.app` 路径后，它会重新成为可启动的应用。

从选定的同一源代码修订和仓库基础版本构建 Web、Portal 和 Portal Dev。桌面构建后缀用于标识打包构建，可能与基础版本不同。Portal Dev 保留独立的应用标识、数据目录和更新通道。运行时升级需要完整的软件包；更改显示版本不会升级其内容。

<a id="stage-interface"></a>
## 2. 构建并暂存界面

安装依赖后，从仓库根目录运行[暂存脚本](../../apps/desktop/scripts/refresh-local-portal.mjs)：

```sh
node --import tsx/esm apps/desktop/scripts/refresh-local-portal.mjs \
  --build \
  --application /Applications/Portal.app \
  --output /private/tmp/portal-ui-candidate
```

`--build` 创建 `portal` 客户端产物并记录其配置。仅在已从预期源代码构建这些产物时省略此参数。脚本暂存完整的 `Portal.app`，将兼容的 CSS 类映射到已安装的渲染器，更新主界面的 Portal 标记和图标，记录发生变化的运行时文件哈希及 Electron 归档完整性，并保留已安装应用的开场动画和签名权限。缺少 CSS 导出、不支持的图案、版本不匹配或签名失败都会停止暂存。

若要从保留的应用副本恢复开场颜色，请在暂存新的候选副本时添加 `--opening-from /absolute/path/to/previous/Portal.app`。源副本必须具有相同的应用标识和版本；如果开场样式除标记前景和背景外还有其他差异，脚本会拒绝恢复。

检查 `report.json` 和候选副本的签名：

暂存要求干净且已提交的检出目录，以及为当前修订记录的客户端产物。报告分别记录界面源提交、依赖锁文件 SHA-256、Node 版本、包管理器固定版本、客户端配置，以及已安装运行时的提交。请将报告与候选和原应用一起保留；更新界面资源不会改变运行时源身份。重新构建前，应恢复报告中的 Git 修订并使用冻结的依赖锁文件。

```sh
cat /private/tmp/portal-ui-candidate/report.json
codesign --verify --deep --strict /private/tmp/portal-ui-candidate/Portal.app
```

暂存时，正在运行的安装仍然可用。安装脚本在替换之前再次检查原始归档摘要，因此并发应用更新需要新的候选副本。

<a id="install-interface"></a>
## 3. 安装并重新打开 Portal

完成活动任务并保存草稿，然后通过应用菜单退出 Portal。退出对话框会指出重启将中断的任务或提醒。[安装脚本](../../apps/desktop/scripts/install-local-portal.mjs)在 Portal 进程仍在运行时拒绝替换。

```sh
node apps/desktop/scripts/install-local-portal.mjs \
  --stage /private/tmp/portal-ui-candidate
```

安装脚本验证候选副本，将原应用保留在暂存目录下的 `previous/Portal.app`，并通过文件系统重命名替换应用。暂存目录和应用必须位于同一文件系统。安装可能需要主机权限才能写入 `/Applications`。

通过 Finder 或应用启动器明确打开 `/Applications/Portal.app`。检查紧凑侧栏、选中的会话行、会话标签、输入区，以及随主题变化的超立方体。桌面图标采用白色背景和黑色超立方体；开场动画保留已安装的外观。此流程只更改展示资源，因此应用保留已安装版本和现有数据。本地操作人员负责此视觉验收检查。

<a id="restore-application"></a>
## 4. 恢复之前的应用

退出 Portal，然后恢复保留的应用：

```sh
node apps/desktop/scripts/install-local-portal.mjs \
  --stage /private/tmp/portal-ui-candidate \
  --rollback
```

重新打开 `/Applications/Portal.app`。回滚也会检查已安装归档摘要，并将被替换的候选副本保留在 `replaced/Portal.app`。后续应用更新会导致摘要检查失败；保留两个副本，并在替换之前检查该更新。

<a id="release-targets"></a>
## 发布环境

发布版本使用[由文件管理的桌面设置](../../apps/desktop/README.zh.md)和 [Portal 通道流程](../../FORK.md#dev-channel--promoting-a-change-through-portal-dev)。版本类型和发布环境选择不同的内容：

| 选择项 | 效果 |
|---|---|
| `DSH_DESKTOP_EDITION=portal` | Portal 标识、`portal` 客户端、`~/.dsh`、`nightly` 通道 |
| `DSH_DESKTOP_EDITION=portal-dev` | Portal Dev 标识、`portal-dev` 客户端、`~/.dsh-dev`、`dev` 通道 |
| `DSH_DESKTOP_AUTO_UPDATE_ENV=test` | 配置的 HTTPS 来源、发布批次 ID 和测试 COS bucket |
| `DSH_DESKTOP_AUTO_UPDATE_ENV=production` | 固定的上游 `https://download.deepseek.com` 来源和生产 COS bucket |

打包和上传从 Git 忽略的 `apps/desktop/.env.macos` 或 `.env.windows` 加载发布设置；shell 中的值不能替换这些设置。示例应用 ID 与本地 Portal ID 不同。macOS 打包需要签名、公证和策略配置；仅设置 `DSH_ADHOC_SIGN=1` 无法提供这些配置。Portal 发布操作人员必须在发布之前验证 Portal 自有更新源和凭据。上传产物不会为此本地安装配置更新源。

Git 发布独立于应用安装保存源代码。推送源代码之前，检查分支跟踪配置和远程 URL；此 checkout 的 `fork` 远程保存 Portal fork 分支，`portal` 保存单独的 Portal 仓库，`origin` 保存上游。
