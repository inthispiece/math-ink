import katex from 'katex';
import 'katex/dist/katex.min.css';
import './style.css';
import { ButterflySession, LifecycleEpoch, type ButterflyDocument } from './butterfly-session';
import { requestJson } from './recognition-request';
import { FormulaReview, type ReviewServiceStatus } from './formula-review';
import { pairingFromUrl, canPairLocally, recognitionFailureMessage } from './pairing';
import { boundsOf, cropSelection, drawStroke, hitStroke, selectedStrokes, type Bounds, type Point, type Stroke } from './geometry';
import { bumpRevision, exportMarkdown, importNotes, isStale, loadNotes, loadSettings, newId, newNote, parseBackup, saveNote, saveSettings, type Formula, type Note, type NotebookBackup, type ModelProvider } from './model';

const icons = {
  pen: '<path d="m15 4 5 5-11 11-6 1 1-6Z"/><path d="m12 7 5 5"/>',
  lasso: '<path d="M6 18C2 16 2 11 5 7c3-4 12-5 15 0 5 8-4 14-10 12-3-1-3-5-1-6 2-1 4 1 3 3-1 3-4 5-6 6"/>',
  erase: '<path d="m16 3 6 6-12 12H5l-4-4Z"/><path d="m8 10 6 6M11 21h11"/>',
  hand: '<path d="M8 12V5a2 2 0 0 1 4 0v6-7a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 4-3 6-6 6h-2c-2 0-4-1-5-3l-4-5a2 2 0 0 1 3-2l2 2"/>',
  undo: '<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12h-4"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  cloud: '<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5 5 0 0 1 0 10h-2M12 21V11m-4 4 4-4 4 4"/>',
  settings: '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.5 5.5l2 2m9 9 2 2M5.5 18.5l2-2m9-9 2-2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
};
const icon = (name: keyof typeof icons) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${icons[name]}</svg>`;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<aside class="sidebar" aria-label="笔记导航">
  <a class="brand" href="#"><span class="brand-symbol">m<span>i</span></span><span>MathInk<small>数学手写笔记 · 本地实验</small></span></a>
  <button class="new-note" id="new-note"><span>＋</span> 新建笔记</button>
  <label class="search-box">${icon('search')}<input id="search" type="search" placeholder="搜索标题、标签、公式" aria-label="搜索笔记" /></label>
  <div class="list-heading"><span>我的笔记</span><span id="note-count">0</span></div>
  <nav id="note-list" class="note-list"></nav>
  <div class="sidebar-bottom"><div class="offline-dot"><i></i> 笔记保存在这台设备</div><p>写作可离线，识别按需联网。</p><button id="settings-open" class="text-button">${icon('settings')} 识别与设备设置</button><button id="restore-open" class="text-button">${icon('download')} 恢复 JSON 备份</button></div>
</aside>
<main class="workspace">
  <header class="topbar"><div class="breadcrumb">我的笔记 <span>/</span> <span id="crumb-title"></span></div><div class="top-actions"><span id="save-state" class="save-state" role="status">正在读取</span><button class="tool mobile-settings" id="settings-open-mobile" aria-label="打开识别与设备设置">${icon('settings')}</button><button class="button secondary small" id="export-open">${icon('download')} 导出</button></div></header>
  <section class="note-heading"><div><div class="eyebrow">从原稿到清晰的数学表达</div><input id="note-title" class="note-title" aria-label="笔记标题" placeholder="给笔记起个名字" maxlength="120"/><label class="tag-row"><span>标签</span><input id="note-tags" placeholder="如：分析、积分（逗号分隔）" aria-label="笔记标签，逗号分隔"/></label></div><div class="flow-label"><span>01 手写</span><i>→</i><span>02 圈选</span><i>→</i><span>03 整理</span></div></section>
  <div class="editor-tabs" role="tablist" aria-label="编辑方式"><button id="ink-tab" class="active" role="tab" aria-selected="true">手写原稿 <span id="stroke-count">0 笔</span></button><button id="organized-tab" role="tab" aria-selected="false">整理笔记 <span id="formula-count">0 公式</span></button></div>
  <section class="editor-layout" id="ink-editor">
    <div class="ink-column"><div class="toolbar" aria-label="手写工具"><div class="tool-group"><button class="tool active" data-tool="pen" title="钢笔 (P)" aria-label="钢笔" aria-pressed="true">${icon('pen')}</button><button class="tool" data-tool="lasso" title="套索 (L)" aria-label="圈选笔迹" aria-pressed="false">${icon('lasso')}</button><button class="tool" data-tool="eraser" title="整笔擦除 (E)" aria-label="整笔擦除" aria-pressed="false">${icon('erase')}</button><button class="tool" data-tool="pan" title="移动画布 (H)" aria-label="移动画布" aria-pressed="false">${icon('hand')}</button></div><span class="toolbar-divider"></span><label class="pen-width-label"><span>笔宽</span><input id="pen-width" type="range" min="1" max="9" value="3" aria-label="笔宽"/></label><button class="tool" id="undo" title="撤销 (Ctrl+Z)" aria-label="撤销">${icon('undo')}</button><div class="zoom-controls"><button id="zoom-out" aria-label="缩小画布">−</button><button id="zoom-reset" aria-label="重置画布">100%</button><button id="zoom-in" aria-label="放大画布">＋</button></div></div>
      <div class="canvas-status"><span class="mode-label" id="canvas-mode">实验画布</span><span id="canvas-caption">支持笔压 · 钢笔书写，套索圈选</span><button id="select-all" class="link-button">全选笔迹</button></div>
      <div class="paper-viewport" id="paper-viewport"><canvas id="ink-canvas" aria-label="手写画布：用钢笔书写，再用套索圈选公式"></canvas><div class="canvas-empty" id="canvas-empty"><div class="handwritten">∫ x² dx</div><h2>先写下你的数学</h2><p>在纸上书写，圈选一组笔迹，再把它整理为公式。<br/>此处是可操作的实验画布，Butterfly 集成单独验证。</p></div><div class="page-mark">MATHINK / 01</div></div>
      <div class="paper-footer"><span>第 1 页 · 原始笔迹始终保留</span><span id="selection-label">未圈选</span></div>
      <div id="butterfly-panel" hidden><p id="butterfly-status">正在检测本地 Butterfly 资源…</p><iframe id="butterfly-frame" title="本地 Butterfly 手写画布" sandbox="allow-scripts allow-same-origin"></iframe></div>
    </div>
    <aside class="recognition-panel" aria-label="公式识别与核对"><div class="panel-label">公式工作台</div><h2>把笔迹变成公式</h2><p class="panel-intro">只识别圈选的笔迹。原稿保留，确认后的 LaTeX 可以继续编辑。</p><div class="recognition-state" id="recognition-idle"><div class="selection-illustration">${icon('lasso')}<span>x² + y²</span></div><h3 id="selection-heading">圈选一个公式开始</h3><p id="selection-help">点击套索工具，沿公式画一圈。</p></div><div id="recognition-preview" hidden><div class="preview-label">原始选区</div><img id="source-image" alt="本次选中的原始笔迹"/><div id="provider-badge" class="provider-badge"></div><label class="preview-label" for="latex-input">LaTeX · 可直接修改</label><textarea id="latex-input" rows="5" spellcheck="false" placeholder="识别结果会显示在这里"></textarea><div class="symbol-buttons" aria-label="插入常用数学符号"><button data-symbol="\\frac{}{}">分数</button><button data-symbol="\\sqrt{}">根号</button><button data-symbol="\\int_{a}^{b}">积分</button><button data-symbol="\\sum_{n=1}^{\\infty}">求和</button><button data-symbol="\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}">矩阵</button></div><div class="preview-label">排版预览</div><div class="math-preview" id="math-preview"></div><p class="notice" id="recognition-warning" hidden></p><div class="confirmation-actions"><button id="confirm-formula" class="button primary">确认并整理 ${icon('arrow')}</button><button id="cancel-formula" class="button secondary">取消</button></div></div><div class="recognition-bottom"><button id="recognize" class="button primary full" disabled>${icon('cloud')} 识别圈选公式</button><button id="retry" class="link-button" hidden>重试当前选区</button><div class="privacy-note">仅上传选区图片。首次使用需同意联网识别。</div><div class="service-status" id="service-status">识别服务尚未检测</div></div><div class="confirmed-list" id="confirmed-list"></div></aside>
  </section>
  <section id="organized-editor" class="organized-editor" hidden><div class="organized-main"><div class="organized-heading"><h2>让推导有自己的结构</h2><div class="template-buttons"><button data-template="definition">＋ 定义</button><button data-template="theorem">＋ 定理</button><button data-template="proof">＋ 证明</button></div></div><label class="preview-label" for="markdown-input">Markdown 正文</label><textarea id="markdown-input" placeholder="记录定义、条件、证明思路…\n\n用 [[标题]] 记下关联笔记。首版以 Markdown 保存。" spellcheck="false"></textarea><div class="organized-formulas" id="organized-formulas"></div></div><aside class="organization-help"><div class="panel-label">数学笔记</div><h3>原稿与结论，保持关联</h3><p>每个公式记录来源笔迹和修订号。点击「返回原稿」即可定位。</p><p>改动原稿后，旧公式会提示重新核对。已确认的内容不会被自动替换。</p><button id="backup" class="button secondary full">导出完整备份</button></aside></section>
  <footer class="workspace-footer">MathInk 0.1 · 本地实验版<span>当前画布与原生应用仍需真机验收</span></footer>
</main>
<div class="toast" id="toast" role="status" hidden></div>
<dialog id="settings-dialog"><form id="settings-form"><div class="dialog-heading"><div><div class="eyebrow">本机设置</div><h2>识别与设备</h2></div><button type="button" class="dialog-close" data-close="settings-dialog" aria-label="关闭设置">×</button></div><label class="field">识别服务地址<input id="gateway-url" type="url" required placeholder="http://localhost:8787"/></label><label class="field">局域网配对令牌<input id="pairing-token" type="password" autocomplete="off" placeholder="服务端生成的配对令牌"/></label><p class="field-help">这是连接自有识别服务的令牌。Mathpix 密钥只配置在服务端。</p><label class="field">手写引擎<select id="ink-mode"><option value="experimental">实验画布（现在可用）</option><option value="butterfly">本地 Butterfly（需构建与桥接）</option></select></label><label class="check-field"><input type="checkbox" id="cloud-consent"/><span>允许上传我圈选的笔迹图片进行识别。真实模式由服务端调用 Mathpix；仅在点击识别时上传选区。模拟模式返回固定样例。</span></label><p class="field-help">撤销同意后仍可继续写笔记。笔记保存在当前浏览器，请定期导出备份。</p><div class="dialog-actions"><button type="button" id="health-check" class="button secondary">检查服务连接</button><button type="submit" class="button primary">保存设置</button></div></form></dialog>
<dialog id="consent-dialog"><div class="eyebrow">仅在你点击识别时联网</div><h2>上传本次圈选的公式？</h2><p>只上传选中的笔迹图片。真实识别由你的服务端转发到 Mathpix，供应商处理规则请查看项目隐私说明。笔记内容和其他笔迹不会随请求发送。</p><p>同意状态会保存在本机，可随时在设置中撤销。</p><div class="dialog-actions"><button id="consent-refuse" class="button secondary">继续离线书写</button><button id="consent-allow" class="button primary">同意并识别</button></div></dialog>
<dialog id="export-dialog"><div class="dialog-heading"><h2>导出笔记</h2><button class="dialog-close" data-close="export-dialog" aria-label="关闭导出">×</button></div><p>文本导出便于整理；完整 JSON 备份包含可继续编辑的原始笔迹。</p><div class="export-buttons"><button id="export-latex" class="button secondary">当前笔记 · LaTeX</button><button id="export-markdown" class="button secondary">当前笔记 · Markdown</button><button id="export-backup" class="button primary">所有笔记 · 完整 JSON</button><button id="restore-from-export" class="link-button">恢复已有 JSON 备份</button></div></dialog>
<input type="file" id="restore-file" accept=".json,application/json" hidden />`;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const providerLabel = (provider: string) => ({ deepseek: 'DeepSeek 云模型', ollama: '本地 Qwen（Ollama）', mathpix: 'Mathpix' }[provider] || provider);
const providerField = document.createElement('label'); providerField.className = 'field';
providerField.innerHTML = '模型后端（切换立即生效）<select id="ocr-provider"><option value="deepseek">DeepSeek 云模型</option><option value="ollama">本地 Qwen（Ollama，实验）</option><option value="mathpix">Mathpix（转写）</option></select>';
const localModelQuality = document.createElement('p'); localModelQuality.id = 'local-model-quality'; localModelQuality.className = 'field-help';
localModelQuality.textContent = '本地 Qwen 为实验功能：小模型实测复杂公式和数学检查可能失准，请逐项核对。';
$('ink-mode').closest('label')!.before(providerField, localModelQuality);
$('recognize').innerHTML = `${icon('cloud')} 转写为 LaTeX`;
$('retry').textContent = '重新转写（可能再次计费）';
document.querySelector('.recognition-panel .panel-intro')!.textContent = '先将选区原样转写为 LaTeX。检查公式单独发起，建议需你核对和采用。';
document.querySelector('.privacy-note')!.textContent = '转写只发送选区；检查只发送公式与手动条件。云服务分别征求同意，本地模型不发送到云端。';
$('cloud-consent').nextElementSibling!.textContent = '允许当前云后端接收我点击转写的选区图片（按后端分别授权）。公式检查会另行确认。';
$('consent-dialog').innerHTML = '<div class="eyebrow">仅在你点击转写时上传选区</div><h2>上传本次圈选的公式？</h2><p id="transcription-consent-description"></p><p>只发送本次选区图片，不发送笔记正文。转写不会主动求解或补全公式；检查公式是单独的操作。</p><div class="dialog-actions"><button id="consent-refuse" class="button secondary">继续离线书写</button><button id="consent-allow" class="button primary">同意并转写</button></div>';
const serviceInfo = document.createElement('section');
serviceInfo.className = 'recognition-service'; serviceInfo.setAttribute('aria-live', 'polite');
serviceInfo.innerHTML = '<strong id="recognition-mode">正在检查真实识别配置</strong><p id="recognition-mode-detail">笔记可离线编辑。固定样例演示不识别你的笔迹。</p><p id="quota-summary">正在读取额度信息…</p><button type="button" id="setup-recognition" class="link-button">配置真实识别与查看开通步骤</button>';
document.querySelector('.recognition-panel .panel-intro')!.after(serviceInfo);
const demoButton = document.createElement('button');
demoButton.id = 'demo-recognition'; demoButton.type = 'button'; demoButton.className = 'link-button';
demoButton.textContent = '查看固定样例演示'; demoButton.disabled = true;
$('recognize').after(demoButton);
const manualButton = document.createElement('button'); manualButton.id = 'manual-formula'; manualButton.type = 'button'; manualButton.className = 'link-button'; manualButton.textContent = '手工输入 LaTeX'; demoButton.after(manualButton);
const serviceDetails = document.createElement('div'); serviceDetails.id = 'service-details'; serviceDetails.className = 'service-details'; serviceDetails.setAttribute('aria-live', 'polite');
const setupHelp = document.createElement('p'); setupHelp.className = 'field-help';
setupHelp.innerHTML = '在电脑服务端 .env 配置 DeepSeek 密钥、Ollama 模型或 Mathpix API。应用内只选择后端，不填写供应商密钥。本地 Qwen 需电脑保持运行 Ollama；转写与检查是独立操作。<a href="./ai-setup.html" target="_blank" rel="noopener">查看 DeepSeek 与本地 Qwen 配置说明</a>。';
document.querySelector('#settings-form .dialog-actions')!.before(serviceDetails, setupHelp);
const pairLocalButton = document.createElement('button');
pairLocalButton.id = 'pair-local'; pairLocalButton.type = 'button'; pairLocalButton.className = 'button secondary';
pairLocalButton.textContent = '自动配对本机服务'; pairLocalButton.hidden = true;
document.querySelector('#settings-form .dialog-actions')!.prepend(pairLocalButton);
const settings = loadSettings();
let pairingLinkError = '';
function consumePairingLink(): boolean {
  const pair = pairingFromUrl(location.href);
  if (!pair) return false;
  settings.gatewayUrl = pair.gatewayUrl; settings.pairingToken = pair.token;
  window.history.replaceState(null, '', pair.cleanUrl); saveSettings(settings);
  return true;
}
try { consumePairingLink(); } catch (error) { pairingLinkError = (error as Error).message; }
saveSettings(settings);
let notes: Note[] = [], note: Note;
let tool: 'pen' | 'lasso' | 'eraser' | 'pan' = 'pen';
let selection = new Set<string>();
let activeStroke: Stroke | null = null;
let lasso: Point[] = [];
let gesturePointer: number | null = null;
let gesturePointerType = '';
let eraserDirty = false;
const touchPointers = new Map<number, { x: number; y: number }>();
let pinch: { distance: number; zoom: number; worldX: number; worldY: number } | null = null;
let gestureOrigin = { x: 0, y: 0, panX: 0, panY: 0 };
let zoom = 1, panX = 0, panY = 0;
let history: Stroke[][] = [];
let toastTimer: ReturnType<typeof setTimeout>;
let pending: { imageBase64: string; imageUrl: string; bounds: Bounds; strokeIds: string[]; revision: number; requestId: string; butterfly: boolean; sourcePage?: string; butterflyRevision?: string; butterflySession?: EmbeddedButterfly; provider?: string; simulated?: boolean } | null = null;
let recognizing = false;
let activeRecognition: { note: Note; sequence: number; provider: ModelProvider; previousLatex: string; controller: AbortController } | null = null;
let confirming = false;
let saveSerial = Promise.resolve();
let operationSequence = 0;
let butterflyReady = false;
interface EmbeddedButterfly { frame: HTMLIFrameElement; target: Note; epoch: number; controller: ButterflySession; retiring?: Promise<boolean> }
const butterflyEpoch = new LifecycleEpoch();
const butterflySessions = new Set<EmbeddedButterfly>();
let activeButterflySession: EmbeddedButterfly | null = null;
const canvas = $<HTMLCanvasElement>('ink-canvas');
const viewport = $('paper-viewport');
const context = canvas.getContext('2d')!;
const formulaReview = new FormulaReview({
  parent: $('recognition-preview'),
  state: () => ({ noteId: note?.id || '', sourceRevision: note?.revision || 0, provider: settings.provider, latex: $<HTMLTextAreaElement>('latex-input').value, gateway: settings.gatewayUrl, token: settings.pairingToken.trim(), installationId: settings.installationId }),
  status: signal => readServiceStatus(settings.gatewayUrl, signal),
  adopt: latex => { $<HTMLTextAreaElement>('latex-input').value = latex; renderMath($('math-preview'), latex); $<HTMLButtonElement>('confirm-formula').disabled = !pending; },
  changed: () => void refreshServiceInfo(),
  available: () => !recognizing,
});

