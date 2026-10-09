# 上游、真实 Butterfly 及原生应用构建

四个仓库已按 `platforms/upstreams.lock.json` 的完整提交固定。主仓库提交 gitlink 和补丁，保留上游历史与许可；首次克隆必须初始化 submodule，再应用补丁。

```powershell
git submodule update --init --recursive
node scripts/upstream-apply.mjs
pnpm install
```

补丁已经应用的本机执行第二条会报告 `patch already applied`。脚本发现版本不符或本地修改冲突会停止并保留本地修改，不执行 reset。`platforms/apply-branding.mjs` 是品牌修改的审计工具；通常只运行补丁入口，不需要再次品牌修改。

## 真实 Butterfly Web

源码要求 Flutter **3.47.5**、Dart **3.13+**。本机在 `.tools/flutter` 隔离安装了固定版本源码，不修改全局 Flutter；其 Dart/引擎下载取决于网络。

```powershell
git clone --depth 1 --branch 3.47.5 https://github.com/flutter/flutter.git .tools/flutter
.\.tools\flutter\bin\flutter.bat --version
node scripts/upstream-build-butterfly.mjs
pnpm build:web
```

已有该目录时不要再次 clone。也可以设置 `$env:FLUTTER` 为已有 3.47.5 `flutter.bat` 的完整路径。脚本将 `app`、`api` 原样复制到 `.tools/butterfly-build`，排除不使用的原生平台目录；MathInk 的原生宿主是思源移动客户端。这样 Web 构建不要求开启 Windows 开发者模式或修复未使用的 Butterfly 原生插件，不修改依赖的固定提交。Pub 缓存也隔离在 `.tools/pub-cache`。

脚本核对版本、分析桥接代码、执行选区隔离测试、编译 release Web，复制到 `apps/web/public/vendor/butterfly` 并写入能力清单，保留 Flutter 的 NOTICES 和上游代码、品牌及字体许可。发布版只接受这份本地构建；没有构建时，主界面明确使用独立实验画布，不能称为完整 Butterfly 集成。

桥接输入为 `{type:"mathink",message:{requestId,method,payload}}`，输出同类型并带 `ok`、`result` 或 `error`。实现 `getSelectedInk`、`renderSelectedInk`、`insertMath`、`getDocument`、`setDocument`、`locateInk`。`mathinkReady` 表示 Flutter 编辑器已初始化。`getSelectedInk` 返回当前页、SHA-256 修订号、笔迹 ID 与选区；修订号只包括该页原始笔迹，插入排版公式不会让来源误报过期。渲染时只将所选 PenElement 传给 Butterfly 渲染器，邻近笔迹和标签不进入图片。公式插入为可编辑 Markdown 数学对象，原笔迹保留，来源写入 `extra.mathink`。`locateInk` 返回原页、定位视口并选中仍存在的源笔迹；删除后的源笔迹会明确报告缺失。

构建使用相对资源地址与 hash 路由，因此可部署到普通本地资源目录，无需服务器 rewrite：`index.html#/embed?save=false&language=zh-Hans&fullScreen=layoutOnly`。Flutter 3.47.5 的 CLI 要求绝对 `--base-href /`；脚本先编译，再将产物 HTML 的 base 改为 `./`，并禁用嵌套编辑器自己的 Service Worker，避免与 MathInk 宿主缓存竞争。MathInk 扩展只接受同源父窗口消息。

中文 UI 与画布文字使用本地 Noto Sans SC 回退字体。构建脚本从固定 Google Fonts 提交下载字体，校验锁文件中的 SHA-256，缓存并加入构建副本；SIL OFL 1.1 许可随源码和产物提供。首次构建需下载约 18 MB，安装后的中文显示不需要字体 CDN。字体 URL、原始校验和及许可来源均记录在 `platforms/upstreams.lock.json`，不依赖本机已有缓存。

## 思源共享资源

固定源码要求 Go **1.26.5**、上游前端 pnpm **12.6.0**。在上游 `app` 独立安装依赖，然后用 `pnpm run build:mobile` 构建移动前端；如需知识库桌面模式，另建 `build:desktop`。不要混用 MathInk 根目录的依赖锁或升级上游版本来绕过问题。具体内核依赖见上游 `.github/CONTRIBUTING.md`。

