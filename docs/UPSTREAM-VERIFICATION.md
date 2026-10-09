# 上游构建验证记录

记录日期：2026-10-09。固定的完整源码提交见 `platforms/upstreams.lock.json`；发布后的集成提交另见 `platforms/published-sources.json`。上游基线和集成提交分别记录，不能将补丁后的提交冒充原版发布提交。

| 项目 | 已执行结果 |
| --- | --- |
| 四个上游仓库 | 真实 Git 提交及发布版本已核对；鸿蒙与安卓客户端均匹配思源 3.8.6 |
| 思源移动前端 | 使用其指定 pnpm 12.6.0 执行 `build:mobile`，webpack 编译成功 |
| Butterfly 代码分析 | Flutter 3.47.5 分析数学桥接、Embed 和选择处理器，零问题 |
| Butterfly 回归测试 | 五项真实 Dart 测试通过：选区不泄漏邻近内容、拒绝缺失笔迹、拒绝文本对象、偏移选区裁剪正确、插入公式不改变原笔迹修订号 |
| Butterfly Web | 真实 release JavaScript 构建成功，编译用时约 238 秒；本地 CanvasKit、中文字体、许可与 NOTICES 随产物提供 |
| Butterfly 浏览器闭环 | 真实鼠标写两笔、自动保存、套索选区、仅所选笔迹 PNG、模拟识别纠错、插入公式、回到源笔迹、`.bfly` 恢复和离线重开通过；测试期间无外部网络请求、无页面异常 |
| 补丁重放 | 三个补丁均通过 reverse-check，可识别已应用状态；不重置本地修改 |
| 构建脚本 | Node 语法、PowerShell AST 与 Bash 语法检查通过 |
| 两端资源归档 | 已生成安卓与鸿蒙各自的 `app.zip`，各含 2,397 文件；校验宿主注入、本地资源路径和当前编译文件的 SHA-256 均通过。这些归档是原生壳的构建输入，不是安装包 |
| 安卓 APK | 未构建：尚无 Android SDK、JDK 和 Go 移动工具链 |
| 鸿蒙 HAP | 未构建：尚无 DevEco SDK、隔离的 Go 鸿蒙工具链、签名与测试设备 |

构建保留了上游的希腊语 ICU 警告、未采用的 WebAssembly dry-run 提示和 Cupertino 图标字体提示；它们未阻止本次 JavaScript Web 构建。没有将 Web 构建成功称作安卓或鸿蒙应用通过验收。

中文 Noto Sans SC 字体取自固定 Google Fonts 提交，下载时核对 SHA-256，SIL OFL 1.1 许可随源码提供。许可文本校验按 LF 规范化，支持 Windows Git 的 CRLF 工作树。首次构建依赖网络获取工具链和固定依赖；安装后的编辑资源随应用打包。

另行执行了无本机字体缓存的实际下载验证：Windows 原生 PowerShell 下载器获取字体并通过固定 SHA-256。构建入口在 Windows 使用该下载器，其余平台使用带超时的 fetch；没有要求开发者复用本次 `.tools` 缓存。

浏览器闭环使用明确标注的模拟识别服务，没有将模拟结果当作真实 Mathpix 识别质量。手写笔真机、真实 OCR 凭据和两端商城签名仍需外部条件完成，未预先宣称笔感、识别质量或商城审核通过。
