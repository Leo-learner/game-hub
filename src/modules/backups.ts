import { mkdir, readFile, writeFile, cp, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db, ReleaseRow, FileRecord } from '../db/index.js';
import type { Config } from '../config.js';
import { fail } from '../errors.js';

export async function fileDigest(file:string) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
interface BackupManifest { version:1; createdAt:string; databaseSha256:string; releaseCount:number }
export async function verifyBackup(directory:string) {
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8')) as BackupManifest;
  if(manifest.version!==1)fail(400,'BACKUP_INVALID','不支持的备份格式');
  const dbFile=path.join(directory,'game-hub.sqlite');
  if(await fileDigest(dbFile)!==manifest.databaseSha256)fail(400,'BACKUP_INVALID','数据库备份摘要不匹配');
  const db=new Database(dbFile,{readonly:true,fileMustExist:true});
  try {
    if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)fail(400,'BACKUP_INVALID','数据库完整性校验失败');
    const releases=db.prepare('SELECT * FROM game_releases').all() as ReleaseRow[];
    if(releases.length!==manifest.releaseCount)fail(400,'BACKUP_INVALID','游戏版本数量不匹配');
    for(const release of releases){
      if(!/^[a-f0-9-]+\/[a-f0-9-]+$/.test(release.storage_key))fail(400,'BACKUP_INVALID','无效版本目录');
      const base=path.join(directory,'releases',release.storage_key);
      if(await fileDigest(path.join(base,'source.zip'))!==release.archive_sha256)fail(400,'BACKUP_INVALID','游戏包摘要不匹配');
      for(const file of JSON.parse(release.files_json) as FileRecord[]){
        if(file.path.split('/').some(part=>part==='..'||part==='.'||part==='')||path.isAbsolute(file.path)||file.path.includes('\\'))fail(400,'BACKUP_INVALID','文件路径不合法');
        const actual=path.join(base,'files',file.path);
        if((await stat(actual)).size!==file.size||await fileDigest(actual)!==file.sha256)fail(400,'BACKUP_INVALID','游戏文件摘要不匹配');
      }
    }
    return manifest;
  }finally{db.close();}
}
export async function backup(db:Db,config:Config,destination?:string) {
  const base=path.join(config.dataDir,'backups');
  await mkdir(base,{recursive:true,mode:0o700});
  const directory=destination??path.join(base,new Date(config.now()).toISOString().replace(/[:.]/g,'-'));
  await mkdir(directory,{mode:0o700});
  let success=false;
  try {
    const file=path.join(directory,'game-hub.sqlite');
    await db.backup(file);
    const snapshot=new Database(file,{readonly:true});
    let releases:ReleaseRow[];
    try{releases=snapshot.prepare('SELECT * FROM game_releases').all() as ReleaseRow[];}finally{snapshot.close();}
    for(const release of releases){
      const dest=path.join(directory,'releases',release.storage_key);
      await mkdir(path.dirname(dest),{recursive:true,mode:0o700});
      await cp(path.join(config.dataDir,'releases',release.storage_key),dest,{recursive:true,errorOnExist:true,force:false});
    }
    const manifest:BackupManifest={version:1,createdAt:new Date(config.now()).toISOString(),databaseSha256:await fileDigest(file),releaseCount:releases.length};
    await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
    await verifyBackup(directory);success=true;
    if(!destination){
      const cutoff=config.now()-7*86400000;
      for(const name of await readdir(base)){
        if(!/^\d{4}-\d{2}-\d{2}T/.test(name))continue;
        const dir=path.join(base,name);
        try{const m=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8')) as BackupManifest;
          if(Date.parse(m.createdAt)<cutoff)await rm(dir,{recursive:true});}catch{/* Only prune complete recognized backups. */}
      }
    }
    return directory;
  }finally{if(!success)await rm(directory,{recursive:true,force:true});}
}
export async function restore(directory:string,target:string) {
  await verifyBackup(directory);
  await mkdir(target,{recursive:true,mode:0o750});
  if((await readdir(target)).length)fail(409,'RESTORE_TARGET_NOT_EMPTY','恢复目标必须为空目录');
  await cp(path.join(directory,'game-hub.sqlite'),path.join(target,'game-hub.sqlite'),{errorOnExist:true,force:false});
  try{await cp(path.join(directory,'releases'),path.join(target,'releases'),{recursive:true,errorOnExist:true,force:false});}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
}
