import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

/** Hash the exact Dart source snapshot consumed by the isolated Web build. */
export async function butterflyBuildProvenance(workspace,upstreamCommit,flutterVersion){
  async function walk(relative){const out=[];for(const entry of await readdir(join(workspace,relative),{withFileTypes:true})){const path=relative+'/'+entry.name;if(entry.isDirectory())out.push(...await walk(path));else if(entry.name.endsWith('.dart'))out.push(path);}return out;}
  const paths=[...await walk('app/lib'),...await walk('api/lib'),'app/pubspec.yaml','app/pubspec.lock','api/pubspec.yaml'].sort();
  const source=createHash('sha256');for(const path of paths){source.update(path+'\0');source.update(await readFile(join(workspace,path)));source.update('\0');}
  return{upstreamCommit,flutterVersion,sourceFileCount:paths.length,sourceSha256:source.digest('hex'),mainDartSha256:createHash('sha256').update(await readFile(join(workspace,'app/build/web/main.dart.js'))).digest('hex')};
}
