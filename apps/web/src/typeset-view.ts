import katex from 'katex';
import type {Notebook} from './notebook-domain.ts';
import {orderedBlocks,createParagraphBlock,moveBlock,removeBlock,type Page,type ContentBlock,type SourceRef} from './page-model.ts';
import {editableBlockText} from './draft-content.ts';
import type {HistoryKind} from './notebook-history.ts';
export function recognizedTypeset(note:Notebook,page:Page):boolean{return page.kind==='typeset'&&(!!page.recognitionOrigin||note.insertions.some(i=>i.pageId===page.id&&i.kind==='page'&&note.drafts.some(d=>d.id===i.draftId&&['page','document'].includes(d.type))));}
interface Options {host:HTMLElement;change:(kind:HistoryKind,mutate:()=>void)=>Promise<void>;edit:(block:ContentBlock)=>void;source:(ref:SourceRef)=>void;view:(value:{zoom:number;scrollX:number;scrollY:number})=>void}
const button=(label:string,action:()=>void)=>{const b=document.createElement('button');b.type='button';b.className='link-button';b.textContent=label;b.onclick=action;return b;};
export class TypesetView {
  private note?:Notebook;private pageId='';private selected?:string;private editing=false;private zoom=1;private body=document.createElement('div');
  private options:Options;
  constructor(options:Options){this.options=options;this.body.className='typeset-body';this.options.host.onscroll=()=>{if(this.note)this.options.view({zoom:this.zoom,scrollX:this.options.host.scrollLeft,scrollY:this.options.host.scrollTop});};}
  mount(note:Notebook,pageId:string,editing:boolean){const changed=this.note?.id!==note.id||this.pageId!==pageId;const x=changed?(note.pages.find(p=>p.id===pageId)?.readingView?.scrollX||0):this.options.host.scrollLeft,y=changed?(note.pages.find(p=>p.id===pageId)?.readingView?.scrollY||0):this.options.host.scrollTop;this.note=note;this.pageId=pageId;this.editing=editing;if(changed){this.selected=undefined;this.zoom=note.pages.find(p=>p.id===pageId)?.readingView?.zoom||1;}this.render();this.options.host.scrollTo(x,y);}
  setZoom(value:number){this.zoom=Math.max(.25,Math.min(3,value));this.body.style.zoom=String(this.zoom);this.options.view({zoom:this.zoom,scrollX:this.options.host.scrollLeft,scrollY:this.options.host.scrollTop});}
  currentZoom(){return this.zoom;}
  private render(){
    const note=this.note!,host=this.options.host,legacyEditing=!recognizedTypeset(note,note.pages.find(p=>p.id===this.pageId)!);host.replaceChildren(this.body);this.body.replaceChildren();this.body.style.zoom=String(this.zoom);host.classList.toggle('reading',!this.editing);host.dataset.editMode=String(this.editing);
    for(const block of orderedBlocks(note,this.pageId)){
      const e=document.createElement('div');e.className='typeset-block';e.dataset.blockId=block.id;
      const math=(el:HTMLElement,latex:string,display:boolean)=>{try{katex.render(latex,el,{displayMode:display,throwOnError:false,trust:false,maxExpand:1000});}catch{el.textContent=latex;}};
      if(block.type==='formula'||block.type==='derivation')math(e,editableBlockText(note,block),true);
      else if(block.type==='paragraph'){if(block.content.role==='heading')e.classList.add('typeset-heading');if(block.content.role==='list-item')e.append('• ');for(const run of block.content.runs||[]){const span=document.createElement('span');if(run.type==='formula')math(span,note.formulas.find(f=>f.id===run.formulaId)?.latex||'',false);else span.textContent=run.text;e.append(span);}}
      else if(block.type==='image'){const image=document.createElement('img');image.src=block.content.imageDataUrl||'';image.alt=block.content.caption||'原图区域';e.append(image);if(block.content.caption){const caption=document.createElement('p');caption.textContent=block.content.caption;e.append(caption);}}
      else e.textContent=block.content.markdown||'';
      if(this.editing){e.tabIndex=0;e.setAttribute('aria-label','选择内容块');const select=()=>{this.selected=block.id;const x=host.scrollLeft,y=host.scrollTop;this.render();host.scrollTo(x,y);};e.onclick=event=>{if(!(event.target as HTMLElement).closest('button'))select();};e.onkeydown=event=>{if(event.key==='Enter'&&event.target===e){event.preventDefault();select();}};if(this.selected===block.id||legacyEditing){e.classList.add('block-selected');const controls=document.createElement('div');controls.className='typeset-block-actions';controls.append(button('编辑',()=>this.options.edit(block)));for(const id of block.sourceRefIds){const ref=note.sources.find(s=>s.id===id);if(ref)controls.append(button('返回此块原稿',()=>this.options.source(ref)));}controls.append(button('上移',()=>void this.options.change('move',()=>{moveBlock(note,block.id,-1);})),button('下移',()=>void this.options.change('move',()=>{moveBlock(note,block.id,1);})),button('删除内容块',()=>void this.options.change('delete',()=>{removeBlock(note,block.id);})));e.append(controls);}}
      this.body.append(e);
    }
    if(this.editing)this.body.append(button('＋ 添加段落',()=>void this.options.change('insert',()=>{const block=createParagraphBlock(note,'新段落',this.pageId);this.selected=block.id;})));
  }
}
