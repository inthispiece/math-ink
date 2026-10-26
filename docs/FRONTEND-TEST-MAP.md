# 前端交互测试迁移记录

本记录对应 `FRONTEND-INTERACTION-PLAN.md` 的页面与草稿交互改造。它列出旧断言的去向，不是新增产品计划。用例已经迁移不等于已经通过；最终执行结果以开发预览验收记录和测试日志为准。

新流程为：笔记库 → 单篇多页书写 → 明确调用工具 → 自动保存本篇草稿 → 用户核对与显式插入。原先常驻数学面板、两主标签、确认后才保存结果、切笔记取消任务、整理后自动另建笔记的断言按新流程替换。没有使用 `test.skip`，也没有通过调整测试目录排除失败用例。

## 新测试的职责

| 测试文件 | 覆盖范围 |
| --- | --- |
| [notebook-interaction.spec.ts](../tests/e2e/notebook-interaction.spec.ts) | 首页、独立书写、分页与视图、页面管理、自动存稿、任务归属、不抢焦点、原请求恢复、provider 切换、回收、断网、配置与失败、手机备份保护、手工公式、高置信度仍待人工核对；桌面 100 篇 × 30 页实验基线 |
| [draft-editor.spec.ts](../tests/e2e/draft-editor.spec.ts) | 草稿连续编辑保存、公式唯一来源、拆合、结构和图片、建议采用/撤销/过期/批量冲突、结果恢复、剪贴板失败、草稿回收、独立插入及存储失败 |
| [providers-and-review.spec.ts](../tests/e2e/providers-and-review.spec.ts) | 模型选择、逐次范围同意、本地 Qwen 隔离、独立文字公式检查与建议采用 |
| [pairing.spec.ts](../tests/e2e/pairing.spec.ts) | 当前设置表单令牌、原网关身份查询、托管会话退出与等待连接 |
| [recognition-failure.spec.ts](../tests/e2e/recognition-failure.spec.ts) | 已有响应头但正文未完成的超时、明确取消和晚到结果 |
| [advanced-tools.spec.ts](../tests/e2e/advanced-tools.spec.ts) | 所选上下文、整理保留条件公式、明确候选笔记范围、未验证证明建议、独立本地多项式核对；人工本地关联、反向链接、修改/删页后实时搜索与关系状态（零服务请求） |
| [page-storage.spec.ts](../tests/e2e/page-storage.spec.ts) | 原版本 1 数据库原子迁移、失败回滚、导入冲突不改旧数据；现目标为版本 3 |
| [notebook-storage.spec.ts](../tests/e2e/notebook-storage.spec.ts) | 版本 2→3 原始恢复材料、后台结果与新笔迹并发、编辑时间保护、回收/永久删除、版本冲突 |
| [page-source-restore.spec.ts](../tests/e2e/page-source-restore.spec.ts) | 旧正式内容升级后的可见入口、行内公式编辑与重开后身份保留；单篇导出到干净来源后严格定位原稿副本；相同修订号但内容不同必须拒绝 |

所有新模型交互用例使用隔离响应。`/v1/**` 未声明的接口也会被测试拦截，不会从本机 `.env` 调用真实模型。少量实际 HTTP 测试使用临时无密钥网关。它们验证请求、归属和数据可靠性，不证明模型准确率。

## 原 mathink.spec.ts：7 项

| 原测试标题 | 新位置与语义 |
| --- | --- |
| actual handwriting → lasso → consent → controlled OCR response → corrected LaTeX → organized → source, with durable reload | `notebook-interaction` 的实际书写、公式自动存稿、整页隔离和重开；`draft-editor` 的编辑、显式放置和返回原稿。结果保存与插入分成两步。 |
| empty selection submits nothing; refusing cloud consent leaves original notes editable | `notebook-interaction` 的拒绝上传恢复 pen；选择操作不触发请求，提交前请求计数为零。空选区与原稿保留另由画布/几何核心测试验证。 |
| already opened notebook remains writable and saves offline; reloading later keeps the original strokes and prose | `notebook-interaction` 的 offline writing 与首页重开；旧正文另由 `page-source-restore`、schema 迁移和有序导出核心测试验证。发布缓存的离线重开属于生产包检查。 |
| a failed transcription preserves ink; an explicit potentially billable retry starts a new request identity | `notebook-interaction` 的 network/401/429/invalid-json；`draft-editor` 的 GET-only 查询和明确 redo 使用新标识。 |
| changing source during recognition displays an old-source warning, preserves the result and marks the confirmed formula stale | `draft-editor` 的 changed/deleted source；`notebook-interaction` 的跨页后台归属；`notebook-domain` 的 `draftSourceState` 与历史版本显式使用。 |
| tablet viewport keeps the handwriting and recognition controls reachable | `notebook-interaction` 的横竖屏、关闭工具后原画布不重挂；真实笔压/掌触/延迟继续单独验收。 |
| phone controls remain accessible; backup preserves IDs and only restores conflicts after explicit protected confirmation | `notebook-interaction` 的 phone backup conflict：触控按钮可达、取消不改数据、先备份再确认覆盖、恢复后 ID 不变。 |

