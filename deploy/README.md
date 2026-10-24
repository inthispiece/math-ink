# MathInk 托管试用部署

此配方同时提供前端静态资源、账号网关与 HTTPS 反向代理，主线为 DeepSeek。面向单实例邀请试用；本机仍可保持 local 配对模式。当前开发机器未安装 Docker，镜像构建和公网 HTTPS 仍需在部署环境验收；本机使用真实 Node HTTP 服务验证账号、任务及数据边界。

## 准备与启动

需要 Linux 主机、Docker Compose、可解析到主机的域名以及 DeepSeek 凭据。浏览器试用先行，原生 APK/HAP、真实手写笔及商店发布仍走独立流程。

从根目录 .env.example 复制到服务器私有 .env，填写：

    OCR_PROVIDER=deepseek
    MATHINK_DOMAIN=notes.your-domain.example
    DEEPSEEK_API_KEY=在服务器填写，不发给客户端
    DEEPSEEK_MODEL=deepseek-flash
    GATEWAY_AUTH_MODE=hosted

公开云生成还必须配置 AI_PRICE_CONFIG：JSON 包含 model、date（YYYY-MM-DD）、currency（CNY）、inputPerMillion、outputPerMillion，使用缓存价格时另填 cachedInputPerMillion。这些是每百万 token 的人民币价格，运营者应按[官方价目](https://api-docs.deepseek.com/quick_start/pricing/)核对日期、时段及币种，外币需要明确换算，不能直接当人民币。缺少当前模型的带日期价格时返回 PRICING_REQUIRED，不调用模型或扣额度。

根 .env.example 列出用户/全服务的日月次数、金额、并发、频率，以及任务的上下文、输出和总时间限制。缺少供应商用量或任务超时，费用为未知并占用预留；预留不是账单。试用前审核上限。

    docker compose --env-file .env -f deploy/compose.yml up --build -d
    docker compose --env-file .env -f deploy/compose.yml exec gateway node scripts/hosted-admin.mjs invite 24 1

第二条只在管理员终端显示一次私有邀请码。用户在 HTTPS 应用入口“识别与设备”用邀请码注册并登录；不需要填写供应商密钥或安装 Ollama。额度依据服务端账号，不信任 installationId。不要把邀请码写进源码、镜像或公开问题。

Caddy 是唯一公开端口，8787 只在 Compose 内网；SQLite 位于 /app/data 持久卷。Docker 构建生成前端；若需要 Butterfly，先按固定上游说明生成 apps/web/public/vendor/butterfly 再构建镜像，否则实验画布可用。不同域名/IP 的浏览器存储不互通，登录不自动同步；切换前导出设备完整备份。

## 运维和账单

以下命令接在上述 Compose exec gateway 后运行：

    node scripts/hosted-admin.mjs users
    node scripts/hosted-admin.mjs disable 用户ID
    node scripts/hosted-admin.mjs ledger 100
    node scripts/hosted-admin.mjs reconcile --request 请求ID --amount 已核对人民币金额
    node scripts/hosted-admin.mjs backup /app/data/backups/metadata-日期.sqlite

ledger 只含请求标识、账号散列、模型、token、预留和结算。供应商账单对账后才释放未知费用；实际金额可以为零，但不能因没取得回复就认定免费。对账带审计，相同金额幂等，不退次数。备份采用 SQLite 在线一致性备份并拒绝覆盖已有文件；密码和会话散列仍是私有材料。

恢复时停止网关，先保留当前数据库，恢复经校验的元数据备份，重新开放公网前运行：

    node scripts/hosted-admin.mjs restore-lockdown

恢复锁定会撤销所有旧会话、废止全部旧邀请码、禁用恢复的全部账号，并记录审计。否则旧备份可能使已消费邀请或已封禁账号重新有效。管理员先对照独立保管的账号撤销记录复核，再运行 users 和 enable 精确用户ID，仅重新开放审核后的账号并发放新邀请；旧会话不会随启用复活。恢复保留次数、去重和费用元数据；任务正文不在服务器，重启后丢失结果明确标记不可恢复，设备原稿及已收草稿保留。不要删除 SQLite 来重置额度。

Compose 使用独立 172.30.73.0/24 网络，网关为 .2、Caddy 为 .3。只有 .3 是明确可信代理，Caddy 覆盖 X-Forwarded-For，网关才采用其中单个合法客户端 IP 作认证限流。直接请求伪造转发头无效；不要把任意代理、域名、CIDR 或公网访问来源加入可信列表。若该子网与主机现有网络冲突，必须同步修改两容器静态 IP、子网及可信代理配置，始终保持 8787 不公开。

## 发布前门槛

先以少量邀请和总预算试用。核对 HTTPS、账号隔离/撤销、安装标识绕过、并发/频率/次数/金额触发、未知费用、任务重启和备份恢复。当前并发限制是网关活跃请求数，取消等待不能证明供应商停止执行；未知费用继续保留。预算触发后停止新生成，设备仍可书写、编辑和导出。

运营者需提供域名、联系方式、正式隐私政策、供应商数据处理信息和适用备案。此配方没有创建付费主机或代替真实云端质量验收。

托管服务不连接用户电脑回环 Ollama。使用本地模式需主动打开自己电脑或局域网入口，再导入笔记备份；HTTPS 网页不能因此承诺一键连接电脑 HTTP。跨设备同步、支付和 Lean 形式验证另行实施。
