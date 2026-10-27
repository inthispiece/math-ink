import { readdir, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';
const root = 'dist/web';
await mkdir(join(root, 'licenses'), { recursive: true });
await cp('node_modules/katex/LICENSE', join(root, 'licenses/katex-LICENSE.txt'));
await cp('node_modules/fflate/LICENSE', join(root, 'licenses/fflate-LICENSE.txt'));
await cp('node_modules/pdf-lib/LICENSE.md', join(root, 'licenses/pdf-lib-LICENSE.txt'));
await cp('node_modules/pdfjs-dist/LICENSE', join(root, 'licenses/pdfjs-LICENSE.txt'));
const require=createRequire(import.meta.url),pdfRequire=createRequire(require.resolve('pdf-lib/package.json'));
for(const [dependency,file,label]of [['@pdf-lib/standard-fonts','LICENSE.md','pdf-standard-fonts'],['@pdf-lib/upng','LICENSE','pdf-upng'],['pako','LICENSE','pako']])await cp(join(dirname(pdfRequire.resolve(dependency+'/package.json')),file),join(root,'licenses',label+'-LICENSE.txt'));
const tslib=dirname(pdfRequire.resolve('tslib'));for(const file of ['LICENSE.txt','CopyrightNotice.txt'])await cp(join(tslib,file),join(root,'licenses','tslib-'+file));
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = join(path, entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (!name.endsWith('.map') && entry.name !== 'sw.js') files.push('./' + relative(root, name).replaceAll('\\', '/'));
  }
}
await walk(root);
const hash = createHash('sha256');
for (const file of files.sort()) hash.update(await readFile(join(root, file)));
const cache = `mathink-${hash.digest('hex').slice(0, 16)}`;
await writeFile(join(root, 'sw.js'), `const PREFIX='mathink:'+self.registration.scope+':'; const CACHE=PREFIX+${JSON.stringify(cache)}; const FILES=${JSON.stringify(files)};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(PREFIX)&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url); if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.includes('/v1/'))return;const scope=new URL(self.registration.scope);const key=event.request.mode==='navigate'&&url.pathname===scope.pathname?new URL('index.html',scope).href:event.request;event.respondWith(caches.open(CACHE).then(cache=>cache.match(key,{ignoreSearch:true})).then(cached=>cached||fetch(event.request)));});
`);
console.log(`离线资源：${files.length} 个，缓存 ${cache}`);