在根目录构建 MathInk Web 与内置宿主桥接后，`platforms/prepare-resources.mjs android|harmony` 将 `appearance`、`guide`、`stage`、`changelogs` 复制至临时目录，加入 `stage/mathink/` 和宿主脚本，并向移动 HTML 注入 `/stage/mathink-host.js`，最后生成客户端要求的 `app.zip`。原上游编译资源不修改。

宿主桥接与完整数学编辑界面随原生应用内置，最终安装包无需用户另装思源或插件。没有真实 Butterfly 构建或思源移动前端时，打包脚本停止，不生成带空资源的安装包。

`node scripts/upstream-verify-resources.mjs android harmony` 检查资源 ZIP 中的宿主注入、本地路径、桥接清单及当前编译文件的校验和。两端原生构建入口也执行此检查。`app.zip` 是原生壳需要的资源归档，本身不是可安装的 APK 或 HAP。

## Android（最低 Android 10）

安装 Android Studio、对应 JDK、SDK API 36，设置 `JAVA_HOME` 与 `ANDROID_HOME`。固定源中的 Gradle 9.7.1 与 AGP 9.3.0 由上游 wrapper 决定，首次构建需要网络。安装 Go 1.26.5、gomobile 并按上游指南初始化其工具链。

```powershell
.\platforms\build-android.ps1 -Kernel
```

该命令以 `-androidapi 29` 编译 arm64 Go 内核、打包资源并构建 Huawei Debug APK。调试包名 `io.github.inthispiece.mathink.debug`；正式包名 `io.github.inthispiece.mathink`。Java 内部 namespace 保留以减少迁移风险，应用身份与 FileProvider 独立。工作区使用该应用的私有/专属外部目录，与原版思源分离。

正式构建需自行配置 `MATHINK_KEYSTORE`、`MATHINK_STORE_PASSWORD`、`MATHINK_KEY_ALIAS`、`MATHINK_KEY_PASSWORD`，然后运行 `-Release`。签名文件和密码不提交。构建产物位置以 Gradle 实际输出为准；仓库不附未构建的 APK。

## HarmonyOS（最低 5.1 API 18）

使用 DevEco Studio 和 Harmony SDK：目标 6.0 API 20，最低 5.1 API 18。原上游证书路径已移除；用自己的 bundle `io.github.inthispiece.mathink.ho` 配置本地自动签名。真机调试需要华为开发者身份和设备签名配置。

Go 鸿蒙内核需 Linux/WSL2、Linux Harmony SDK、log adaptor 及**独立的 Go 1.26.5 副本**。按上游开发指南，仅对该副本应用 TLS、cgo 和 net resolver 调整，不能修改其他项目的 Go 安装。设置 `GOROOT_HARMONY`、`OHOS_NDK_HOME`、`LOG_ADAPTOR_HOME` 后：

```bash
bash platforms/build-harmony-kernel.sh
```

脚本编译 arm64 `libkernel.so`，复制编译生成的头文件到客户端，产物不提交。然后在 Windows 上设置 `HVIGOR` 为 DevEco 的 hvigorw.js 路径，配置好本应用签名，运行：

```powershell
.\platforms\build-harmony.ps1
```

生成 HAP 需实际 SDK、内核及签名通过；正式商城 APP 打包、设备笔感测试和审核仍是独立发布门槛。当前构建脚本不代替商城审核。

## 共存与隐私

内核以 `-X github.com/siyuan-note/siyuan/kernel/util.FixedPort=6817` 编译，两端原生 URL 同步改为 6817，避免与原版 6806 冲突。外部 URI 使用 `mathink:`，入口转换为思源内部块路由以保留兼容性。原版内部知识库 UI 和用户账号功能尚需正式发行前进一步收敛与品牌检查。

首启说明采用本地 MathInk 文本，不显示原软件的运营方协议。鸿蒙拒绝协议只退出，不清空应用数据。实验版文本明确标注需在发行前补齐实际运营主体、联系方式、网关区域和服务商处理信息。

## 仍须真机确认

请记录鸿蒙笔压、掌触、套索、缩放、横竖屏、前后台切换及保存恢复测试；安卓需要手写笔真机。模拟器通过或 Web 自动化通过都不能作为笔感验收。使用已有思源真实笔记前先做备份，实验数据推荐放在独立 MathInk 工作区。
