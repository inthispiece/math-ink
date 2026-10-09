# HTTPS 识别服务

先完成本地预览与真实服务配置。此目录提供单实例部署配方，不会自动创建云资源、注册域名或启动付费服务。

准备 Linux 主机与指向主机的域名。在项目根目录 `.env` 配置：

```dotenv
OCR_PROVIDER=mathpix
MATHINK_DOMAIN=ocr.example.com
MATHPIX_APP_ID=your-id
MATHPIX_APP_KEY=your-key
GATEWAY_PAIRING_TOKEN=at-least-24-random-characters
GATEWAY_ALLOWED_ORIGINS=https://ocr.example.com,http://127.0.0.1:6817
```

```sh
docker compose --env-file .env -f deploy/compose.yml up --build -d
```

Caddy 提供 HTTPS，仅它暴露公网端口。SQLite 使用持久卷；容器以非 root 用户运行。配对令牌是接入控制，不能作为随公开安装包发布的永久秘密。默认总额度保护费用，但公开服务可能被滥用耗尽额度；扩大发行前应结合账户或设备验证。

网关不记录请求正文。当前图片、公式结果不落盘；哈希标识、状态与额度元数据会保存。正式运营者需提供自己的隐私政策、联系方式、数据处理信息和适用备案。更新供应商价格和费用上限后再扩大用户规模。
