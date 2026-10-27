# 第三方来源与许可

MathInk 新增代码按 AGPL-3.0-only 发布。上游代码保留各自作者、历史及许可证，以下声明不覆盖其原始授权。

| 项目 | 用途 | 许可与对应源码 |
| --- | --- | --- |
| SiYuan | 前端、内核 | AGPL-3.0；`upstream/siyuan/LICENSE` |
| SiYuan Android | 安卓容器 | AGPL-3.0；`upstream/siyuan-android/LICENSE` |
| SiYuan Harmony | 鸿蒙容器 | AGPL-3.0；`upstream/siyuan-harmony/LICENSE` |
| Linwood Butterfly | 手写画布 | 主体 AGPL-3.0；`api` Apache-2.0；部分图像/文档 CC-BY-SA-4.0 |
| KaTeX | 离线公式排版与字体 | MIT；源码依赖 `node_modules/katex/LICENSE`；预览内 `web/licenses/katex-LICENSE.txt`，插件内 `web/licenses/katex-LICENSE.txt` |
| fflate 0.8.2 | 预览打包；运行时有界解析 Butterfly `.bfly` 元数据和页面，用于原生插入/撤销状态核对 | MIT；Copyright (c) 2023 Arjun Barrett；源码依赖 `node_modules/fflate/LICENSE`；预览及插件内 `web/licenses/fflate-LICENSE.txt` |
| Noto Sans SC | Butterfly 与 PDF 中文离线字体 | SIL OFL 1.1；`upstream/butterfly/app/fonts/NotoSansSC-LICENSE.txt`；固定来源与 SHA256 见上游版本清单；PDF 资源内 `vendor/pdfjs/MathInkSans-LICENSE.txt` |
| PDF.js / pdfjs-dist 6.4.299 | 本地解析、按需渲染 PDF；使用 legacy 构建及离线 CMaps、标准字体、WASM | Apache-2.0；`node_modules/pdfjs-dist/LICENSE`；预览及插件内 `web/licenses/pdfjs-LICENSE.txt`，字体及 WASM 原始声明随对应目录保留 |
| pdf-lib 1.17.1 | 保留原 PDF 页并叠加批注，组合导出页面 | MIT；`node_modules/pdf-lib/LICENSE.md`；预览及插件内 `web/licenses/pdf-lib-LICENSE.txt`；其 MIT 依赖 standard-fonts、upng、pako、tslib 的声明一并保留 |

DeepSeek 与 Mathpix 是单独的联网服务，不随源码提供账号、付费额度或服务授权。本地模式由用户另行安装 [Ollama（MIT）](https://github.com/ollama/ollama/blob/main/LICENSE) 和 [Qwen3-VL-2B-Instruct（Apache-2.0）](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct/blob/main/LICENSE)；本仓库和发布 ZIP 不包含这些运行时或模型权重，其原始许可证随各自下载材料保留。名称和商标归相应权利人。MathInk 与上游产品运营方没有隶属关系。

源码提交、SDK版本与补丁记录见 `platforms/upstreams.lock.json`；个人 fork 修改后的提交见 `platforms/published-sources.json`。构建包应标注相应 Git 提交。发布时一并提供源码与构建材料，保留许可证文件；不得只发布编译后的画布。
