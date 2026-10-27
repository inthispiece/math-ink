import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url),root=dirname(require.resolve('pdfjs-dist/package.json')),target='apps/web/public/vendor/pdfjs';
await mkdir(target,{recursive:true});
for(const directory of ['cmaps','standard_fonts','wasm'])await cp(join(root,directory),join(target,directory),{recursive:true});
await cp(join(root,'LICENSE'),join(target,'LICENSE.txt'));
const lock=JSON.parse(await readFile('platforms/upstreams.lock.json','utf8')),font=lock.bundledFonts.find(font=>font.family==='Noto Sans SC'||font.asset==='NotoSansSC-Variable.ttf');
if(!font)throw new Error('缺少固定中文字体清单');
await mkdir('.tools',{recursive:true});
const cached=join('.tools',font.asset);let bytes=await readFile(cached).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(!bytes){if(process.platform==='win32'){const quote=value=>"'"+value.replaceAll("'","''")+"'",result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri ${quote(font.url)} -OutFile ${quote(cached)} -TimeoutSec 60`],{stdio:'inherit',windowsHide:true});if(result.status!==0)throw new Error('无法下载固定中文字体');bytes=await readFile(cached);}else{const response=await fetch(font.url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('无法下载固定中文字体');bytes=Buffer.from(await response.arrayBuffer());await writeFile(cached,bytes);}}
if(createHash('sha256').update(bytes).digest('hex')!==font.sha256)throw new Error('中文字体哈希不匹配');
const license=await readFile(font.licenseFile).catch(error=>{if(error.code==='ENOENT')return readFile('licenses/NotoSansSC-LICENSE.txt');throw error;});if(createHash('sha256').update(license.toString('utf8').replaceAll('\r\n','\n')).digest('hex')!==font.licenseSha256)throw new Error('中文字体许可不匹配');
await writeFile(join(target,'MathInkSans.ttf'),bytes);await writeFile(join(target,'MathInkSans-LICENSE.txt'),license);
