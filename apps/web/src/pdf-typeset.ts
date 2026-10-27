import katex from 'katex';
import katexCss from 'katex/dist/katex.min.css?inline';
import {orderedBlocks} from './page-model.ts';
import type {Note} from './model.ts';
export interface PrintableUnit {id:string;groupId?:string;height:number;paint:(context:CanvasRenderingContext2D,x:number,y:number)=>void}
let fontReady:Promise<void>|undefined,mathCss:Promise<string>|undefined;
async function fonts(){await(fontReady??=(async()=>{const face=new FontFace('MathInkPdf',`url("${new URL('vendor/pdfjs/MathInkSans.ttf',document.baseURI).href}")`);document.fonts.add(await face.load());})());}
const dataUrl=(blob:Blob)=>new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
async function inlineMathCss(){return mathCss??=(async()=>{const css=katexCss.replace(/src:([^;}]+);/g,(_all,src:string)=>'src:'+(src.match(/url\([^)]*\.woff2[^)]*\)\s*format\([^)]*\)/)?.[0]||src)+';');const urls=[...new Set([...css.matchAll(/url\(["']?([^\)"']+)["']?\)/g)].map(m=>m[1]))];let result=css;for(const url of urls){const response=await fetch(new URL(url,import.meta.url));if(!response.ok)throw new Error('离线公式字体缺失，请完成应用资源加载后重试');result=result.replaceAll(url,await dataUrl(await response.blob()));}return result;})();}
export async function printableMath(latex:string,display=true):Promise<HTMLImageElement>{
  const markup=katex.renderToString(latex,{displayMode:display,throwOnError:true,trust:false,maxExpand:1000,output:'html'}),measure=document.createElement('div');measure.style.cssText='position:fixed;left:-100000px;top:0;width:max-content;font-size:22px;visibility:hidden';measure.innerHTML=markup;document.body.append(measure);await document.fonts.ready;const r=measure.getBoundingClientRect();measure.remove();const width=Math.ceil(r.width)+10,height=Math.ceil(r.height)+10;if(width>16384||height>10000)throw new Error('此公式超出安全渲染大小，请先手工拆分为多行。');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="font-size:22px;color:#253d35;padding:5px;width:max-content"><style>${await inlineMathCss()}</style>${markup}</div></foreignObject></svg>`;
  const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await image.decode();return image;
}
/** Text is painted from bundled Chinese fonts, inline math stays in its reading position. */
export async function layoutTypeset(note:Note,pageId:string,width=720):Promise<PrintableUnit[]>{
  await fonts();const units:PrintableUnit[]=[],measure=document.createElement('canvas').getContext('2d')!;measure.font='18px MathInkPdf';
  for(const b of orderedBlocks(note,pageId)){
    if(b.type==='formula'||b.type==='derivation'){const f=note.formulas.find(f=>f.id===b.content.formulaId),image=await printableMath(f?.latex||'\\,');const scale=Math.min(f?.scale??1,width/image.width,900/image.height),height=image.height*scale+22;units.push({id:b.id,height,paint:(c,x,y)=>c.drawImage(image,x+(width-image.width*scale)/2,y+11,image.width*scale,image.height*scale)});continue;}
    if(b.type==='image'){const image=new Image();image.src=b.content.imageDataUrl||'';await image.decode();const scale=Math.min(1,width/image.naturalWidth,900/image.naturalHeight);units.push({id:b.id,height:image.naturalHeight*scale+20,paint:(c,x,y)=>c.drawImage(image,x,y+10,image.naturalWidth*scale,image.naturalHeight*scale)});continue;}
    const font=b.content.role==='heading'?'600 24px MathInkPdf':'18px MathInkPdf',lineHeight=b.content.role==='heading'?40:30;measure.font=font;
    type Token={text?:string;image?:HTMLImageElement;width:number;height:number};let line:Token[]=[],used=0,index=0;
    const flush=()=>{const tokens=line.slice(),height=Math.max(lineHeight,...tokens.map(t=>t.height+8));units.push({id:b.id+'-line-'+index++,groupId:b.id,height,paint:(c,x,y)=>{c.font=font;c.fillStyle='#253d35';c.textBaseline='alphabetic';let left=x;for(const token of tokens){if(token.image)c.drawImage(token.image,left,y+(height-token.height)/2,token.width,token.height);else c.fillText(token.text||'',left,y+height*.73);left+=token.width;}}});line=[];used=0;};
    const runs=b.type==='legacy-markdown'?[{type:'text' as const,text:b.content.markdown||''}]:b.content.runs||[];
    for(const run of runs){if(run.type==='formula'){const image=await printableMath(note.formulas.find(f=>f.id===run.formulaId)?.latex||'\\,',false),scale=Math.min(18/22,width/image.width);const token={image,width:image.width*scale,height:image.height*scale};if(used+token.width>width&&line.length)flush();line.push(token);used+=token.width;}else for(const character of run.text){if(character==='\n'){flush();continue;}const token={text:character,width:measure.measureText(character).width,height:lineHeight-8};if(used+token.width>width&&line.length)flush();line.push(token);used+=token.width;}}
    if(line.length||!index)flush();units.push({id:b.id+'-gap',groupId:b.id,height:14,paint:()=>{}});
  }
  return units;
}
