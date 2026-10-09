import type { ExportRecord } from './siyuan-api.ts';

export interface ExportStorageOptions {
  request?: typeof fetch;
  timeoutMs?: number;
}

function recordPath(pluginName: string, key: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(pluginName) || pluginName.includes('..')) throw new Error('插件存储名称无效');
  const encoded = encodeURIComponent(key);
  if (!encoded || encoded.length > 180) throw new Error('导出记录标识过长或为空');
  return `/data/storage/petal/${pluginName}/exports-${encoded}.json`;
}

function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function isAssetPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/?assets\//.test(value) && !value.includes('..') && !/[\\\r\n]/.test(value);
}

export function validateExportRecord(value: unknown): ExportRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('导出记录损坏，请先恢复记录，避免重复创建公式');
  const record = value as ExportRecord & { bodyBlockId?: string };
  if (!isBlockId(record.documentId) || !isBlockId(record.notebookId) || !isAssetPath(record.snapshotAsset) || (record.butterflyAsset !== undefined && !isAssetPath(record.butterflyAsset)) || (record.bodyBlockId !== undefined && !isBlockId(record.bodyBlockId)) || !record.formulaBlockIds || typeof record.formulaBlockIds !== 'object' || Array.isArray(record.formulaBlockIds) || !Object.values(record.formulaBlockIds).every(isBlockId)) throw new Error('导出记录损坏，请先恢复记录，避免重复创建公式');
  return record;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('思源导出记录存储超时，请检查连接后再重试')); }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function loadExportRecord(pluginName: string, key: string, options: ExportStorageOptions = {}): Promise<ExportRecord | undefined> {
  const path = recordPath(pluginName, key);
  const request = options.request || fetch;
  return withTimeout(async signal => {
    const response = await request('/api/file/getFile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ path }), signal });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`读取思源导出记录失败（HTTP ${response.status}）`);
    let content: unknown;
    try { content = await response.json(); } catch { throw new Error('思源导出记录不是有效 JSON，请恢复记录后重试'); }
    if (content && typeof content === 'object' && 'code' in content) {
      const result = content as { code: unknown; msg?: string };
      if (result.code === 404) return undefined;
      throw new Error(result.msg || '读取思源导出记录失败');
    }
    return validateExportRecord(content);
  }, options.timeoutMs);
}

export async function saveExportRecord(pluginName: string, key: string, record: ExportRecord, options: ExportStorageOptions = {}): Promise<void> {
  const path = recordPath(pluginName, key);
  validateExportRecord(record);
  const request = options.request || fetch;
  return withTimeout(async signal => {
    const form = new FormData();
    form.set('path', path);
    form.set('isDir', 'false');
    form.set('file', new Blob([JSON.stringify(record)], { type: 'application/json' }), path.slice(path.lastIndexOf('/') + 1));
    const response = await request('/api/file/putFile', { method: 'POST', credentials: 'same-origin', body: form, signal });
    if (!response.ok) throw new Error(`保存思源导出记录失败（HTTP ${response.status}）`);
    const result = await response.json() as { code?: number; msg?: string };
    if (result.code !== 0) throw new Error(result.msg || '思源未确认导出记录写入成功');
  }, options.timeoutMs);
}
