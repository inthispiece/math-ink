import {test,expect,type Page,type BrowserContext,type CDPSession,type Locator} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {unzipSync} from 'fflate';
import {toolFixture,notes,settings} from './fixtures/notebook-tools';

test.use({hasTouch:true});
type Engine='experimental'|'butterfly';
type Camera={zoom:number;panX:number;panY:number};
interface NativeDocument {data:number[];page:string;pages:{id:string;name:string}[]}

async function native<T=any>(page:Page,method:string,payload:unknown={}):Promise<T>{
  return page.evaluate(({method,payload})=>new Promise<any>((resolve,reject)=>{
    const frame=document.querySelector<HTMLIFrameElement>('#butterfly-frame')!,requestId=crypto.randomUUID();
    const timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(new Error('Navigation fixture bridge '+method));},30000);
    function receive(event:MessageEvent){if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.type!=='mathink'||event.data.message?.requestId!==requestId)return;clearTimeout(timer);window.removeEventListener('message',receive);event.data.message.ok===false?reject(new Error(event.data.message.error)):resolve(event.data.message.result);}
    window.addEventListener('message',receive);frame.contentWindow!.postMessage({type:'mathink',message:{requestId,method,payload}},location.origin);
  }),{method,payload});
}
async function saved(page:Page){await expect(page.locator('#save-state')).toHaveText('已保存',{timeout:15000});const index=Number((await page.locator('#page-number').textContent())!.split('/')[0].trim())-1;await expect.poll(async()=>{const n=(await notes(page))[0];return n?.currentPageId===n?.pageOrder[index];}).toBe(true);}
async function camera(page:Page,engine:Engine):Promise<Camera>{
  if(engine==='butterfly'){const v=await native(page,'getView');return{zoom:v.zoom,panX:-v.x*v.zoom,panY:-v.y*v.zoom};}
  const n=(await notes(page))[0];return n.pageViews[n.currentPageId];
}
function nativeInk(document:NativeDocument){const entries=unzipSync(new Uint8Array(document.data)),row=document.pages.find(p=>p.id===document.page)!;const page=JSON.parse(new TextDecoder().decode(entries['BFLY/pages/'+row.name+'.json']));return(page.layers||[]).flatMap((layer:any)=>layer.content||[]).filter((element:any)=>element.type==='pen');}
async function inkCount(page:Page,engine:Engine){if(engine==='butterfly')return nativeInk(await native<NativeDocument>(page,'getDocument')).length;const n=(await notes(page))[0];return n.pageStrokes[n.currentPageId].length;}
async function setup(page:Page,context:BrowserContext,engine:Engine){
  const service=await toolFixture(page,context);
  if(engine==='butterfly'){await settings(page);await page.locator('#ink-mode').selectOption('butterfly');await page.getByRole('button',{name:'保存设置',exact:true}).click();}
  await page.locator('#new-note').click();await expect(page.locator('#editor-view')).toBeVisible();
  if(engine==='butterfly'){await expect(page.locator('#butterfly-status')).toHaveText('',{timeout:60000});expect((await native(page,'getCapabilities')).pageGestures).toBe(true);}
  await page.locator('#add-page').click();await expect(page.locator('#page-number')).toHaveText('2 / 2');await saved(page);
  await page.locator('#add-page').click();await expect(page.locator('#page-number')).toHaveText('3 / 3');await saved(page);
  await page.locator('#prev-page').click();await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);
  await page.locator('#prev-page').click();await expect(page.locator('#page-number')).toHaveText('1 / 3');await saved(page);
  const surface=page.locator(engine==='butterfly'?'#butterfly-frame':'#ink-canvas');
  const cdp=await context.newCDPSession(page);return{service,surface,cdp};
}
async function pointsOn(surface:Locator,fractions:number[][]){const box=(await surface.boundingBox())!;return fractions.map(([x,y])=>({x:box.x+box.width*x,y:box.y+box.height*y}));}
async function touch(cdp:CDPSession,path:{x:number;y:number}[],cancel=false){
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[path[0]]});
  for(const point of path.slice(1))await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point]});
  await cdp.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});
}
async function swipe(cdp:CDPSession,surface:Locator,direction:'next'|'previous',cancel=false){if(await surface.evaluate(e=>e.tagName==='IFRAME'))await native(surface.page(),'getViewport');const from=direction==='next'?.76:.24,to=direction==='next'?.24:.76;await touch(cdp,await pointsOn(surface,[[from,.55],[(from+to)/2,.55],[to,.55]]),cancel);}
async function footerSwipe(page:Page,cdp:CDPSession,direction:'next'|'previous'){
  const box=(await page.locator('#page-number').boundingBox())!,x=box.x+box.width/2,y=box.y+box.height/2,dx=direction==='next'?-150:150;
  await touch(cdp,[{x,y},{x:x+dx/2,y},{x:x+dx,y}]);
}
async function pinch(cdp:CDPSession,surface:Locator){
  const [a,b,a2,b2]=await pointsOn(surface,[[.4,.45],[.6,.45],[.3,.45],[.75,.45]]);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a,b]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[a2,b2]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