function toast(message: string): void { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function saveCurrent(): void {
  note.updatedAt = new Date().toISOString();
  const currentNote = structuredClone(note);
  $('save-state').textContent = '正在保存…';
  saveSerial = saveSerial.then(() => saveNote(currentNote)).then(() => { $('save-state').textContent = '已保存到本机'; }).catch(error => { $('save-state').textContent = '保存失败'; toast(error.message); });
}
function draw(): void {
  if (!note) return;
  const dpr = window.devicePixelRatio || 1;
  const width = viewport.clientWidth, height = viewport.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.save(); context.translate(panX, panY); context.scale(zoom, zoom);
  note.strokes.forEach(stroke => drawStroke(context, stroke));
  if (activeStroke) drawStroke(context, activeStroke);
  const bounds = boundsOf(note.strokes.filter(s => selection.has(s.id)), 8);
  if (bounds) { context.strokeStyle = '#58806f'; context.lineWidth = 1.5 / zoom; context.setLineDash([6 / zoom, 5 / zoom]); context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height); context.setLineDash([]); }
  if (lasso.length) { context.strokeStyle = '#58806f'; context.lineWidth = 1.5 / zoom; context.setLineDash([5 / zoom, 4 / zoom]); context.beginPath(); lasso.forEach((p, index) => index === 0 ? context.moveTo(p.x, p.y) : context.lineTo(p.x, p.y)); context.stroke(); context.setLineDash([]); }
  context.restore();
  $('canvas-empty').hidden = note.strokes.length > 0 || activeStroke !== null;
  $('stroke-count').textContent = settings.inkMode === 'butterfly' ? 'Butterfly' : `${note.strokes.length} 笔`;
  $('formula-count').textContent = `${note.formulas.length} 公式`;
  $('zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
}
function pointerPoint(event: PointerEvent): Point { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left - panX) / zoom, y: (event.clientY - rect.top - panY) / zoom, pressure: event.pointerType === 'pen' ? (event.pressure || 0.5) : 0.5 }; }
function snapshot(): void { history.push(structuredClone(note.strokes)); if (history.length > 35) history.shift(); }
function sourceChanged(): void { formulaReview.invalidate('原稿已改变，请重新检查公式'); bumpRevision(note); saveCurrent(); draw(); renderFormulas(); updateSelection(); }
function updateSelection(): void {
  const butterfly = settings.inkMode === 'butterfly';
  const count = butterfly ? 0 : selection.size;
  $('selection-label').textContent = count ? `已圈选 ${count} 笔` : '未圈选';
  $('selection-heading').textContent = count ? `已选中 ${count} 笔，准备识别` : '圈选一个公式开始';
  $('selection-help').textContent = butterfly ? '使用下方画布内的套索工具，沿公式画一圈。' : count ? '识别图片仅包含这些笔迹。' : '点击套索工具，沿公式画一圈。';
  $<HTMLButtonElement>('recognize').disabled = recognizing || (settings.inkMode === 'experimental' ? count === 0 : !butterflyReady);
  $<HTMLButtonElement>('demo-recognition').disabled = $<HTMLButtonElement>('recognize').disabled;
  formulaReview.update();
}
function setTool(value: typeof tool): void { tool = value; document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => { const active = button.dataset.tool === tool; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }); canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair'; }
function endGesture(event: PointerEvent): void {
  if (event.pointerType === 'touch') {
    touchPointers.delete(event.pointerId); pinch = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const remaining = touchPointers.entries().next().value;
    if (remaining) { gesturePointer = remaining[0]; gesturePointerType = 'touch'; gestureOrigin = { x: remaining[1].x, y: remaining[1].y, panX, panY }; return; }
  }
  if (gesturePointer !== event.pointerId) return;
  if (activeStroke) { note.strokes.push(activeStroke); activeStroke = null; sourceChanged(); }
  if (eraserDirty) { eraserDirty = false; sourceChanged(); }
  if (tool === 'lasso' && lasso.length) { selection = new Set(selectedStrokes(note.strokes, lasso).map(s => s.id)); lasso = []; updateSelection(); draw(); if (!selection.size) toast('这次圈选没有笔迹，请把公式完整圈入'); }
  gesturePointer = null;
  gesturePointerType = '';
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
canvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch') {
    if (gesturePointerType === 'pen') return;
    touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); canvas.setPointerCapture(event.pointerId);
    if (touchPointers.size === 2) { const [a, b] = [...touchPointers.values()]; const rect = canvas.getBoundingClientRect(); const x = (a.x + b.x) / 2 - rect.left, y = (a.y + b.y) / 2 - rect.top; pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom, worldX: (x - panX) / zoom, worldY: (y - panY) / zoom }; return; }
  }
  if (event.pointerType === 'pen' && gesturePointer !== null && gesturePointerType === 'touch') { for (const pointer of touchPointers.keys()) if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer); touchPointers.clear(); pinch = null; gesturePointer = null; }
  if (event.button !== 0 || gesturePointer !== null) return;
  gesturePointer = event.pointerId; canvas.setPointerCapture(event.pointerId);
  gesturePointerType = event.pointerType;
  gestureOrigin = { x: event.clientX, y: event.clientY, panX, panY };
  if (event.pointerType === 'touch' || tool === 'pan') return;
  event.preventDefault();
  const p = pointerPoint(event);
  if (tool === 'pen') { snapshot(); activeStroke = { id: newId(), color: '#293630', width: Number($<HTMLInputElement>('pen-width').value), points: [p] }; }
  if (tool === 'lasso') { selection.clear(); lasso = [p]; }
  if (tool === 'eraser') { const remaining = note.strokes.filter(s => !hitStroke(s, p, 12 / zoom)); if (remaining.length !== note.strokes.length) { snapshot(); note.strokes = remaining; selection = new Set([...selection].filter(id => remaining.some(s => s.id === id))); eraserDirty = true; } }
  draw();
});
canvas.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch' && touchPointers.has(event.pointerId)) {
    touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && touchPointers.size >= 2) { event.preventDefault(); const [a, b] = [...touchPointers.values()]; const rect = canvas.getBoundingClientRect(); zoom = Math.max(0.3, Math.min(4, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance)); panX = (a.x + b.x) / 2 - rect.left - pinch.worldX * zoom; panY = (a.y + b.y) / 2 - rect.top - pinch.worldY * zoom; draw(); return; }
  }
  if (gesturePointer !== event.pointerId) return;
  event.preventDefault();
  if (event.pointerType === 'touch' || tool === 'pan') { panX = gestureOrigin.panX + event.clientX - gestureOrigin.x; panY = gestureOrigin.panY + event.clientY - gestureOrigin.y; draw(); return; }
  const coalesced = event.getCoalescedEvents?.();
  const events = coalesced?.length ? coalesced : [event];
  events.forEach(part => { const p = pointerPoint(part); if (activeStroke) activeStroke.points.push(p); if (tool === 'lasso') lasso.push(p); if (tool === 'eraser') { const remaining = note.strokes.filter(s => !hitStroke(s, p, 12 / zoom)); if (remaining.length !== note.strokes.length) { if (!eraserDirty) snapshot(); note.strokes = remaining; selection = new Set([...selection].filter(id => remaining.some(s => s.id === id))); eraserDirty = true; } } });
  draw();
});
canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', endGesture);
canvas.addEventListener('wheel', event => { event.preventDefault(); if (event.ctrlKey || event.metaKey) changeZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.offsetX, event.offsetY); else { panX -= event.deltaX; panY -= event.deltaY; draw(); } }, { passive: false });
new ResizeObserver(draw).observe(viewport);
function changeZoom(factor: number, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2): void { const next = Math.max(0.3, Math.min(4, zoom * factor)); panX = x - (x - panX) * next / zoom; panY = y - (y - panY) * next / zoom; zoom = next; draw(); }
function renderNotes(): void {
  const search = $<HTMLInputElement>('search').value.trim().toLowerCase();
  const filtered = notes.filter(n => `${n.title} ${n.tags.join(' ')} ${n.formulas.map(f => f.latex).join(' ')}`.toLowerCase().includes(search)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('note-count').textContent = String(notes.length);
  const list = $('note-list'); list.replaceChildren();
  filtered.forEach(n => { const button = document.createElement('button'); button.className = `note-item${n.id === note?.id ? ' active' : ''}`; button.setAttribute('aria-current', n.id === note?.id ? 'page' : 'false'); const title = document.createElement('strong'); title.textContent = n.title || '未命名笔记'; const preview = document.createElement('span'); preview.textContent = n.tags.length ? n.tags.join(' · ') : '手写原稿与公式'; const meta = document.createElement('small'); meta.textContent = `${n.formulas.length} 公式 · ${new Date(n.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`; button.append(title, preview, meta); button.addEventListener('click', () => switchNote(n)); list.append(button); });
  if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'list-empty'; empty.textContent = '没有匹配的笔记'; list.append(empty); }
}
async function switchNote(target: Note): Promise<boolean> {
  const epoch = butterflyEpoch.begin();
  if (activeButterflySession && activeButterflySession.target.id !== target.id) {
    if (!await retireButterflySession()) { reactivateButterflyAfterFailure(); return false; }
  }
  if (!butterflyEpoch.current(epoch)) return false;
  stopRecognition(); formulaReview.invalidate('已切换笔记，请重新检查', true); $<HTMLDialogElement>('consent-dialog').close();
  $<HTMLTextAreaElement>('latex-input').value = '';
  operationSequence++; note = target; selection.clear(); history = []; pending = null; activeStroke = null; lasso = []; zoom = 1; panX = panY = 0; $<HTMLInputElement>('note-title').value = note.title; $<HTMLInputElement>('note-tags').value = note.tags.join('、'); $<HTMLTextAreaElement>('markdown-input').value = note.markdown; $('crumb-title').textContent = note.title; $('recognition-idle').hidden = false; $('recognition-preview').hidden = true; $('retry').hidden = true; renderNotes(); renderFormulas(); updateSelection(); draw(); if (settings.inkMode === 'butterfly') void configureInkMode(); return true; }
