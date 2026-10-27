import {newId,type Note,type NotebookBackup} from './model.ts';
import {loadFolders} from './folders.ts';
import {folderNameKey,normalizeFolderName,validateFolder,type Folder} from './asset-model.ts';

export interface BackupFolderMappingDependencies {
 loadFolders?:()=>Promise<Folder[]>;
 prompt?:(message:string,defaultValue?:string)=>string|null;
 newId?:()=>string;
 now?:()=>string;
}
export interface BackupFolderMappingResult {backup:NotebookBackup;folderMapping:Record<string,string|null>}

/** Remap only directory metadata; source identities and content snapshots remain unchanged. */
function rewriteNoteFolders(note:Note,aliases:Map<string,string>,depth=0):Note {
 if(depth>64)throw new Error('备份的嵌套笔记结构过深');
 const folderId=note.folderId&&aliases.get(note.folderId);let changed=!!folderId;
 const drafts=note.drafts?.map(draft=>{const content=draft.content?rewriteNoteFolders(draft.content,aliases,depth+1):undefined;let draftChanged=content!==draft.content;const documentPages=draft.documentPages?.map(page=>{const next=rewriteNoteFolders(page.content,aliases,depth+1);if(next===page.content)return page;draftChanged=true;return{...page,content:next};});if(!draftChanged)return draft;changed=true;return{...draft,...(content?{content}:{}),...(documentPages?{documentPages}:{})};});
 if(!changed)return note;
 return{...note,...(folderId?{folderId,folderRevision:(note.folderRevision||0)+1}:{}),...(drafts?{drafts}:{})};
}
function rewriteTaskFolders(value:unknown,aliases:Map<string,string>):unknown {
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 const task=value as{folderId?:string|null;frozen?:Note;pages?:{content?:Note;[key:string]:unknown}[]};let changed=false;
 const folderId=task.folderId&&aliases.get(task.folderId);if(folderId)changed=true;
 const frozen=task.frozen?rewriteNoteFolders(task.frozen,aliases):undefined;if(frozen!==task.frozen)changed=true;
 const pages=task.pages?.map(page=>{if(!page.content)return page;const content=rewriteNoteFolders(page.content,aliases);if(content===page.content)return page;changed=true;return{...page,content};});
 return changed?{...task,...(folderId?{folderId}:{}),...(frozen?{frozen}:{}),...(pages?{pages}:{})}:value;
}

/** Ask only for collisions. No directory or notebook is written until the complete importer commits. */
export async function resolveBackupFolderMapping(backup:NotebookBackup,dependencies:BackupFolderMappingDependencies={}):Promise<BackupFolderMappingResult|null> {
 const incoming=backup.folders||[];if(!incoming.length)return{backup,folderMapping:{}};
 incoming.forEach(validateFolder);if(new Set(incoming.map(folder=>folder.id)).size!==incoming.length||new Set(incoming.map(folder=>folderNameKey(folder.name))).size!==incoming.length)throw new Error('备份包含重复文件夹标识或名称，请先检查备份');
 const current=await(dependencies.loadFolders||loadFolders)();current.forEach(validateFolder);
 const ask=dependencies.prompt||((message:string,defaultValue?:string)=>window.prompt(message,defaultValue));
 const folderMapping:Record<string,string|null>={},aliases=new Map<string,string>(),folders=incoming.map(folder=>({...folder})),reservedIds=new Set([...current,...incoming].map(folder=>folder.id));
 for(let index=0;index<folders.length;index++){
  const folder=folders[index],collision=current.find(existing=>existing.id===folder.id||folderNameKey(existing.name)===folderNameKey(folder.name));if(!collision)continue;
  let error='';
  while(true){
   const answer=ask(`${error?error+'\n\n':''}备份文件夹“${folder.name}”与当前目录存在标识或名称冲突。请选择本次导入去向：\n1. 使用一个现有文件夹\n2. 放入未分类\n3. 输入新名称，创建独立文件夹\n\n取消会停止本次恢复，不修改目录。`,'');
   if(answer===null)return null;const choice=answer.trim();
   if(choice==='1'){
    let selectionError='';while(true){const selected=ask(`${selectionError?selectionError+'\n\n':''}选择“${folder.name}”的目标文件夹编号：\n${current.map((existing,i)=>`${i+1}. ${existing.name}`).join('\n')}\n\n同名目录也须明确选择，不会自动合并。`,'');if(selected===null)return null;const text=selected.trim(),position=/^[1-9]\d*$/.test(text)?Number(text)-1:-1;if(Number.isSafeInteger(position)&&position>=0&&position<current.length){folderMapping[folder.id]=current[position].id;break;}selectionError='请输入列表中的有效目录编号。';}break;
   }
   if(choice==='2'){folderMapping[folder.id]=null;break;}
   if(choice==='3'){
    let nameError='',previous='';while(true){const value=ask(`${nameError?nameError+'\n\n':''}为备份文件夹“${folder.name}”输入新的独立名称：`,previous);if(value===null)return null;previous=value;let name:string;try{name=normalizeFolderName(value);}catch(failure){nameError=(failure as Error).message;continue;}
     if(current.some(existing=>folderNameKey(existing.name)===folderNameKey(name))||folders.some((other,i)=>i!==index&&!Object.hasOwn(folderMapping,other.id)&&folderNameKey(other.name)===folderNameKey(name))){nameError='已有同名文件夹，请输入其他名称，或取消后明确选择现有目录。';continue;}
     let id='',attempt=0;do{id=(dependencies.newId||newId)();if(++attempt>16)throw new Error('新文件夹标识发生冲突，请重新开始恢复');}while(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||reservedIds.has(id));reservedIds.add(id);const at=(dependencies.now||(()=>new Date().toISOString()))();if(!Number.isFinite(Date.parse(at)))throw new Error('文件夹创建时间无效');
     aliases.set(folder.id,id);folders[index]={id,name,createdAt:at,updatedAt:at,revision:0};break;
    }break;
   }
   error='请输入 1、2 或 3，选择本次恢复的目录去向。';
  }
 }
 if(!aliases.size)return{backup,folderMapping};
 return{backup:{...backup,folders,notes:backup.notes.map(note=>rewriteNoteFolders(note,aliases)),...(backup.documentTasks?{documentTasks:backup.documentTasks.map(task=>rewriteTaskFolders(task,aliases))}:{})},folderMapping};
}
