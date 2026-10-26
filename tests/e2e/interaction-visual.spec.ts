import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {toolFixture,seedToolNotes,openToolOwner,openToolDraft} from './fixtures/notebook-tools';

test('capture the six actual interaction states and tablet layout without model requests',async({page,context})=>{
  const service=await toolFixture(page,context),seed=await seedToolNotes(page,{formulaDraft:true});await page.reload();await expect(page.locator('.note-card')).toHaveCount(1);const directory='.local/frontend-states';await mkdir(directory,{recursive:true});
  await page.screenshot({path:directory+'/01-library.png',fullPage:true});await openToolOwner(page,seed);await page.screenshot({path:directory+'/02-writing.png'});
  await page.locator('#toolbox-open').click();await page.screenshot({path:directory+'/03-tools.png'});await page.locator('#drafts-open').click();await expect(page.locator('.draft-item')).toHaveCount(1);await page.screenshot({path:directory+'/04-drafts.png'});
  await openToolDraft(page,seed.noteId,seed.draftId);await page.screenshot({path:directory+'/05-detail.png'});await page.getByRole('button',{name:'插入当前页',exact:true}).click();await expect(page.locator('#placement-bar')).toBeVisible();await page.locator('#ink-canvas').hover({position:{x:200,y:180}});await page.screenshot({path:directory+'/06-placement.png'});await page.locator('#placement-cancel').click();
  await page.setViewportSize({width:800,height:1280});await page.locator('#drafts-open').click();await page.screenshot({path:directory+'/07-tablet.png'});expect(service.generated()).toHaveLength(0);
});
