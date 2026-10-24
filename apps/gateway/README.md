# MathInk AI 任务网关

Node.js 24 内置 HTTP 与 SQLite，无服务端 npm 依赖。从仓库根目录运行 node --env-file-if-exists=.env apps/gateway/src/server.ts。

主线为 OCR_PROVIDER=deepseek、DEEPSEEK_API_KEY、DEEPSEEK_MODEL=deepseek-flash。直接不带配置的代码默认仍是明确标注的 mock 预设演示；真实模式没凭据报错，不以演示代替。Mathpix 为可选对照，本地 Qwen 保留选区实验，整页等新增任务尚未开放。完整操作见 [AI 配置指南](../../docs/AI-SETUP.md)。当前真实 DeepSeek 质量评测为 0 次；程序测试不能代替真实验收。

## 本机与托管身份

本机监听 127.0.0.1:8787。局域网设置 GATEWAY_HOST=0.0.0.0、至少 24 字符 GATEWAY_PAIRING_TOKEN，客户端使用 Bearer 配对令牌，来源明确配置 GATEWAY_ALLOWED_ORIGINS。这种入口用于开发联调。

托管设置 GATEWAY_AUTH_MODE=hosted，通过 HTTPS 提供前端与 API。用户邀请注册、账号登录、使用可撤销会话；管理入口为 scripts/hosted-admin.mjs。预算根据服务端可信账号，installationId 不是账号，不能更换它绕过额度。供应商密钥只存在服务器，网页不分发密钥或共享配对令牌。实际域名、服务器、预算及邀请仍需配置。

托管服务器无法访问用户电脑回环 Ollama，托管端拒绝本地供应商。用户主动打开自己电脑/局域网入口使用 Qwen。登录不等于笔记同步；不同域名、端口和局域网地址的浏览器存储隔离，须从旧入口导出完整 schema 2 JSON，在新入口导入并核对。

## 接口

- GET /v1/status?provider=deepseek：模型、配置、模拟标记、任务能力及上下文/输出/时间/费用上界，不返回密钥。
- GET /v1/provider-health?provider=...：鉴权后检查就绪，须核对 ready:true，不生成内容。
- GET /v1/usage?provider=...&installationId=...：次数、金额及预留；托管按会话确定用户。
- POST /v1/recognize：接收 clientRequestId、installationId、provider 可选、imageBase64、sourceRevision，忠实转写选区，不求值。
- POST /v1/review：接收 clientRequestId、installationId、provider 可选、sourceRevision、latex、context 可选，独立检查文字公式，不附图；建议须用户采用。
- POST /v1/tasks：接收 clientRequestId、installationId、provider 可选、sourceRevision、type、input；DeepSeek 支持 page-transcribe、context-review、organize、knowledge-links、proof-assist，返回 202 等待或已有任务。
- GET /v1/tasks/:taskId?installationId=...：查询原任务，本机配对也必须附带原 installationId；托管验证会话归属。
- POST /v1/tasks/:taskId/cancel?installationId=...：尝试取消，供应商计算仍可能计费。
- 托管账号：POST /v1/auth/register（username/password/invite）、POST /v1/auth/login、GET /v1/auth/me、POST /v1/auth/logout。注销撤销当前会话，注册/登录有网络频率保护。

标识为 8–128 位 ASCII 字母、数字或 ._:-，修订为非负整数。图片为有效非交错 PNG，最大 1,400,000 字节、4,194,304 像素、单边 4096。整页不能用当前屏幕可见截图代替。input 含稳定 noteId/pageId/contentRevision，整页使用图，其他任务用有版本的所选 blocks，关联另有有限 candidates。严格结构、引用核验及提示词见 [types.ts](src/types.ts)、[tasks.ts](src/tasks.ts)。

整页输出文字片段、行内/独立公式、顺序、坐标及疑点；上下文建议分识别、语言、数学和缺少条件；整理保留全部原块引用，摘要及新解释独立标示。引用需匹配实际块、版本、原文，笔记文字不能改变权限或扩大上传范围。证明仅提供初等代数/基础微积分未验证建议，不执行工具。前端独立本地多项式工具只核对有理系数单变量恒等式或候选原函数，其结论不验证整篇 AI 建议。

## 去重、恢复与费用

同身份、供应商、任务类型、客户端 ID 去重；同 ID 改输入或版本返回冲突。双击合并，失败/超时/未知不自动重试；显式重做使用新 ID 并提示可能再次计费。

SQLite 默认 .local/gateway.sqlite，只保存请求/任务、散列、账号会话、用量和预算元数据，不存笔记、图片、公式、上下文正文或供应商密钥。结果正文只在内存，默认最长 24 小时、最多 1,000 条。重启/缓存淘汰保留元数据，返回 REQUEST_RESULT_UNAVAILABLE 或任务 result-unavailable，不再调用供应商。设备已收草稿保留，重做须确认。

调用前原子预留次数和保守金额，结束后按供应商用量和带日期价格结算。超时、取消、无价格/用量时费用未知，不按免费释放。保护覆盖每用户/全服务并发、频率、日/月次数与金额，以及单任务图片、上下文、输出、子调用和时间。AI_PRICE_CONFIG 包含对应模型、日期、CNY 输入/缓存输入/输出每百万 token 的价格；估算须定期与账单核对。

代码默认次数每安装/用户日 10、全服务日 200/月 2,000；开发 .env 可不同。金额默认每用户日 5 元/月 50 元、全服务日 50 元/月 500 元、单任务上限 5 元，无价格时每请求保留 0.5 元。以运行配置及接口为准，保护值不是供应商实际价格。本地 Qwen/演示不扣云端额度。保留数据库才能维持预算与去重，不要删库恢复额度。

真实评测见 [evaluation/README.md](../../evaluation/README.md)，必须显式允许可能付费、给出预算，默认每轮最多 3 条。40 道候选检查题未人工核验；没有真实页、人工数据或账单则报告未知。node --test apps/gateway/test/*.test.ts 使用隔离响应，不调用付费 API。
