import {drawStroke,hitStroke,cropSelection,type Stroke,type Point,type Bounds} from './geometry.ts';
import {renderInkPage,type FullPageImage} from './page-render.ts';
import {newId} from './model.ts';
import type {PageView,PaperType} from './notebook-domain.ts';
import {contentBounds,selectContent,transformContent,defaultFormulaBounds,type SelectionFormula,type SelectionState,type FormulaBounds} from './selection.ts';
import katex from 'katex';

export type InkTool='pen'|'eraser'|'lasso'|'pan';
export type CanvasChange='ink'|'move'|'scale';
interface State {noteId:string;pageId:string;revision:number;strokes:Stroke[];placements:SelectionFormula[];paper:PaperType;view:PageView}
interface Options {
  parent:HTMLElement;state:()=>State;
  beforeChange:(kind:CanvasChange)=>void;changed:(strokes:Stroke[],reason:CanvasChange)=>void;cancelled:()=>void;
  viewChanged:(view:PageView)=>void;selected:(selection:SelectionState)=>void;
  placing:(point:{x:number;y:number})=>void;renderObjects:(transform:PageView)=>void;mathBounds?:FormulaBounds;notify?:(message:string)=>void;
}
interface Gesture {pointerId:number;kind:'move'|'scale';start:Point;bounds:Bounds;strokes:Stroke[];placements:SelectionFormula[];strokeIds:string[];formulaIds:string[];changed:boolean}
const WIDTH=1000,HEIGHT=1414;

