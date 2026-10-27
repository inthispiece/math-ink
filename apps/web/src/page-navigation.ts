export interface PageGeometry {width:number;height:number}
export interface CameraView {zoom:number;panX:number;panY:number}
export interface SwipeOptions {zone:'paper'|'navigation';pointerType:string;tool:string;fingerWriting:boolean;locked:boolean;popup:boolean;selection:boolean;placement:boolean;viewport:PageGeometry;geometry:PageGeometry;view:CameraView}
export function fitPageView(page:PageGeometry,viewport:PageGeometry):CameraView {const zoom=Math.max(.1,Math.min(3,(viewport.width-48)/page.width));return{zoom,panX:(viewport.width-page.width*zoom)/2,panY:24};}
export function resetPageView(page:PageGeometry,viewport:PageGeometry):CameraView {return{zoom:1,panX:(viewport.width-page.width)/2,panY:Math.max(24,(viewport.height-page.height)/2)};}
/** A camera gesture may become navigation only from its original boundary. */
export class PageSwipe {
  private candidate?:{id:number;x:number;y:number;time:number;next:boolean;previous:boolean};
  private pointers=new Set<number>();
  begin(id:number,x:number,y:number,time:number,o:SwipeOptions){
    this.pointers.add(id);this.candidate=undefined;
    if(this.pointers.size!==1||o.pointerType!=='touch'||o.locked||o.popup||o.placement||o.selection||x<24||x>o.viewport.width-24)return;
    if(o.zone==='paper'&&(o.fingerWriting||!['pan','read'].includes(o.tool)))return;
    const fits=o.geometry.width*o.view.zoom<=o.viewport.width-46;
    this.candidate={id,x,y,time,next:o.zone==='navigation'||fits||o.view.panX+o.geometry.width*o.view.zoom<=o.viewport.width+2,previous:o.zone==='navigation'||fits||o.view.panX>=-2};
  }
  finish(id:number,x:number,y:number,time:number):-1|0|1 {const c=this.candidate;this.pointers.delete(id);this.candidate=undefined;if(!c||c.id!==id||this.pointers.size)return 0;const dx=x-c.x,dy=y-c.y,dt=Math.max(1,time-c.time);if(Math.abs(dx)<64||Math.abs(dx)<Math.abs(dy)*1.6||Math.abs(dx)/dt<.08||dt>1500)return 0;return dx<0&&c.next?1:dx>0&&c.previous?-1:0;}
  cancel(){this.candidate=undefined;}
  reset(){this.candidate=undefined;this.pointers.clear();}
}