## 原 demo-vs-real.spec.ts：7 项

| 原测试标题 | 新位置与语义 |
| --- | --- |
| the demo gateway never supplies its fixed integral through the real-recognition button | `notebook-interaction` 的 simulated success 拒绝；网关 Mock 与真实后端隔离的核心测试保留。 |
| the explicit local sample works offline with zero real quota, asks for no upload consent and stays visibly marked as a demo | 原固定样例按钮退出主界面；改为无配置普通书写、手工 LaTeX 草稿和本地多项式核对，均零模型请求。Mock 不扣真实额度的服务行为仍由网关核心测试覆盖。 |
| provider and remaining real-service quota are visible both in the notebook and settings | 主界面常驻服务指标按计划收起；选定后端和连接在工具/设置展开验证，额度窗口与费用保护由网关核心测试、429 浏览器路径验证。 |
| Mathpix without credentials stops before consent or image upload and retains editable ink | 新共用配置预检的 missing configuration 浏览器场景；Mathpix 缺凭据且不扣额、不回落的专用网关核心测试保留。 |
| a server that incorrectly returns a simulated success cannot populate the real OCR result | `notebook-interaction` 的 simulated success 必须 failed、无 LaTeX/正式对象、没有一直 running。 |
| an exhausted real quota keeps the source and still permits an explicit local sample without another OCR request | `notebook-interaction` 的 429 后继续书写与手工草稿零请求；本地工具不依赖云额度。 |
| reviewRequired warns even without a confidence score or with 0.99, and preserves indefinite-integral and Holder candidates verbatim | `notebook-interaction` 的 raw Hölder/high confidence 与不定积分；默认待人工核对，原识别字符串保留，不添加积分限或答案。 |

## 原 page-workbench.spec.ts：15 项

