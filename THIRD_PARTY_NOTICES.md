# 第三方来源与许可

MathInk 新增代码按 AGPL-3.0-only 发布。上游代码保留各自作者、历史及许可证，以下声明不覆盖其原始授权。

| 项目 | 用途 | 许可与对应源码 |
| --- | --- | --- |
| SiYuan | 前端、内核 | AGPL-3.0；`upstream/siyuan/LICENSE` |
| SiYuan Android | 安卓容器 | AGPL-3.0；`upstream/siyuan-android/LICENSE` |
| SiYuan Harmony | 鸿蒙容器 | AGPL-3.0；`upstream/siyuan-harmony/LICENSE` |
| Linwood Butterfly | 手写画布 | 主体 AGPL-3.0；`api` Apache-2.0；部分图像/文档 CC-BY-SA-4.0 |
| KaTeX | 离线公式排版与字体 | MIT；源码依赖 `node_modules/katex/LICENSE`；预览内 `web/licenses/katex-LICENSE.txt`，插件内 `web/licenses/katex-LICENSE.txt` |
| Noto Sans SC | Butterfly 中文离线字体 | SIL OFL 1.1；`upstream/butterfly/app/fonts/NotoSansSC-LICENSE.txt`；固定来源与 SHA256 见上游版本清单 |

Mathpix 是单独的联网服务，不随源码提供账号、付费额度或服务授权。名称和商标归相应权利人。MathInk 与上游产品运营方没有隶属关系。

源码提交、SDK版本与补丁记录见 `platforms/upstreams.lock.json`；个人 fork 修改后的提交见 `platforms/published-sources.json`。构建包应标注相应 Git 提交。发布时一并提供源码与构建材料，保留许可证文件；不得只发布编译后的画布。
