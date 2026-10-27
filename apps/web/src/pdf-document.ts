import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type {PDFDocumentProxy,PDFPageProxy} from 'pdfjs-dist';
import type {BinaryResource} from './asset-model.ts';
import {createBinaryResource} from './binary-resources.ts';
export const PDF_LIMITS={bytes:32*1024*1024,pages:100,pixels:16_000_000};
export interface PdfPageInfo {pageIndex:number;width:number;height:number;rotation:number;displayWidth:number;displayHeight:number}
export interface PdfRendered {imageUrl:string;width:number;height:number;canvas:HTMLCanvasElement;contentEmpty:boolean}
let library:Promise<typeof import('pdfjs-dist')>|undefined;
const loadingTasks=new WeakMap<PDFDocumentProxy,{destroy:()=>Promise<void>}>();
async function closeDocument(doc:PDFDocumentProxy){await loadingTasks.get(doc)?.destroy();loadingTasks.delete(doc);}
async function pdfLibrary(){return library??=import('pdfjs-dist/legacy/build/pdf.mjs').then(lib=>{lib.GlobalWorkerOptions.workerSrc=workerUrl;return lib;});}
async function open(bytes:Uint8Array):Promise<PDFDocumentProxy>{
  const lib=await pdfLibrary(),base=new URL('vendor/pdfjs/',document.baseURI).href;
  const task=lib.getDocument({data:bytes.slice(),cMapUrl:base+'cmaps/',cMapPacked:true,standardFontDataUrl:base+'standard_fonts/',wasmUrl:base+'wasm/',enableXfa:false,useSystemFonts:false,stopAtErrors:true});
  let password=false;task.onPassword=()=>{password=true;void task.destroy();};
  try{const doc=await task.promise;loadingTasks.set(doc,task);return doc;}catch(error){await task.destroy().catch(()=>{});throw new Error(password?'此 PDF 需要密码；本版不支持加密 PDF，请先使用未加密副本。':'无法读取 PDF，未导入空白替代页：'+(error as Error).message);}
}
function pageInfo(page:PDFPageProxy,index:number):PdfPageInfo{const v=page.getViewport({scale:1}),box=page.view;return{pageIndex:index,width:box[2]-box[0],height:box[3]-box[1],rotation:((page.rotate%360)+360)%360,displayWidth:v.width,displayHeight:v.height};}
async function render(doc:PDFDocumentProxy,index:number,maxDimension:number,signal?:AbortSignal):Promise<PdfRendered>{
  if(signal?.aborted)throw new DOMException('已取消','AbortError');const page=await doc.getPage(index+1),base=page.getViewport({scale:1}),scale=Math.min(maxDimension/Math.max(base.width,base.height),Math.sqrt(PDF_LIMITS.pixels/(base.width*base.height))),view=page.getViewport({scale});
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.ceil(view.width));canvas.height=Math.max(1,Math.ceil(view.height));const context=canvas.getContext('2d')!;
  const task=page.render({canvas,canvasContext:context,viewport:view,background:'#ffffff'}),cancel=()=>task.cancel();signal?.addEventListener('abort',cancel,{once:true});
  try{await task.promise;if(signal?.aborted)throw new DOMException('已取消','AbortError');const [operators,annotations,lib]=await Promise.all([page.getOperatorList(),page.getAnnotations({intent:'display'}),pdfLibrary()]);const ops=lib.OPS as Record<string,number>,safe=new Set(['dependency','save','restore','transform','beginText','endText','setFont','setLeading','setTextMatrix','moveText','nextLine','setCharSpacing','setWordSpacing','setHScale','setTextRise','setTextRenderingMode','setLeadingMoveText','setFillRGBColor','setStrokeRGBColor','setLineWidth','setLineCap','setLineJoin','setMiterLimit','setDash'].map(name=>ops[name]).filter(value=>typeof value==='number'));const contentEmpty=annotations.length===0&&operators.fnArray.every(op=>safe.has(op));return{imageUrl:canvas.toDataURL('image/png'),width:base.width,height:base.height,canvas,contentEmpty};}finally{signal?.removeEventListener('abort',cancel);if(signal?.aborted)canvas.width=canvas.height=1;page.cleanup();}
}
/** Metadata first; thumbnails/high-resolution pages are requested individually. No database writes. */
export class PdfImportSession {
  readonly resource:BinaryResource;readonly pages:PdfPageInfo[];private doc:PDFDocumentProxy;
  private constructor(resource:BinaryResource,pages:PdfPageInfo[],doc:PDFDocumentProxy){this.resource=resource;this.pages=pages;this.doc=doc;}
  static async create(file:File,signal?:AbortSignal){
    if(file.size<8||file.size>PDF_LIMITS.bytes)throw new Error('PDF 最大 32MB；请先拆分较大的文档。');const bytes=new Uint8Array(await file.arrayBuffer());if(signal?.aborted)throw new DOMException('已取消','AbortError');
    if(new TextDecoder().decode(bytes.slice(0,1024)).indexOf('%PDF-')<0)throw new Error('所选文件不是有效 PDF');
    const {PDFDocument}=await import('pdf-lib');try{const check=await PDFDocument.load(bytes,{updateMetadata:false});if(check.isEncrypted)throw new Error('encrypted');}catch(error){if(/encrypt/i.test((error as Error).message))throw new Error('此 PDF 已加密或需要密码；本版不支持加密 PDF，请先使用未加密副本。');throw new Error('PDF 结构无法完整读取，未导入：'+(error as Error).message);}
    const doc=await open(bytes);try{if(doc.numPages>PDF_LIMITS.pages)throw new Error('每次最多导入100页，请分段导入。');const pages:PdfPageInfo[]=[];for(let i=0;i<doc.numPages;i++){if(signal?.aborted)throw new DOMException('已取消','AbortError');const p=await doc.getPage(i+1);pages.push(pageInfo(p,i));p.cleanup();}return new PdfImportSession(await createBinaryResource(bytes,'application/pdf',file.name),pages,doc);}catch(error){await closeDocument(doc);throw error;}
  }
  render(index:number,maxDimension=1600,signal?:AbortSignal){if(!this.pages[index])throw new Error('PDF 页码不存在');return render(this.doc,index,maxDimension,signal);}
  async close(){await closeDocument(this.doc);}
}
interface CachedPdf{loading:Promise<PDFDocumentProxy>;doc?:PDFDocumentProxy;uses:number;last:number}
const documents=new Map<string,CachedPdf>();
/** At most two idle parsed originals; every request renders one page and releases page operators. */
export async function renderPdfPage(resource:BinaryResource,index:number,maxDimension=1800,signal?:AbortSignal):Promise<PdfRendered>{
  let entry=documents.get(resource.id);if(!entry){const created:CachedPdf={loading:open(resource.bytes),uses:0,last:Date.now()};entry=created;documents.set(resource.id,created);void created.loading.then(doc=>{created.doc=doc;},()=>{if(documents.get(resource.id)===created)documents.delete(resource.id);});}entry.uses++;entry.last=Date.now();
  try{return await render(await entry.loading,index,maxDimension,signal);}finally{entry.uses--;for(const [id,value] of [...documents].sort((a,b)=>a[1].last-b[1].last)){if(documents.size<=2)break;if(!value.uses&&value.doc){documents.delete(id);await closeDocument(value.doc);}}}
}
