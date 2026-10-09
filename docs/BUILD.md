# 构建与双端实验

先运行 `pnpm check`，获得 `dist/web`、`dist/plugin/math-ink` 和 `dist/host/bootstrap.js`。

上游初始化、固定提交和画布补丁见 [上游构建说明](UPSTREAM-BUILD.md)。完整克隆：

```powershell
git submodule update --init --recursive
```

Butterfly 固定版本中声明的 Flutter/Dart 工具链必须真实可取得且通过构建。不可用时应报告构建阻塞，不能将实验 Canvas 重新命名为 Butterfly 或上传空画布产物。

平台准备脚本负责内置数学资源和宿主入口、修改自有包名与协议、设置独立内核端口、保存上游原许可。执行方法见 [上游构建说明](UPSTREAM-BUILD.md) 和 `platforms/` 中的脚本。

Android 需要 JDK、Android SDK/NDK、Go/CGO 与 gomobile。共享前端和内核必须使用同一思源提交；将生成的 AAR 和 app.zip 放入客户端，使用 Gradle 构建调试 APK。发布签名不提交 GitHub。

HarmonyOS 需要 DevEco Studio 与匹配 SDK。原生内核按思源该提交的 Linux 构建步骤在 WSL2/Linux 中构建，使用项目专用 Go 工具链。Windows 上的 `wsl.exe` 仅代表启动器存在，不代表已安装 Linux 发行版。将库和 app.zip 放入鸿蒙项目，绑定真机进行调试签名。公开测试应使用华为测试分发，正式上架提交发布签名 APP 包。

任何原生安装包生成后，均记录源码提交、工具版本、产物 SHA256 和测试设备。源码改造与脚本成功不等于完成真机运行、笔感或商城审核。
