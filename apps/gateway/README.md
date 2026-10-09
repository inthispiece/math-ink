# MathInk 公式识别网关

使用 Node.js 24 的内置 HTTP 与 SQLite，无服务端 npm 依赖。从仓库根目录运行 `node --env-file-if-exists=.env apps/gateway/src/server.ts`。默认监听 `127.0.0.1:8787`、使用明确标注的 `mock` 预设公式，不识别实际笔迹。

真实模式设置 `OCR_PROVIDER=mathpix`、`MATHPIX_APP_ID`、`MATHPIX_APP_KEY`。Mathpix 凭据只能放在服务端环境变量；不放入插件、前端构建或版本库。未配置凭据的真实模式返回 `PROVIDER_NOT_CONFIGURED`，不会降级为模拟结果。

平板联调设置 `GATEWAY_HOST=0.0.0.0`、至少 24 字符的 `GATEWAY_PAIRING_TOKEN`。客户端使用 `Authorization: Bearer <令牌>`；WebView 来源使用逗号分隔的 `GATEWAY_ALLOWED_ORIGINS` 明确配置。正式服务通过反向代理启用 HTTPS，保持网关内网监听；开发用安装标识和配对令牌不等于正式用户认证。

## 接口

- `GET /v1/status`：供应商、配置状态、模拟标记、配对要求及默认额度；不返回密钥。
- `POST /v1/recognize`：JSON `{clientRequestId, installationId, imageBase64, sourceRevision}`。两个标识使用 8–128 个 ASCII 字母、数字或 `._:-`，修订号为非负整数。图片接受原始 base64 或 PNG data URL；仅支持非交错 PNG，最大 1,400,000 字节、4,194,304 像素、单边最大 4096 像素。选区内没有笔迹应由客户端阻止提交。
- 响应：`{requestId,status,provider,simulated,sourceRevision,latex?,confidence?,error?}`，错误包含 `{code,message,retryable}`。HTTP 状态对应成功 200、输入 400/413/415、权限 401/403、无公式 422、额度 429、供应商异常 502/503/504。结果需用户核对确认。

`clientRequestId` 由客户端在选区确定后生成，相同安装、供应商和请求标识合并进行中的调用；内容或来源修订变化返回 409。失败或超时不自动重试，已提交请求仍计入额度。重试同一请求返回缓存结果；用户明确重新识别才生成新标识。

## 保存与额度

SQLite 默认在 `.local/gateway.sqlite`。数据库仅保存随机服务端请求标识、安装/请求/内容散列、额度时间和处理状态；不保存图片、公式正文或密钥，不记录请求正文日志。识别结果仅在进程内缓存，最长 24 小时、最多 1,000 条。重启或缓存过期后旧请求返回 `REQUEST_RESULT_UNAVAILABLE`，不会再次请求供应商。保留 SQLite 数据库以维持额度与重复提交保护，删除它会重置限制。

默认按 `Asia/Shanghai` 日期原子预扣额度：安装实例每日 10 次、服务每日 200 次、每月 2,000 次。通过 `OCR_INSTALLATION_DAILY_LIMIT`、`OCR_GLOBAL_DAILY_LIMIT`、`OCR_GLOBAL_MONTHLY_LIMIT`、`GATEWAY_TIME_ZONE` 调整。模拟识别也计入本地测试额度，可使用独立测试数据库。安装标识可被客户端重置，正式公开服务还需服务端身份校验及网络限流。

Mathpix 请求固定发送 `metadata.improve_mathpix=false`；供应商自身的计费与元数据保留以其隐私协议为准。[Mathpix 图片接口](https://docs.mathpix.com/reference/post-v3-text)、[隐私控制](https://mathpix.com/docs/convert/privacy)

测试：`node --test apps/gateway/test/*.test.ts`。测试使用临时 SQLite、真实 PNG 编解码和伪造 Mathpix HTTP 响应，不调用付费 API。