/** A single selection and one content command per completed gesture. */
export class NotebookCanvas {
  readonly canvas=document.createElement('canvas');
  private preview=document.createElement('div');
  tool:InkTool='pen';color='#253d35';width=3;fingerWriting=false;
  private options:Options;private ctx:CanvasRenderingContext2D;private observer:ResizeObserver;
  private active:Stroke|null=null;private strokePointer:number|null=null;private before:Stroke[]|null=null;
  private touches=new Map<number,{x:number;y:number}>();private palm=false;
  private start:{pointerId:number;x:number;y:number;panX:number;panY:number}|null=null;
  private pinch:{distance:number;zoom:number;worldX:number;worldY:number}|null=null;
  private lasso:Point[]=[];private selectedIds=new Set<string>();private generation=0;private gesture:Gesture|null=null;
  private view:PageView={zoom:1,panX:0,panY:0};private pageId='';private placement=false;private ghost:Point|null=null;
  constructor(options:Options){
    this.options=options;this.ctx=this.canvas.getContext('2d')!;this.canvas.id='ink-canvas';this.canvas.tabIndex=0;
    this.canvas.style.touchAction='none';this.canvas.setAttribute('aria-label','当前页手写纸面');options.parent.append(this.canvas);
    for(const [type,fn] of [['pointerdown',(e:PointerEvent)=>this.down(e)],['pointermove',(e:PointerEvent)=>this.move(e)],['pointerup',(e:PointerEvent)=>this.up(e)],['pointercancel',(e:PointerEvent)=>this.up(e,true)]] as const)this.canvas.addEventListener(type,fn);
    this.canvas.addEventListener('wheel',e=>{e.preventDefault();if(e.ctrlKey||e.metaKey){const p=this.local(e),old=this.view.zoom,next=Math.max(.25,Math.min(3,old*Math.exp(-e.deltaY*.003)));this.view.panX=p.x-(p.x-this.view.panX)*next/old;this.view.panY=p.y-(p.y-this.view.panY)*next/old;this.view.zoom=next;}else{this.view.panX-=e.deltaX;this.view.panY-=e.deltaY;}this.saveView();this.draw();},{passive:false});
    this.preview.className='placement-formula-preview';this.preview.hidden=true;options.parent.append(this.preview);
    this.observer=new ResizeObserver(()=>this.draw());this.observer.observe(options.parent);
  }
  private local(e:Pick<PointerEvent,'clientX'|'clientY'>){const r=this.canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
  private point(e:PointerEvent):Point{const p=this.local(e);return{x:(p.x-this.view.panX)/this.view.zoom,y:(p.y-this.view.panY)/this.view.zoom,pressure:e.pointerType==='pen'?Math.max(0,Math.min(1,e.pressure)):.5};}
  private mathBounds:FormulaBounds=p=>(this.options.mathBounds||defaultFormulaBounds)(p);
  private bounds(){const s=this.options.state();return contentBounds(s.strokes,s.placements,[...this.selectedIds],this.mathBounds);}
  currentSelection():SelectionState {const s=this.options.state(),strokeIds=s.strokes.filter(p=>this.selectedIds.has(p.id)).map(p=>p.id),formulaIds=s.placements.filter(p=>!p.deletedAt&&this.selectedIds.has(p.id)).map(p=>p.id);return{noteId:s.noteId,pageId:s.pageId,revision:s.revision,generation:this.generation,objectIds:[...strokeIds,...formulaIds],strokeIds,formulaIds,bounds:this.bounds()};}
  private announce(){this.options.selected(this.currentSelection());}
  clearSelection(expected?:Pick<SelectionState,'noteId'|'pageId'|'generation'>):boolean {const s=this.options.state();if(expected&&(expected.noteId!==s.noteId||expected.pageId!==s.pageId||expected.generation!==this.generation))return false;this.cancelTransform();if(this.tool==='lasso')this.strokePointer=null;this.selectedIds.clear();this.lasso=[];this.generation++;this.announce();this.draw();return true;}
  selectObjects(ids:string[]){this.finish();this.selectedIds=new Set(ids);this.generation++;this.announce();this.draw();}
  selectAll(){const s=this.options.state();this.selectObjects([...s.strokes.map(p=>p.id),...s.placements.filter(p=>!p.deletedAt).map(p=>p.id)]);}
  hasSelection(){return this.currentSelection().objectIds.length>0;}
  selection(){const selection=this.currentSelection();if(selection.formulaIds.length)throw new Error(selection.strokeIds.length?'当前混选了笔迹和公式，请调整为纯笔迹选区后识别。':'当前选中的是排版公式，可直接编辑或复制；识别只接收手写笔迹。');const strokes=this.options.state().strokes.filter(p=>this.selectedIds.has(p.id));return{...cropSelection(strokes),strokeIds:strokes.map(p=>p.id)};}
  private capture(){if(this.before)return;this.before=structuredClone(this.options.state().strokes);this.options.beforeChange('ink');}
  private commitInk(){if(this.before&&JSON.stringify(this.before)!==JSON.stringify(this.options.state().strokes))this.options.changed(this.options.state().strokes,'ink');else if(this.before)this.options.cancelled();this.before=null;}
  private inside(p:Point){return p.x>=0&&p.x<=WIDTH&&p.y>=0&&p.y<=HEIGHT;}
  private handle(p:Point,b:Bounds){return Math.hypot(p.x-b.x-b.width,p.y-b.y-b.height)<=22/this.view.zoom;}
  private contains(p:Point,b:Bounds){return p.x>=b.x&&p.x<=b.x+b.width&&p.y>=b.y&&p.y<=b.y+b.height;}
  private beginTransform(e:PointerEvent,p:Point,bounds:Bounds,kind:'move'|'scale'){
    const s=this.options.state(),selected=this.currentSelection();this.options.beforeChange(kind);if(e.pointerType==='pen')this.palm=true;
    this.gesture={pointerId:e.pointerId,kind,start:p,bounds,strokes:structuredClone(s.strokes),placements:structuredClone(s.placements),strokeIds:selected.strokeIds,formulaIds:selected.formulaIds,changed:false};this.strokePointer=e.pointerId;
  }
  private down(e:PointerEvent){
    if(e.button!==0)return;try{this.canvas.setPointerCapture(e.pointerId);}catch{}const p=this.point(e);
    if(e.pointerType==='touch'){
      if(this.palm)return;this.touches.set(e.pointerId,this.local(e));
      if(this.touches.size===2){this.start=null;this.cancelTransform();this.cancelStroke();const[a,b]=[...this.touches.values()],x=(a.x+b.x)/2,y=(a.y+b.y)/2;this.pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom:this.view.zoom,worldX:(x-this.view.panX)/this.view.zoom,worldY:(y-this.view.panY)/this.view.zoom};return;}if(this.touches.size>2)return;
    }
    if(this.placement){this.ghost=p;this.draw();return;}
    const bounds=this.tool==='lasso'?this.bounds():null;
    if(bounds&&(this.handle(p,bounds)||this.contains(p,bounds))){this.beginTransform(e,p,bounds,this.handle(p,bounds)?'scale':'move');this.draw();return;}
    if(this.tool==='pan'||e.pointerType==='touch'&&!this.fingerWriting){this.start={pointerId:e.pointerId,...this.local(e),panX:this.view.panX,panY:this.view.panY};return;}
    if(e.pointerType==='pen')this.palm=true;this.strokePointer=e.pointerId;
    if(this.tool==='pen'&&this.inside(p)){this.capture();this.active={id:newId(),color:this.color,width:this.width,points:[p]};}
    if(this.tool==='eraser'){this.capture();this.erase(p);}
    if(this.tool==='lasso'){this.clearSelection();this.strokePointer=e.pointerId;this.lasso=[p];}
    this.draw();
  }
  private applyPreview(p:Point){
    const g=this.gesture;if(!g)return;const origin={x:g.bounds.x,y:g.bounds.y},a={x:g.start.x-origin.x,y:g.start.y-origin.y},b={x:p.x-origin.x,y:p.y-origin.y};
    const ratio=g.kind==='scale'?Math.max(.01,(a.x*b.x+a.y*b.y)/Math.max(1,a.x*a.x+a.y*a.y)):1;
    try{const out=transformContent(g.strokes,g.placements,g,{origin,scale:ratio,dx:g.kind==='move'?p.x-g.start.x:0,dy:g.kind==='move'?p.y-g.start.y:0});const s=this.options.state();s.strokes.splice(0,s.strokes.length,...out.strokes);for(const value of out.placements){const target=s.placements.find(item=>item.id===value.id);if(target){if(value.scale===undefined)delete target.scale;Object.assign(target,value);}}g.changed=JSON.stringify([g.strokes,g.placements])!==JSON.stringify([s.strokes,s.placements]);this.draw();}catch(error){this.options.notify?.((error as Error).message);this.cancelTransform();this.draw();}
  }
  private move(e:PointerEvent){
    if(this.placement){this.ghost=this.point(e);this.draw();return;}
    if(e.pointerType==='touch'){
      if(this.palm)return;if(this.touches.has(e.pointerId))this.touches.set(e.pointerId,this.local(e));
      if(this.pinch&&this.touches.size===2){const[a,b]=[...this.touches.values()],x=(a.x+b.x)/2,y=(a.y+b.y)/2;this.view.zoom=Math.max(.25,Math.min(3,this.pinch.zoom*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,this.pinch.distance)));this.view.panX=x-this.pinch.worldX*this.view.zoom;this.view.panY=y-this.pinch.worldY*this.view.zoom;this.saveView();this.draw();return;}
    }
    if(this.gesture?.pointerId===e.pointerId){this.applyPreview(this.point(e));return;}
    if(this.start?.pointerId===e.pointerId){const p=this.local(e);this.view.panX=this.start.panX+p.x-this.start.x;this.view.panY=this.start.panY+p.y-this.start.y;this.saveView();this.draw();return;}
    if(e.pointerId!==this.strokePointer){const b=this.bounds(),p=this.point(e);this.canvas.style.cursor=this.tool==='lasso'?(b&&this.handle(p,b)?'nwse-resize':b&&this.contains(p,b)?'move':'crosshair'):this.tool==='pan'?'grab':'crosshair';return;}
    const samples=e.getCoalescedEvents?.()||[];for(const event of samples.length?samples:[e]){const p=this.point(event);if(this.active&&this.inside(p))this.active.points.push(p);if(this.tool==='eraser')this.erase(p);if(this.tool==='lasso')this.lasso.push(p);}this.draw();
  }
  private up(e:PointerEvent,cancel=false){
    if(e.pointerType==='pen')this.palm=false;const pinching=!!this.pinch;this.touches.delete(e.pointerId);if(this.touches.size<2){this.pinch=null;if(pinching&&this.touches.size===1){const [id,p]=[...this.touches.entries()][0];this.start={pointerId:id,...p,panX:this.view.panX,panY:this.view.panY};}}if(this.start?.pointerId===e.pointerId)this.start=null;
    if(this.placement){if(!cancel&&!pinching){const p=this.point(e);if(this.inside(p))this.options.placing({x:p.x,y:p.y});}this.release(e);return;}
    if(this.gesture?.pointerId===e.pointerId){const gesture=this.gesture;if(cancel)this.cancelTransform();else{this.applyPreview(this.point(e));if(this.gesture){this.gesture=null;if(gesture.changed){this.generation++;this.options.changed(this.options.state().strokes,gesture.kind);this.announce();}else this.options.cancelled();}}this.strokePointer=null;this.palm=false;this.release(e);this.draw();return;}
    if(e.pointerId===this.strokePointer){
      if(cancel){this.cancelStroke();this.lasso=[];}
      else{if(this.active){this.options.state().strokes.push(this.active);this.active=null;}if(this.tool==='lasso'&&this.lasso.length>2){const s=this.options.state(),selected=selectContent(s.strokes,s.placements,this.lasso,this.mathBounds);this.selectedIds=new Set(selected.objectIds);this.generation++;this.announce();}this.lasso=[];this.commitInk();}
      this.strokePointer=null;this.palm=false;
    }
    this.release(e);this.draw();
  }
  private release(e:PointerEvent){if(this.canvas.hasPointerCapture(e.pointerId))this.canvas.releasePointerCapture(e.pointerId);}
  private erase(p:Point){const strokes=this.options.state().strokes;for(let i=strokes.length-1;i>=0;i--)if(hitStroke(strokes[i],p,10/this.view.zoom))strokes.splice(i,1);}
  private cancelStroke(){if(this.before){const s=this.options.state().strokes;s.splice(0,s.length,...this.before);this.options.cancelled();}this.active=null;this.before=null;this.strokePointer=null;}
  private cancelTransform(){const g=this.gesture;if(!g)return false;const s=this.options.state();s.strokes.splice(0,s.strokes.length,...structuredClone(g.strokes));for(const original of g.placements){const p=s.placements.find(p=>p.id===original.id);if(p){if(original.scale===undefined)delete p.scale;Object.assign(p,structuredClone(original));}}this.gesture=null;this.strokePointer=null;this.options.cancelled();return true;}
  escape():'transform'|'selection'|'none'{if(this.cancelTransform()){this.draw();return'transform';}if(this.hasSelection()||this.lasso.length){this.clearSelection();return'selection';}return'none';}
  finish(){this.cancelTransform();if(this.active){this.options.state().strokes.push(this.active);this.active=null;}this.commitInk();this.strokePointer=null;this.lasso=[];this.palm=false;this.touches.clear();this.start=null;this.pinch=null;this.saveView();this.draw();}
  setPage(){this.cancelTransform();this.cancelStroke();const s=this.options.state();this.pageId=s.noteId+':'+s.pageId;this.view={...s.view};this.selectedIds.clear();this.generation++;this.lasso=[];this.placement=false;this.preview.hidden=true;this.ghost=null;this.announce();this.draw();}
  setTool(tool:InkTool){this.finish();if(tool!=='lasso')this.clearSelection();this.tool=tool;this.canvas.dataset.tool=tool;this.draw();}
  setPlacement(enabled:boolean,latex=''){this.finish();if(enabled)this.clearSelection();this.placement=enabled;this.ghost=null;this.preview.hidden=!enabled;try{katex.render(latex,this.preview,{throwOnError:false,trust:false});}catch{this.preview.textContent=latex;}this.canvas.classList.toggle('placing',enabled);this.draw();}
  fullPage(revision:string,page:string):FullPageImage{return renderInkPage(this.options.state().strokes,{revision,page});}
  currentView(){return{...this.view};}
  locate(b:Bounds){this.view.zoom=Math.min(1.5,Math.max(.4,(this.canvas.clientWidth-100)/Math.max(1,b.width)));this.view.panX=this.canvas.clientWidth/2-(b.x+b.width/2)*this.view.zoom;this.view.panY=this.canvas.clientHeight/3-(b.y+b.height/2)*this.view.zoom;this.saveView();this.draw();}
  fit(){this.view={zoom:Math.min(1,(this.canvas.clientWidth-48)/WIDTH),panX:24,panY:24};this.saveView();this.draw();}
  private saveView(){if(this.pageId)this.options.viewChanged({...this.view});}
  draw(){
    const s=this.options.state(),dpr=devicePixelRatio||1,w=this.options.parent.clientWidth,h=this.options.parent.clientHeight;if(w<=0||h<=0)return;
    if(this.canvas.width!==Math.round(w*dpr)||this.canvas.height!==Math.round(h*dpr)){this.canvas.width=Math.round(w*dpr);this.canvas.height=Math.round(h*dpr);}
    const c=this.ctx;c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);c.save();c.translate(this.view.panX,this.view.panY);c.scale(this.view.zoom,this.view.zoom);c.shadowColor='#1e36220e';c.shadowBlur=24;c.fillStyle='#fffefa';c.fillRect(0,0,WIDTH,HEIGHT);c.shadowBlur=0;c.strokeStyle='#e5e8df';c.lineWidth=.7;
    if(s.paper!=='blank'){c.beginPath();for(let y=48;y<HEIGHT;y+=36){c.moveTo(0,y);c.lineTo(WIDTH,y);}if(s.paper==='grid')for(let x=28;x<WIDTH;x+=36){c.moveTo(x,0);c.lineTo(x,HEIGHT);}c.stroke();}
    s.strokes.forEach(stroke=>drawStroke(c,stroke));if(this.active)drawStroke(c,this.active);
    const bounds=this.bounds();this.canvas.dataset.selectionCount=String(this.currentSelection().objectIds.length);this.canvas.dataset.selectionBounds=bounds?JSON.stringify(bounds):'';
    if(bounds&&this.tool==='lasso'){c.strokeStyle='#35856b';c.lineWidth=1.5/this.view.zoom;c.setLineDash([7/this.view.zoom,5/this.view.zoom]);c.strokeRect(bounds.x,bounds.y,bounds.width,bounds.height);c.setLineDash([]);c.fillStyle='#fff';c.beginPath();c.arc(bounds.x+bounds.width,bounds.y+bounds.height,7/this.view.zoom,0,2*Math.PI);c.fill();c.stroke();}
    if(this.lasso.length){c.strokeStyle='#35856b';c.lineWidth=1.5/this.view.zoom;c.beginPath();this.lasso.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.stroke();}c.restore();
    this.preview.hidden=!this.placement;if(this.placement){const p=this.ghost||{x:80,y:80};this.preview.style.left=(p.x*this.view.zoom+this.view.panX)+'px';this.preview.style.top=(p.y*this.view.zoom+this.view.panY)+'px';this.preview.style.transform='scale('+this.view.zoom+')';}this.options.renderObjects({...this.view});
  }
}
