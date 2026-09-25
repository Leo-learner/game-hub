import { randomUUID, createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, rename, readFile, writeFile, open, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import yazl from 'yazl';
import type { Db, Manifest, FileRecord, ReleaseRow } from '../db/index.js';
import type { Config } from '../config.js';
import { GameService } from './games.js';
import { AppError, fail } from '../errors.js';

export function safeRelative(name:string):string {
  if(!name || name.length>500 || /[\\:%?#\x00-\x1f\x7f]/.test(name) || name.startsWith('/') ||
    name.split('/').some(s=>!s||s==='.'||s==='..'||s.startsWith('.')||['node_modules','.git'].includes(s))) {
    fail(400,'INVALID_ARCHIVE_PATH','游戏包包含不允许的文件路径');
  }
  return name;
}
const zipOpen=(file:string)=>new Promise<ZipFile>((resolve,reject)=>yauzl.open(file,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(e,z)=>e?reject(e):resolve(z!)));
const zipStream=(zip:ZipFile,entry:Entry)=>new Promise<Readable>((resolve,reject)=>zip.openReadStream(entry,(e,s)=>e?reject(e):resolve(s!)));
export class ReleaseService {
  constructor(private db:Db,private config:Config,private games:GameService) {}
  async lock() {
    const tmp=path.join(this.config.dataDir,'tmp');
    await mkdir(tmp,{recursive:true,mode:0o700});
    const file=path.join(tmp,'import.lock');
    for(let attempt=0;attempt<2;attempt++){
      try {const handle=await open(file,'wx',0o600);await handle.writeFile(String(process.pid));await handle.close();return async()=>{await rm(file,{force:true});};}
      catch(e){
        if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
        try {const pid=Number(await readFile(file,'utf8'));if(!Number.isInteger(pid)||pid<=0)fail(409,'UPLOAD_BUSY','上传锁需要运维检查');process.kill(pid,0);}
        catch(inner){if((inner as NodeJS.ErrnoException).code==='ESRCH'){await rm(file,{force:true});continue;}if(inner instanceof AppError)throw inner;}
        fail(409,'UPLOAD_BUSY','已有游戏包正在处理，请稍后重试');
      }
    }
    fail(409,'UPLOAD_BUSY','已有游戏包正在处理');
  }
  async importZip(slug:string,input:Readable) {
    const game=this.games.get(slug),unlock=await this.lock();
    const id=randomUUID(),staging=path.join(this.config.dataDir,'tmp',id),storageKey=game.id+'/'+id;
    const dest=path.join(this.config.dataDir,'releases',storageKey);
    let moved=false,committed=false;
    try {
      await mkdir(path.join(staging,'files'),{recursive:true,mode:0o750});
      let bytes=0;const hash=createHash('sha256');
      await pipeline(input,new Transform({transform:(chunk:Buffer,_e,cb)=>{
        bytes+=chunk.length;if(bytes>this.config.uploadMaxBytes){cb(new AppError(413,'UPLOAD_TOO_LARGE','ZIP 超过大小限制'));return;}
        hash.update(chunk);cb(null,chunk);
      }}),createWriteStream(path.join(staging,'source.zip'),{flags:'wx',mode:0o640}));
      const files=await this.extract(path.join(staging,'source.zip'),path.join(staging,'files'));
      if(!files.some(f=>f.path==='index.html'))fail(400,'ENTRY_MISSING','ZIP 根目录必须包含 index.html');
      let raw:Record<string,unknown>={};
      if(files.some(f=>f.path==='game.json')){
        const manifestFile=files.find(f=>f.path==='game.json')!;
        if(manifestFile.size>16384)fail(400,'INVALID_MANIFEST','game.json 不能超过 16 KiB');
        try {raw=JSON.parse(await readFile(path.join(staging,'files','game.json'),'utf8'));} catch {fail(400,'INVALID_MANIFEST','game.json 不是合法 JSON');}
        if(!raw||typeof raw!=='object'||Array.isArray(raw))fail(400,'INVALID_MANIFEST','game.json 必须是对象');
      }
      const allowed=['manifestVersion','cover','saveSchemaVersion','saveSlots'];
      if(Object.keys(raw).some(k=>!allowed.includes(k)))fail(400,'INVALID_MANIFEST','game.json 包含不支持的字段');
      const manifest:Manifest={manifestVersion:1,saveSchemaVersion:1,saveSlots:this.config.saveMaxSlots,...raw} as Manifest;
      if(manifest.manifestVersion!==1||!Number.isSafeInteger(manifest.saveSchemaVersion)||manifest.saveSchemaVersion<1||manifest.saveSchemaVersion>2147483647||
         !Number.isInteger(manifest.saveSlots)||manifest.saveSlots<1||manifest.saveSlots>this.config.saveMaxSlots)
        fail(400,'INVALID_MANIFEST','清单版本或存档能力不合法');
      if(manifest.cover!==undefined){
        if(typeof manifest.cover!=='string')fail(400,'INVALID_MANIFEST','封面路径必须是字符串');
        safeRelative(manifest.cover);
        if(!files.some(f=>f.path===manifest.cover)||!/\.(png|jpg|jpeg|webp|gif|svg|avif)$/i.test(manifest.cover))fail(400,'INVALID_MANIFEST','封面文件不存在或格式不支持');
      }
      await mkdir(path.dirname(dest),{recursive:true,mode:0o750});await rename(staging,dest);moved=true;
      const row:ReleaseRow={id,game_id:game.id,archive_sha256:hash.digest('hex'),archive_bytes:bytes,manifest_json:JSON.stringify(manifest),files_json:JSON.stringify(files),
        storage_key:storageKey,created_at:this.config.now(),published_at:null};
      this.db.prepare('INSERT INTO game_releases VALUES (@id,@game_id,@archive_sha256,@archive_bytes,@manifest_json,@files_json,@storage_key,@created_at,@published_at)').run(row);
      committed=true;return this.games.presentRelease(row);
    } finally {
      if(!committed)await rm(moved?dest:staging,{recursive:true,force:true});
      await unlock();
    }
  }
  async extract(zipPath:string,target:string):Promise<FileRecord[]> {
    let zip:ZipFile;
    try {zip=await zipOpen(zipPath);}catch {fail(400,'INVALID_ZIP','文件不是有效 ZIP');}
    const files:FileRecord[]=[];const seen=new Set<string>();let total=0,count=0;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const stop=(error:unknown)=>{if(settled)return;settled=true;zip.close();reject(error instanceof AppError?error:new AppError(400,'INVALID_ZIP','ZIP 损坏或无法完整解压'));};
      zip.on('error',stop);
      zip.on('end',()=>{if(!settled){settled=true;resolve(files);}});
      zip.on('entry',(entry:Entry)=>{void (async()=>{
        count++;if(count>this.config.uploadMaxFiles)fail(413,'ARCHIVE_LIMIT','ZIP 文件数量超过限制');
        const directory=entry.fileName.endsWith('/');
        const name=entry.fileName.replace(/\/$/,'');
        if(name.startsWith('__MACOSX/')||name==='__MACOSX'||name.split('/').at(-1)==='.DS_Store'){zip.readEntry();return;}
        safeRelative(name);
        const key=name.normalize('NFC').toLowerCase();
        if(seen.has(key))fail(400,'INVALID_ARCHIVE_PATH','ZIP 包含重复文件路径');
        seen.add(key);
        const mode=(entry.externalFileAttributes>>>16)&0xf000;
        if(mode!==0&&mode!==0x8000&&mode!==0x4000)fail(400,'INVALID_ARCHIVE_PATH','ZIP 不允许链接或特殊文件');
        if((mode===0x4000&&!directory)||(mode===0x8000&&directory))fail(400,'INVALID_ARCHIVE_PATH','ZIP 文件类型冲突');
        if(entry.isEncrypted())fail(400,'INVALID_ZIP','不支持加密 ZIP');
        if(entry.uncompressedSize+total>this.config.extractMaxBytes)fail(413,'ARCHIVE_LIMIT','解压后文件超过总大小限制');
        const destination=path.join(target,...name.split('/'));
        if(directory){await mkdir(destination,{recursive:true,mode:0o750});zip.readEntry();return;}
        await mkdir(path.dirname(destination),{recursive:true,mode:0o750});
        let size=0,crc=0;const hash=createHash('sha256');
        await pipeline(await zipStream(zip,entry),new Transform({transform:(chunk:Buffer,_e,cb)=>{
          size+=chunk.length;total+=chunk.length;
          if(total>this.config.extractMaxBytes||size>entry.uncompressedSize){cb(new AppError(413,'ARCHIVE_LIMIT','解压后文件超过大小限制'));return;}
          hash.update(chunk);crc=crc32(chunk,crc);cb(null,chunk);
        }}),createWriteStream(destination,{flags:'wx',mode:0o640}));
        if(size!==entry.uncompressedSize||crc!==(entry.crc32>>>0))fail(400,'INVALID_ZIP','ZIP 文件校验失败');
        files.push({path:name,size,sha256:hash.digest('hex')});
        zip.readEntry();
      })().catch(stop);});
      zip.readEntry();
    });
  }
  async importDirectory(slug:string,directory:string) {
    const zip=new yazl.ZipFile();
    let count=0;
    const visit=async(dir:string,relative='')=>{
      for(const name of (await readdir(dir)).sort()){
        if(name==='.DS_Store')continue;
        const rel=relative?relative+'/'+name:name;safeRelative(rel);
        const file=path.join(dir,name),stat=await lstat(file);
        if(stat.isSymbolicLink())fail(400,'INVALID_ARCHIVE_PATH','目录中不能包含符号链接');
        if(stat.isDirectory())await visit(file,rel);
        else if(stat.isFile()){if(++count>this.config.uploadMaxFiles)fail(413,'ARCHIVE_LIMIT','文件数量超过限制');zip.addFile(file,rel);}
        else fail(400,'INVALID_ARCHIVE_PATH','目录中不能包含特殊文件');
      }
    };
    await visit(path.resolve(directory));zip.end();
    return this.importZip(slug,zip.outputStream as Readable);
  }
}
