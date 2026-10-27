import {readFile, mkdir, cp, writeFile, stat} from 'node:fs/promises';
import {resolve, join, relative, sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {butterflyBuildProvenance} from './butterfly-build-provenance.mjs';
const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(join(root, 'platforms/upstreams.lock.json'), 'utf8'));
const flutter = process.env.FLUTTER || join(root, '.tools/flutter/bin', process.platform === 'win32' ? 'flutter.bat' : 'flutter');
const environment = {...process.env, PUB_CACHE:join(root,'.tools/pub-cache'),
  FLUTTER_WINDOWS:'false', FLUTTER_LINUX:'false',
  GIT_CONFIG_COUNT:'1', GIT_CONFIG_KEY_0:'http.version', GIT_CONFIG_VALUE_0:'HTTP/1.1'};
// Flutter pub also validates every native platform directory it sees. MathInk
// uses SiYuan's native shells, so build an identical Web-only source copy rather
// than requiring Windows symlink privileges or unused native plugin classes.
const workspace = join(root,'.tools/butterfly-build');
const app = join(workspace,'app');
const skip = new Set(['.git','.dart_tool','build','node_modules','android','ios','linux','macos','windows']);
await mkdir(workspace,{recursive:true});
for (const name of ['app','api']) {
  const source = join(root,'upstream/butterfly',name);
  await cp(source,join(workspace,name),{recursive:true,
    filter:path => !relative(source,path).split(sep).some(segment=>skip.has(segment)),
  });
}
for (const font of lock.bundledFonts ?? []) {
  const cached = join(root,'.tools',font.asset);
  let bytes = await readFile(cached).catch(error => {
    if(error.code==='ENOENT') return null; throw error;
  });
  if (!bytes) {
    console.log(`Downloading pinned offline font: ${font.family}`);
    if (process.platform==='win32') {
      // The native Windows downloader respects the system's networking/proxy
      // configuration; Node's direct fetch may be blocked on this host.
      const quote = value=>`'${value.replaceAll("'","''")}'`;
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        `$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri ${quote(font.url)} -OutFile ${quote(cached)} -TimeoutSec 60`],
        {stdio:'inherit',windowsHide:true});
      if(result.status!==0) throw new Error(`Font download failed: ${result.error?.message??result.status}`);
      bytes=await readFile(cached);
    } else {
      const response = await fetch(font.url,{signal:AbortSignal.timeout(60000)});
      if(!response.ok) throw new Error(`Font download failed: ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(cached,bytes);
    }
  }
  if (createHash('sha256').update(bytes).digest('hex')!==font.sha256) throw new Error(`Font checksum mismatch: ${font.asset}`);
  const license = await readFile(join(root,font.licenseFile));
  if (createHash('sha256').update(license.toString('utf8').replaceAll('\r\n','\n')).digest('hex')!==font.licenseSha256) throw new Error(`Font license checksum mismatch: ${font.licenseFile}`);
  await writeFile(join(app,'fonts',font.asset),bytes);
}
function run(args) {
  const result = spawnSync(flutter, args, {
    cwd: app, stdio: 'inherit',
    shell: process.platform === 'win32', windowsHide: true,
    env: environment,
  });
  if (result.status !== 0) throw new Error(`Flutter failed: ${args.join(' ')} (${result.error?.message ?? result.status})`);
}
await stat(flutter).catch(() => {throw new Error(`Flutter ${lock.toolchains.flutter} is required. Set FLUTTER to its executable; see docs/UPSTREAM-BUILD.md`)});
const version = spawnSync(flutter, ['--version', '--machine'], {encoding:'utf8', shell:process.platform==='win32', windowsHide:true, env:environment});
if (version.status !== 0) throw new Error('Flutter SDK bootstrap failed');
const metadata = JSON.parse(version.stdout.slice(version.stdout.indexOf('{')));
if (metadata.frameworkVersion !== lock.toolchains.flutter) throw new Error(`Require Flutter ${lock.toolchains.flutter}; found ${metadata.frameworkVersion}`);
run(['pub', 'get', ...(process.env.MATHINK_FLUTTER_OFFLINE === '1' ? ['--offline'] : [])]);
run(['analyze', '--no-pub', 'lib/bloc/document_bloc.dart', 'lib/embed/mathink.dart', 'lib/embed/handler.dart', 'lib/handlers/select.dart', 'lib/renderers/renderer.dart', 'lib/views/view.dart', 'lib/actions/select.dart', 'lib/embed/mathink_navigation.dart', 'lib/cubits/editor_controller.dart', 'lib/cubits/editor_runtime.dart', 'test/embed/mathink_interaction_test.dart', 'test/embed/mathink_navigation_test.dart']);
run(['test', '--no-pub', 'test/embed/mathink_selection_test.dart', 'test/embed/mathink_interaction_test.dart', 'test/handlers/select_handler_test.dart', 'test/embed/mathink_navigation_test.dart']);
run(['build', 'web', '--no-pub', '--release', '--base-href', '/', '--pwa-strategy=none', '--no-web-resources-cdn', '--no-wasm-dry-run']);
const output = join(root, 'apps/web/public/vendor/butterfly');
await mkdir(output, {recursive:true});
await cp(join(app,'build/web'), output, {recursive:true});
// The pinned Flutter CLI rejects relative base-href values, while the loader
// itself supports a relative HTML base. Make the compiled bundle relocatable.
const htmlPath = join(output,'index.html');
const html = await readFile(htmlPath,'utf8');
if (!html.includes('<base href="/"')) throw new Error('Flutter HTML base anchor missing');
await writeFile(htmlPath,html.replace(/<base href="\/"\s*\/?>/,'<base href="./" />'));
const licenses = join(output,'licenses');
await mkdir(licenses,{recursive:true});
for (const [source,name] of [['LICENSE','Butterfly-LICENSE'],['api/LICENSE','Butterfly-API-LICENSE'],['BRANDING_LICENSE','Butterfly-BRANDING-LICENSE']]) {
  await cp(join(root,'upstream/butterfly',source),join(licenses,name));
}
await cp(join(root,'upstream/butterfly/app/fonts'),join(licenses,'fonts'),{
  recursive:true,filter:path=>!path.endsWith('.ttf'),
});
const manifest = JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
const mathInkBuild=await butterflyBuildProvenance(workspace,lock.repositories.find(r=>r.name==='butterfly').commit,lock.toolchains.flutter);
await writeFile(join(output,'manifest.json'), JSON.stringify({...manifest,mathInkBridge:1,version:'2.6.0',entry:'/vendor/butterfly/index.html#/embed?save=false&language=zh-Hans&fullScreen=layoutOnly',mathInkBuild}, null, 2));
console.log(`Built Butterfly v2.6.0 with MathInk bridge from verified base ${lock.repositories[0].commit}; rerun pnpm build:web to bundle it offline.`);