function renderMath(container: HTMLElement, latex: string): void { try { katex.render(latex, container, { displayMode: true, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000 }); } catch (error) { container.textContent = `请检查公式语法：${(error as Error).message.replace(/^KaTeX parse error: /, '')}`; container.classList.add('math-error'); return; } container.classList.remove('math-error'); }
function formulaCard(formula: Formula, index: number, compact = false): HTMLElement {
  const card = document.createElement('article'); card.className = `formula-card${compact ? ' compact' : ''}`;
  const heading = document.createElement('div'); heading.className = 'formula-card-heading'; const title = document.createElement('span'); title.textContent = `公式 ${String(index + 1).padStart(2, '0')}`; const tag = document.createElement('span'); tag.className = isStale(note, formula) ? 'stale-label' : 'source-label'; tag.textContent = isStale(note, formula) ? '原稿已变化' : '已关联原稿'; heading.append(title, tag);
  const math = document.createElement('div'); math.className = 'formula-math'; renderMath(math, formula.latex);
  const actions = document.createElement('div'); actions.className = 'formula-actions'; const back = document.createElement('button'); back.className = 'link-button'; back.innerHTML = `${icon('back')} 返回原稿`; back.addEventListener('click', () => { showTab('ink'); selection = new Set(formula.sourceStrokeIds); const bounds = formula.sourceBounds; zoom = Math.min(1.6, Math.max(0.4, (viewport.clientWidth - 80) / Math.max(1, bounds.width))); panX = viewport.clientWidth / 2 - (bounds.x + bounds.width / 2) * zoom; panY = Math.max(70, viewport.clientHeight / 3) - (bounds.y + bounds.height / 2) * zoom; updateSelection(); draw(); if (formula.butterfly) void locateButterflySource(formula); });
  const edit = document.createElement('button'); edit.className = 'link-button'; edit.textContent = '编辑 LaTeX'; edit.addEventListener('click', () => { const textarea = document.createElement('textarea'); textarea.className = 'formula-edit'; textarea.value = formula.latex; textarea.setAttribute('aria-label', '编辑已保存公式'); const done = document.createElement('button'); done.className = 'button secondary small'; done.textContent = '保存修改'; done.addEventListener('click', () => { if (!textarea.value.trim()) return toast('公式不能为空'); formula.latex = textarea.value.trim(); saveCurrent(); renderFormulas(); renderNotes(); }); math.replaceWith(textarea); actions.replaceChildren(done); textarea.focus(); }); actions.append(back, edit);
  card.append(heading, math, actions); if (formula.simulated) { const mock = document.createElement('small'); mock.className = 'mock-footnote'; mock.textContent = '固定演示样例，与原稿无关；未经过真实识别'; card.append(mock); } return card;
}
function renderFormulas(): void { const confirmed = $('confirmed-list'); const organized = $('organized-formulas'); confirmed.replaceChildren(); organized.replaceChildren(); if (note.formulas.length) { const label = document.createElement('div'); label.className = 'panel-label'; label.textContent = '已整理的公式'; confirmed.append(label); note.formulas.forEach((formula, index) => { confirmed.append(formulaCard(formula, index, true)); organized.append(formulaCard(formula, index)); }); } else { const empty = document.createElement('div'); empty.className = 'organized-empty'; empty.textContent = '圈选并确认的公式将出现在这里，同时保留原笔迹链接。'; organized.append(empty); } $('formula-count').textContent = `${note.formulas.length} 公式`; }
function showTab(tab: 'ink' | 'organized'): void { $('ink-editor').hidden = tab !== 'ink'; $('organized-editor').hidden = tab !== 'organized'; $('ink-tab').classList.toggle('active', tab === 'ink'); $('organized-tab').classList.toggle('active', tab === 'organized'); $('ink-tab').setAttribute('aria-selected', String(tab === 'ink')); $('organized-tab').setAttribute('aria-selected', String(tab === 'organized')); if (tab === 'ink') requestAnimationFrame(draw); }

