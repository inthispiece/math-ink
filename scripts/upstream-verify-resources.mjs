import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {unzipSync} from 'fflate';
const root=resolve(import.meta.dirname,'..');
const targets=process.argv.slice(2);
if(!targets.length||targets.some(target=>!['android','harmony'].includes(target))) throw new Error('Usage: node scripts/upstream-verify-resources.mjs android|harmony [harmony|android]');
const required=['stage/build/mobile/index.html','stage/mathink/index.html','stage/mathink-host.js',
  'stage/mathink/vendor/butterfly/index.html','stage/mathink/vendor/butterfly/main.dart.js',
  'stage/mathink/vendor/butterfly/manifest.json','stage/mathink/vendor/butterfly/assets/NOTICES',
  'stage/mathink/vendor/butterfly/assets/fonts/NotoSansSC-Variable.ttf','licenses/SiYuan-LICENSE'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const target of targets){
  const path=target==='android'?'upstream/siyuan-android/app/src/main/assets/app.zip':'upstream/siyuan-harmony/entry/src/main/resources/rawfile/app.zip';
  let entries=0;
  const files=unzipSync(await readFile(join(root,path)),{filter:file=>{entries++;return required.includes(file.name);}});
  for(const name of required)if(!files[name]?.length)throw new Error(`Missing ${name}`);
  if(!new TextDecoder().decode(files[required[0]]).includes('<script src="/stage/mathink-host.js"></script>'))throw new Error('Missing mobile host injection');
  if(!new TextDecoder().decode(files[required[3]]).includes('<base href="./"'))throw new Error('Wrong Butterfly resource base');
  const manifest=JSON.parse(new TextDecoder().decode(files[required[5]]));
  if(manifest.mathInkBridge!==1||!manifest.entry.includes('#/embed?'))throw new Error('Invalid Butterfly bridge manifest');
  for(const [name,source] of [[required[1],'dist/web/index.html'],[required[2],'dist/host/bootstrap.js'],
    [required[4],'dist/web/vendor/butterfly/main.dart.js'],[required[6],'dist/web/vendor/butterfly/assets/NOTICES'],
    [required[7],'dist/web/vendor/butterfly/assets/fonts/NotoSansSC-Variable.ttf'],[required[8],'upstream/siyuan/LICENSE']]){
    if(hash(files[name])!==hash(await readFile(join(root,source))))throw new Error(`Changed packed resource ${name}`);
  }
  console.log(JSON.stringify({target,entries,bytes:(await stat(join(root,path))).size,verified:'mobile host injection, local paths, current MathInk/Butterfly assets, Chinese font and licenses'}));
}
