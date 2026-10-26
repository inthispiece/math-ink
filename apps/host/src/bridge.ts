import { parseBackup } from '../../web/src/model.ts';
import { SiYuanApi, type ExportRecord, type Notebook } from './siyuan-api.ts';
const activeExportKeys = new Set<string>();

export function attachSiYuanBridge(frame: HTMLIFrameElement, options: {
  notebookId: () => string;
  loadRecord: (id: string) => Promise<ExportRecord | undefined>;
  saveRecord: (id: string, record: ExportRecord) => Promise<void>;
  status: (message: string) => void;
}): () => void {
  const api = new SiYuanApi();
  const pending = new Map<string, Promise<void>>();
  const exporting = activeExportKeys;
  const origin = location.origin;
  const listener = (event: MessageEvent) => {
    if (event.origin !== origin || event.source !== frame.contentWindow || event.data?.type !== 'mathink:siyuan') return;
    const { requestId, action, payload } = event.data;
    if (typeof requestId !== 'string' || requestId.length > 100 || action !== 'exportNote') return;
    if (pending.has(requestId)) return;
    const notebookId = options.notebookId();
    const task = Promise.resolve().then(async () => {
      let exportKey: string | undefined;
      try {
        const note = parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: payload?.note?.pageOrder ? 3 : payload?.note?.pages ? 2 : 1, exportedAt: new Date().toISOString(), notes: [payload?.note] })).notes[0];
        if (JSON.stringify(note).length > 20_000_000) throw new Error('笔记过大，请分成多页导出');
        const key = `${notebookId}-${note.id}`;
        if (exporting.has(key)) throw new Error('这篇笔记正在整理，请等待保存完成');
        exporting.add(key); exportKey = key;
        options.status('正在保存原稿与公式到思源…');
        const previous = await options.loadRecord(key);
        const record = await api.exportNote(note, notebookId, previous, undefined, record => options.saveRecord(key, record));
        await options.saveRecord(key, record);
        frame.contentWindow?.postMessage({ type: 'mathink:siyuan:result', requestId, ok: true, result: record }, origin);
        options.status('原稿与公式已保存到思源');
      } catch (error) {
        const message = error instanceof Error ? error.message : '保存失败，请重试';
        frame.contentWindow?.postMessage({ type: 'mathink:siyuan:result', requestId, ok: false, error: message }, origin);
        options.status(message);
      } finally { pending.delete(requestId); if (exportKey) exporting.delete(exportKey); }
    });
    pending.set(requestId, task);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

export async function populateNotebooks(select: HTMLSelectElement, createIfEmpty = false): Promise<void> {
  const api = new SiYuanApi();
  let notebooks: Notebook[] = await api.notebooks();
  if (!notebooks.length && createIfEmpty) {
    await api.call('/api/notebook/createNotebook', { name: 'MathInk' });
    notebooks = await api.notebooks();
  }
  select.replaceChildren();
  for (const notebook of notebooks) {
    const option = document.createElement('option'); option.value = notebook.id; option.textContent = notebook.name;
    select.append(option);
  }
  if (!notebooks.length) { const option = document.createElement('option'); option.textContent = '请先创建并打开一个笔记本'; option.value = ''; select.append(option); }
}
