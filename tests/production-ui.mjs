import assert from 'node:assert/strict';

/** Shared selectors for the built schema-4 application, without mock providers. */
export async function waitForLibrary(page) {
  await page.locator('#library-view').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('library-count')?.textContent?.includes('正在'));
}
export async function waitForSaved(page) {
  await page.waitForFunction(() => document.getElementById('save-state')?.textContent === '已保存');
}
export async function savedNotebooks(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('math-ink-notebooks');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      if(open.result.version!==4){open.result.close();reject(new Error('Production app did not upgrade notebook database to schema4'));return;}
      const db = open.result, tx = db.transaction('notes', 'readonly'), read = tx.objectStore('notes').getAll();
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
      tx.oncomplete = () => db.close();
    };
  }));
}
export async function createNotebook(page, title) {
  await page.locator('#new-note').click();
  await page.locator('#editor-view').waitFor({ state: 'visible' });
  await page.locator('#note-title').fill(title);
  await page.locator('#note-title').blur();
  await page.waitForFunction(title => document.getElementById('note-title')?.value === title && document.getElementById('save-state')?.textContent === '已保存', title);
  assert.ok((await savedNotebooks(page)).some(note => note.title === title));
}
export async function openNotebook(page, title) {
  await page.getByRole('button', { name: '打开 ' + title, exact: true }).click();
  await page.locator('#editor-view').waitFor({ state: 'visible' });
  await waitForSaved(page);
}
export async function manualFormulaDraft(page, latex) {
  await page.locator('#toolbox-open').click();
  await page.getByText('手工创建草稿', { exact: true }).click();
  page.once('dialog', dialog => void dialog.accept(latex));
  await page.getByRole('button', { name: '输入 LaTeX 公式', exact: true }).click();
  await page.locator('#draft-detail-dialog').waitFor({ state: 'visible' });
  await page.locator('#draft-formula-preview .katex').waitFor({ state: 'visible' });
}
export async function waitForButterfly(page) {
  await page.waitForFunction(() => {
    const frame = document.getElementById('butterfly-frame');
    return !!frame && frame.style.pointerEvents !== 'none' && document.getElementById('butterfly-status')?.textContent === '';
  }, undefined, { timeout: 60000 });
  await waitForSaved(page);
}
export const isGenerationRequest = request => request.method() === 'POST' && /^\/v1\/(?:recognize|recognitions|review|tasks)(?:\/|$)/.test(new URL(request.url()).pathname);