async function wheelZoom(page:Page,surface:Locator,delta=-120){
  const [point]=await pointsOn(surface,[[.5,.3]]);await page.mouse.click(point.x,point.y);const frame=await surface.evaluate(e=>e.tagName==='IFRAME'),before=frame?(await native(page,'getView')).zoom:await page.locator('#zoom-percent').textContent();await page.keyboard.down('Control');try{if(frame)await native(page,'getView');await page.mouse.wheel(0,delta);await expect.poll(async()=>frame?(await native(page,'getView')).zoom:await page.locator('#zoom-percent').textContent()).not.toBe(before);}finally{await page.keyboard.up('Control');}
}
async function screenshot(page:Page,name:string){await mkdir('.local/bf002/qa',{recursive:true});await page.screenshot({path:'.local/bf002/qa/navigation-'+name+'.png'});}

for(const engine of ['experimental','butterfly'] as const){
  test(`BF002 ${engine} host percentages use real zoom; fit width differs from 100 and blank desktop double click leaves no dots`,async({page,context})=>{
    test.setTimeout(180000);const {service,surface,cdp}=await setup(page,context,engine);const baselineRevision=(await notes(page))[0].revision;await page.locator('#tool-pan').click();await page.locator('#zoom-fit').click();
    const width=engine==='butterfly'?(await native(page,'getViewport')).viewport.width:await surface.evaluate(e=>e.clientWidth);await expect.poll(async()=>(await camera(page,engine)).zoom).toBeCloseTo((width-48)/1000,2);const fitted=(await camera(page,engine)).zoom;await expect(page.locator('#zoom-percent')).toHaveText(Math.round(fitted*100)+'%');expect(Math.abs(fitted-1)).toBeGreaterThan(.05);
    await page.locator('#zoom-percent').click();await expect.poll(async()=>(await camera(page,engine)).zoom).toBe(1);expect(await inkCount(page,engine)).toBe(0);
    await wheelZoom(page,surface);await expect.poll(async()=>(await camera(page,engine)).zoom).toBeGreaterThan(1.2);const manual=(await camera(page,engine)).zoom;await expect(page.locator('#zoom-percent')).toHaveText(Math.round(manual*100)+'%');await saved(page);
    await page.setViewportSize({width:800,height:1280});await expect.poll(async()=>(await camera(page,engine)).zoom).toBeCloseTo(manual,3);await screenshot(page,engine+'-portrait-manual');await page.setViewportSize({width:1280,height:800});await expect.poll(async()=>(await camera(page,engine)).zoom).toBeCloseTo(manual,3);
    const [touchBlank]=await pointsOn(surface,[[.7,.5]]);await touch(cdp,[touchBlank]);await page.waitForTimeout(70);await touch(cdp,[touchBlank]);await expect.poll(async()=>(await camera(page,engine)).zoom).toBe(1);await wheelZoom(page,surface);await expect.poll(async()=>(await camera(page,engine)).zoom).toBeGreaterThan(1.2);
    await page.locator('#tool-pen').click();if(engine==='butterfly')await native(page,'getView');const [blank]=await pointsOn(surface,[[.7,.5]]);await page.mouse.dblclick(blank.x,blank.y,{delay:60});await expect.poll(async()=>(await camera(page,engine)).zoom).toBe(1);await saved(page);if(engine==='butterfly')await native(page,'finishInput');expect(await inkCount(page,engine)).toBe(0);
    await page.locator('#back-library').click();await expect(page.locator('#library-view')).toBeVisible();await page.locator('.note-cover').click();await expect(page.locator('#page-number')).toHaveText('1 / 3');if(engine==='butterfly')await expect(page.locator('#butterfly-status')).toHaveText('',{timeout:60000});await page.locator('#tool-pan').click();await wheelZoom(page,surface);await expect.poll(async()=>(await camera(page,engine)).zoom).toBeGreaterThan(1.2);const reopenedZoom=(await camera(page,engine)).zoom;await expect(page.locator('#zoom-percent')).toHaveText(Math.round(reopenedZoom*100)+'%');await saved(page);await screenshot(page,engine+'-reopened-live-percentage');
    await page.locator('#next-page').click();await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);expect((await camera(page,engine)).zoom).not.toBeCloseTo(reopenedZoom,2);await page.locator('#prev-page').click();await expect(page.locator('#page-number')).toHaveText('1 / 3');await saved(page);await expect.poll(async()=>(await camera(page,engine)).zoom).toBeCloseTo(reopenedZoom,3);
    const n=(await notes(page))[0];expect(n.revision).toBe(baselineRevision);expect(n.pageOrder.filter(id=>n.pages.some(p=>p.id===id&&!p.deletedAt&&!p.nativeMissing))).toHaveLength(3);if(engine==='butterfly')expect((await native(page,'listPages')).pages.filter((p:any)=>!p.deleted)).toHaveLength(3);expect(service.generated()).toHaveLength(0);
  });

  test(`BF002 ${engine} enlarged paper pans first, requires a new outward swipe, and a pinch never turns a page`,async({page,context})=>{
    test.setTimeout(180000);const {service,surface,cdp}=await setup(page,context,engine);await page.locator('#tool-pan').click();await page.locator('#zoom-fit').click();await wheelZoom(page,surface,engine==='butterfly'?-120:-200);await expect.poll(async()=>(await camera(page,engine)).zoom).toBeGreaterThan(2);await saved(page);const before=(await notes(page))[0],first=before.currentPageId;
    await swipe(cdp,surface,'next');await saved(page);await expect(page.locator('#page-number')).toHaveText('1 / 3');expect((await notes(page))[0].currentPageId).toBe(first);
    await swipe(cdp,surface,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);await swipe(cdp,surface,'previous');await expect(page.locator('#page-number')).toHaveText('1 / 3');await saved(page);await swipe(cdp,surface,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);
    await page.locator('#zoom-fit').click();const second=(await notes(page))[0].currentPageId;await pinch(cdp,surface);await saved(page);await expect(page.locator('#page-number')).toHaveText('2 / 3');expect((await notes(page))[0].currentPageId).toBe(second);
    await page.locator('#zoom-fit').click();await swipe(cdp,surface,'previous');await expect(page.locator('#page-number')).toHaveText('1 / 3');await saved(page);await page.locator('#zoom-fit').click();await swipe(cdp,surface,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);
    expect(await inkCount(page,engine)).toBe(0);expect(service.generated()).toHaveLength(0);await screenshot(page,engine+'-after-gesture-arbitration');
  });

  test(`BF002 ${engine} selection, finger writing, placement and a held pen cannot turn paper or bypass the footer lock`,async({page,context})=>{
    test.setTimeout(240000);const {service,surface,cdp}=await setup(page,context,engine);await page.locator('#zoom-fit').click();if(engine==='butterfly')expect((await native(page,'getViewport')).tool).toBe('pen');const [start,end]=await pointsOn(surface,[[.3,.25],[.4,.32]]);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:8});await page.mouse.up();await expect.poll(()=>inkCount(page,engine)).toBe(1);await saved(page);
    await page.locator('#tool-lasso').click();await page.locator('#select-all').click();await expect(page.locator('#selection-label')).toContainText('1');const selected={x:(start.x+end.x)/2,y:(start.y+end.y)/2};await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:selected.x,y:selected.y,button:'left',buttons:1,pointerType:'pen',force:.7});await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:selected.x+12,y:selected.y+8,button:'left',buttons:1,pointerType:'pen',force:.7});if(engine==='butterfly')await expect.poll(async()=>(await native(page,'getViewport')).busy).toBe(true);await footerSwipe(page,cdp,'next');await expect(page.locator('#page-number')).toHaveText('1 / 3');await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:selected.x+12,y:selected.y+8,button:'left',buttons:0,pointerType:'pen',force:0});await saved(page);await swipe(cdp,surface,'next');await expect(page.locator('#page-number')).toHaveText('1 / 3');
    await page.locator('#tool-pen').click();await page.locator('#finger-writing').check();await swipe(cdp,surface,'next');await expect(page.locator('#page-number')).toHaveText('1 / 3');await footerSwipe(page,cdp,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);await page.locator('#prev-page').click();await expect(page.locator('#page-number')).toHaveText('1 / 3');await saved(page);await page.locator('#finger-writing').uncheck();
    await page.locator('#toolbox-open').click();await page.getByText('手工创建草稿',{exact:true}).click();page.once('dialog',dialog=>void dialog.accept('x^2'));await page.getByRole('button',{name:'输入 LaTeX 公式',exact:true}).click();await expect(page.locator('#draft-detail-dialog')).toBeVisible();await page.getByRole('button',{name:'插入当前页',exact:true}).click();await expect(page.locator('#placement-bar')).toBeVisible();await footerSwipe(page,cdp,'next');await expect(page.locator('#page-number')).toHaveText('1 / 3');await expect(page.locator('#placement-bar')).toBeVisible();await page.locator('#placement-cancel').click();if(await page.locator('#panel-close').isVisible())await page.locator('#panel-close').click();
    await page.locator('#tool-pen').click();await page.locator('#zoom-fit').click();if(engine==='experimental')await surface.evaluate(element=>{const target=window as any;target.__navigationPenHeld=false;element.addEventListener('pointerdown',event=>{if((event as PointerEvent).pointerType==='pen')target.__navigationPenHeld=true;});element.addEventListener('pointerup',event=>{if((event as PointerEvent).pointerType==='pen')target.__navigationPenHeld=false;});});const [pen]=await pointsOn(surface,[[.5,.25]]);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:pen.x,y:pen.y,button:'left',buttons:1,pointerType:'pen',force:.7});if(engine==='butterfly')await expect.poll(async()=>(await native(page,'getViewport')).busy).toBe(true);else{await expect.poll(()=>page.evaluate(()=>(window as any).__navigationPenHeld)).toBe(true);await expect(page.locator('#save-state')).toHaveText('正在编辑…');}await footerSwipe(page,cdp,'next');await expect(page.locator('#page-number')).toHaveText('1 / 3');await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pen.x,y:pen.y,button:'left',buttons:0,pointerType:'pen',force:0});if(engine==='butterfly')await expect.poll(async()=>(await native(page,'getViewport')).busy).toBe(false);else await expect.poll(()=>page.evaluate(()=>(window as any).__navigationPenHeld)).toBe(false);await saved(page);
    await page.locator('#tool-pan').click();await page.locator('#zoom-fit').click();await swipe(cdp,surface,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');expect(service.generated()).toHaveLength(0);
  });
}