async function recognize(retry = false, demo = false): Promise<void> {
  if (recognizing) return;
  formulaReview.invalidate('开始新的转写，旧检查结果已失效');
  const currentNote = note;
  const sequence = operationSequence;
  const attempt = { note: currentNote, sequence, provider: settings.provider, previousLatex: $<HTMLTextAreaElement>('latex-input').value, controller: new AbortController() };
  activeRecognition = attempt;
  recognizing = true; updateSelection(); $('recognize').textContent = '正在识别…'; $('service-status').textContent = '正在连接识别服务';
  try {
    if (!retry) { pending = null; $('recognition-preview').hidden = true; $('recognition-idle').hidden = false; }
    if (!retry || !pending) {
      if (settings.inkMode === 'butterfly') {
        const embedded = activeButterflySession;
        if (!embedded?.controller.ready) throw new Error('Butterfly 原稿尚未恢复，请等待画布就绪');
        const chosen = await butterflyRequest('getSelectedInk', {}, embedded) as { strokeIds: string[]; bounds: Bounds; revision: string; page: string };
        if (!chosen.strokeIds?.length) throw new Error('请先在 Butterfly 中圈选笔迹');
        const rendered = await butterflyRequest('renderSelectedInk', { strokeIds: chosen.strokeIds, revision: chosen.revision }, embedded) as { pngBase64: string };
        if (!rendered.pngBase64) throw new Error('Butterfly 未返回有效的选区图片');
        if (!isCurrentRecognition(attempt)) return;
        pending = { imageBase64: rendered.pngBase64, imageUrl: `data:image/png;base64,${rendered.pngBase64}`, bounds: chosen.bounds, strokeIds: chosen.strokeIds, revision: currentNote.revision, sourcePage: chosen.page, butterflyRevision: chosen.revision, butterflySession: embedded, requestId: newId(), butterfly: true };
      } else { const selected = note.strokes.filter(s => selection.has(s.id)); const crop = cropSelection(selected); pending = { ...crop, strokeIds: selected.map(s => s.id), revision: note.revision, requestId: newId(), butterfly: false }; }
    }
    if (!isCurrentRecognition(attempt)) return;
    const chosen = pending!;
    $('recognition-preview').hidden = false; $('recognition-idle').hidden = true; $('source-image').hidden = false; $('source-image').previousElementSibling!.removeAttribute('hidden'); $<HTMLImageElement>('source-image').src = chosen.imageUrl;
    $('math-preview').textContent = '正在检查真实识别配置…'; $('provider-badge').textContent = '正在检查服务'; $('recognition-warning').hidden = true; $<HTMLButtonElement>('confirm-formula').disabled = true;
    if (demo) {
      chosen.provider = 'local-demo'; chosen.simulated = true;
      const example = '\\int_0^1 x^2\\,dx=\\frac{1}{3}';
      $<HTMLTextAreaElement>('latex-input').value = example;
      $('provider-badge').textContent = '本地演示 · 固定样例，未读取笔迹'; $('provider-badge').classList.add('mock');
      $('recognition-warning').textContent = '这是固定的排版与整理示例，与左侧笔迹无关。没有上传选区，也不消耗真实识别额度。'; $('recognition-warning').hidden = false;
      renderMath($('math-preview'), example); $<HTMLButtonElement>('confirm-formula').disabled = false;
      $('service-status').textContent = '仅演示操作流程，未进行手写识别'; $('retry').hidden = true;
      return;
    }
    const status = await readServiceStatus(settings.gatewayUrl, attempt.controller.signal);
    if (!isCurrentRecognition(attempt) || pending !== chosen) return;
    applyServiceStatus(status);
    if (status.simulated !== false || status.provider === 'mock') throw new RecognitionSetupError('真实手写识别尚未启用：当前服务仅提供固定样例。请配置真实模型后转写，示例不能用于识别你的公式');
    if (status.provider !== settings.provider) throw new RecognitionSetupError('服务尚未支持所选模型，请更新或检查服务配置后重试');
    if (!status.configured) throw new RecognitionSetupError(`真实识别尚未配置：请在电脑 .env 配置 ${providerLabel(settings.provider)} 的凭据或本地模型。尚未上传笔迹，也未扣减额度`);
    if (status.capabilities?.transcribe === false) throw new RecognitionSetupError('当前模型不支持图片转写；可选择其他后端，或手工输入 LaTeX 后单独检查公式');
    if (!status.local && !settings.cloudConsentProviders.includes(settings.provider)) { $('math-preview').textContent = '等待你同意上传本次选区，原稿已保留'; $('provider-badge').textContent = '尚未上传'; $('transcription-consent-description').textContent = `将本次选区发送给 ${providerLabel(settings.provider)}。此前对其他云后端的同意不会沿用。`; $<HTMLDialogElement>('consent-dialog').showModal(); return; }
    $<HTMLTextAreaElement>('latex-input').value = ''; $('math-preview').textContent = '等待识别结果…'; $('provider-badge').textContent = '正在转写';
    const { response, data: result } = await requestJson<{ status?: string; latex?: string; confidence?: number; reviewRequired?: boolean; uncertainSymbols?: string[]; provider?: string; simulated?: boolean; error?: { code?: string; message?: string } | string; message?: string }>(`${settings.gatewayUrl.replace(/\/$/, '')}/v1/recognize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(settings.pairingToken.trim() ? { Authorization: `Bearer ${settings.pairingToken.trim()}` } : {}) },
      body: JSON.stringify({ clientRequestId: chosen.requestId, installationId: settings.installationId, provider: attempt.provider, imageBase64: chosen.imageBase64, sourceRevision: chosen.revision }), signal: attempt.controller.signal,
    }, { timeoutMs: (status.requestTimeoutMs ?? 30000) + 5000 });
    if (!isCurrentRecognition(attempt) || pending !== chosen) return;
    if (response.status === 401) throw new PairingError('服务尚未配对或令牌已失效，请打开启动窗口的配对链接，或在设置中重新配对');
    if (!result || !response.ok || result.status === 'error' || typeof result.latex !== 'string' || !result.latex.trim()) throw new Error(typeof result?.error === 'string' ? result.error : result?.error?.message || result?.message || `识别未完成（HTTP ${response.status}）`);
    if (result.simulated !== false || result.provider !== attempt.provider || /mock|demo/i.test(result.provider)) throw new RecognitionSetupError('服务返回了模拟样例或其他后端的结果，已拒绝采用。请检查服务后手动重试');
    chosen.provider = result.provider; chosen.simulated = false;
    $<HTMLTextAreaElement>('latex-input').value = result.latex;
    $('provider-badge').textContent = `${status.local ? '本地转写' : '联网识别'} · ${chosen.provider}${typeof result.confidence === 'number' ? ` · 置信度 ${Math.round(result.confidence * 100)}%` : ''}`;
    $('provider-badge').classList.toggle('mock', chosen.simulated);
    renderMath($('math-preview'), result.latex); $<HTMLButtonElement>('confirm-formula').disabled = false;
    if (note.revision !== chosen.revision) { $('recognition-warning').textContent = '原稿在识别期间已变化。这是之前选区的结果，请对照后确认。'; $('recognition-warning').hidden = false; }
    if (result.reviewRequired || (typeof result.confidence === 'number' && result.confidence < 0.8)) { $('recognition-warning').textContent = `${$('recognition-warning').hidden ? '' : $('recognition-warning').textContent + ' '}识别包含低置信度内容，请逐项对照原稿核对上下标、范数、积分限和多行结构；可直接修改 LaTeX。`; $('recognition-warning').hidden = false; }
    if (Array.isArray(result.uncertainSymbols) && result.uncertainSymbols.some(symbol => typeof symbol === 'string')) { $('recognition-warning').textContent = `${$('recognition-warning').hidden ? '' : $('recognition-warning').textContent + ' '}需核对的符号：${result.uncertainSymbols.filter(symbol => typeof symbol === 'string').slice(0, 30).join('、')}`; $('recognition-warning').hidden = false; }
    $('service-status').textContent = chosen.simulated ? '模拟模式已连接' : '识别完成，请核对'; $('retry').hidden = false;
  } catch (error) {
    if (!isCurrentRecognition(attempt)) return;
    const message = error instanceof Error ? error.message : '无法连接识别服务';
    const detail = recognitionFailureMessage(message);
    if (!$<HTMLTextAreaElement>('latex-input').value && attempt.previousLatex) $<HTMLTextAreaElement>('latex-input').value = attempt.previousLatex;
    toast(detail); $('service-status').textContent = detail;
    $('math-preview').textContent = `识别失败：${detail}`;
    $('provider-badge').textContent = '识别未完成'; $('provider-badge').classList.remove('mock');
    $('recognition-warning').textContent = '可以检查设置后手动重试，也可以取消并继续书写。不会自动重复调用识别。';
    $('recognition-warning').hidden = !pending;
    $<HTMLButtonElement>('confirm-formula').disabled = true;
    $('retry').hidden = !pending;
    if (error instanceof PairingError || error instanceof RecognitionSetupError) openSettings(error instanceof PairingError);
  } finally {
    if (activeRecognition === attempt) { activeRecognition = null; recognizing = false; updateSelection(); $('recognize').innerHTML = `${icon('cloud')} 转写为 LaTeX`; if (!demo) void refreshServiceInfo(); }
  }
}
function isCurrentRecognition(attempt: NonNullable<typeof activeRecognition>): boolean {
  return activeRecognition === attempt && attempt.note.id === note.id && attempt.sequence === operationSequence && attempt.provider === settings.provider;
}
function stopRecognition(): void {
  const attempt = activeRecognition;
  activeRecognition = null;
  if (!attempt) return;
  attempt.controller.abort(); recognizing = false;
  if (!$<HTMLTextAreaElement>('latex-input').value && attempt.previousLatex) { $<HTMLTextAreaElement>('latex-input').value = attempt.previousLatex; renderMath($('math-preview'), attempt.previousLatex); }
  $('service-status').textContent = '已停止等待识别，原稿已保留';
  $('recognize').innerHTML = `${icon('cloud')} 转写为 LaTeX`;
  $<HTMLButtonElement>('confirm-formula').disabled = true;
  updateSelection();
}
async function confirmFormula(): Promise<void> {
  if (!pending || recognizing || confirming) return;
  const latex = $<HTMLTextAreaElement>('latex-input').value.trim(); if (!latex) return toast('请先填写公式');
  const targetNote = note, chosen = pending;
  confirming = true; $<HTMLButtonElement>('confirm-formula').disabled = true;
  const formula: Formula = { id: newId(), latex, sourceStrokeIds: chosen.strokeIds, sourceRevision: chosen.revision, sourceBounds: chosen.bounds, sourcePage: chosen.sourcePage || 'default', sourceButterflyRevision: chosen.butterflyRevision, createdAt: new Date().toISOString(), provider: chosen.provider || 'manual', simulated: chosen.simulated || false, butterfly: chosen.butterfly };
  let insertionError = '';
  try {
    if (chosen.butterfly) { try { await butterflyRequest('insertMath', { latex, strokeIds: chosen.strokeIds, revision: chosen.butterflyRevision }, chosen.butterflySession); await saveButterflyDocument(false, chosen.butterflySession); } catch (error) { insertionError = `；Butterfly 插入失败：${(error as Error).message}`; } }
    targetNote.formulas.push(formula);
    if (targetNote.id === note.id) { saveCurrent(); renderFormulas(); renderNotes(); if (pending === chosen) cancelPreview(); }
    else await saveNote(structuredClone(targetNote));
    toast(`公式已整理，原笔迹仍保留${insertionError}`);
  } catch (error) { toast(`公式保存失败：${(error as Error).message}`); }
  finally { confirming = false; $<HTMLButtonElement>('confirm-formula').disabled = !pending; }
}
function cancelPreview(): void { stopRecognition(); formulaReview.invalidate('已取消当前公式检查'); pending = null; $('recognition-preview').hidden = true; $('recognition-idle').hidden = false; $('retry').hidden = true; }

function currentButterfly(embedded: EmbeddedButterfly): boolean {
  return activeButterflySession === embedded && butterflyEpoch.current(embedded.epoch) && embedded.target.id === note.id && settings.inkMode === 'butterfly';
}
async function butterflyRequest(type: string, payload: unknown, embedded = activeButterflySession): Promise<unknown> {
  if (!embedded?.controller.ready) throw new Error('本地 Butterfly 原稿尚未安全恢复，请等待画布就绪');
  return embedded.controller.request(type, payload);
}
async function persistButterflyDocument(target: Note, document: ButterflyDocument, changed: boolean): Promise<void> {
  const page = document.page || 'default';
  const revisions = target.butterflyPageRevisions || {};
  const previousRevision = Object.hasOwn(revisions, page) ? revisions[page] : target.butterflyPage === page ? target.butterflyRevision : target.formulas.filter(formula => formula.butterfly && (formula.sourcePage || 'default') === page && formula.sourceButterflyRevision).sort((a, b) => b.sourceRevision - a.sourceRevision)[0]?.sourceButterflyRevision;
  const updated = previousRevision !== undefined && previousRevision !== document.revision;
  target.butterflyData = document.data;
  target.butterflyRevision = document.revision;
  target.butterflyPage = page;
  target.butterflyPageRevisions = { ...revisions, [page]: document.revision };
  if (changed && updated) bumpRevision(target);
  target.updatedAt = new Date().toISOString();
  const snapshot = structuredClone(target);
  if (target.id === note.id) $('save-state').textContent = '正在保存原稿…';
  const task = saveSerial.catch(() => {}).then(() => saveNote(snapshot));
  saveSerial = task.catch(() => {});
  try {
    await task;
    if (target.id === note.id) { $('save-state').textContent = '已保存到本机'; renderFormulas(); }
  } catch (error) {
    if (target.id === note.id) $('save-state').textContent = '原稿保存失败';
    throw error;
  }
}
async function saveButterflyDocument(changed = true, embedded = activeButterflySession): Promise<void> {
  if (!embedded) throw new Error('本地 Butterfly 尚未加载');
  await embedded.controller.save(changed);
}
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  const embedded = [...butterflySessions].find(session => session.frame.contentWindow === event.source);
  if (!embedded) return;
  embedded.controller.receive(event.data);
});

function updateInkModePresentation(butterfly: boolean): void {
  document.querySelector<HTMLElement>('.toolbar')!.hidden = butterfly;
  document.querySelector<HTMLElement>('.paper-footer')!.hidden = butterfly;
  $('select-all').hidden = butterfly;
  $('canvas-mode').textContent = butterfly ? 'Butterfly 验证模式' : '实验画布';
  $('canvas-caption').textContent = butterfly ? '使用下方画布内的钢笔与套索工具书写、圈选' : '支持笔压 · 钢笔书写，套索圈选';
  $('stroke-count').textContent = butterfly ? 'Butterfly' : `${note.strokes.length} 笔`;
}
function reactivateButterflyAfterFailure(): void {
  const embedded = activeButterflySession;
  if (!embedded) return;
  embedded.epoch = butterflyEpoch.begin();
  settings.inkMode = 'butterfly'; saveSettings(settings);
  updateInkModePresentation(true);
  $('butterfly-panel').hidden = false; viewport.hidden = true;
  embedded.frame.hidden = false;
  embedded.frame.style.pointerEvents = embedded.controller.ready ? '' : 'none';
  butterflyReady = embedded.controller.ready; updateSelection();
}
async function retireButterflySession(): Promise<boolean> {
  const embedded = activeButterflySession;
  if (!embedded) return true;
  if (embedded.retiring) return embedded.retiring;
  embedded.frame.style.pointerEvents = 'none';
  embedded.retiring = (async () => {
    try {
      await embedded.controller.flush();
      embedded.controller.dispose(); butterflySessions.delete(embedded); embedded.frame.remove();
      if (activeButterflySession === embedded) activeButterflySession = null;
      return true;
    } catch (error) {
      $('save-state').textContent = '原稿保存失败';
      $('butterfly-status').textContent = '上一份原稿未成功保存，已保留原画布；请检查存储与连接后再次切换，或导出备份。';
      toast(`原稿尚未保存，已保留当前画布：${(error as Error).message}`);
      return false;
    } finally { embedded.retiring = undefined; }
  })();
  return embedded.retiring;
}
async function configureInkMode(): Promise<void> {
  if (activeRecognition) cancelPreview();
  const epoch = butterflyEpoch.begin();
  const target = note;
  const butterfly = settings.inkMode === 'butterfly';
  butterflyReady = false; updateSelection();
  if (!await retireButterflySession()) { reactivateButterflyAfterFailure(); return; }
  if (!butterflyEpoch.current(epoch) || target.id !== note.id || butterfly !== (settings.inkMode === 'butterfly')) return;
  $('butterfly-panel').hidden = !butterfly; viewport.hidden = butterfly;
  updateInkModePresentation(butterfly);
  const previousFrame = document.getElementById('butterfly-frame');
  const frame = document.createElement('iframe'); frame.id = 'butterfly-frame'; frame.title = '本地 Butterfly 手写画布'; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin'); frame.style.pointerEvents = 'none';
  if (previousFrame) previousFrame.replaceWith(frame); else $('butterfly-panel').append(frame);
  if (!butterfly) { updateSelection(); draw(); return; }
  try {
    const response = await fetch(new URL('vendor/butterfly/manifest.json', location.href));
    if (!butterflyEpoch.current(epoch) || target.id !== note.id || settings.inkMode !== 'butterfly') { frame.remove(); return; }
    if (!response.ok) throw new Error('尚未构建本地 Butterfly 资源');
    const manifest = await response.json() as { mathInkBridge?: number; entry?: string };
    if (!butterflyEpoch.current(epoch) || target.id !== note.id || settings.inkMode !== 'butterfly') { frame.remove(); return; }
    if (manifest.mathInkBridge !== 1) throw new Error('本地资源缺少 MathInk 圈选桥接扩展');
    const entry = (manifest.entry || 'vendor/butterfly/index.html').replace(/^\/vendor\//, 'vendor/');
    const url = new URL(entry, location.href); if (url.origin !== location.origin) throw new Error('Butterfly 资源必须与应用同源');
    const embedded = { frame, target, epoch } as EmbeddedButterfly;
    embedded.controller = new ButterflySession({
      newId,
      initialData: target.butterflyData ? [...target.butterflyData] : undefined,
      send: packet => { if (!frame.contentWindow) throw new Error('Butterfly 原稿窗口已关闭'); frame.contentWindow.postMessage(packet, location.origin); },
      persist: (document, changed) => persistButterflyDocument(target, document, changed),
      onState: phase => {
        if (!currentButterfly(embedded)) return;
        butterflyReady = phase === 'ready'; frame.style.pointerEvents = butterflyReady ? '' : 'none';
        if (phase === 'restoring') $('butterfly-status').textContent = '正在恢复原稿，重建完成前暂不开放书写…';
        if (phase === 'ready') $('butterfly-status').textContent = '本地 Butterfly 原稿已恢复；笔感仍需真机验证';
        updateSelection();
      },
      onError: error => {
        if (!currentButterfly(embedded)) return;
        $('save-state').textContent = '原稿保存失败';
        $('butterfly-status').textContent = `原稿备份保留，当前操作未完成：${error.message}`;
        toast(error.message);
      },
    });
    activeButterflySession = embedded; butterflySessions.add(embedded);
    frame.onload = () => { if (currentButterfly(embedded) && !embedded.controller.ready) $('butterfly-status').textContent = '本地资源已加载，等待 Butterfly 桥接就绪…'; };
    frame.src = `${url.pathname}#/embed?save=true&language=zh-Hans&fullScreen=layoutOnly`;
    $('butterfly-status').textContent = '本地 Butterfly 正在加载…';
  } catch (error) {
    if (!butterflyEpoch.current(epoch) || target.id !== note.id || settings.inkMode !== 'butterfly') { frame.remove(); return; }
    frame.removeAttribute('src'); $('butterfly-status').textContent = `${(error as Error).message}。请切回实验画布继续测试。`;
  }
  updateSelection(); draw();
}

async function locateButterflySource(formula: Formula): Promise<void> {
  const expectedNote = note;
  try {
    if (settings.inkMode !== 'butterfly') { settings.inkMode = 'butterfly'; saveSettings(settings); await configureInkMode(); }
    const embedded = activeButterflySession;
    if (!embedded || embedded.target.id !== expectedNote.id) throw new Error('本地 Butterfly 未构建，尚无法定位原稿页');
    await embedded.controller.whenReady();
    if (expectedNote.id !== note.id || !currentButterfly(embedded)) return;
    const result = await butterflyRequest('locateInk', { page: formula.sourcePage || 'default', strokeIds: formula.sourceStrokeIds, bounds: formula.sourceBounds }, embedded) as { foundStrokeIds?: string[]; sourceMissing?: boolean };
    toast(result.sourceMissing ? '已返回来源页，部分原笔迹已修改或删除，请对照原稿备份' : '已定位来源页与原笔迹');
  } catch (error) { toast(`原稿来源仍保留，当前无法自动定位：${(error as Error).message}`); }
}
const hostCalls = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window.parent || window.parent === window) return;
  const message = event.data;
  if (message?.type !== 'mathink:siyuan:result' || typeof message.requestId !== 'string') return;
  const call = hostCalls.get(message.requestId); if (!call) return;
  clearTimeout(call.timer); hostCalls.delete(message.requestId);
  message.ok ? call.resolve(message.result) : call.reject(new Error(message.error || '思源写入失败，原稿仍保存在本机'));
});
if (new URLSearchParams(location.search).get('host') === 'siyuan' && window.parent !== window) {
  const exportButton = document.createElement('button'); exportButton.className = 'button secondary full siyuan-export'; exportButton.textContent = '整理到思源'; $('recognition-bottom').append(exportButton);
  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true; exportButton.textContent = '正在写入思源…';
    try {
      const current = structuredClone(note);
      await new Promise((resolve, reject) => {
        const requestId = newId(); const timer = setTimeout(() => { hostCalls.delete(requestId); reject(new Error('思源插件没有确认写入，请检查插件连接')); }, 30000);
        hostCalls.set(requestId, { resolve, reject, timer });
        window.parent.postMessage({ type: 'mathink:siyuan', requestId, action: 'exportNote', payload: { note: current, markdown: exportMarkdown(current), butterflyData: current.butterflyData } }, location.origin);
      });
      toast('已整理到思源，原稿备份与公式来源已关联');
    } catch (error) { toast((error as Error).message); } finally { exportButton.disabled = false; exportButton.textContent = '整理到思源'; }
  });
}

