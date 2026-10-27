import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {toolFixture,seedToolNotes,notes,openToolOwner} from './fixtures/notebook-tools';

test('BF002 emergency backup combines unsaved active content with other tabs latest bodies, drafts and newly created notes',async({page,context})=>{
 const service=await toolFixture(page,context),seed=await seedToolNotes(page,{candidates:true});
 await openToolOwner(page,seed);
 await expect(page.locator('#save-state')).toHaveText('已保存');
 const otherId=seed.candidates[0].id,otherTab=await context.newPage();
 // A separate document shares IndexedDB but cannot refresh the editor's in-memory library cache.
 await otherTab.goto('/ai-setup.html');
 const changed=await otherTab.evaluate(async({otherId,blockId})=>{
  const mp='/src/model.ts',dp='/src/notebook-domain.ts',rp='/src/notebook-repository.ts',pp='/src/page-model.ts',fp='/src/folders.ts';
  const m=await import(mp) as typeof import('../../apps/web/src/model.ts'),d=await import(dp) as typeof import('../../apps/web/src/notebook-domain.ts'),r=await import(rp) as typeof import('../../apps/web/src/notebook-repository.ts'),p=await import(pp) as typeof import('../../apps/web/src/page-model.ts'),f=await import(fp) as typeof import('../../apps/web/src/folders.ts');
  const folder=await f.createFolder('另一个标签页的目录');let draftId='',snapshotId='';
  await r.updateNote(otherId,n=>{
   n.title='另一标签页更新后的数学笔记';
   p.updateBlock(n,blockId,{content:{runs:[{type:'text',text:'最新正文：Hölder 条件 p > 1，不应退回旧缓存。'}]}});
   const canvas=document.createElement('canvas');canvas.width=80;canvas.height=40;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#ffffff';ctx.fillRect(0,0,80,40);ctx.fillStyle='#223d35';ctx.fillText('x^2',8,25);
   snapshotId=d.addSnapshot(n,canvas.toDataURL('image/png'));
   draftId=d.createDraft(n,{type:'formula',sourcePageId:n.pages[0].id,status:'completed',latex:'a^2+b^2=c^2',snapshotIds:[snapshotId],version:1}).id;
  });
  await f.moveNoteToFolder(otherId,folder.id);
  const created=d.ensureNotebook(m.newNote());created.title='主标签页缓存中从未存在的新笔记';created.folderId=folder.id;await r.saveEditingNote(created);
  return{other:await r.getNote(otherId),createdId:created.id,folderId:folder.id,draftId,snapshotId};
 },{otherId,blockId:seed.candidates[0].blockId});
 await page.bringToFront();
 // Fail only this tab's active-note writes. Reads and the other tab's successful work remain intact.
 await page.evaluate(noteId=>{
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value:any,...args:any[]){
   if(this.name==='notes'&&value?.id===noteId)throw new DOMException('fixture current note storage full','QuotaExceededError');
   return original.apply(this,[value,...args] as [any,IDBValidKey?]);
  };
 },seed.noteId);
 await page.locator('#note-title').fill('当前原稿只在内存中的未保存标题');
 await page.locator('#note-title').blur();
 await expect(page.locator('#save-error')).toBeVisible();
 await expect(page.locator('#save-state')).toHaveText('保存失败');
 const downloading=page.waitForEvent('download');
 await page.locator('#emergency-export').click();
 const download=await downloading;
 expect(download.suggestedFilename()).toBe('MathInk-当前未确认保存.mathink.json');
 const text=await readFile((await download.path())!,'utf8');
 // Exercise the real resource-pool restore boundary, rather than inspecting an unexpanded JSON token.
 const backup=await page.evaluate(async text=>{
  const path='/src/model.ts',m=await import(path) as typeof import('../../apps/web/src/model.ts');return m.parseBackup(text);
 },text);
 expect(backup.schemaVersion).toBe(4);
 expect(backup.notes).toHaveLength(4);
 const active=backup.notes.find(n=>n.id===seed.noteId)!,other=backup.notes.find(n=>n.id===otherId)!;
 expect(active.title).toBe('当前原稿只在内存中的未保存标题');
 expect(active.strokes.map(stroke=>stroke.id)).toContain('tool-ink');
 expect(other.title).toBe(changed.other!.title);
 expect(other.blocks).toEqual(changed.other!.blocks);
 expect(other.drafts).toEqual(changed.other!.drafts);
 expect(other.drafts!.find(draft=>draft.id===changed.draftId)!.latex).toBe('a^2+b^2=c^2');
 expect(other.resources![changed.snapshotId]).toEqual(changed.other!.resources[changed.snapshotId]);
 expect(other.folderId).toBe(changed.folderId);
 expect(backup.folders!.map(folder=>folder.id)).toContain(changed.folderId);
 expect(backup.notes.find(n=>n.id===changed.createdId)!.title).toBe('主标签页缓存中从未存在的新笔记');
 const stored=await notes(page);
 expect(stored.find(n=>n.id===seed.noteId)!.title).toBe(seed.title);
 expect(stored.find(n=>n.id===otherId)!.drafts).toEqual(changed.other!.drafts);
 await expect(page.locator('#save-error')).toBeVisible();
 expect(service.generated()).toHaveLength(0);
 await otherTab.close();
});
