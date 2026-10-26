import 'katex/dist/katex.min.css';
import { NotebookApplication } from './notebook-app';
new NotebookApplication();
if ((import.meta as ImportMeta & { env?: { PROD:boolean } }).env?.PROD && 'serviceWorker' in navigator) { void navigator.serviceWorker.register(new URL('sw.js',document.baseURI),{scope:'./'}).catch(()=>{}); }
