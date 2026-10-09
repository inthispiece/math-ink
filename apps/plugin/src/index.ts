import { Plugin, Dialog, showMessage } from 'siyuan';
import { attachSiYuanBridge, populateNotebooks } from '../../host/src/bridge.ts';
import { loadExportRecord, saveExportRecord } from '../../host/src/plugin-storage.ts';

export default class MathInkPlugin extends Plugin {
  private dialog?: Dialog;
  private detach?: () => void;
  onload(): void {
    this.addIcons('<symbol id="iconMathInk" viewBox="0 0 24 24"><path d="M4 4h16v2H8l6 6-6 6h12v2H4v-2l7-6-7-6z"/></symbol>');
    this.addTopBar({ icon: 'iconMathInk', title: 'MathInk 数学手写', callback: () => this.openMathInk() });
    this.addCommand({ langKey: 'openMathInk', hotkey: '⌘⇧M', callback: () => this.openMathInk() });
  }
  openMathInk(): void {
    if (this.dialog) return;
    this.dialog = new Dialog({ title: 'MathInk 数学手写实验', width: '96vw', height: '92vh', content: '<div class="mathink-host" style="height:100%;display:flex;flex-direction:column"><div style="padding:8px 12px;display:flex;gap:12px;align-items:center"><label>整理到笔记本：<select class="mathink-notebook"></select></label><span class="mathink-status" role="status"></span></div><iframe title="MathInk 手写笔记" style="flex:1;width:100%;min-height:0;border:0"></iframe></div>', destroyCallback: () => { this.detach?.(); this.detach = undefined; this.dialog = undefined; } });
    const frame = this.dialog.element.querySelector('iframe')!;
    const select = this.dialog.element.querySelector<HTMLSelectElement>('.mathink-notebook')!;
    const status = this.dialog.element.querySelector<HTMLElement>('.mathink-status')!;
    this.detach = attachSiYuanBridge(frame, {
      notebookId: () => select.value,
      loadRecord: id => loadExportRecord(this.name, id),
      saveRecord: (id, record) => saveExportRecord(this.name, id, record),
      status: message => { status.textContent = message; }
    });
    frame.src = `/plugins/${this.name}/web/index.html?host=siyuan`;
    populateNotebooks(select).catch(error => showMessage(String(error), 7000, 'error'));
  }
  onunload(): void { this.detach?.(); this.dialog?.destroy(); }
}
