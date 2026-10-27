import type { Note,NotebookBackup } from '../../web/src/model.ts';
import { isStale } from '../../web/src/model.ts';
import { orderedBlocks, markdownFormula, type ContentBlock } from '../../web/src/page-model.ts';
import { formalNoteForExport,exportFormalBackup,formalAssetLoader } from '../../web/src/formal-export.ts';
import {decodeBinaryResource} from '../../web/src/asset-model.ts';

type ApiResult<T> = { code: number; msg: string; data: T };
type Operation = { doOperations: { id: string; action: string }[] };
export interface Notebook { id: string; name: string; closed?: boolean }
export interface ExportRecord { documentId: string; notebookId: string; bodyBlockId?: string; title?: string; formulaBlockIds: Record<string, string>; contentBlockIds?: Record<string, string>; snapshotAsset: string; butterflyAsset?: string;binaryAssets?:Record<string,string> }
export class SiYuanApi {
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = fetch) { this.request = request; }
  async call<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`思源服务请求失败（${response.status}）`);
    const result = await response.json() as ApiResult<T>;
    if (result.code !== 0) throw new Error(result.msg || '思源 API 返回错误');
    return result.data;
  }
  async notebooks(): Promise<Notebook[]> {
    const data = await this.call<{ notebooks: Notebook[] }>('/api/notebook/lsNotebooks', {});
    return data.notebooks.filter(book => !book.closed);
  }
  async upload(name: string, blob: Blob): Promise<string> {
    const form = new FormData();
    form.set('assetsDirPath', '/assets/');
    form.set('file[]', blob, name);
    const response = await this.request('/api/asset/upload', { method: 'POST', credentials: 'same-origin', body: form });
    if (!response.ok) throw new Error('原稿资产上传失败');
    const result = await response.json() as ApiResult<{ succMap: Record<string, string>; errFiles?: string[] }>;
    const path = result.data?.succMap?.[name];
    if (result.code !== 0 || !path || result.data.errFiles?.length) throw new Error(result.msg || '原稿资产未完整保存');
    return path;
  }
  async attrs(id: string, attrs: Record<string, string>): Promise<void> {
    await this.call('/api/attr/setBlockAttrs', { id, attrs });
  }
  async exportNote(note: Note, notebookId: string, previous?: ExportRecord, butterflyData?: number[], progress?: (record: ExportRecord) => Promise<void>,formalBackup?:NotebookBackup): Promise<ExportRecord> {
    if (!notebookId) throw new Error('请先选择目标笔记本');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(note.id)) throw new Error('笔记标识格式无效，无法安全保存原稿');
    // Keep the existing host block mapping when upgrading a legacy notebook.
    const structured = Array.isArray(note.pages) && Array.isArray(note.blocks);
    note = formalNoteForExport(note);
    const safeId = note.id;
    const envelope=await exportFormalBackup(note,formalBackup?formalAssetLoader(formalBackup):undefined);
    const backup = JSON.stringify(envelope);
    const snapshotAsset = await this.upload(`mathink-${safeId}.mathink.json`, new Blob([backup], { type: 'application/json' }));
    const bytes = butterflyData ?? (Array.isArray(note.butterflyData) ? note.butterflyData : undefined);
    const butterflyAsset = bytes ? await this.upload(`mathink-${safeId}.bfly`, new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })) : undefined;
    const binaryAssets:Record<string,string>={},pdfLinks:string[]=[];
    for(const encoded of envelope.binaryResources||[]){const resource=decodeBinaryResource(encoded),extension=resource.mime==='application/pdf'?'pdf':resource.mime==='image/png'?'png':'jpg';binaryAssets[resource.id]=previous?.binaryAssets?.[resource.id]||await this.upload(`mathink-${resource.id}.${extension}`,new Blob([new Uint8Array(resource.bytes)],{type:resource.mime}));if(resource.mime==='application/pdf')pdfLinks.push(`[${(resource.name||'PDF 原文件').replace(/[\[\]\\()\r\n]/g,' ')}](${binaryAssets[resource.id]})`);}
    const title = note.title.replace(/[\\/\r\n]/g, '／').slice(0, 120) || '未命名笔记';
    const record: ExportRecord = previous && previous.notebookId === notebookId ? { ...previous, formulaBlockIds: { ...previous.formulaBlockIds }, snapshotAsset, butterflyAsset,binaryAssets } : {
      documentId: await this.call<string>('/api/filetree/createDocWithMd', { notebook: notebookId, path: `/MathInk/${title} · ${safeId}`, markdown: '' }),
      notebookId, formulaBlockIds: {}, snapshotAsset, butterflyAsset,binaryAssets
    };
    await progress?.(record);
    if (record.title !== title) {
      await this.call('/api/filetree/renameDocByID', { id: record.documentId, title: `${title} · ${safeId}` });
      record.title = title;
      await progress?.(record);
    }
    const body = `{{{row\n\n${structured ? '按页面阅读顺序整理；原稿与内容块分别保留。' : note.markdown || '数学手写笔记'}\n\n[原稿备份](${snapshotAsset})${butterflyAsset ? ` · [Butterfly 原稿](${butterflyAsset})` : ''}${pdfLinks.length?'\n\n原 PDF：'+pdfLinks.join(' · '):''}\n\n}}}`;
    if (record.bodyBlockId) await this.call('/api/block/updateBlock', { id: record.bodyBlockId, dataType: 'markdown', data: body, lockType: true });
    else {
      const operations = await this.call<Operation[]>('/api/block/appendBlock', { parentID: record.documentId, dataType: 'markdown', data: body });
      record.bodyBlockId = operations[0]?.doOperations[0]?.id;
      if (!record.bodyBlockId) throw new Error('思源没有返回整理正文块标识');
      await progress?.(record);
    }
    await this.attrs(record.bodyBlockId, { 'custom-mathink-managed': 'body', 'custom-mathink-note-id': note.id });
    await this.attrs(record.documentId, {
      'custom-mathink-note-id': note.id,
      'custom-mathink-source-asset': snapshotAsset,
      'custom-mathink-source-revision': String(note.revision),
      'custom-mathink-content-revision': String(note.contentRevision || 0),
      'custom-mathink-tags': note.tags.join(',')
    });
    if (structured) {
      record.contentBlockIds = { ...record.contentBlockIds };
      const markdown = (block: ContentBlock): string => {
        if (block.type === 'legacy-markdown') return block.content.markdown || '';
        if (block.type === 'formula' || block.type === 'derivation') return markdownFormula(note.formulas.find(f => f.id === block.content.formulaId),true);
        if (block.type === 'image') return `[原图区域见完整原稿备份](${snapshotAsset})\n\n${block.content.caption || '待手工核对的原图区域'}`;
        return (block.content.runs || []).map(run => run.type === 'text' ? run.text : markdownFormula(note.formulas.find(f => f.id === run.formulaId),false)).join('');
      };
      let previousId = record.bodyBlockId;
      const currentIds = new Set<string>();
      for (const block of orderedBlocks(note)) {
        currentIds.add(block.id);
        const formulaId = block.content.formulaId;
        let targetId = record.contentBlockIds[block.id] || (formulaId ? record.formulaBlockIds[formulaId] : undefined);
        const data = `{{{row\n\n${markdown(block)}\n\n}}}`;
        if (targetId) await this.call('/api/block/updateBlock', { id: targetId, dataType: 'markdown', data });
        else {
          const operations = await this.call<Operation[]>('/api/block/appendBlock', { parentID: record.documentId, dataType: 'markdown', data });
          targetId = operations[0]?.doOperations[0]?.id;
          if (!targetId) throw new Error('思源没有返回页面内容块标识');
        }
        record.contentBlockIds[block.id] = targetId;
        if (formulaId) record.formulaBlockIds[formulaId] = targetId;
        await progress?.(record);
        const source = note.sources?.filter(s => block.sourceRefIds.includes(s.id)) || [];
        const formula = formulaId ? note.formulas.find(f => f.id === formulaId) : undefined;
        await this.attrs(targetId, {
          'custom-mathink-note-id': note.id, 'custom-mathink-block-id': block.id,
          'custom-mathink-page-id': block.pageId, 'custom-mathink-content-revision': String(block.revision),
          'custom-mathink-source-asset': snapshotAsset, 'custom-mathink-source-refs': JSON.stringify(source),
          'custom-mathink-source-removed': 'false',
          ...(formula ? {
            'custom-mathink-formula-id': formula.id,
            'custom-mathink-formula-scale': String(formula.scale??1),
            'custom-mathink-source-strokes': JSON.stringify(formula.sourceStrokeIds),
            'custom-mathink-source-revision': String(formula.sourceRevision),
            'custom-mathink-source-page': formula.sourcePage || 'default',
            'custom-mathink-source-butterfly-revision': formula.sourceButterflyRevision || '',
            'custom-mathink-source-bounds': JSON.stringify(formula.sourceBounds),
            'custom-mathink-source-stale': String(isStale(note, formula)),
          } : {}),
        });
        if (previousId) await this.call('/api/block/moveBlock', { id: targetId, previousID: previousId });
        previousId = targetId;
      }
      // Preserve previously exported content instead of deleting edits in SiYuan.
      for (const [sourceId, targetId] of Object.entries(record.contentBlockIds)) if (!currentIds.has(sourceId)) {
        await this.attrs(targetId, { 'custom-mathink-source-removed': 'true' });
        if (previousId) await this.call('/api/block/moveBlock', { id: targetId, previousID: previousId });
        previousId = targetId;
      }
      return record;
    }
    for (const formula of note.formulas) {
      let blockId = Object.hasOwn(record.formulaBlockIds, formula.id) ? record.formulaBlockIds[formula.id] : undefined;
      if (blockId) await this.call('/api/block/updateBlock', { id: blockId, dataType: 'markdown', data: markdownFormula(formula,true) });
      else {
        const operations = await this.call<Operation[]>('/api/block/appendBlock', { parentID: record.documentId, dataType: 'markdown', data: markdownFormula(formula,true) });
        blockId = operations[0]?.doOperations[0]?.id;
        if (!blockId) throw new Error('思源没有返回公式块标识');
        record.formulaBlockIds[formula.id] = blockId;
        await progress?.(record);
      }
      await this.attrs(blockId, {
        'custom-mathink-formula-id': formula.id,
        'custom-mathink-formula-scale': String(formula.scale??1),
        'custom-mathink-note-id': note.id,
        'custom-mathink-source-asset': snapshotAsset,
        'custom-mathink-source-strokes': JSON.stringify(formula.sourceStrokeIds),
        'custom-mathink-source-revision': String(formula.sourceRevision),
        'custom-mathink-source-page': formula.sourcePage || 'default',
        'custom-mathink-source-butterfly-revision': formula.sourceButterflyRevision || '',
        'custom-mathink-source-bounds': JSON.stringify(formula.sourceBounds),
        'custom-mathink-source-stale': String(isStale(note, formula))
      });
    }
    return record;
  }
}
