# MathInk · 数学手写笔记

手写 → 圈选公式 → 联网识别 → 对照纠错 → 保存 LaTeX → 整理进知识库 → 返回原稿。

这是可运行的开发预览。发布 ZIP 和插件包含实际构建的 Butterfly 及离线中文字体；首次克隆可先用实验画布。真实 Mathpix、原生安装包和两端笔感仍需分别验收。预览包不代表已通过应用市场审核。

![发布预览中的本地 Butterfly、公式工作台与原稿关联](docs/butterfly-preview.png)

## 本地运行

需要 Node.js 24 和 pnpm 11.25.0。首次克隆主仓库即可运行实验界面，无需下载整个上游源码。

```powershell
git clone https://github.com/inthispiece/math-ink.git
cd math-ink
pnpm install --frozen-lockfile
pnpm dev:demo
```

打开终端显示的 `http://localhost:5173`。先用笔或鼠标写公式，再套索圈选。当前命令运行演示服务，请点击独立的「查看固定样例演示」体验排版与整理：**演示不读取笔迹、不上传、不限次数**。主按钮「识别圈选公式」必须使用已配置的真实服务，不会以固定样例代替识别结果。

若已在 `D:\note`，直接从 `pnpm install` 开始。常用命令：

| 命令 | 用途 |
| --- | --- |
| `pnpm dev:demo` | 本机实验；显式查看固定样例，不识别笔迹 |
| `pnpm dev:ocr` | 使用 `.env` 中的 Mathpix 服务端凭据 |
| `pnpm dev:lan` | 同一局域网平板实验，终端显示可直接打开的配对链接 |
| `pnpm check` | 类型检查、单元/接口测试、构建 |
| `pnpm test:e2e` | 浏览器完整流程测试，默认使用 Edge |
| `pnpm test:preview` | 已构建 ZIP 的实际解压运行、离线重载和网关验证 |
| `pnpm test:butterfly` | 真实 Butterfly 本地资源、手写、桥接与原稿恢复验证 |
| `pnpm build` | 输出 `dist/web`、思源插件和原生客户端引导资源 |
| `pnpm preview` | 启动已构建的离线资源预览，默认 `http://127.0.0.1:8787` |
| `pnpm package:preview` | 生成可下载预览 ZIP、思源插件 ZIP 和 SHA256 清单 |
| `pnpm doctor` | 查看开发工具是否可用 |

这台电脑已完成构建时，可双击 `Start-MathInk.cmd` 启动本机预览；同一 Wi-Fi 平板实验双击 `Start-MathInk-Lan.cmd`，或在 `D:\note` 运行 `.\Start-MathInk.cmd -Lan`。打开启动窗口显示的地址或配对链接。CMD 入口直接运行 Node，无需调整 PowerShell 执行策略。原 `Start-MathInk.ps1` 仍可使用。GitHub Release 的开发预览 ZIP 只需 Node.js 24，无需安装 npm 依赖。

## 真实识别与平板实验

```powershell
# 首次配置时复制；已有 .env 请直接编辑，避免覆盖已有配置。
Copy-Item .env.example .env
# 用编辑器填写 MATHPIX_APP_ID、MATHPIX_APP_KEY；勿提交此文件。
pnpm dev:ocr
```

使用前在 Mathpix 控制台关闭 Improve Mathpix；每次请求也关闭对应选项。只有用户圈选的笔迹图像会上传，原稿保留本地；拒绝联网识别仍可写笔记。供应商会处理数据并保留必要计费信息，详见 [隐私说明](docs/PRIVACY.md)。真实调用需要你自己的付费服务账户，本项目不包含额度。

没有账户时，按 [中文开通步骤与额度说明](docs/MATHPIX-SETUP.md) 创建 Mathpix OCR API 账户、获取 `app_id` / `app_key` 并填入服务端 `.env`。个人 Snip 订阅不能替代 API。页面会常驻显示真实识别是否配置；未配置时不上传、不扣额，也不生成看似识别成功的样例。复杂公式适配保留范数、上下标、矩阵及多行结构，仍需真实笔迹验证准确率。

旧版的每设备每天 10 次是本项目的本地成本限制，误用于 Mock 的问题已修复。当前开发配置为每设备每天 200 次、服务总共每天 1,000 次和每月 10,000 次，可在 `.env` 调整并重启；不使用配置文件时，代码仍采用 10 / 200 / 2000 的保守默认值。设置中显示本地已用、剩余及重置时间；供应商余额、限流与费用单独计算，增加本地上限也会增加可能的付费调用量。本地演示不限额，旧笔记与账目保留。

平板和电脑连接同一 Wi-Fi 后双击 `Start-MathInk-Lan.cmd`，或运行 `.\Start-MathInk.cmd -Lan` / `pnpm dev:lan`，直接打开启动窗口打印的「平板配对入口」。链接会完成配对并移除地址中的令牌。自动生成的令牌保存在电脑的 `.local/pairing-token`，重启继续使用；环境变量或 `.env` 中明确配置的令牌优先。不要提交或分享令牌文件。

本机预览页面可自动配对；已打开的页面可在设置中点击「自动配对本机服务」。开发服务器使用启动窗口中的配对链接；「检查服务连接」会验证令牌且不调用 OCR。其他设备若提示令牌失效，请重新打开当前启动窗口的配对链接，或在设置中粘贴当前服务令牌。无需清除笔记。需要真实识别时先在 `.env` 中设置 `OCR_PROVIDER=mathpix`。局域网 HTTP 仅用于受信网络上的开发联调；公网必须 HTTPS。笔记保存在当前设备浏览器中，建议定期导出备份；电脑和平板不会自动同步。

识别失败会在公式预览区显示具体原因，并保留原稿。一次请求最多等待 35 秒（包括响应正文读取），可取消等待或手动重试；不会自动重复调用。配对令牌错误、额度耗尽或真实识别未配置时，请按错误提示处理。升级后若已打开的页面仍显示旧界面，电脑按 `Ctrl+Shift+R` 强制刷新；无需清除浏览器数据或笔记。

## 思源插件和独立客户端

`pnpm build` 后把 `dist/plugin/math-ink` 复制到思源工作空间 `data/plugins/`，在插件设置启用，再打开 MathInk。插件支持通过公开 API 保存原稿资产、公式块和来源属性。在应用设置填识别服务地址；配置服务端允许的思源页面 Origin，并使用配对令牌。

上游源码与双端构建见 [构建说明](docs/BUILD.md)。独立客户端使用自己的包名、协议及本地端口，并内置数学界面；鸿蒙目标为 5.1+，安卓最低 Android 10。安装与手写性能以真机验收为准。

在包含完整资源的预览中，打开「识别与设备」选择「本地 Butterfly」，使用画布内的钢笔和套索。实际浏览器已验证书写、选区隔离、可编辑公式、原稿回溯与离线重开；[开发预览验收记录](docs/DEVELOPMENT-PREVIEW.md) 列出已验证范围与尚待配置的项目。

## 数据和开源

笔迹、确认后的公式及笔记存放设备本地。导出 `.mathink.json` 可恢复完整实验笔记；Butterfly 模式另保留原 `.bfly` 文档。Markdown 和 LaTeX 导出可用于论文及其他笔记软件。

AGPL-3.0-only。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，架构见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，发布条件见 [发布清单](docs/RELEASE.md)。
