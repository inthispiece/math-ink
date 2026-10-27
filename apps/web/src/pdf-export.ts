import {PDFDocument,PDFName,PDFDict,PDFArray,degrees} from 'pdf-lib';
import type {Note} from './model.ts';
import type {Page} from './page-model.ts';
import {ensureNotebook,visiblePages,type Notebook} from './notebook-domain.ts';
import {getBinaryResource} from './binary-resources.ts';
import {renderPdfPage} from './pdf-document.ts';
import type {BinaryResource} from './asset-model.ts';
import type {FullPageImage} from './page-render.ts';
import {layoutTypeset} from './pdf-typeset.ts';
import {paginateBlocks,parsePageRange,PDF_QUALITY,type PdfQuality} from './pdf-layout.ts';
export interface PdfExportOptions {range:string;quality:PdfQuality;excludeBlank:boolean}
export interface PdfPhysicalPage {sourcePageId:string;logicalPageNumber:number;physicalPageNumber:number;width:number;height:number;rotation:number;mode:'original-overlay'|'image';thumbnail?:string}
export interface PdfExportResult {bytes:Uint8Array;pages:PdfPhysicalPage[];warnings:string[];sourceRevision:number;sourceStorageRevision:number}
export type ExportPageRenderer=(note:Notebook,page:Page,maxDimension:number,annotationsOnly?:boolean)=>Promise<FullPageImage>;
function blank(note:Notebook,p:Page){return !p.pdf&&p.kind==='handwritten'&&!note.pageStrokes[p.id]?.length&&!note.placements.some(v=>v.pageId===p.id&&!v.deletedAt)&&(!note.butterflyData?.length||note.inkEngine!=='butterfly');}
function cleanActions(page:import('pdf-lib').PDFPage){page.node.delete(PDFName.of('AA'));const annots=page.node.lookup(PDFName.of('Annots'));if(annots instanceof PDFArray)for(let i=0;i<annots.size();i++){const annotation=annots.lookup(i);if(annotation instanceof PDFDict){annotation.delete(PDFName.of('A'));annotation.delete(PDFName.of('AA'));}}}
function png(url:string){return Uint8Array.from(atob(url.split(',')[1]),c=>c.charCodeAt(0));}
function thumbnail(canvas:HTMLCanvasElement){const result=document.createElement('canvas');result.width=160;result.height=Math.max(1,Math.round(canvas.height/canvas.width*160));result.getContext('2d')!.drawImage(canvas,0,0,result.width,result.height);return result.toDataURL('image/png');}
/** The caller supplies one frozen persisted snapshot. Only visible formal pages enter output. */
export async function buildPdfExport(input:Note,options:PdfExportOptions,render:ExportPageRenderer,signal?:AbortSignal,onProgress?:(done:number,total:number)=>void):Promise<PdfExportResult>{
  const note=ensureNotebook(structuredClone(input)),logical=visiblePages(note),indices=parsePageRange(options.range,logical.length),doc=await PDFDocument.create(),pages:PdfPhysicalPage[]=[],warnings:string[]=[],originals=new Map<string,PDFDocument>(),quality=PDF_QUALITY[options.quality];
  if(indices.length>500)throw new Error('单次最多导出500张逻辑页，请按页码范围分段导出');const assets=new Map<string,BinaryResource>();let sourceBytes=0;for(const index of indices){const id=logical[index].pdf?.resourceId;if(!id||assets.has(id))continue;const resource=await getBinaryResource(id);if(!resource)throw new Error('PDF 原文件资源缺失，未输出不完整文档');sourceBytes+=resource.size;if(sourceBytes>128*1024*1024)throw new Error('所选原 PDF 合计超过128MB，请缩小页码范围分段导出');assets.set(id,resource);}
  doc.setTitle(note.title);doc.setProducer('MathInk - original PDF with annotations; raster handwritten/typeset pages');doc.setSubject('Formal pages only. Full MathInk backup preserves editable notes.');
  for(let i=0;i<indices.length;i++){
    if(signal?.aborted)throw new DOMException('已取消导出','AbortError');const index=indices[i],p=logical[index];if(options.excludeBlank&&blank(note,p)){onProgress?.(i+1,indices.length);continue;}
    if(p.pdf){
      const info=p.pdf,resource=assets.get(info.resourceId)!;let original=originals.get(info.resourceId);if(!original){original=await PDFDocument.load(resource.bytes,{updateMetadata:false});originals.set(info.resourceId,original);}
      const overlay=await render(note,p,Math.ceil(Math.max(info.displayWidth,info.displayHeight)*quality),true),preview=await renderPdfPage(resource,info.pageIndex,280);
      if(options.excludeBlank&&preview.contentEmpty&&overlay.annotationEmpty){preview.canvas.width=preview.canvas.height=1;onProgress?.(i+1,indices.length);continue;}
      const [page]=await doc.copyPages(original,[info.pageIndex]);cleanActions(page);doc.addPage(page);const image=await doc.embedPng(png(overlay.imageUrl)),crop=page.getCropBox(),r=((page.getRotation().angle%360)+360)%360;
      const position=r===90?{x:crop.x+crop.width,y:crop.y}:r===180?{x:crop.x+crop.width,y:crop.y+crop.height}:r===270?{x:crop.x,y:crop.y+crop.height}:{x:crop.x,y:crop.y};
      page.drawImage(image,{...position,width:r%180?crop.height:crop.width,height:r%180?crop.width:crop.height,rotate:degrees(r)});
      const annotation=new Image();annotation.src=overlay.imageUrl;await annotation.decode();preview.canvas.getContext('2d')!.drawImage(annotation,0,0,preview.canvas.width,preview.canvas.height);const previewUrl=preview.canvas.toDataURL('image/png');preview.canvas.width=preview.canvas.height=1;
      if(overlay.clipped)warnings.push('原第 '+(index+1)+' 页含超出 PDF 纸面的批注；按原尺寸输出会裁边，请检查组合预览并调整位置。');
      pages.push({sourcePageId:p.id,logicalPageNumber:index+1,physicalPageNumber:pages.length+1,width:info.displayWidth,height:info.displayHeight,rotation:info.rotation,mode:'original-overlay',thumbnail:previewUrl});
    }else if(p.kind==='handwritten'){
      const image=await render(note,p,Math.ceil(1131*quality));if(options.excludeBlank&&image.contentEmpty){onProgress?.(i+1,indices.length);continue;}const page=doc.addPage([595.276,841.89]),embedded=await doc.embedPng(png(image.imageUrl)),scale=Math.min(595.276/embedded.width,841.89/embedded.height),width=embedded.width*scale,height=embedded.height*scale;page.drawImage(embedded,{x:(595.276-width)/2,y:(841.89-height)/2,width,height});
      if(image.bounds.width>1000.1||image.bounds.height>1414.1||image.bounds.x<0||image.bounds.y<0)warnings.push('原第 '+(index+1)+' 页含纸面外内容，已按完整范围缩放适配 A4，不裁切。');
      pages.push({sourcePageId:p.id,logicalPageNumber:index+1,physicalPageNumber:pages.length+1,width:595.276,height:841.89,rotation:0,mode:'image',thumbnail:image.imageUrl});
    }else{
      const width=800,height=1131,margin=40,units=await layoutTypeset(note,p.id,width-margin*2),byId=new Map(units.map(u=>[u.id,u])),sheets=paginateBlocks(units,height-margin*2);
      for(const slices of sheets){const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*quality);canvas.height=Math.ceil(height*quality);const c=canvas.getContext('2d')!;c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);c.scale(quality,quality);let y=margin;for(const slice of slices){c.save();c.beginPath();c.rect(margin,y,width-margin*2,slice.height);c.clip();byId.get(slice.id)!.paint(c,margin,y-slice.offset);c.restore();y+=slice.height;}const image=await doc.embedPng(png(canvas.toDataURL('image/png'))),page=doc.addPage([595.276,841.89]);page.drawImage(image,{x:0,y:0,width:595.276,height:841.89});pages.push({sourcePageId:p.id,logicalPageNumber:index+1,physicalPageNumber:pages.length+1,width:595.276,height:841.89,rotation:0,mode:'image',thumbnail:thumbnail(canvas)});canvas.width=canvas.height=1;}
    }
    onProgress?.(i+1,indices.length);
  }
  if(!pages.length)throw new Error('所选范围没有可输出页面，请保留空白页或调整范围');
  return{bytes:await doc.save(),pages,warnings,sourceRevision:note.revision,sourceStorageRevision:note.storageRevision};
}
