import {readFile, writeFile, mkdir, cp, readdir, stat, rm} from 'node:fs/promises';
import {resolve, join, relative, isAbsolute} from 'node:path';
import {zipSync} from 'fflate';
const root = resolve(import.meta.dirname, '..');
const target = process.argv[2];
if (!['android','harmony'].includes(target)) throw new Error('Usage: node platforms/prepare-resources.mjs android|harmony');
const core = join(root,'upstream/siyuan/app');
const web = join(root,'dist/web');
const host = join(root,'dist/host/bootstrap.js');
const mobile = join(core,'stage/build/mobile/index.html');
for (const path of [mobile, join(web,'index.html'), host, join(web,'vendor/butterfly/manifest.json')]) {
  await stat(path).catch(() => {throw new Error(`Missing ${relative(root,path)}. Build SiYuan mobile, real Butterfly, MathInk web, and host first.`)});
}
const work = join(root,'dist/native-resources',target);
const generatedRoot = join(root,'dist/native-resources');
const child = relative(generatedRoot,work);
if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Unsafe generated resource path');
await rm(work,{recursive:true,force:true});
await mkdir(work,{recursive:true});
for (const name of ['appearance','guide','stage','changelogs']) {
  await cp(join(core,name),join(work,name),{recursive:true});
}
await cp(web,join(work,'stage/mathink'),{recursive:true});
await cp(host,join(work,'stage/mathink-host.js'));
await mkdir(join(work,'licenses'),{recursive:true});
await cp(join(root,'upstream/siyuan/LICENSE'),join(work,'licenses/SiYuan-LICENSE'));
await writeFile(join(work,'VERSION'), '3.8.6');
const html = await readFile(join(work,'stage/build/mobile/index.html'),'utf8');
if (!html.includes('</body>')) throw new Error('SiYuan mobile HTML injection anchor missing');
await writeFile(join(work,'stage/build/mobile/index.html'),html.replace('</body>','<script src="/stage/mathink-host.js"></script></body>'));
const files={};
async function collect(dir){
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory()) await collect(path);
    else files[relative(work,path).replaceAll('\\','/')]=new Uint8Array(await readFile(path));
  }
}
await collect(work);
const output=target==='android'?join(root,'upstream/siyuan-android/app/src/main/assets/app.zip'):join(root,'upstream/siyuan-harmony/entry/src/main/resources/rawfile/app.zip');
await mkdir(resolve(output,'..'),{recursive:true});
await writeFile(output,zipSync(files,{level:6}));
console.log(`Prepared ${target} app.zip with local MathInk, Butterfly, and SiYuan resources (${Object.keys(files).length} files).`);
