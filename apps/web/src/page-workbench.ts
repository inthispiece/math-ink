import katex from 'katex';
import { newId, type Formula, type Note, type ModelProvider } from './model';
import { requestJson } from './recognition-request';
import { normalizedSourceBounds, type FullPageImage } from './page-render';
import { ensurePageModel, orderedBlocks, blockText, createParagraphBlock, createFormulaBlock, updateBlock, updateFormulaLatex, moveBlock, removeBlock, captureContext, createSuggestion, isSuggestionStale, applySuggestion, rejectSuggestion, undoSuggestion, applyCheckedSuggestions, type ContentBlock, type BlockContent, type PageTask, type SourceRef, type InlineRun, type SuggestionCategory } from './page-model';
import { searchNotes, addLink, backlinks, resolveLink, linkState } from './knowledge';
import { checkPolynomial } from './polynomial-check';
type TaskType = 'page-transcribe' | 'context-review' | 'organize' | 'knowledge-links' | 'proof-assist';
interface State {
    provider: ModelProvider;
    gateway: string;
    token: string;
    installationId: string;
}
interface CapabilityStatus {
    configured: boolean;
    provider: string;
    simulated: boolean;
    taskCapabilities?: Partial<Record<TaskType, boolean>>;
}
interface RemoteBlock {
    id: string;
    kind: string;
    segments?: ({
        type: 'text';
        text: string;
    } | {
        type: 'math';
        latex: string;
    })[];
    latex?: string;
    bbox: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    uncertainties: string[];
}
interface TaskReply {
    taskId: string;
    provider: string;
    model: string;
    type: TaskType;
    status: string;
    sourceRevision: number;
    contentRevision?: number;
    result?: unknown;
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
    cost?: unknown;
    error?: {
        message?: string;
    };
    steps?: {
        id: string;
        status: string;
    }[];
}
interface Options {
    parent: HTMLElement;
    toolbar: HTMLElement;
    note: () => Note;
    notes: () => Note[];
    state: () => State;
    capture: () => Promise<FullPageImage>;
    changed: (note?: Note) => void;
    flushSource:()=>Promise<void>;
    notify: (message: string) => void;
    show: () => void;
    jump: (source: SourceRef) => void;
    jumpBlock: (noteId: string, blockId: string) => Promise<void>;
    newDraft: (note: Note) => Promise<void>;
}
const taskNames: Record<TaskType, string> = { 'page-transcribe': '整页转写', 'context-review': '上下文检查', organize: '整理草稿', 'knowledge-links': '关联建议', 'proof-assist': '证明步骤建议' };
const labels: Record<string, string> = { recognition: '识别疑点', language: '语言表达', mathematics: '数学问题', 'missing-condition': '缺少条件', organization: '整理', paragraph: '段落', formula: '独立公式', derivation: '多行推导', 'legacy-markdown': '旧 Markdown（原样保留）', image: '原图区域' };
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); e.textContent = text; if (className)
    e.className = className; return e; };
