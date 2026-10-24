import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBackup, newNote, type Note } from '../../apps/web/src/model.ts';
import { createParagraphBlock, createSourceRef, ensurePageModel, updateBlock } from '../../apps/web/src/page-model.ts';
import { rememberSourceCopies } from '../../apps/web/src/source-copy.ts';
import { quotaState } from './fixtures/ocr-state';

function sourceNote() {
  const note=ensurePageModel(newNote());note.title='独立恢复的来源原稿';note.revision=7;note.strokes=[{id:'original-source-ink',color:'#111',width:3,points:[{x:40,y:50,pressure:.5},{x:90,y:100,pressure:.7}]}];
  const block=createParagraphBlock(note,'带原稿来源的条件');const source=createSourceRef(note,note.pages[0].id,{x:20,y:30,width:100,height:100},['original-source-ink']);source.nativeRevision='7';updateBlock(note,block.id,{sourceRefIds:[source.id]});return {note,source};
}
async function statusRoutes(page:Page){await page.route('**/v1/status**',route=>route.fulfill({json:{status:'ok',authMode:'local',provider:'deepseek',simulated:false,configured:true,capabilities:{transcribe:true,review:true},taskCapabilities:{organize:true}}}));await page.route('**/v1/usage?**',route=>route.fulfill({json:quotaState()}));}
async function importSingle(page:Page,note:Note){await page.locator('#restore-file').setInputFiles({name:'single-note.mathink.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(createBackup([note])))});await expect(page.locator('#note-title')).toHaveValue(note.title);await expect(page.locator('#save-state')).toHaveText('已保存到本机');}

test('organized draft exported alone restores proven manuscript copy while retaining original source identity',async({page,browser})=>{
  const {note:original,source}=sourceNote();await statusRoutes(page);
  let request:Record<string,any>|undefined;
  await page.route('**/v1/tasks',route=>{request=route.request().postDataJSON();return route.fulfill({status:202,json:{taskId:'source-organization',status:'pending',provider:'deepseek',model:'fixture-model',type:'organize',sourceRevision:request!.sourceRevision}});});
  await page.route('**/v1/tasks/source-organization?**',route=>route.fulfill({json:{taskId:'source-organization',status:'ok',provider:'deepseek',model:'fixture-model',type:'organize',sourceRevision:request!.sourceRevision,contentRevision:request!.input.contentRevision,result:{title:'来源整理',outline:request!.input.blocks.map((b:Record<string,unknown>)=>({blockId:b.id,level:2,category:'text'})),summary:'仅作明确标示的摘要',newExplanations:[]}}}));
  await page.goto('/');await expect(page.locator('#save-state')).toHaveText('已保存到本机');await importSingle(page,original);await page.locator('#page-workbench-open').click();await page.locator('#organize-page').click();await page.locator('#page-consent-allow').click();await expect(page.locator('#page-task-list')).toContainText('completed');await page.getByRole('button',{name:'采用为新整理草稿（保留本篇）',exact:true}).click();await expect(page.locator('#note-title')).toHaveValue('来源整理（整理草稿）');
  await page.locator('#export-open').click();const downloaded=page.waitForEvent('download');await page.locator('#export-backup').click();const path=await(await downloaded).path();const exported=JSON.parse(await readFile(path!,'utf8'));const draft:Note=exported.notes.find((n:Note)=>n.title==='来源整理（整理草稿）');expect(draft.sourceCopyProofs).toHaveLength(1);expect(draft.sources![0].noteId).toBe(original.id);
  const clean=await browser.newContext();try{const restored=await clean.newPage();await statusRoutes(restored);await restored.goto('/');await expect(restored.locator('#save-state')).toHaveText('已保存到本机');await importSingle(restored,draft);await restored.locator('#page-workbench-open').click();await restored.locator('.content-block').filter({hasText:'带原稿来源的条件'}).getByRole('button',{name:'返回此块原稿',exact:true}).click();await expect(restored.locator('#ink-editor')).toBeVisible();await expect(restored.locator('#toast')).toContainText('内容与版本一致的本篇原稿副本');await expect(restored.locator('#selection-label')).toHaveText('已圈选 1 笔');
    const stored=await restored.evaluate(async id=>new Promise<any>((resolve,reject)=>{const request=indexedDB.open('math-ink-notebooks');request.onsuccess=()=>{const db=request.result,read=db.transaction('notes','readonly').objectStore('notes').get(id);read.onsuccess=()=>{db.close();resolve(read.result);};read.onerror=()=>reject(read.error);};}),draft.id);expect(stored.sources[0].noteId).toBe(original.id);expect(stored.sources[0].id).toBe(source.id);expect(stored.sourceCopyProofs[0].manuscriptSha256).toMatch(/^[a-f0-9]{64}$/);
  }finally{await clean.close();}
});

test('same version number with altered copied ink refuses source fallback',async({page})=>{
  const {note:original,source}=sourceNote(),draft=structuredClone(original);draft.id='changed-draft';draft.title='不匹配的原稿副本';draft.pages.forEach(p=>p.noteId=draft.id);rememberSourceCopies(original,draft);draft.strokes[0].points[0].x+=200;expect(draft.revision).toBe(source.sourceRevision);
  await statusRoutes(page);await page.goto('/');await expect(page.locator('#save-state')).toHaveText('已保存到本机');await importSingle(page,draft);await page.locator('#page-workbench-open').click();await page.getByRole('button',{name:'返回此块原稿',exact:true}).click();await expect(page.locator('#toast')).toContainText('无法通过内容与版本核对');await expect(page.locator('#organized-editor')).toBeVisible();
});
