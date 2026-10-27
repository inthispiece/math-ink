import katex from 'katex';
import {drawStroke,boundsOf,type Stroke} from './geometry.ts';
import type {FullPageImage} from './page-render.ts';
import type {FormulaPlacement} from './notebook-domain.ts';

async function formulaImage(latex:string):Promise<HTMLImageElement>{
  const markup=katex.renderToString(latex,{output:'mathml',displayMode:false,throwOnError:true,trust:false,maxExpand:1000}).replaceAll('class="katex"','');
  const style='font-size:22px;color:#253d35;font-family:serif;padding:0;margin:0;text-align:left;white-space:nowrap';
  const measure=document.createElement('div');measure.style.cssText=style+';position:fixed;left:-100000px;top:0;visibility:hidden;width:max-content';measure.innerHTML=markup;document.body.append(measure);
  let width:number,height:number;try{const rect=measure.getBoundingClientRect();width=Math.ceil(rect.width)+8;height=Math.ceil(rect.height)+8;}finally{measure.remove();}
  if(width>16384||height>16384)throw new Error('公式对象超出安全图片尺寸');
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><foreignObject x="0" y="0" width="'+width+'" height="'+height+'"><div xmlns="http://www.w3.org/1999/xhtml" style="'+style+'">'+markup+'</div></foreignObject></svg>';
  const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await image.decode();return image;
}
/** A fixed complete logical page, independent of viewport, including every placed math instance. */
export async function capturePaperPage(strokes:Stroke[],placements:FormulaPlacement[],page:string,revision:string):Promise<FullPageImage>{
  const objects=placements.filter(p=>!p.deletedAt);
  if(!strokes.length&&!objects.length)throw new Error('当前页为空，请先书写或插入内容。');
  let images:HTMLImageElement[];try{images=await Promise.all(objects.map(p=>formulaImage(p.latex)));}catch{throw new Error('当前页公式对象暂时无法导出为图片，未上传不完整页面；原稿和草稿仍保留。');}
  const ink=boundsOf(strokes,24),left=Math.min(0,ink?.x||0,...objects.map(p=>p.x)),top=Math.min(0,ink?.y||0,...objects.map(p=>p.y));
  const right=Math.max(1000,ink?ink.x+ink.width:0,...objects.map((p,i)=>p.x+(14+images[i].width)*(p.scale??1))),bottom=Math.max(1414,ink?ink.y+ink.height:0,...objects.map((p,i)=>p.y+(10+images[i].height)*(p.scale??1)));
  const bounds={x:left,y:top,width:right-left,height:bottom-top},scale=2048/Math.max(bounds.width,bounds.height);
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(bounds.width*scale);canvas.height=Math.ceil(bounds.height*scale);
  const c=canvas.getContext('2d');if(!c)throw new Error('无法生成完整页快照，原稿保留。');
  const scaleX=canvas.width/bounds.width,scaleY=canvas.height/bounds.height;
  c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);c.scale(scaleX,scaleY);c.translate(-bounds.x,-bounds.y);
  strokes.forEach(s=>drawStroke(c,s));
  objects.forEach((p,i)=>{const scale=p.scale??1;c.drawImage(images[i],p.x+14*scale,p.y+10*scale,images[i].width*scale,images[i].height*scale);});
  let imageUrl:string;try{imageUrl=canvas.toDataURL('image/png');}catch{throw new Error('浏览器未允许完整页图片导出，尚未上传；原稿保留。');}
  return{imageBase64:imageUrl.split(',')[1],imageUrl,page,revision,bounds,strokeIds:strokes.map(s=>s.id),transform:{scaleX,scaleY,offsetX:bounds.x,offsetY:bounds.y}};
}