function button(text: string, action: () => void, className = 'button secondary small') { const e = make('button', text, className); e.type = 'button'; e.onclick = action; return e; }
function math(element: HTMLElement, latex: string, displayMode = true) { try {
    katex.render(latex, element, { displayMode, throwOnError: true, trust: false, maxExpand: 1000, strict: 'ignore' });
}
catch {
    element.textContent = latex;
    element.classList.add('math-error');
} }
/** Structured editing is independent of provider output. Raw ink is never replaced. */
export class PageWorkbench {
    private root: HTMLElement;
    private consent: HTMLDialogElement;
    private active: AbortController | null = null;
    private activeTaskId:string|null=null;
    private sequence = 0;
    private selectedBlock = '';
    private currentPage = '';
    private checked = new Set<string>();
    private status: CapabilityStatus | null = null;
    private lastNote = '';
    private approved: (() => void) | null = null;
    private scope = 'block';
    private options: Options;
    constructor(options: Options) {
        this.options = options;
        this.root = make('section', '', 'page-workbench');
        this.root.id = 'page-workbench';
        this.root.innerHTML = '<div class="page-workbench-heading"><div><div class="panel-label">整页工作台 · 开发实验</div><h2>原稿与排版草稿</h2></div><button id="page-transcribe" class="button primary">当前完整页 → 排版草稿</button></div><p class="field-help">单栏中英数学笔记优先。模型结果待逐块核对；图表、多栏与图形证明保留原图。真实云端质量尚未验收。</p><p id="page-capability" role="status"></p><div class="page-controls"><label>页面 <select id="page-select"></select></label><button id="add-paragraph" class="button secondary small">＋ 手工段落</button><button id="add-page-formula" class="button secondary small">＋ 手工公式</button><label>本次发送范围 <select id="context-scope"><option value="block">当前段落</option><option value="page">当前页全部内容块</option></select></label><button id="context-check" class="button secondary small">检查所选范围</button><button id="organize-page" class="button secondary small">生成整理建议</button></div><details id="context-preview"><summary>查看本次上下文范围（上传前可核对）</summary><pre id="context-payload"></pre></details><div id="page-task-status" role="status"></div><div id="page-task-list"></div><div class="page-comparison"><aside><h3>完整原稿</h3><img id="page-source-image" alt="当前页完整原稿，非屏幕截图" hidden/><p id="page-source-caption">先点击整页转写，或手工建立内容块。</p></aside><div id="page-block-list"></div></div><section id="page-suggestions"><h3>修改建议</h3><p>区分原稿可能写错与识别可能看错。建议不会自动应用，缺少条件仍保留疑问。</p><button id="apply-checked" class="button secondary small">仅采用勾选且仍有效的建议</button><div id="suggestion-list"></div></section><section class="knowledge-panel"><h3>有来源的关联</h3><label>检索当前设备笔记<input id="knowledge-search" type="search" placeholder="正文、公式、标签"/></label><div id="knowledge-results"></div><fieldset id="knowledge-scope"><legend>允许 AI 查看哪些笔记（需主动勾选）</legend></fieldset><button id="suggest-links" class="button secondary small">为选定笔记范围生成关联建议</button><div id="knowledge-links"></div><div id="backlinks"></div></section><section class="proof-panel"><h3>限定范围的证明辅助 · 未验证建议</h3><label>领域<select id="proof-domain"><option value="elementary-algebra">初等代数</option><option value="calculus">基础微积分</option></select></label><label>目标<input id="proof-goal" maxlength="1000" placeholder="本次希望推进的一个目标"/></label><label>已知假设（逐行）<textarea id="proof-assumptions" rows="2" maxlength="4000"></textarea></label><p>已有步骤来自上面展示的所选上下文。输出不构成已证明结论，尚未接入符号或形式验证。</p><button id="proof-assist" class="button secondary small">请求下一步建议（未验证）</button></section>';
        options.parent.prepend(this.root);
        const entry = button('整页排版草稿', () => { options.show(); this.el('page-transcribe').focus(); });
        entry.id = 'page-workbench-open';
        options.toolbar.append(entry);
        this.consent = make('dialog');
        this.consent.id = 'page-consent-dialog';
        this.consent.innerHTML = '<h2 id="page-consent-title"></h2><p id="page-consent-description"></p><pre id="page-consent-payload"></pre><p>仅本次请求授权，不沿用圈选图片授权。提交后取消或超时仍可能计费，不会自动重复生成。</p><div class="dialog-actions"><button id="page-consent-refuse" class="button secondary">取消，不上传</button><button id="page-consent-allow" class="button primary">确认本次范围并发送</button></div>';
        document.body.append(this.consent);
        this.el('page-consent-refuse').onclick = () => { this.approved = null; this.consent.close(); };
        this.el('page-consent-allow').onclick = () => { const action = this.approved; this.approved = null; this.consent.close(); action?.(); };
        this.consent.oncancel = () => { this.approved = null; };
        this.el('page-transcribe').onclick = () => void this.prepare('page-transcribe');
        this.el('context-check').onclick = () => void this.prepare('context-review');
        this.el('organize-page').onclick = () => void this.prepare('organize');
        this.el('suggest-links').onclick = () => void this.prepare('knowledge-links');
        this.el('proof-assist').onclick = () => void this.prepare('proof-assist');
        this.el<HTMLSelectElement>('context-scope').onchange = () => { this.scope = this.el<HTMLSelectElement>('context-scope').value; this.renderScope(); };
        this.el<HTMLSelectElement>('page-select').onchange = () => { this.currentPage = this.el<HTMLSelectElement>('page-select').value; this.selectedBlock = ''; this.render(); };
        this.el('add-paragraph').onclick = () => { const b = createParagraphBlock(this.options.note(), '新段落', this.currentPage); this.selectedBlock = b.id; this.changed(); };
        this.el('add-page-formula').onclick = () => { const n = this.options.note(); const f = this.formula(n, 'x', undefined); const b = createFormulaBlock(n, f.id, this.currentPage); this.selectedBlock = b.id; this.changed(); };
        this.el('apply-checked').onclick = () => void this.afterSourceFlush(() => { const result = applyCheckedSuggestions(this.options.note(), [...this.checked]); this.checked.clear(); this.changed(); options.notify(`已采用 ${result.applied.length} 条；跳过 ${result.skipped.length} 条过期或冲突建议。`); });
        this.el<HTMLInputElement>('knowledge-search').oninput = () => this.renderSearch();
        const polynomial = make('section', '', 'polynomial-panel');
        polynomial.innerHTML = '<h3>本地多项式核对 · 与 AI 建议分开</h3><p>精确计算只适用于有理系数的单变量多项式（全体实数，无额外条件）。不支持一般定理或复杂函数；不传云端、不修改笔记。</p><label>检查类型<select id="polynomial-kind"><option value="antiderivative">候选原函数的导数是否等于被积函数</option><option value="identity">多项式恒等式</option></select></label><label>左式 / 被积函数（ASCII）<input id="polynomial-left" value="x^2" maxlength="500"/></label><label>右式 / 候选原函数（ASCII）<input id="polynomial-right" value="x^3/2+C" maxlength="500"/></label><button id="polynomial-check" class="button secondary small">仅在本机精确核对</button><pre id="polynomial-result" role="status">尚未运行工具。AI 步骤仍为未验证建议。</pre>';
        this.root.append(polynomial);
        this.el('polynomial-check').onclick = () => { const result = checkPolynomial(this.el<HTMLSelectElement>('polynomial-kind').value as 'identity' | 'antiderivative', this.el<HTMLInputElement>('polynomial-left').value, this.el<HTMLInputElement>('polynomial-right').value); this.el('polynomial-result').textContent = `工具结果：${result.status}\n${result.message}\n范围：${result.scope}\n工具：${result.tool}${result.counterexample ? `\n反例：x=${result.counterexample.x}，左式=${result.counterexample.left}，右式=${result.counterexample.right}` : ''}\n此结果不验证其他 AI 建议或整篇证明。`; };
    }
    private el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
    private changed() { this.options.changed(); this.render(); }
    private async afterSourceFlush(action:()=>void){
        const target=this.options.note(),state=JSON.stringify(this.options.state());
        try{await this.options.flushSource();if(target!==this.options.note()||state!==JSON.stringify(this.options.state()))throw new Error('笔记或服务已经切换，旧建议未采用。');action();}
        catch(error){this.options.notify((error as Error).message);this.render();}
    }
    invalidate(message = '服务或笔记已切换，未完成任务保留在设备上；不会自动重做。') {
        ++this.sequence;
        this.active?.abort();
        this.active = null;this.activeTaskId=null;
        this.approved = null;
        this.consent.close();
        this.el('page-task-status').textContent = message;
    }
    update(status?: CapabilityStatus) { if (status)
        this.status = status; this.renderCapability(); }
    private renderCapability() {
        const p = this.options.state().provider;
        this.el('page-capability').textContent = p === 'ollama' ? '本地 Qwen 目前只开放选区公式实验；整页和上下文任务尚未评测，保持手工编辑。不会自动切换云端。' : p === 'mathpix' ? 'Mathpix 只用于选区转写；整页、整理及检查需主动切换到 DeepSeek。' : 'DeepSeek 整页与上下文为开发实验，需服务端密钥及本次范围授权。';
        const ids: Record<TaskType, string> = { 'page-transcribe': 'page-transcribe', 'context-review': 'context-check', organize: 'organize-page', 'knowledge-links': 'suggest-links', 'proof-assist': 'proof-assist' };
        for (const [type, id] of Object.entries(ids))
            this.el<HTMLButtonElement>(id).disabled = !!this.active || p !== 'deepseek' || this.status?.taskCapabilities?.[type as TaskType] === false;
    }
    render() {
        const n = ensurePageModel(this.options.note());
        if (this.lastNote !== n.id) {
            this.invalidate();
            this.lastNote = n.id;
            this.selectedBlock = '';
            this.currentPage = '';
            this.checked.clear();
        }
        if (!n.pages.some(p => p.id === this.currentPage))
            this.currentPage = n.pages.find(p => p.nativePageId === (n.butterflyPage || 'default'))?.id || n.pages[0].id;
        const select = this.el<HTMLSelectElement>('page-select');
        select.replaceChildren(...n.pages.map((p, i) => { const o = make('option', `第 ${i + 1} 页 · ${p.nativePageId}`); o.value = p.id; return o; }));
        select.value = this.currentPage;
        const blocks = orderedBlocks(n, this.currentPage);
        if (!blocks.some(b => b.id === this.selectedBlock))
            this.selectedBlock = blocks[0]?.id || '';
        this.el('page-block-list').replaceChildren(...blocks.map((b, i) => this.blockCard(b, i)));
        if (!blocks.length)
            this.el('page-block-list').append(make('p', '此页还没有排版内容。可先手工添加，或使用 DeepSeek 整页转写。', 'organized-empty'));
        const latest = [...n.tasks].reverse().find(t => t.pageId === this.currentPage && t.type === 'page-transcribe' && t.sourceImage);
        const source = this.el<HTMLImageElement>('page-source-image');
        source.hidden = !latest?.sourceImage;
        if (latest?.sourceImage) {
            source.src = latest.sourceImage.imageUrl;
            this.el('page-source-caption').textContent = `完整来源页 ${latest.sourceImage.page} · 原稿修订 ${latest.input.sourceRevision}${latest.input.sourceRevision !== n.revision ? '（原稿已变化）' : ''}`;
        }
        this.renderScope();
        this.renderTasks();
        this.renderSuggestions();
        this.renderSearch();
        this.renderLinks();
        this.renderCapability();
        const scope = this.el('knowledge-scope');
        const old = new Set([...scope.querySelectorAll<HTMLInputElement>('input:checked')].map(x => x.value));
        scope.replaceChildren(make('legend', '允许 AI 查看哪些笔记（需主动勾选）'));
        for (const item of this.options.notes()) {
            const label = make('label');
            const check = make('input');
            check.type = 'checkbox';
            check.value = item.id;
            check.checked = old.has(item.id);
            label.append(check, document.createTextNode(item.title || '未命名笔记'));
            scope.append(label);
        }
    }
    focusBlock(id: string) { this.selectedBlock = id; this.currentPage = ensurePageModel(this.options.note()).blocks.find(b => b.id === id)?.pageId || this.currentPage; this.render(); this.el('page-block-list').querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' }); }
    private formula(n: Note, latex: string, source: SourceRef | undefined, inline = false): Formula { const f: Formula = { id: newId(), latex, ...(inline ? { inline: true } : {}), sourceStrokeIds: source?.strokeIds || [], sourceRevision: source?.sourceRevision ?? n.revision, sourceBounds: source?.bounds || { x: 0, y: 0, width: 1, height: 1 }, provider: source ? 'deepseek' : 'manual', simulated: false, createdAt: new Date().toISOString(), ...(source ? { sourceRefId: source.id, sourcePage: source.nativePageId, sourceButterflyRevision: source.nativeInkRevision, butterfly: Boolean(source.nativeInkRevision) || source.nativePageId !== 'default' } : {}) }; n.formulas.push(f); return f; }
    private editableText(b: ContentBlock) { return this.editableTextFor(this.options.note(), b); }
    /** Called only for an explicit user save; AI proposals use inlineProposal instead. */
    private runs(text:string,source?:SourceRef,existing:InlineRun[]=[]):InlineRun[]{
        const note=this.options.note(),tokens=inlineMathTokens(text);
        const original=existing.filter((run):run is Extract<InlineRun,{type:'formula'}>=>run.type==='formula');
        const available=[...original],resolved=new Map<number,string>();
        // Reserve every unchanged occurrence before assigning changed positions. An insertion
        // before an existing formula must not take that formula's identity or source.
        tokens.forEach((token,index)=>{const position=available.findIndex(run=>note.formulas.find(f=>f.id===run.formulaId)?.latex===token.latex);if(position>=0)resolved.set(index,available.splice(position,1)[0].formulaId);});
        const reserved=new Set(resolved.values()),unused=[...new Set(available.map(run=>run.formulaId))].filter(id=>!reserved.has(id));
        tokens.forEach((token,index)=>{if(resolved.has(index))return;const previous=unused.shift();if(previous){updateFormulaLatex(note,previous,token.latex);resolved.set(index,previous);}else resolved.set(index,this.formula(note,token.latex,source,true).id);});
        const runs:InlineRun[]=[];let cursor=0;
        tokens.forEach((token,index)=>{if(token.start>cursor)runs.push({type:'text',text:text.slice(cursor,token.start)});runs.push({type:'formula',formulaId:resolved.get(index)!});cursor=token.end;});
        if(cursor<text.length||!runs.length)runs.push({type:'text',text:text.slice(cursor)});
        return runs;
    }
    private inlineProposal(text:string,existing:InlineRun[]):{runs:InlineRun[];changes:{formulaId:string;originalLatex:string;proposedLatex:string}[]}|null{
        const note=this.options.note(),tokens=inlineMathTokens(text);
        const original=existing.filter((run):run is Extract<InlineRun,{type:'formula'}>=>run.type==='formula');
        if(tokens.length!==original.length)return null;
        const available=[...original],resolved=new Map<number,string>();
        tokens.forEach((token,index)=>{const match=available.findIndex(run=>note.formulas.find(f=>f.id===run.formulaId)?.latex===token.latex);if(match>=0)resolved.set(index,available.splice(match,1)[0].formulaId);});
        tokens.forEach((_token,index)=>{if(!resolved.has(index))resolved.set(index,available.shift()!.formulaId);});
        // Reordering identities or giving two occurrences of a shared identity different
        // values cannot be represented as a safe canonical formula patch.
        if(original.some((run,index)=>run.formulaId!==resolved.get(index)))return null;
        const values=new Map<string,string>();for(let i=0;i<tokens.length;i++){const id=resolved.get(i)!,previous=values.get(id);if(previous!==undefined&&previous!==tokens[i].latex)return null;values.set(id,tokens[i].latex);}
        const changes:{formulaId:string;originalLatex:string;proposedLatex:string}[]=[];
        for(const [formulaId,proposedLatex]of values){const formula=note.formulas.find(f=>f.id===formulaId);if(!formula)return null;if(formula.latex!==proposedLatex)changes.push({formulaId,originalLatex:formula.latex,proposedLatex});}
        const runs:InlineRun[]=[];let cursor=0;tokens.forEach((token,index)=>{if(token.start>cursor)runs.push({type:'text',text:text.slice(cursor,token.start)});runs.push({type:'formula',formulaId:resolved.get(index)!});cursor=token.end;});
        if(cursor<text.length||!runs.length)runs.push({type:'text',text:text.slice(cursor)});
        return{runs,changes};
    }
    private splitParagraph(block:ContentBlock,text:string,point:number){
        const note=ensurePageModel(this.options.note());
        if(point<=0||point>=text.length)return this.options.notify('请先把光标放在希望拆分的位置。');
        if(inlineMathTokens(text).some(token=>point>token.start&&point<token.end))return this.options.notify('请把拆分光标移到行内公式之外，保留完整公式。');
        const source=note.sources.find(s=>block.sourceRefIds.includes(s.id));
        if(block.type==='legacy-markdown'){
            updateBlock(note,block.id,{content:{markdown:text.slice(0,point)}});
            const right=createParagraphBlock(note,text.slice(point),block.pageId);
            updateBlock(note,right.id,{sourceRefIds:[...block.sourceRefIds],needsReview:block.needsReview});
            const page=note.pages.find(p=>p.id===block.pageId)!;moveBlock(note,right.id,page.blockOrder.indexOf(block.id)+1-page.blockOrder.indexOf(right.id));
        }else{
            const runs=text===this.editableText(block)?structuredClone(block.content.runs||[]):this.runs(text,source,block.content.runs);
            const left:InlineRun[]=[],right:InlineRun[]=[];let offset=0;
            for(const run of runs){const length=run.type==='text'?run.text.length:(note.formulas.find(f=>f.id===run.formulaId)?.latex.length||0)+2;
                if(offset+length<=point)left.push(run);else if(offset>=point)right.push(run);else if(run.type==='text'){left.push({type:'text',text:run.text.slice(0,point-offset)});right.push({type:'text',text:run.text.slice(point-offset)});}else throw new Error('不能在行内公式内部拆分');offset+=length;
            }
            const created=createParagraphBlock(note,'',block.pageId);
            updateBlock(note,created.id,{content:{...block.content,runs:right},sourceRefIds:[...block.sourceRefIds],needsReview:block.needsReview,...(block.uncertainties?{uncertainties:[...block.uncertainties]}:{})});
            // Attach the right-hand references before removing them from the original.
            // Legacy inline formulas may not have the newer `inline` flag yet.
            updateBlock(note,block.id,{content:{...block.content,runs:left}});
            const page=note.pages.find(p=>p.id===block.pageId)!;moveBlock(note,created.id,page.blockOrder.indexOf(block.id)+1-page.blockOrder.indexOf(created.id));
        }
        this.changed();
    }
    private blockCard(b: ContentBlock, index: number) {
        const n = ensurePageModel(this.options.note());
        const card = make('article', '', 'content-block');
        card.dataset.blockId = b.id;
        card.classList.toggle('selected', b.id === this.selectedBlock);
        const heading = make('div', '', 'block-heading');
        const choose = button(`${index + 1}. ${labels[b.type]}${b.needsReview ? ' · 待核对' : ''}`, () => { this.selectedBlock = b.id; this.render(); }, 'link-button');
        choose.setAttribute('aria-pressed', String(b.id === this.selectedBlock));
        heading.append(choose, make('small', `内容修订 ${b.revision}`));
        card.append(heading);
        if (b.uncertainties?.length)
            card.append(make('p', `识别疑点：${b.uncertainties.join('；')}`, 'notice'));
        const preview = make('div', '', 'block-preview');if(b.content.role==='heading')preview.classList.add('block-heading-text');if(b.content.role==='list-item')preview.append(document.createTextNode('• '));
        if (b.type === 'paragraph') {
            for (const run of b.content.runs || []) {
                const s = make('span');
                if (run.type === 'text')
                    s.textContent = run.text;
                else
                    math(s, n.formulas.find(f => f.id === run.formulaId)?.latex || '', false);
                preview.append(s);
            }
        }
        else if (b.type === 'formula' || b.type === 'derivation')
            math(preview, blockText(n, b));
        else if (b.type === 'image') {
            const im = make('img');
            im.src = b.content.imageDataUrl || '';
            im.alt = b.content.caption || '保留原图';
            preview.append(im, make('p', b.content.caption || '需手工处理的原图区域'));
        }
        else
            preview.textContent = blockText(n, b);
        card.append(preview);
        const edit = make('textarea');
        edit.value = this.editableText(b);
        edit.rows = b.type === 'formula' ? 2 : 3;
        edit.setAttribute('aria-label', `内容块 ${index + 1} 编辑`);
        edit.maxLength = 32000;
        card.append(edit);
        if (b.type === 'paragraph')
            card.append(make('small', '行内公式用 $LaTeX$ 输入；保存后公式独立引用。'));
        const actions = make('div', '', 'block-actions');
        actions.append(button('保存内容', () => { if(edit.value===this.editableText(b))return;if (b.type === 'formula' || b.type === 'derivation') {
            updateFormulaLatex(n, b.content.formulaId!, edit.value);
        }
        else if (b.type === 'image')
            updateBlock(n, b.id, { content: { ...b.content, caption: edit.value } });
        else
            updateBlock(n, b.id, { content: b.type === 'legacy-markdown' ? { markdown: edit.value } : { ...b.content, runs: this.runs(edit.value, n.sources.find(s => b.sourceRefIds.includes(s.id)),b.content.runs) } }); this.changed(); }));
        actions.append(button('已核对', () => { updateBlock(n, b.id, { needsReview: false }); this.changed(); }), button('上移', () => { moveBlock(n, b.id, -1); this.changed(); }), button('下移', () => { moveBlock(n, b.id, 1); this.changed(); }));
        const type = make('select');
        type.setAttribute('aria-label', `内容块 ${index + 1} 类型`);
        for (const t of ['paragraph', 'formula', 'derivation'] as const) {
            const o = make('option', labels[t]);
            o.value = t;
            type.append(o);
        }
        type.value = ['paragraph', 'formula', 'derivation'].includes(b.type) ? b.type : 'paragraph';
        type.onchange = () => { const value = type.value as ContentBlock['type']; const text = edit.value; const source = n.sources.find(s => b.sourceRefIds.includes(s.id)); if (value === 'paragraph')
            updateBlock(n, b.id, { type: value, content: { runs: this.runs(text, source) } });
        else {
            const f = this.formula(n, text, source);
            updateBlock(n, b.id, { type: value, content: { formulaId: f.id } });
        } this.changed(); };
        actions.append(type);
        if(b.type==='paragraph'){
            const role=make('select');role.setAttribute('aria-label',`内容块 ${index+1} 段落结构`);
            for(const [value,label] of [['text','普通段落'],['heading','标题'],['list-item','列表项']]){const o=make('option',label);o.value=value;role.append(o);}
            role.value=b.content.role||'text';role.onchange=()=>{const selected=role.value;updateBlock(n,b.id,{content:{...b.content,role:selected==='text'?undefined:selected as 'heading'|'list-item',level:selected==='heading'?2:undefined}});this.changed();};actions.append(role);
        }
        if (b.type === 'paragraph' || b.type === 'legacy-markdown')
            actions.append(button('在光标处分块',()=>this.splitParagraph(b,edit.value,edit.selectionStart)));
        const next = orderedBlocks(n, b.pageId)[index + 1];
        if (next && b.type === 'paragraph' && next.type === 'paragraph')
            actions.append(button('与下一段合并', () => {if(edit.value!==this.editableText(b))return this.options.notify('请先保存当前内容，再合并段落。'); updateBlock(n, b.id, { content: { ...b.content,runs: [...(b.content.runs || []), { type: 'text', text: '\n' }, ...(next.content.runs || [])] }, sourceRefIds: [...new Set([...b.sourceRefIds, ...next.sourceRefIds])], needsReview: b.needsReview || next.needsReview }); removeBlock(n, next.id); this.changed(); }));
        for (const refId of b.sourceRefIds) {
            const s = n.sources.find(x => x.id === refId);
            if(s&&((s.nativeInkRevision&&n.butterflyContentRevisions?.[s.nativePageId]!==s.nativeRevision)||(!s.nativeInkRevision&&s.sourceRevision!==n.revision)))card.append(make('p','来源页已变化，请返回原稿核对。','notice'));if (s)
                actions.append(button('返回此块原稿', () => this.options.jump(s), 'link-button'));
        }
        if (!b.sourceRefIds.length)
            card.append(make('small', '手工或导入内容，没有原稿关联。'));
        actions.append(button('删除此草稿块', () => { removeBlock(n, b.id); this.changed(); }, 'link-button'));
        card.append(actions);
        return card;
    }
    private scopeBlocks() { const n = this.options.note(); return orderedBlocks(n, this.currentPage).filter(b => this.scope === 'page' || b.id === this.selectedBlock); }
    private wireBlocks(blocks: ContentBlock[], note = this.options.note()) { return blocks.map(b => ({ id: b.id, version: b.revision, kind: b.type, ...(b.type === 'formula' || b.type === 'derivation' ? { latex: blockText(note, b) } : { text: this.editableTextFor(note, b) }) })); }
    private editableTextFor(note: Note, b: ContentBlock) { return b.type === 'paragraph' ? (b.content.runs || []).map(r => r.type === 'text' ? r.text : `$${note.formulas.find(f => f.id === r.formulaId)?.latex || ''}$`).join('') : blockText(note, b); }
    private renderScope() { this.el('context-payload').textContent = this.scopeBlocks().map(b => `[${b.id} · 修订 ${b.revision}]\n${this.editableText(b)}`).join('\n\n') || '此范围没有内容块，请先添加或选择一个段落。'; }
    private async prepare(type: TaskType) {
        if (this.active)
            return;
        try{await this.options.flushSource();}catch(error){this.options.notify((error as Error).message);return;}
        const n = ensurePageModel(this.options.note()), state = this.options.state();
        if (state.provider !== 'deepseek') {
            this.options.notify('当前后端没有开放此任务。可继续手工编辑；不会自动转云。');
            return;
        }
        try {
            const { response, data } = await requestJson<CapabilityStatus>(`${state.gateway.replace(/\/$/, '')}/v1/status?provider=${state.provider}`, {}, { timeoutMs: 10000 });
            if (!response.ok || !data || data.simulated !== false || data.provider !== state.provider || !data.configured || data.taskCapabilities?.[type] !== true)
                throw new Error('当前服务尚未开放或配置此任务，请更新网关并配置 DeepSeek；可继续手工编辑。');
            this.status = data;
            if (n !== this.options.note() || JSON.stringify(state) !== JSON.stringify(this.options.state()))
                return;
            let image: FullPageImage | undefined;
            let blocks = this.scopeBlocks();
            let candidates: ReturnType<PageWorkbench['wireBlocks']> = [];
            if (type === 'page-transcribe') {
                image = await this.options.capture();
                if (n !== this.options.note())
                    return;
                const p = n.pages.find(p => p.nativePageId === image!.page);
                if (p)
                    this.currentPage = p.id;
                else
                    this.currentPage = ensurePageModel(n).pages.find(p => p.nativePageId === image!.page)!.id;
                blocks = [];
            }
            else if (!blocks.length)
                throw new Error('请先选择内容块，或添加手工段落。');
            if (type === 'knowledge-links') {
                const allowed = new Set([...this.el('knowledge-scope').querySelectorAll<HTMLInputElement>('input:checked')].map(e => e.value));
                if (!allowed.size)
                    throw new Error('请先勾选允许检索并发送的笔记范围。');
                for (const candidate of this.options.notes().filter(item => allowed.has(item.id)))
                    candidates.push(...this.wireBlocks(orderedBlocks(candidate), candidate));
                candidates = candidates.slice(0, 30);
                if (!candidates.length)
                    throw new Error('所选笔记没有可供关联的内容块。');
            }
            const input = { noteId: n.id, pageId: this.currentPage, contentRevision: n.contentRevision, ...(image ? { imageBase64: image.imageBase64 } : { blocks: this.wireBlocks(blocks) }), ...(candidates.length ? { candidates } : {}), ...(type === 'proof-assist' ? { domain: this.el<HTMLSelectElement>('proof-domain').value, goal: this.el<HTMLInputElement>('proof-goal').value.trim(), assumptions: this.el<HTMLTextAreaElement>('proof-assumptions').value.split('\n').filter(Boolean), steps: blocks.map(b => this.editableText(b)) } : {}) };
            if (type === 'proof-assist' && !input.goal)
                throw new Error('请填写本次证明辅助的目标。');
            const snapshot = captureContext(n, blocks.map(b => b.id));
            const identity = JSON.stringify(state);
            const sourceRevision = n.revision;
            this.el('page-consent-title').textContent = `${taskNames[type]}：确认本次发送范围`;
            this.el('page-consent-description').textContent = type === 'page-transcribe' ? '本次上传当前完整页 PNG，包含页内全部文字、公式及图形；不是圈选图片，也不是当前屏幕截图。原始笔迹坐标留在设备。' : `发送上面所选${this.scope === 'page' ? '本页' : '本段'}的 ${blocks.length} 个内容块${candidates.length ? `，以及你勾选范围内的 ${candidates.length} 个候选块` : ''}；不会发送其他笔记或图片。`;
            this.el('page-consent-payload').textContent = image ? `来源页 ${image.page}，范围 ${Math.round(image.bounds.width)} × ${Math.round(image.bounds.height)}，完整 PNG；${image.strokeIds.length} 个原笔迹标识留本机。` : JSON.stringify(input, null, 2);
            this.approved = () => { if (n !== this.options.note() || JSON.stringify(this.options.state()) !== identity || sourceRevision !== n.revision || JSON.stringify(captureContext(n, blocks.map(b => b.id))) !== JSON.stringify(snapshot)) {
                this.options.notify('内容或模型设置已改变，请重新确认发送范围。');
                return;
            } void this.submit(type, input, snapshot, image); };
            this.consent.showModal();
        }
        catch (error) {
            this.options.notify((error as Error).message);
        }
        finally {
            this.renderCapability();
        }
    }
    private async submit(type: TaskType, input: unknown, snapshot: PageTask['input'], image?: FullPageImage) {
        if (this.active)
            return;
        const n = ensurePageModel(this.options.note());
        const state = this.options.state(), controller = new AbortController();
        this.active = controller;
        const seq = ++this.sequence;
        const now = new Date().toISOString();
        const storedInput = { ...obj(input) };
        delete storedInput.imageBase64;
        const task: PageTask = { id: newId(), type: type === 'knowledge-links' ? 'link' : type === 'proof-assist' ? 'proof' : type, provider: state.provider, model: '', pageId: this.currentPage, input: snapshot, status: 'pending', steps: [{ id: 'generate', clientRequestId: newId(), status: 'pending', blockIds: [] }], createdAt: now, updatedAt: now, request: { type, input:storedInput, gateway: state.gateway }, ...(image ? { sourceImage: {imageUrl:image.imageUrl,bounds:image.bounds,strokeIds:image.strokeIds,page:image.page,revision:image.revision,transform:image.transform,...(image.inkRevision?{inkRevision:image.inkRevision}:{})} } : {}) };
        this.activeTaskId=task.id;n.tasks.push(task);
        this.options.changed(n);
        this.renderTasks();
        this.renderCapability();
        try {
            this.el('page-task-status').textContent = '正在提交任务。提交后将保存请求标识，刷新不会自动重新生成。';
            const { response, data } = await requestJson<TaskReply>(`${state.gateway.replace(/\/$/, '')}/v1/tasks`, { method: 'POST', signal: controller.signal, headers: this.headers(state), body: JSON.stringify({ clientRequestId: task.steps[0].clientRequestId, installationId: state.installationId, provider: state.provider, sourceRevision: snapshot.sourceRevision, type, input }) }, { timeoutMs: 15000 });
            if (!response.ok || !data?.taskId || data.provider !== state.provider)
                throw new Error(obj(data?.error).message as string || `任务未确认（HTTP ${response.status}）`);
            task.gatewayTaskId = data.taskId;
            task.model = data.model;
            task.status = 'running';
            task.steps[0].status = 'running';
            this.options.changed(n);
            await this.poll(n, task, state, controller, seq);
        }
        catch (error) {
            if (task.status === 'pending' || task.status === 'running') {
                task.status = controller.signal.aborted ? 'cancelled' : 'unknown';
                task.error = `${(error as Error).message}。提交状态可能未知；请先查询原请求，重做可能再次计费。`;
                task.steps[0].status = task.status;
            }
            this.options.changed(n);
        }
        finally {
            if (this.active === controller) {
                this.active = null;
                this.render();
            }
            this.options.changed(n);
        }
    }
    private headers(state: State) { return { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) }; }
    private async poll(n: Note, task: PageTask, state: State, controller: AbortController, seq: number) {
        const deadline = Date.now() + 300000;
        while (!controller.signal.aborted && seq === this.sequence) {
            const { response, data } = await requestJson<TaskReply>(`${state.gateway.replace(/\/$/, '')}/v1/tasks/${encodeURIComponent(task.gatewayTaskId!)}?installationId=${encodeURIComponent(state.installationId)}`, { signal: controller.signal, headers: this.headers(state) }, { timeoutMs: 15000 });
            if (!response.ok || !data || data.provider !== task.provider || data.taskId !== task.gatewayTaskId)
                throw new Error('任务查询失败或返回了其他任务；保留本机草稿。');
            task.updatedAt = new Date().toISOString();
            task.usage = data.usage;
            task.cost = data.cost;
            if (data.status === 'ok') {
                const expectedType = task.type === 'link' ? 'knowledge-links' : task.type === 'proof' ? 'proof-assist' : task.type;
                if (data.type !== expectedType || data.sourceRevision !== task.input.sourceRevision || (data.contentRevision !== undefined && data.contentRevision !== task.input.contentRevision))
                    throw new Error('任务返回的输入版本不匹配，结果未采用。');
                task.result = data.result;
                await this.receive(n, task, data.result, controller.signal);
                if (controller.signal.aborted)
                    throw new DOMException('已取消接收', 'AbortError');
                task.status = 'completed';
                task.steps[0].status = 'completed';
                delete task.error;
                this.options.changed(n);
                if (n === this.options.note())
                    this.el('page-task-status').textContent = '草稿已保存到本机，请逐块核对。模型结果未经质量验收。';
                return;
            }
            if (['error', 'result-unavailable', 'cancelled'].includes(data.status)) {
                task.status = data.status === 'result-unavailable' ? 'unknown' : data.status === 'cancelled' ? 'cancelled' : 'failed';
                task.error = data.error?.message || '服务已没有结果正文。不会自动重新生成；明确重做可能再次计费。';
                task.steps[0].status = task.status;
                this.options.changed(n);
                return;
            }
            task.status = 'running';
            this.options.changed(n);
            if (n === this.options.note())
                this.renderTasks();
            if (Date.now() > deadline)
                throw new Error('本机等待已结束，云端状态仍未知');
            await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
        }
    }
    private async receive(n: Note, task: PageTask, value: unknown, signal: AbortSignal) {
        const data = obj(value);
        const note = ensurePageModel(n);
        if (task.type === 'page-transcribe') {
            if (!Array.isArray(data.blocks) || !task.sourceImage)
                throw new Error('整页结果结构不完整，原稿保留。');
            const full = task.sourceImage;
            for (const raw of data.blocks.slice(task.steps[0].blockIds.length)) {
                if (signal.aborted)
                    throw new DOMException('已取消接收', 'AbortError');
                const item = raw as RemoteBlock;
                if (!item || typeof item.kind !== 'string' || !item.bbox || !Array.isArray(item.uncertainties))
                    throw new Error('整页块结果无效，已收到的草稿保留。');
                const source: SourceRef = { id: newId(), noteId: note.id, pageId: task.pageId, nativePageId: full.page, nativeRevision: String(full.revision), ...(restoreImage(full).inkRevision ? { nativeInkRevision: restoreImage(full).inkRevision } : {}), strokeIds: [...full.strokeIds], sourceRevision: task.input.sourceRevision, bounds: normalizedSourceBounds(restoreImage(full), item.bbox), transform: full.transform, kind: 'ink' };
                note.sources.push(source);
                let block: ContentBlock;
                if (['formula', 'equation'].includes(item.kind) && typeof item.latex === 'string') {
                    const f = this.formula(note, item.latex, source);
                    block = createFormulaBlock(note, f.id, task.pageId);
                    if (item.kind === 'equation')
                        updateBlock(note, block.id, { type: 'derivation' });
                }
                else if (item.kind === 'image-region') {
                    const imageDataUrl = await cropRegion(full.imageUrl, item.bbox);
                    if (signal.aborted)
                        throw new DOMException('已取消接收', 'AbortError');
                    block = createParagraphBlock(note, '', task.pageId);
                    updateBlock(note, block.id, { type: 'image', content: { imageDataUrl, caption: '模型未能处理此原图区域，请返回来源手工核对。' } });
                }
                else {
                    const runs: InlineRun[] = [];
                    for (const segment of item.segments || []) {
                        if (segment.type === 'text')
                            runs.push({ type: 'text', text: segment.text });
                        else if (segment.type === 'math')
                            runs.push({ type: 'formula', formulaId: this.formula(note, segment.latex, source, true).id });
                    }
                    block = createParagraphBlock(note, '', task.pageId);
                    updateBlock(note, block.id, { content: { runs: runs.length ? runs : [{ type: 'text', text: '' }], ...(item.kind === 'heading' ? { role: 'heading' as const, level: 2 as const } : item.kind === 'list-item' ? { role: 'list-item' as const } : {}) } });
                }
                updateBlock(note, block.id, { sourceRefIds: [source.id], needsReview: true, uncertainties: item.uncertainties });
                task.steps[0].blockIds.push(block.id);
                this.options.changed(n);
            }
        }
        else if (task.type === 'context-review') {
            if (!Array.isArray(data.suggestions))
                throw new Error('检查建议结构无效，未修改内容。');
            const manualReview:unknown[]=[];
            for (const raw of data.suggestions) {
                const r = obj(raw), target = note.blocks.find(b => b.id === r.blockId);
                if (!target || target.revision !== r.expectedVersion || this.editableTextFor(note, target) !== r.before)
                    continue;
                if (!snapshotMatches(note, task.input))
                    continue;
                const evidence = Array.isArray(r.evidence) ? r.evidence.map(e => { const x = obj(e); return `[${x.blockId} · 修订 ${x.version}] ${x.quote}`; }) : [];
                const after = typeof r.after === 'string' ? r.after : '';
                if (!after)
                    continue;
                const formula = target.type === 'formula' || target.type === 'derivation';
                const inline=target.type==='paragraph'?this.inlineProposal(after,target.content.runs||[]):undefined;
                if(inline===null||target.type==='image'){
                    manualReview.push({...r,localReason:'该建议会新增、删除、重排行内公式，或对共享公式提出冲突值，未生成可采用修改。原公式保持不变，请手工编辑或单独检查公式。'});
                    continue;
                }
                createSuggestion(note, { targetBlockId: target.id, proposed: formula ? target.content : target.type === 'legacy-markdown' ? { markdown: after } : { ...target.content, runs:inline!.runs }, ...(formula ? { proposedLatex: after } : {}), ...(inline?.changes.length?{inlineFormulaChanges:inline.changes}:{}), category: r.type as SuggestionCategory, reason: String(r.reason || ''), evidence, contextBlockIds: Object.keys(task.input.blocks) });
            }
            if(manualReview.length)data.manualReview=manualReview;
        }
    }
    private renderTasks() {
        const n = ensurePageModel(this.options.note());
        const list = this.el('page-task-list');
        list.replaceChildren();
        for (const task of [...n.tasks].reverse().filter(t => t.pageId === this.currentPage)) {
            const row = make('article', '', 'page-task');
            if(!snapshotMatches(n,task.input,task.type!=='page-transcribe'))row.append(make('p','输入内容或来源页已变化：此结果只供对照；过期建议不能应用。','notice'));const kind: TaskType = task.type === 'link' ? 'knowledge-links' : task.type === 'proof' ? 'proof-assist' : task.type;
            const cost = obj(task.cost);
            row.append(make('p', cost.status === 'estimated' ? `估算费用 ¥${cost.amount}（价格日期 ${cost.priceDate}，须与供应商账单核对）` : `费用未知${typeof cost.reserved === 'number' ? `，已预留 ¥${cost.reserved}` : ''}；不能视为免费`));
            if (task.type === 'page-transcribe' && Array.isArray(obj(task.result).warnings))
                row.append(make('p', `页面提示：${(obj(task.result).warnings as unknown[]).join('；')}`));
            if(task.type==='context-review'){
                const result=obj(task.result);if(typeof result.summary==='string')row.append(make('p',result.summary));
                if(Array.isArray(result.manualReview))for(const raw of result.manualReview){const item=obj(raw),card=make('div','','suggestion-card');card.append(make('strong','需要手工核对 · 未采用'),make('p',String(item.localReason)),make('label','原文（保持不变）'),make('pre',String(item.before)),make('label','AI 建议（只读，不会应用）'),make('pre',String(item.after)),make('p',String(item.reason||'')));row.append(card);}
            }
            row.append(make('strong', `${taskNames[kind]} · ${task.status}`), make('p', task.error || `模型 ${task.model || task.provider}；已收到 ${task.steps[0]?.blockIds.length || 0} 个块；${task.usage ? `输入 ${task.usage.inputTokens} / 输出 ${task.usage.outputTokens} token` : '用量未知，不能视为免费'}`));
            if (['pending', 'running', 'unknown'].includes(task.status)) {
                if (task.gatewayTaskId)
                    row.append(button('查询原任务（不重新生成）', () => void this.resume(task)));
                if (task.gatewayTaskId)
                    row.append(button('取消等待并尝试停止任务', () => void this.cancelTask(task)));
            }
            if (['failed', 'unknown', 'cancelled'].includes(task.status) && task.request)
                row.append(button('明确重做（可能再次计费）', () => {
                    const req=obj(task.request),state=this.options.state(),target=this.options.note();
                    if(state.provider!==task.provider||state.gateway!==req.gateway)return this.options.notify('请先主动切回原模型及服务地址；不会自动转发其他云服务。');
                    this.el('page-consent-title').textContent='重做将创建新请求，可能再次计费';
                    this.el('page-consent-description').textContent='使用原请求的输入重做。原结果未知或已失败，已保存的草稿和原稿继续保留。确认才会再次请求供应商。';
                    this.el('page-consent-payload').textContent=`${taskNames[kind]}；原来源修订 ${task.input.sourceRevision}\n${task.sourceImage?'原始完整页 PNG':JSON.stringify(req.input,null,2)}`;
                    this.approved=()=>{if(target!==this.options.note()||JSON.stringify(state)!==JSON.stringify(this.options.state()))return this.options.notify('服务或笔记已改变，请重新确认。');const image=task.sourceImage?restoreImage(task.sourceImage):undefined;void this.submit(req.type as TaskType,{...obj(req.input),...(image?{imageBase64:image.imageBase64}:{})},task.input,image);};
                    this.consent.showModal();
                }));
            if (task.result && task.type === 'organize')
                this.organizeResult(row, task);
            if (task.result && task.type === 'link')
                this.relationsResult(row, task);
            if (task.result && task.type === 'proof')
                this.proofResult(row, task);
            list.append(row);
        }
    }
    private async resume(task:PageTask){
        if(this.active)return;
        if(task.provider!==this.options.state().provider||obj(task.request).gateway!==this.options.state().gateway)return this.options.notify('请切回原任务的模型和服务地址后查询；不会转发到其他服务。');
        const target=this.options.note(),controller=new AbortController(),sequence=++this.sequence;
        this.active=controller;this.activeTaskId=task.id;
        try{await this.poll(target,task,this.options.state(),controller,sequence);}
        catch(error){if(task.status!=='cancelled'){task.status='unknown';task.error=(error as Error).message;}}
        finally{if(this.active===controller){this.active=null;this.activeTaskId=null;}this.options.changed(target);if(target===this.options.note())this.render();}
    }
    private async cancelTask(task: PageTask) { if(this.activeTaskId===task.id){this.active?.abort();this.active=null;this.activeTaskId=null;} task.status = 'cancelled'; task.error = '已取消本机等待。若供应商已经接收，仍可能计费；原稿与已收草稿保留。'; this.options.changed(); this.renderTasks(); const s = this.options.state(); if (task.gatewayTaskId)
        try {
            await requestJson(`${s.gateway.replace(/\/$/, '')}/v1/tasks/${encodeURIComponent(task.gatewayTaskId)}/cancel?installationId=${encodeURIComponent(s.installationId)}`, { method: 'POST', headers: this.headers(s) }, { timeoutMs: 5000 });
        }
        catch { /* Status remains deliberately unknown to billing. */ } this.renderCapability(); }
    private renderSuggestions() { const n = ensurePageModel(this.options.note()); const list = this.el('suggestion-list'); list.replaceChildren(); for (const s of n.suggestions) {
        const card = make('article', '', 'suggestion-card');
        const stale = isSuggestionStale(n, s);
        card.append(make('strong', `${labels[s.category]} · ${s.status}${stale ? ' · 已过期（只能查看）' : ''}`), make('p', s.reason));
        const before = make('pre'), after = make('pre');
        const originalFormulas={...s.snapshot.formulas},proposedFormulas={...s.snapshot.formulas};
        for(const change of s.inlineFormulaChanges||[]){originalFormulas[change.formulaId]=change.originalLatex;proposedFormulas[change.formulaId]=change.proposedLatex;}
        before.textContent = s.originalLatex || this.contentText(s.original,originalFormulas);
        after.textContent = s.proposedLatex || this.contentText(s.proposed,proposedFormulas);
        card.append(make('label', '改前'), before, make('label', '建议（尚未采用）'), after, make('p', `依据：${s.evidence.join('\n') || '未提供明确依据，请自行核对。'}`));
        const actions = make('div', '', 'block-actions');
        const check = make('input');
        check.type = 'checkbox';
        check.setAttribute('aria-label', '勾选此修改建议');
        check.checked = this.checked.has(s.id);
        check.disabled = stale || s.status !== 'pending';
        check.onchange = () => { if (check.checked)
            this.checked.add(s.id);
        else
            this.checked.delete(s.id); };
        actions.append(check);
        if (s.status === 'pending') {
            const accept = button('采用此建议', () => void this.afterSourceFlush(() => { const ok = applySuggestion(n, s.id); this.changed(); if (!ok)
                this.options.notify('建议已经过期或目标已修改，未覆盖内容。'); }));
            accept.disabled = stale;
            actions.append(accept, button('拒绝', () => { rejectSuggestion(n, s.id); this.changed(); }));
        }
        if (s.status === 'accepted')
            actions.append(button('撤销采用', () => { const ok = undoSuggestion(n, s.id); this.changed(); if (!ok)
                this.options.notify('采用后内容已再次编辑，无法安全撤销。'); }));
        card.append(actions);
        list.append(card);
    } }
    private contentText(content: BlockContent,formulas:Record<string,string>={}) { return content.markdown ?? content.caption ?? (content.runs || []).map(r => r.type === 'text' ? r.text : `$${formulas[r.formulaId]??this.options.note().formulas.find(f => f.id === r.formulaId)?.latex??''}$`).join(''); }
    private organizeResult(row:HTMLElement,task:PageTask){
        const result=obj(task.result),pre=make('pre');pre.textContent=JSON.stringify(result,null,2);
        row.append(make('strong','整理建议：原条件、公式和来源均保留；摘要与新增解释单独标示。'),pre,button('采用为新整理草稿（保留本篇）',()=>void this.afterSourceFlush(()=>this.adoptOrganization(task,result))));
    }
    private adoptOrganization(task:PageTask,result:Record<string,unknown>){
        if(!snapshotMatches(this.options.note(),task.input))return this.options.notify('整理范围已改变，请重新生成；不会覆盖原笔记。');
        const draft=structuredClone(this.options.note());draft.id=newId();draft.title=String(result.title||draft.title)+'（整理草稿）';draft.suggestions=[];draft.tasks=[];draft.links=[];
        const pageIds=new Map((draft.pages||[]).map(p=>[p.id,newId()])),blockIds=new Map((draft.blocks||[]).map(b=>[b.id,newId()])),formulaIds=new Map(draft.formulas.map(f=>[f.id,newId()]));
        draft.pages?.forEach(p=>{p.id=pageIds.get(p.id)!;p.noteId=draft.id;p.blockOrder=p.blockOrder.map(id=>blockIds.get(id)!);});
        draft.blocks?.forEach(b=>{b.id=blockIds.get(b.id)!;b.pageId=pageIds.get(b.pageId)!;if(b.content.formulaId)b.content.formulaId=formulaIds.get(b.content.formulaId)!;b.content.runs?.forEach(r=>{if(r.type==='formula')r.formulaId=formulaIds.get(r.formulaId)!;});delete b.contentHash;});draft.formulas.forEach(f=>f.id=formulaIds.get(f.id)!);
        const outline=Array.isArray(result.outline)?result.outline.map(obj):[];
        const proposedIds=outline.map(item=>blockIds.get(String(item.blockId))).filter((id):id is string=>!!id);
        for(const page of draft.pages||[]){const inPage=proposedIds.filter(id=>page.blockOrder.includes(id)),selected=new Set(inPage);let cursor=0;page.blockOrder=page.blockOrder.map(id=>selected.has(id)?inPage[cursor++]:id);}
        const categories:Record<string,string>={definition:'定义',theorem:'定理',example:'例题',proof:'证明'};
        for(const item of outline){const block=draft.blocks?.find(b=>b.id===blockIds.get(String(item.blockId)));if(!block||!categories[String(item.category)])continue;const heading=createParagraphBlock(draft,'【AI 分类建议：'+categories[String(item.category)]+'】',block.pageId);updateBlock(draft,heading.id,{content:{...heading.content,role:'heading',level:Math.max(1,Math.min(4,Number(item.level)||2)) as 1|2|3|4}});const page=draft.pages!.find(p=>p.id===block.pageId)!;moveBlock(draft,heading.id,page.blockOrder.indexOf(block.id)-page.blockOrder.indexOf(heading.id));}
        const summary=createParagraphBlock(draft,'【AI 摘要建议，不替代原文】\n'+String(result.summary||''));moveBlock(draft,summary.id,-10000);
        if(Array.isArray(result.newExplanations)&&result.newExplanations.length)createParagraphBlock(draft,'【AI 新增解释，未验证】\n'+result.newExplanations.join('\n'));
        void this.options.newDraft(draft);
    }
    private relationsResult(row: HTMLElement, task: PageTask) { const result = obj(task.result); if (!Array.isArray(result.links))
        return; for (const raw of result.links) {
        const link = obj(raw);
        const line = make('div', '', 'suggestion-card');
        line.append(make('p', `建议关系 ${link.relation}：${link.reason}`), make('pre', JSON.stringify(link.evidence, null, 2)), button('采用此关联', () => void this.afterSourceFlush(() => { if (!snapshotMatches(this.options.note(), task.input))
            return this.options.notify('来源已改变，关联建议已过期。'); const target = this.options.notes().find(n => ensurePageModel(n).blocks.some(b => b.id === link.toBlockId)); if (!target)
            return this.options.notify('目标已删除。'); const sent = obj(obj(task.request).input).candidates; const candidate = Array.isArray(sent) ? sent.map(obj).find(c => c.id === link.toBlockId) : undefined; if (!candidate || ensurePageModel(target).blocks.find(b => b.id === link.toBlockId)?.revision !== candidate.version)
            return this.options.notify('目标内容已改变，关联建议已过期。'); addLink(this.options.note(), { sourceBlockId: String(link.fromBlockId), targetNoteId: target.id, targetBlockId: String(link.toBlockId), targetRevision: ensurePageModel(target).blocks.find(b => b.id === link.toBlockId)?.revision, relation: link.relation as 'related' }); this.changed(); })));
        row.append(line);
    } }
    private proofResult(row: HTMLElement, task: PageTask) { const result = obj(task.result); row.append(make('strong', '未验证的步骤建议，不代表证明完成'), make('pre', JSON.stringify(result, null, 2))); if (Array.isArray(result.nextSteps))
        result.nextSteps.forEach((step, i) => row.append(button(`采用步骤 ${i + 1} 为草稿（未验证）`, () => void this.afterSourceFlush(() => { if (!snapshotMatches(this.options.note(), task.input))
            return this.options.notify('输入步骤已改变，请重新请求。'); createParagraphBlock(this.options.note(), `【AI 步骤建议，未验证】${String(step)}`, task.pageId); this.changed(); })))); }
    private renderSearch() { const query = this.el<HTMLInputElement>('knowledge-search').value; const results = this.el('knowledge-results'); results.replaceChildren(); if (!query.trim())
        return; for (const hit of searchNotes(this.options.notes(), query, { limit: 10 })) {
        const row = make('article');
        row.append(button(hit.text.slice(0, 140), () => void this.options.jumpBlock(hit.noteId, hit.blockId), 'link-button'), button('将当前块手工链接到此处', () => { if (!this.selectedBlock)
            return; addLink(this.options.note(), { sourceBlockId: this.selectedBlock, targetNoteId: hit.noteId, targetBlockId: hit.blockId, targetRevision: ensurePageModel(this.options.notes().find(n => n.id === hit.noteId)!).blocks.find(b => b.id === hit.blockId)?.revision, relation: 'related' }); this.changed(); }));
        results.append(row);
    } }
    private renderLinks() { const n = ensurePageModel(this.options.note()), links = this.el('knowledge-links'); links.replaceChildren(); for (const link of n.links) {
        const resolved = resolveLink(this.options.notes(), link);
        const state = linkState(this.options.notes(), link);
        const row = make('p', `${link.relation} · ${state === 'broken' ? '断链' : state === 'changed' ? '目标已变化，请核对' : '来源有效'} `);
        if (resolved)
            row.append(button('跳到关联块', () => void this.options.jumpBlock(link.targetNoteId, link.targetBlockId), 'link-button'));
        links.append(row);
    } const back = this.el('backlinks'); back.replaceChildren(make('h4', '反向链接')); for (const link of backlinks(this.options.notes(), n.id, this.selectedBlock || undefined))
        back.append(button(`来自笔记 ${link.sourceNoteId}`, () => void this.options.jumpBlock(link.sourceNoteId, link.sourceBlockId), 'link-button')); }
}
function snapshotMatches(n: Note, snapshot: PageTask['input'],includeContent=true) { const note = ensurePageModel(n); return (!includeContent||note.contentRevision===snapshot.contentRevision) && Object.entries(snapshot.sourcePages||{}).every(([page,revision])=>note.butterflyContentRevisions?.[page]===revision) && note.revision === snapshot.sourceRevision && Object.entries(snapshot.blocks).every(([id, v]) => note.blocks.find(b => b.id === id)?.revision === v) && Object.entries(snapshot.formulas).every(([id, latex]) => note.formulas.find(f => f.id === id)?.latex === latex); }
function restoreImage(source: NonNullable<PageTask['sourceImage']>): FullPageImage { return { ...source, revision: String(source.revision), imageBase64: source.imageUrl.split(',')[1] || '', transform: source.transform || { offsetX: source.bounds.x, offsetY: source.bounds.y, scaleX: 1, scaleY: 1 } }; }
async function cropRegion(url: string, box: RemoteBlock['bbox']): Promise<string> { const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement('canvas'); const x = Math.max(0, box.x) * image.naturalWidth, y = Math.max(0, box.y) * image.naturalHeight; canvas.width = Math.max(1, Math.ceil(Math.min(box.width, 1 - box.x) * image.naturalWidth)); canvas.height = Math.max(1, Math.ceil(Math.min(box.height, 1 - box.y) * image.naturalHeight)); const context = canvas.getContext('2d'); if (!context)
    throw new Error('无法保留原图区域；原始完整页仍保留。'); context.drawImage(image, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/png'); }
function inlineMathTokens(text:string):{start:number;end:number;latex:string}[]{
    const escaped=(index:number)=>{let count=0;for(let i=index-1;i>=0&&text[i]==='\\';i--)count++;return count%2===1;};
    const tokens:{start:number;end:number;latex:string}[]=[];
    for(let start=0;start<text.length;start++){if(text[start]!=='$'||escaped(start))continue;let end=start+1;while(end<text.length&&text[end]!=='\n'&&(text[end]!=='$'||escaped(end)))end++;if(end<text.length&&text[end]==='$'&&end>start+1){tokens.push({start,end:end+1,latex:text.slice(start+1,end)});start=end;}}
    return tokens;
}
