# 真实 AI 评测

这里提供可重复的评测工具和待核对题目，不含真实私人笔记、供应商密钥或模型成绩。程序测试不代表识别准确率。先由人工审核标签和参考答案，再冻结验收集；不要根据模型输出修改期望答案。

运行环境为项目使用的 Node.js 24。先启动已配置 DeepSeek 的 MathInk 网关。

```powershell
node scripts/eval-ai.mjs init
```

此命令在 `.local/evaluation/` 创建空的 `manifest.json`、`assessments.json` 和 40 题候选 `checks-manifest.json`，已有文件不覆盖。候选题预拟正确/错误各 20 题，覆盖积分、不等式、遗漏条件、矩阵和多行推导；全部 `humanVerified:false`，不是已人工验收的题集，也不是 40 页真实笔记。

按 [清单示例](manifest.example.json) 添加真实 PNG 页面。目标是 30 页调试、20 页独立验收，尚未收集的数据不得填作已完成。按 `writerGroup` 和 `sourceGroup` 分组，同一书写者或来源不能跨两组。路径相对于清单；图片可以保留在本机其他私人目录，单张 PNG 上限 1.4 MB。清单、结果和人工评审只能写入本项目 `.local`，不会进入发布包。

```powershell
node scripts/eval-ai.mjs validate
node scripts/eval-ai.mjs validate --manifest .local/evaluation/checks-manifest.json
```

验证只检查清单、分组、图片，不发生成请求。需要独立审核候选题的期望标签、假设和正确答案；核对后才把相应 `humanVerified` 设为 `true`，然后冻结清单。验收集不要继续用于调试。修改清单或模型、提示词后使用新的运行文件，并保留旧版本作比较。

在本机环境变量配置网关地址和访问令牌，不要把 DeepSeek 供应商密钥传给脚本：

```powershell
$env:EVAL_GATEWAY_URL = 'http://127.0.0.1:8787'
# 在本机填写网关配对令牌或托管登录会话令牌，勿提交或发在聊天里。
$env:EVAL_GATEWAY_TOKEN = '在本机填写'
node scripts/eval-ai.mjs run --allow-paid --budget-cny 15 --limit 3
```

`run` 必须显式同意可能计费并给出金额预算；默认一次最多 3 条。脚本先检查服务端是否真实配置 DeepSeek，以及服务端保守单任务费用上界。没有密钥或上界就不提交生成请求。示例 15 元是按默认每任务 5 元最坏上界预留 3 次的保护值，不是 3 次调用的实际价格；服务端还有独立的每用户及全服务预算。可缩小 `--limit` 和预算，但预算小于一次保守预留时不会调用。价格未配置、用量不完整、超时、取消和未知结果均不能按免费处理。

每次付费 POST 前，先将 `pending`、请求 ID 和预留费用原子写入运行文件。中断后再次 `run` 只处理尚未提交的样本，不自动重做 `pending/unknown/error`。页面任务保存服务端任务 ID，可用原任务查询接口核对；结果丢失时先对账，再显式新建运行文件决定是否重做。进程异常退出可能留下 `.lock`，须先确认无运行中的评测、核对未知请求后手工删除这一锁文件。不要靠删记录绕过预算。多个运行文件的预算不自动合并，服务端全局预算仍必须开启。

```powershell
node scripts/eval-ai.mjs run --manifest .local/evaluation/checks-manifest.json --run-file .local/evaluation/checks-run.json --allow-paid --budget-cny 5 --limit 1
node scripts/eval-ai.mjs report --manifest .local/evaluation/checks-manifest.json --run-file .local/evaluation/checks-run.json --output .local/evaluation/checks-report.json
```

评审 `assessments.json` 使用如下字段；一条样本仅一条评审。只有验收组、`humanVerified:true` 且实际调用成功的样本才进入人工验收统计。未填项目为未知，不填 0 代替未测。

```json
[
  {
    "sampleId": "acceptance-page-001",
    "readingOrderCorrect": true,
    "formulaUnits": { "correct": 8, "total": 10 },
    "contentUnits": {
      "paragraphs": { "correct": 4, "total": 4 },
      "conditions": { "correct": 3, "total": 4 }
    },
    "manualSeconds": 600,
    "aiCorrectionSeconds": 450
  },
  {
    "sampleId": "integral-e1",
    "correctIssueFound": true,
    "erroneousChangeSuggested": false
  }
]
```

报告记录模型、提示词版本及实现 SHA-256、样本标识、P50/P95 延迟、供应商用量和费用状态；账单未人工对过始终 `billingReconciled:false`。有人工参考中文时计算汉字 CER，有英文参考时计算 WER；阅读顺序、公式数学意义、关键条件保留、正确题误改和错误题检出均需人工评审。规范化 LaTeX 字符串只作格式对照，绝不能等同数学正确率。人工与 AI 后核对时间应交错测试，避免熟悉内容带来偏差。