test('BF002 cancelled touch recovers navigation and fast overlapping swipes wait for the existing save rather than skipping pages',async({page,context})=>{
  const {service,surface,cdp}=await setup(page,context,'experimental');await page.locator('#tool-pan').click();await page.locator('#zoom-fit').click();await swipe(cdp,surface,'next',true);await expect(page.locator('#page-number')).toHaveText('1 / 3');await page.locator('#zoom-fit').click();await swipe(cdp,surface,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);await page.locator('#prev-page').click();await expect(page.locator('#page-number')).toHaveText('1 / 3');await saved(page);
  await page.evaluate(()=>{
    const state=window as any;state.__holdNavigation=true;state.__navigationCompletions=[];const original=IDBDatabase.prototype.transaction,setter=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete')!.set!;
    IDBDatabase.prototype.transaction=function(this:IDBDatabase,...args:any[]){const tx=Reflect.apply(original,this,args) as IDBTransaction;if(args[1]==='readwrite'&&tx.objectStoreNames.contains('notes')){let value:any;Object.defineProperty(tx,'oncomplete',{configurable:true,get:()=>value,set:fn=>{value=fn;setter.call(tx,(event:Event)=>{if(state.__holdNavigation)state.__navigationCompletions.push(()=>fn?.call(tx,event));else fn?.call(tx,event);});}});}return tx;};
  });
  await footerSwipe(page,cdp,'next');await expect.poll(()=>page.evaluate(()=>(window as any).__navigationCompletions.length)).toBeGreaterThan(0);await footerSwipe(page,cdp,'next');await expect(page.locator('#page-number')).toHaveText('1 / 3');
  await page.evaluate(()=>{const state=window as any;state.__holdNavigation=false;for(const done of state.__navigationCompletions.splice(0))done();});await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);expect(service.generated()).toHaveLength(0);
});

