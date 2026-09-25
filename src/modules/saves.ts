import type { Static } from '@sinclair/typebox';
import type { Db, SaveRow } from '../db/index.js';
import type { Config } from '../config.js';
import { GameService } from './games.js';
import { digest } from './auth.js';
import { fail } from '../errors.js';
import { SaveWrite } from '../schemas.js';

export function meta(row:SaveRow) {
  return {slot:row.slot,schemaVersion:row.schema_version,revision:row.revision,updatedAt:new Date(row.updated_at).toISOString(),sizeBytes:row.size_bytes};
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
export class SaveService {
  constructor(private db:Db,private config:Config,private games:GameService) {}
  list(userId:string,slug:string) {
    const g=this.games.forSaves(slug);
    return {items:(this.db.prepare('SELECT * FROM saves WHERE user_id=? AND game_id=? AND deleted_at IS NULL ORDER BY slot').all(userId,g.id) as SaveRow[]).map(meta)};
  }
  summaries(userId:string,page=1,pageSize=20) {
    const total=(this.db.prepare('SELECT COUNT(*) AS total FROM saves WHERE user_id=? AND deleted_at IS NULL').get(userId) as {total:number}).total;
    const rows=this.db.prepare('SELECT s.*,g.slug,g.title FROM saves s JOIN games g ON g.id=s.game_id WHERE user_id=? AND deleted_at IS NULL ORDER BY s.updated_at DESC,g.slug,s.slot LIMIT ? OFFSET ?').all(userId,pageSize,(page-1)*pageSize) as (SaveRow&{slug:string;title:string})[];
    return {items:rows.map(r=>({...meta(r),gameId:r.game_id,slug:r.slug,gameTitle:r.title})),page,pageSize,total};
  }
  read(userId:string,slug:string,slot:string) {
    const g=this.games.forSaves(slug);
    const row=this.db.prepare('SELECT * FROM saves WHERE user_id=? AND game_id=? AND slot=? AND deleted_at IS NULL').get(userId,g.id,slot) as SaveRow|undefined;
    if(!row)fail(404,'SAVE_NOT_FOUND','存档不存在');
    return {...meta(row),data:JSON.parse(row.data_json!) as Record<string,unknown>};
  }
  write(userId:string,slug:string,slot:string,input:Static<typeof SaveWrite>,key?:string) {
    const data=JSON.stringify(input.data),bytes=Buffer.byteLength(data);
    if(bytes>this.config.saveMaxBytes)fail(413,'SAVE_TOO_LARGE','存档超过大小限制',{maxBytes:this.config.saveMaxBytes});
    const g=this.games.forSaves(slug),scope='PUT:'+g.id+':'+slot;
    const fingerprint=digest(canonical(input));
    return this.db.transaction(()=>{
      const now=this.config.now();
      if(key) {
        const record=this.db.prepare('SELECT * FROM idempotency_keys WHERE user_id=? AND scope=? AND key=? AND expires_at>?').get(userId,scope,key,now) as {fingerprint:string;response_json:string}|undefined;
        if(record){
          if(record.fingerprint!==fingerprint)fail(409,'IDEMPOTENCY_CONFLICT','同一幂等键不能用于不同内容');
          return JSON.parse(record.response_json) as ReturnType<typeof meta>;
        }
      }
      const old=this.db.prepare('SELECT * FROM saves WHERE user_id=? AND game_id=? AND slot=?').get(userId,g.id,slot) as SaveRow|undefined;
      const active=old&&old.deleted_at===null;
      if((active&&input.expectedRevision!==old.revision)||(!active&&input.expectedRevision!==0))
        fail(409,'SAVE_CONFLICT','存档已变化，请重新读取',{currentRevision:active?old.revision:0});
      if(!active){
        const count=(this.db.prepare('SELECT COUNT(*) AS n FROM saves WHERE user_id=? AND game_id=? AND deleted_at IS NULL').get(userId,g.id) as {n:number}).n;
        const limit=Math.min(this.games.configFor(g).saveSlots,this.config.saveMaxSlots);
        if(count>=limit)fail(409,'SAVE_SLOT_LIMIT','存档槽位已达上限',{maxSlots:limit});
      }
      const revision=(old?.revision??0)+1;
      const row:SaveRow={user_id:userId,game_id:g.id,slot,data_json:data,schema_version:input.schemaVersion,size_bytes:bytes,revision,updated_at:now,deleted_at:null};
      this.db.prepare('INSERT INTO saves VALUES (@user_id,@game_id,@slot,@data_json,@schema_version,@size_bytes,@revision,@updated_at,@deleted_at) ON CONFLICT(user_id,game_id,slot) DO UPDATE SET data_json=excluded.data_json,schema_version=excluded.schema_version,size_bytes=excluded.size_bytes,revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=NULL').run(row);
      const response=meta(row);
      if(key)this.db.prepare('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,scope,key) DO UPDATE SET fingerprint=excluded.fingerprint,response_json=excluded.response_json,expires_at=excluded.expires_at').run(userId,scope,key,fingerprint,JSON.stringify(response),now+86400000);
      return response;
    }).immediate();
  }
  remove(userId:string,slug:string,slot:string,revision:number) {
    const g=this.games.forSaves(slug);
    this.db.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM saves WHERE user_id=? AND game_id=? AND slot=? AND deleted_at IS NULL').get(userId,g.id,slot) as SaveRow|undefined;
      if(!row)fail(404,'SAVE_NOT_FOUND','存档不存在');
      if(row.revision!==revision)fail(409,'SAVE_CONFLICT','存档已变化，请重新读取',{currentRevision:row.revision});
      this.db.prepare('UPDATE saves SET data_json=NULL,size_bytes=0,revision=revision+1,deleted_at=?,updated_at=? WHERE user_id=? AND game_id=? AND slot=?').run(this.config.now(),this.config.now(),userId,g.id,slot);
    }).immediate();
    return {ok:true as const};
  }
}
