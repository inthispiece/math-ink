import {test,expect} from '@playwright/test';
import {toolFixture} from './fixtures/notebook-tools';

test('complete paper PNG includes offscreen handwriting and rendered math at its original position without upload',async({page,context})=>{
  const fixture=await toolFixture(page,context);
  const result=await page.evaluate(async()=>{
    const path='/src/paper-snapshot.ts',module=await import(path);
    const rendered=await module.capturePaperPage([{id:'offscreen',color:'#253d35',width:5,points:[{x:1450,y:1700,pressure:.5},{x:1500,y:1750,pressure:.5}]}],[{id:'placed',pageId:'paper',draftId:'draft',draftVersion:1,operationId:'op',latex:'\\int x^2\\,dx',x:60,y:60,createdAt:new Date().toISOString()}],'paper','1');
    const image=new Image();image.src=rendered.imageUrl;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d')!;c.drawImage(image,0,0);
    const dark=(x:number,y:number,w:number,h:number)=>{const t=rendered.transform,sx=t.scaleX,sy=t.scaleY,d=c.getImageData(Math.floor((x-t.offsetX)*sx),Math.floor((y-t.offsetY)*sy),Math.floor(w*sx),Math.floor(h*sy)).data;let count=0;for(let i=0;i<d.length;i+=4)if(d[i]<190&&d[i+1]<190&&d[i+2]<190&&d[i+3]>100)count++;return count;};
    return{bounds:rendered.bounds,mathPixels:dark(60,60,300,180),offscreenPixels:dark(1430,1680,100,100),width:image.width,height:image.height};
  });
  expect(result.bounds.width).toBeGreaterThan(1500);expect(result.bounds.height).toBeGreaterThan(1750);expect(result.mathPixels).toBeGreaterThan(40);expect(result.offscreenPixels).toBeGreaterThan(40);expect(Math.max(result.width,result.height)).toBe(2048);expect(fixture.generated()).toHaveLength(0);
});

test('large multirow formula objects are measured before export so the full formula is never clipped to a fixed-height box',async({page,context})=>{
  const fixture=await toolFixture(page,context);
  const result=await page.evaluate(async()=>{
    const path='/src/paper-snapshot.ts',module=await import(path),latex='\\begin{pmatrix}'+Array.from({length:45},(_,i)=>String(i)+' & x^2').join(' \\\\ ')+'\\end{pmatrix}';
    const rendered=await module.capturePaperPage([],[{id:'matrix',pageId:'p',draftId:'d',draftVersion:1,operationId:'op',latex,x:100,y:1200,createdAt:new Date().toISOString()}],'p','1');
    return{bounds:rendered.bounds,png:rendered.imageUrl.startsWith('data:image/png;base64,')};
  });
  expect(result.png).toBe(true);expect(result.bounds.height).toBeGreaterThan(2000);expect(fixture.generated()).toHaveLength(0);
});