test('BF002 a swipe with failed local storage stays on its source page and retries saving without losing ink',async({page,context})=>{
  const {service,surface,cdp}=await setup(page,context,'experimental');const [a,b]=await pointsOn(surface,[[.3,.25],[.4,.32]]);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();await expect.poll(()=>inkCount(page,'experimental')).toBe(1);await page.locator('#tool-pan').click();await page.locator('#zoom-fit').click();await saved(page);const original=(await notes(page))[0];
  await page.evaluate(()=>{const state=window as any;state.__failNavigationSave=true;const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(this:IDBObjectStore,value:any,...keys:any[]){if(state.__failNavigationSave&&this.name==='notes')throw new DOMException('navigation fixture storage full','QuotaExceededError');return Reflect.apply(put,this,[value,...keys]);};});
  await swipe(cdp,surface,'next');await expect(page.locator('#save-error')).toBeVisible();await expect(page.locator('#page-number')).toHaveText('1 / 3');expect((await notes(page))[0].currentPageId).toBe(original.currentPageId);expect((await notes(page))[0].pageStrokes).toEqual(original.pageStrokes);
  await page.locator('#retry-save').evaluate(button=>button.addEventListener('click',()=>{(window as any).__failNavigationSave=false;},{once:true,capture:true}));await page.locator('#retry-save').click();await expect(page.locator('#save-error')).not.toBeVisible();await saved(page);await footerSwipe(page,cdp,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');expect((await notes(page))[0].pageStrokes[original.currentPageId]).toEqual(original.pageStrokes[original.currentPageId]);expect(service.generated()).toHaveLength(0);
});

async function setupTypeset(page:Page,context:BrowserContext){
  const service=await toolFixture(page,context);const noteId=await page.evaluate(async()=>{const mp='/src/model.ts',dp='/src/notebook-domain.ts',pp='/src/page-model.ts',rp='/src/notebook-repository.ts';const m=await import(mp),d=await import(dp),p=await import(pp),r=await import(rp),n=d.ensureNotebook(m.newNote());n.title='触控阅读与数学排版';const first=d.currentPage(n);first.kind='typeset';first.paper='blank';first.recognitionOrigin={kind:'page'};const pages=[first,d.addPage(n,{kind:'typeset',paper:'blank'}),d.addPage(n,{kind:'typeset',paper:'blank'})];for(const [i,page]of pages.entries()){page.recognitionOrigin={kind:'page'};for(let j=0;j<24;j++)p.createParagraphBlock(n,`第${i+1}页第${j+1}段，阅读时可以选择这些文字，双击文字不会改变比例。数学笔记应保留定义、条件和推导。`,page.id);}d.selectPage(n,first.id);await r.saveEditingNote(n);return n.id;});await page.reload();await expect(page.locator('#library-view')).toBeVisible();await page.getByRole('button',{name:'打开 触控阅读与数学排版',exact:true}).click();await expect(page.locator('#typeset-page')).toBeVisible();await expect(page.locator('#typeset-edit')).toHaveAttribute('aria-pressed','false');return{service,noteId,cdp:await context.newCDPSession(page),surface:page.locator('#typeset-page')};
}
async function readingZoom(page:Page){const n=(await notes(page))[0];return n.pages.find(p=>p.id===n.currentPageId)!.readingView?.zoom||1;}

test('BF002 typeset reading keeps vertical scroll, text selection, manual zoom across rotation and per-page zoom persistence',async({page,context})=>{
  const {service,surface,cdp}=await setupTypeset(page,context),before=(await notes(page))[0];await page.locator('#zoom-fit').click();await expect(page.locator('#zoom-indicator')).toBeVisible();await wheelZoom(page,surface,-80);const zoom=await surface.locator('.typeset-body').evaluate(element=>Number((element as HTMLElement).style.zoom));expect(zoom).toBeGreaterThan(1.5);await expect.poll(()=>readingZoom(page)).toBeCloseTo(zoom,4);await expect(page.locator('#zoom-percent')).toHaveText(Math.round(zoom*100)+'%');
  await surface.locator('.typeset-block').first().locator('span').first().dblclick({position:{x:60,y:8}});expect(await readingZoom(page)).toBeCloseTo(zoom,3);expect(await page.evaluate(()=>window.getSelection()?.toString().length||0)).toBeGreaterThan(0);
  await touch(cdp,await pointsOn(surface,[[.6,.7],[.6,.45],[.6,.25]]));await expect.poll(()=>surface.evaluate(e=>e.scrollTop)).toBeGreaterThan(100);await expect(page.locator('#page-number')).toHaveText('1 / 3');
  await page.setViewportSize({width:800,height:1280});await expect.poll(()=>readingZoom(page)).toBeCloseTo(zoom,3);await screenshot(page,'typeset-portrait-manual');await page.setViewportSize({width:1280,height:800});await expect.poll(()=>readingZoom(page)).toBeCloseTo(zoom,3);
  await footerSwipe(page,cdp,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);expect(await readingZoom(page)).toBe(1);await wheelZoom(page,surface,-160);await expect.poll(()=>readingZoom(page)).toBeGreaterThan(1.2);await expect.poll(()=>surface.evaluate(e=>e.scrollLeft)).toBeGreaterThan(10);
  await swipe(cdp,surface,'previous');await expect(page.locator('#page-number')).toHaveText('2 / 3');await expect.poll(()=>surface.evaluate(e=>e.scrollLeft)).toBe(0);await swipe(cdp,surface,'previous');await expect(page.locator('#page-number')).toHaveText('1 / 3');await expect.poll(()=>readingZoom(page)).toBeCloseTo(zoom,3);
  await expect(page.locator('#typeset-edit')).toHaveAttribute('aria-pressed','false');await page.locator('#zoom-fit').click();await swipe(cdp,surface,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');await saved(page);await page.locator('#prev-page').click();await expect(page.locator('#page-number')).toHaveText('1 / 3');await page.locator('#zoom-fit').click();await expect(page.locator('#zoom-percent')).toBeVisible();await page.locator('#zoom-percent').click();await expect.poll(()=>readingZoom(page)).toBe(1);
  await saved(page);const after=(await notes(page))[0];expect(after.revision).toBe(before.revision);expect(after.blocks).toEqual(before.blocks);expect(after.formulas).toEqual(before.formulas);expect(service.generated()).toHaveLength(0);
});

test('BF002 editing a typeset page blocks paper and footer page turns; leaving edit mode restores navigation',async({page,context})=>{
  const {service,surface,cdp}=await setupTypeset(page,context);await page.locator('#zoom-fit').click();await page.locator('#typeset-edit').click();await expect(page.locator('#typeset-edit')).toHaveAttribute('aria-pressed','true');await swipe(cdp,surface,'next');await footerSwipe(page,cdp,'next');await expect(page.locator('#page-number')).toHaveText('1 / 3');await expect(page.locator('#typeset-edit')).toHaveAttribute('aria-pressed','true');await page.locator('#typeset-edit').click();await swipe(cdp,surface,'next');await expect(page.locator('#page-number')).toHaveText('2 / 3');await expect(page.locator('#typeset-edit')).toHaveAttribute('aria-pressed','false');expect(service.generated()).toHaveLength(0);
});
