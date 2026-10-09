import { attachSiYuanBridge, populateNotebooks } from './bridge.ts';
import { loadExportRecord, saveExportRecord } from './plugin-storage.ts';

function mount(): void {
  if (document.getElementById('mathink-native-host')) return;
  const root = document.createElement('section'); root.id = 'mathink-native-host';
  root.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;background:#f6f5f0';
  root.innerHTML = '<div style="display:flex;gap:12px;padding:8px;align-items:center;font:14px sans-serif"><strong>MathInk</strong><label>知识库：<select aria-label="目标笔记本"></select></label><button type="button">打开知识库</button><span role="status"></span></div><iframe title="MathInk 数学笔记" style="flex:1;border:0;width:100%;min-height:0"></iframe>';
  const launcher = document.createElement('button'); launcher.textContent = 'MathInk 手写'; launcher.hidden = true;
  launcher.style.cssText = 'position:fixed;right:16px;bottom:24px;z-index:100000;padding:12px;border-radius:12px;background:#14554e;color:white';
  document.body.append(root, launcher);
  root.querySelector('button')!.onclick = () => { root.style.display = 'none'; launcher.hidden = false; };
  launcher.onclick = () => { root.style.display = 'flex'; launcher.hidden = true; };
  const select = root.querySelector('select')!;
  const frame = root.querySelector('iframe')!;
  const status = root.querySelector('span')!;
  attachSiYuanBridge(frame, {
    notebookId: () => select.value,
    loadRecord: id => loadExportRecord('math-ink', id),
    saveRecord: (id, record) => saveExportRecord('math-ink', id, record),
    status: message => { status.textContent = message; }
  });
  frame.src = '/stage/mathink/index.html?host=siyuan';
  populateNotebooks(select, true).catch(error => { status.textContent = String(error); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