if ((import.meta as ImportMeta & { env?: { PROD: boolean } }).env?.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).catch(() => { /* Offline writing still persists locally if this host cannot install a worker. */ });
}

function download(name: string, content: string, type = 'text/plain;charset=utf-8'): void { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function filename(): string { return (note.title || 'MathInk').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_'); }
function backup(): void { const value: NotebookBackup = { format: 'math-ink', schemaVersion: 1, exportedAt: new Date().toISOString(), notes }; download(`MathInk-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(value, null, 2), 'application/json'); toast('完整备份已导出'); }
class PairingError extends Error {}
class RecognitionSetupError extends Error {}

interface ServiceStatus extends ReviewServiceStatus { model?: string; providers?: { id: string; label: string; configured: boolean; local: boolean; model: string; transcribe: boolean; review: boolean }[] }
interface QuotaPeriod { limit: number | null; used: number; remaining: number | null; resetsAt: string | null }
interface ServiceUsage { quota: { enforced: boolean; installationDaily: QuotaPeriod; globalDaily: QuotaPeriod; globalMonthly: QuotaPeriod }; timeZone: string }
async function readServiceStatus(gateway: string, signal?: AbortSignal): Promise<ServiceStatus> {
  const endpoint = new URL('v1/status', gateway.endsWith('/') ? gateway : gateway + '/'); endpoint.searchParams.set('provider', settings.provider);
  const { response, data } = await requestJson<ServiceStatus>(endpoint.href, { signal }, { timeoutMs: 10000 });
  if (!response.ok || !data || typeof data.provider !== 'string' || typeof data.simulated !== 'boolean' || typeof data.configured !== 'boolean') throw new Error('无法读取识别服务状态，请检查服务地址并重启服务');
  return { ...data, local: data.provider === 'ollama' && data.local !== false, capabilities: data.capabilities ?? { transcribe: !data.simulated, review: ['deepseek', 'ollama'].includes(data.provider) } };
}
function applyServiceStatus(status: ServiceStatus): void {
  const simulated = status.simulated || status.provider === 'mock';
  $('recognition-mode').textContent = simulated ? '未启用真实识别 · 当前为演示服务' : status.configured ? `${providerLabel(status.provider)} · ${status.local ? '本地模型' : '真实识别已配置'}` : `真实识别未配置 · ${providerLabel(settings.provider)}`;
  $('recognition-mode-detail').textContent = simulated ? '固定样例与笔迹无关。演示操作使用下方独立按钮。' : status.local ? '本地 Qwen 不是模拟结果。需电脑持续运行 Ollama；图片与公式发送到你的电脑，不上传云端。首次加载模型可能需要等待，可随时取消。' : status.configured ? '转写原式，不主动求解。检查公式需另行发起，结果经你采用后才能保存。' : '在电脑 .env 配置所选后端的凭据或模型。未配置时不会上传笔迹或消耗额度。';
  serviceInfo.classList.toggle('unconfigured', simulated || !status.configured);
  $('retry').textContent = status.local ? '重新转写（本地）' : '重新转写（可能再次计费）';
  if (!simulated && status.configured && status.capabilities?.transcribe === false && status.capabilities.review) $('recognition-mode').textContent = `${providerLabel(status.provider)} · 仅公式检查可用`;
  if (status.model) $('recognition-mode-detail').textContent = `模型：${status.model}。${$('recognition-mode-detail').textContent}`;
  formulaReview.update(status);
}
let serviceInfoSequence = 0;
async function refreshServiceInfo(gateway = settings.gatewayUrl, token = settings.pairingToken): Promise<void> {
  const sequence = ++serviceInfoSequence;
  try {
    const status = await readServiceStatus(gateway);
    if (sequence !== serviceInfoSequence) return;
    applyServiceStatus(status);
    const { response, data } = await requestJson<ServiceUsage>(`${gateway.replace(/\/$/, '')}/v1/usage?provider=${settings.provider}&installationId=${encodeURIComponent(settings.installationId)}`, { headers: token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {} }, { timeoutMs: 5000 });
    if (sequence !== serviceInfoSequence) return;
    if (!response.ok || !data?.quota) throw new Error(response.status === 401 ? '额度信息需先完成服务配对。' : '额度信息暂不可用，请重启服务并检查连接。');
    const quota = data.quota;
    if (status.simulated || !quota.enforced) {
      $('quota-summary').textContent = status.local ? '本地 Ollama：不设云服务额度，电脑需保持运行模型' : '本地固定样例演示：不限次数，不消耗真实额度';
      $('service-details').textContent = status.local ? `${providerLabel(status.provider)} · ${status.configured ? '已配置' : '未配置'}。在你的电脑推理，不是 mock，不受云服务额度限制。可检查后端连接以确认模型是否已安装。` : '当前服务为模拟模式，不是手写识别。固定样例演示在本机运行，不上传笔迹、不限次数。';
      return;
    }
    const row = (label: string, period: QuotaPeriod) => `${label}：已用 ${period.used} / ${period.limit}，剩余 ${period.remaining}`;
    $('quota-summary').textContent = `本地服务额度 · 本设备今日剩余 ${quota.installationDaily.remaining} / ${quota.installationDaily.limit}`;
    const reset = quota.installationDaily.resetsAt ? new Date(quota.installationDaily.resetsAt).toLocaleString('zh-CN', { timeZone: data.timeZone }) : '未知';
    const monthReset = quota.globalMonthly.resetsAt ? new Date(quota.globalMonthly.resetsAt).toLocaleString('zh-CN', { timeZone: data.timeZone }) : '未知';
    $('service-details').textContent = `${providerLabel(status.provider)} · ${status.configured ? '已配置' : '未配置'}\n${row('本设备今日', quota.installationDaily)}\n${row('服务今日', quota.globalDaily)}\n${row('服务本月', quota.globalMonthly)}\n每日额度重置：${reset}（${data.timeZone}）\n每月额度重置：${monthReset}（${data.timeZone}）\n云端转写与检查共用本服务成本额度；可在电脑 .env 调整，不代表 Mathpix 账户余额或其他供应商余额。`;
  } catch (error) {
    if (sequence !== serviceInfoSequence) return;
    const message = error instanceof Error ? error.message : '服务信息暂不可用';
    $('quota-summary').textContent = message; $('service-details').textContent = message;
  }
}

function showPairingAction(): void {
  $('pair-local').hidden = !canPairLocally($<HTMLInputElement>('gateway-url').value.trim(), location.href);
}
function openSettings(focusPairing = false): void {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  if (!dialog.open) {
    $<HTMLInputElement>('gateway-url').value = settings.gatewayUrl;
    $<HTMLInputElement>('pairing-token').value = settings.pairingToken;
    $<HTMLInputElement>('cloud-consent').checked = settings.cloudConsentProviders.includes(settings.provider);
    $<HTMLSelectElement>('ocr-provider').value = settings.provider;
    $<HTMLSelectElement>('ink-mode').value = settings.inkMode;
    showPairingAction(); dialog.showModal(); void refreshServiceInfo();
  }
  if (focusPairing) { const field = $<HTMLInputElement>('pairing-token'); field.focus(); field.select(); }
}
async function localPairing(gatewayUrl: string): Promise<string> {
  if (!canPairLocally(gatewayUrl, location.href)) throw new Error('请使用启动窗口的配对链接，或填写服务配对令牌');
  const { response, data } = await requestJson<{ status?: string; pairingToken?: string }>(`${gatewayUrl.replace(/\/$/, '')}/v1/local-pairing`, { mode: 'same-origin' }, { timeoutMs: 3000 });
  if (!response.ok || data?.status !== 'ok' || typeof data.pairingToken !== 'string') throw new Error('无法自动配对，请重启本机服务后再试，或使用启动窗口的配对链接');
  return data.pairingToken;
}
async function initializePairing(): Promise<void> {
  if (!canPairLocally(settings.gatewayUrl, location.href)) return;
  try { settings.pairingToken = await localPairing(settings.gatewayUrl); saveSettings(settings); }
  catch { /* Offline writing and explicit pairing links remain available. */ }
}
async function pairLocalFromSettings(): Promise<void> {
  const button = $<HTMLButtonElement>('pair-local'); button.disabled = true;
  try {
    const url = $<HTMLInputElement>('gateway-url').value.trim().replace(/\/$/, '');
    const token = await localPairing(url);
    $<HTMLInputElement>('pairing-token').value = token;
    settings.gatewayUrl = url; settings.pairingToken = token; saveSettings(settings);
    await healthCheck();
  } catch (error) { toast((error as Error).message); }
  finally { button.disabled = false; }
}
async function healthCheck(): Promise<void> {
  try {
    const gateway = $<HTMLInputElement>('gateway-url').value.trim().replace(/\/$/, '');
    const token = $<HTMLInputElement>('pairing-token').value.trim();
    const { response: pairingResponse, data: pairingData } = await requestJson<{ status?: string; pairingRequired?: boolean }>(`${gateway}/v1/pairing`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, { timeoutMs: 10000 });
    if (pairingResponse.status === 401) throw new PairingError('服务配对失败，请打开启动窗口的配对链接，或重新填写配对令牌');
    if (!pairingResponse.ok || pairingData?.status !== 'ok' || typeof pairingData.pairingRequired !== 'boolean') throw new Error('无法验证配对，请检查服务地址并重启 MathInk 服务');
    const data = await readServiceStatus(gateway);
    const { response, data: health } = await requestJson<{ status?: string; ready?: boolean; error?: { message?: string }; message?: string }>(`${gateway}/v1/provider-health?provider=${settings.provider}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, { timeoutMs: 15000 });
    if (!response.ok || health?.status !== 'ok' || health?.ready !== true) throw new Error(health?.error?.message || health?.message || '模型后端未就绪，请检查服务端凭据或本地模型安装');
    $('service-status').textContent = `服务已配对 · ${providerLabel(data.provider)} · 后端连接检查通过`;
    toast($('service-status').textContent!);
    void refreshServiceInfo(gateway, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未连接识别服务，请检查地址和网络';
    $('service-status').textContent = message; toast(message);
    if (error instanceof PairingError) openSettings(true);
  }
}

$('new-note').addEventListener('click', async () => { const created = newNote(); notes.push(created); if (!await switchNote(created)) { renderNotes(); return; } saveCurrent(); $<HTMLInputElement>('note-title').focus(); $<HTMLInputElement>('note-title').select(); });
$('search').addEventListener('input', renderNotes);
$('note-title').addEventListener('input', () => { note.title = $<HTMLInputElement>('note-title').value; $('crumb-title').textContent = note.title; saveCurrent(); renderNotes(); });
$('note-tags').addEventListener('change', () => { note.tags = [...new Set($<HTMLInputElement>('note-tags').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean))]; saveCurrent(); renderNotes(); });
$('markdown-input').addEventListener('input', () => { note.markdown = $<HTMLTextAreaElement>('markdown-input').value; saveCurrent(); });
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool as typeof tool)));
$('undo').addEventListener('click', () => { const previous = history.pop(); if (!previous) return toast('没有可撤销的笔迹操作'); note.strokes = previous; selection.clear(); sourceChanged(); });
$('select-all').addEventListener('click', () => { selection = new Set(note.strokes.map(s => s.id)); updateSelection(); draw(); });
$('zoom-in').addEventListener('click', () => changeZoom(1.2)); $('zoom-out').addEventListener('click', () => changeZoom(1 / 1.2)); $('zoom-reset').addEventListener('click', () => { zoom = 1; panX = panY = 0; draw(); });
$('ink-tab').addEventListener('click', () => showTab('ink')); $('organized-tab').addEventListener('click', () => showTab('organized'));
$('recognize').addEventListener('click', () => void recognize());
$('demo-recognition').addEventListener('click', () => void recognize(false, true));
$('manual-formula').addEventListener('click', () => {
  stopRecognition(); formulaReview.invalidate('手工输入后可单独检查公式');
  if (!pending) pending = { imageBase64: '', imageUrl: '', bounds: boundsOf(note.strokes.filter(stroke => selection.has(stroke.id))) || { x: 0, y: 0, width: 100, height: 100 }, strokeIds: [...selection], revision: note.revision, requestId: newId(), butterfly: false, provider: 'manual', simulated: false };
  $('recognition-preview').hidden = false; $('recognition-idle').hidden = true; $('source-image').hidden = true; $('source-image').previousElementSibling!.setAttribute('hidden', '');
  $('provider-badge').textContent = '手工输入 · 尚未转写'; $('provider-badge').classList.remove('mock');
  renderMath($('math-preview'), $<HTMLTextAreaElement>('latex-input').value); $<HTMLTextAreaElement>('latex-input').focus(); $<HTMLButtonElement>('confirm-formula').disabled = !$<HTMLTextAreaElement>('latex-input').value.trim(); formulaReview.update();
});
$('setup-recognition').addEventListener('click', () => openSettings()); $('retry').addEventListener('click', () => { if (pending) pending.requestId = newId(); void recognize(true); }); $('confirm-formula').addEventListener('click', () => void confirmFormula()); $('cancel-formula').addEventListener('click', cancelPreview);
$('latex-input').addEventListener('input', () => { if (recognizing) stopRecognition(); formulaReview.invalidate('公式输入已改变，请重新检查'); renderMath($('math-preview'), $<HTMLTextAreaElement>('latex-input').value); $<HTMLButtonElement>('confirm-formula').disabled = !pending || !$<HTMLTextAreaElement>('latex-input').value.trim(); });
document.querySelectorAll<HTMLButtonElement>('[data-symbol]').forEach(button => button.addEventListener('click', () => { const input = $<HTMLTextAreaElement>('latex-input'); input.setRangeText(button.dataset.symbol!, input.selectionStart, input.selectionEnd, 'end'); input.focus(); input.dispatchEvent(new Event('input', { bubbles: true })); }));
document.querySelectorAll<HTMLButtonElement>('[data-template]').forEach(button => button.addEventListener('click', () => { const templates = { definition: '\n\n## 定义\n\n**对象与条件：**\n\n**定义：**\n', theorem: '\n\n## 定理\n\n**假设：**\n\n**结论：**\n', proof: '\n\n## 证明\n\n**思路：**\n\n1. \n\n□\n' }; note.markdown += templates[button.dataset.template as keyof typeof templates]; $<HTMLTextAreaElement>('markdown-input').value = note.markdown; saveCurrent(); $<HTMLTextAreaElement>('markdown-input').focus(); }));
$('settings-open').addEventListener('click', () => openSettings());
$('settings-open-mobile').addEventListener('click', () => $('settings-open').click());
function changeProvider(provider: ModelProvider): void {
  if (provider === settings.provider) return;
  stopRecognition(); formulaReview.invalidate('模型后端已改变，旧检查结果已失效'); $<HTMLDialogElement>('consent-dialog').close();
  if (pending) pending.requestId = newId();
  settings.provider = provider; settings.cloudConsent = settings.cloudConsentProviders.includes(provider); saveSettings(settings);
  $<HTMLInputElement>('cloud-consent').checked = settings.cloudConsent;
  $<HTMLButtonElement>('confirm-formula').disabled = !pending || !$<HTMLTextAreaElement>('latex-input').value.trim();
  void refreshServiceInfo(); toast(`已切换到 ${providerLabel(provider)}，请手动发起转写或检查`);
}
$('ocr-provider').addEventListener('change', () => changeProvider($<HTMLSelectElement>('ocr-provider').value as ModelProvider));
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = $<HTMLInputElement>('gateway-url').value.trim().replace(/\/$/, '');
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); }
  catch { toast('请输入有效的 HTTP 或 HTTPS 服务地址'); return; }
  const token = $<HTMLInputElement>('pairing-token').value.trim();
  if (url !== settings.gatewayUrl || token !== settings.pairingToken) { stopRecognition(); formulaReview.invalidate('服务连接已改变，请重新检查'); }
  const inkMode = $<HTMLSelectElement>('ink-mode').value as 'experimental' | 'butterfly';
  const engineChanged = inkMode !== settings.inkMode;
  settings.cloudConsentProviders = settings.cloudConsentProviders.filter(provider => provider !== settings.provider);
  if ($<HTMLInputElement>('cloud-consent').checked && settings.provider !== 'ollama') settings.cloudConsentProviders.push(settings.provider);
  Object.assign(settings, { gatewayUrl: url, pairingToken: token, cloudConsent: settings.cloudConsentProviders.includes(settings.provider), inkMode });
  saveSettings(settings); $<HTMLDialogElement>('settings-dialog').close(); if (engineChanged) void configureInkMode(); void refreshServiceInfo(); toast('设置已保存在本机');
});
$('health-check').addEventListener('click', () => void healthCheck());
$('pair-local').addEventListener('click', () => void pairLocalFromSettings());
$('gateway-url').addEventListener('input', showPairingAction);
window.addEventListener('hashchange', () => {
  try {
    if (!consumePairingLink()) return;
    const wasRecognizing = recognizing;
    stopRecognition(); formulaReview.invalidate('服务配对已改变，请重新检查');
    if (wasRecognizing && pending) {
      $('math-preview').textContent = '配对已更新，原稿已保留，请手动重试识别';
      $('provider-badge').textContent = '等待手动重试';
      $('retry').hidden = false;
    }
    if ($<HTMLDialogElement>('settings-dialog').open) {
      $<HTMLInputElement>('gateway-url').value = settings.gatewayUrl;
      $<HTMLInputElement>('pairing-token').value = settings.pairingToken;
      showPairingAction();
    }
    $('service-status').textContent = '服务配对已更新，请手动重试识别';
    toast('配对已更新，笔记与原稿保持不变');
  } catch (error) { toast((error as Error).message); }
});
$('consent-refuse').addEventListener('click', () => { $<HTMLDialogElement>('consent-dialog').close(); toast('可以继续离线书写，识别未启用'); });
$('consent-allow').addEventListener('click', () => { if (!settings.cloudConsentProviders.includes(settings.provider)) settings.cloudConsentProviders.push(settings.provider); settings.cloudConsent = true; saveSettings(settings); $<HTMLDialogElement>('consent-dialog').close(); void recognize(true); });
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(button => button.addEventListener('click', () => $<HTMLDialogElement>(button.dataset.close!).close()));
$('export-open').addEventListener('click', () => $<HTMLDialogElement>('export-dialog').showModal());
$('export-latex').addEventListener('click', () => download(`${filename()}.tex`, note.formulas.map(f => `% 来源：${note.id}, page ${f.sourcePage || 'default'}, revision ${f.sourceRevision}\n\\[\n${f.latex}\n\\]`).join('\n\n')));
$('export-markdown').addEventListener('click', () => download(`${filename()}.md`, exportMarkdown(note)));
$('export-backup').addEventListener('click', backup); $('backup').addEventListener('click', backup);
$('restore-open').addEventListener('click', () => $<HTMLInputElement>('restore-file').click());
$('restore-from-export').addEventListener('click', () => { $<HTMLDialogElement>('export-dialog').close(); $<HTMLInputElement>('restore-file').click(); });
$('restore-file').addEventListener('change', async () => { const input = $<HTMLInputElement>('restore-file'); const file = input.files?.[0]; if (!file) return; try { if (file.size > 50 * 1024 * 1024) throw new Error('备份超过 50 MB，请分批恢复'); const imported = parseBackup(await file.text()); const restored = imported.notes.map(n => ({ ...n, id: notes.some(current => current.id === n.id) ? newId() : n.id, title: notes.some(current => current.id === n.id) ? `${n.title}（恢复副本）` : n.title })); await importNotes(restored); notes.push(...restored); if (restored.length) await switchNote(restored[0]); toast(`已恢复 ${restored.length} 篇笔记，现有笔记已保留`); } catch (error) { toast((error as Error).message); } finally { input.value = ''; } });
window.addEventListener('keydown', event => { const target = event.target as HTMLElement; if (settings.inkMode === 'butterfly' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return; if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); $('undo').click(); return; } const keys: Record<string, typeof tool> = { p: 'pen', l: 'lasso', e: 'eraser', h: 'pan' }; if (keys[event.key.toLowerCase()]) setTool(keys[event.key.toLowerCase()]); });

async function start(): Promise<void> { try { notes = await loadNotes(); if (!notes.length) { const first = newNote(); first.title = '我的数学手写笔记'; first.tags = ['数学', '手写']; notes.push(first); await saveNote(first); } await switchNote(notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]); $('save-state').textContent = '已保存到本机'; if (settings.inkMode !== 'butterfly') await configureInkMode(); } catch (error) { notes = [newNote()]; await switchNote(notes[0]); $('save-state').textContent = '本地存储不可用'; toast((error as Error).message); } }
void initializePairing().then(async () => { await start(); void refreshServiceInfo(); if (pairingLinkError) toast(pairingLinkError); });