| 原测试标题 | 新位置与语义 |
| --- | --- |
| whole-page draft needs independent consent, preserves ordered inline math and source, and survives reload and export | `notebook-interaction` 的 whole page 独立授权/隔离草稿；`draft-editor` 的结构编辑；`notebook-domain` 的完整备份往返与正式导出隔离。 |
| context suggestions are scoped, explicit, undoable and stale after target editing | `advanced-tools` 的所选上下文；`draft-editor` 的建议预览、采用、撤销和过期。 |
| failed task recovery never automatically creates another paid request; redo needs a separate confirmation and identity | `notebook-interaction` 的 GET-only 恢复；`draft-editor` 的 partial/unavailable/明确 redo；网关持久去重与重启测试保留。 |
| local Qwen extra tasks stay disabled while manual blocks, inline math, split and merge remain available | `providers-and-review` 的本地 Qwen；`draft-editor` 的纯本地块编辑、行内公式和拆合；服务任务能力表核心测试保留。 |
| organization creates a separate draft while preserving formulas and original conditions | `advanced-tools` 的 organize 保留条件公式并保存本篇 Draft；不再自动新建或跳转独立笔记。 |
| manual links use live local search and mark changed targets; proof assistance stays explicitly unverified | `advanced-tools` 的人工搜索、建立关联、打开目标、反向链接、修改/删页后实时结果与 changed/broken 状态（零服务请求）；`knowledge-notebook.test.ts` 补笔记/页面回收与原生撤销/重做后的检索和关系状态；证明 UI 仍显式未验证与单独采用。 |
| hosted login uses a tab-scoped session, account requests and an explicit origin migration guide | `pairing` 的 hosted 会话与退出；`hosted-auth` 和 `hosted.production` 的账号隔离；原 `HostedAccess` 的跨地址备份迁移说明保留。 |
| cancelled page tasks preserve ink, keep task identity and never restart on reload | `recognition-failure` 的 cancel/late reply，`draft-editor` 的未知任务查询，网关任务取消/重启核心测试。关闭面板或换笔记不再视为取消。 |
| polynomial verification is a separate exact local tool and never relabels AI proof suggestions | `advanced-tools` 的独立本地多项式、零服务请求；`polynomial-check.test.ts` 的精确支持范围与反例。 |
| mixed-page heading, list and image regions preserve structure, uncertainty and original pixels | `draft-editor` 的 mixed heading/list/image/derivation；完整原图在去重快照中保留。 |
| shared-context suggestions batch only checked valid targets and preserve unselected content | `draft-editor` 的 checked batch/shared canonical 冲突；页面模型原子提交核心测试保留。 |
| conflicting backup IDs require a current backup and explicit overwrite; cancelling keeps the edited note | `notebook-interaction` 的 phone backup conflict；`page-storage` 的冲突与无效导入事务保护。 |
| unchanged inline formula saves preserve canonical identities, sources and revisions; text edits reuse both formulas | `draft-editor` 的 inline editing 去重及未变不增版本；领域 canonical 公式核心测试。 |
| splitting between inline formulas and merging keeps both identities and sources, and splitting inside math is refused | `draft-editor` 的 splitting/merging 及公式内部拒绝；`draft-editing` 核心测试。 |
| context text and inline math suggestions preview without mutation, apply and undo atomically; inserting or deleting math requires manual editing | `draft-editor` 的 text/inline math suggestions；`page-model` 的 canonical patch、原子采用/撤销与外部公式拒绝。 |

## 保留的迁移与导出技术验证

原 `page-storage.spec.ts` 的三项仍运行，不依赖旧两标签或常驻面板：

- `schema 1 IndexedDB upgrade atomically keeps a recoverable original backup and preserved IDs`
- `failed import and conflicting IDs leave existing stored content intact`
- `invalid legacy data aborts the entire IndexedDB upgrade and keeps version 1 records`

原来源副本的两项在同名 `page-source-restore.spec.ts` 中重写：通过旧正式内容的页面入口点击“返回此块原稿”，覆盖独立恢复、来源身份保留、同修订号篡改拒绝。不是只调用 helper 代替 UI。

同一文件新增旧正式行内公式修改与重开，验证正文/公式的稳定 ID、来源身份和原笔迹继续保留。`knowledge-notebook.test.ts` 验证已删除正式页、回收笔记及原生撤销插入不再出现在本地搜索，也不会仍被关联视为有效；恢复或原生重做后按原 ID 恢复关系。

新 [siyuan-draft-isolation.test.ts](../tests/siyuan-draft-isolation.test.ts) 同时验证常规导出和思源原稿资产：使用 schema 3；未插入的草稿、任务、建议及其私有快照不上传；已插入正式对象的来源资源继续保留；完整用户备份仍包含原草稿。原思源块 ID、阅读顺序和重试不重复插入的测试继续运行。

## 验证范围

`butterfly-notebook.spec.ts` 通过实际宿主界面与离线原生引擎验证分页、公式预览放置、原生撤销/重做、编辑/移动、独立复制和重开。`notebook-races.spec.ts` 专门暂扣真实资源请求和原生消息，验证过期初始化隔离、公式提交期间切页保护、删除中间页后的可见排序。

`paper-snapshot.spec.ts` 检查完整 PNG 的实际像素，覆盖视口外笔迹和按实际尺寸测量的多行矩阵，防止固定截图高度裁切。`interaction-visual.spec.ts` 输出实际运行界面的六个关键状态和竖屏抽屉，使用明确的手工公式测试数据，不作为 OCR 效果证据。

`plugin-path.spec.ts` 保持真实思源插件子目录 URL 并禁止根资源兜底，检查实际原生写入在不切页、不手动 flush 时自动落库，记录立即保存中通知与后续变化事件，重开后核对完整笔迹。

100 篇、每篇 30 页的自动化用例只输出桌面 Edge 实验基线，不设定无依据的平板性能门槛，不视为笔压、掌触或真实设备延迟验收。视觉与交互回归、数据可靠性和模型真实质量分别记录。
