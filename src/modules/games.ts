import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Static } from '@sinclair/typebox';
import type { Db, GameRow, ReleaseRow, Manifest } from '../db/index.js';
import type { Config } from '../config.js';
import { GameCreate,GamePatch } from '../schemas.js';
import { fail } from '../errors.js';

export class GameService {
  constructor(public db:Db, public config:Config) {}
  get(slug:string,publicOnly=false):GameRow {
    const g=this.db.prepare('SELECT * FROM games WHERE slug=?').get(slug) as GameRow|undefined;
    if(!g||(publicOnly&&!g.published))fail(404,'GAME_NOT_FOUND','游戏不存在或未发布');
    return g;
  }
  release(id:string):ReleaseRow {
    const r=this.db.prepare('SELECT * FROM game_releases WHERE id=?').get(id) as ReleaseRow|undefined;
    if(!r)fail(404,'RELEASE_NOT_FOUND','版本不存在');
    return r;
  }
  configFor(g:GameRow):Manifest {
    return g.current_release_id?JSON.parse(this.release(g.current_release_id).manifest_json):
      {manifestVersion:1,saveSlots:this.config.saveMaxSlots,saveSchemaVersion:1};
  }
  present(g:GameRow) {
    const manifest=this.configFor(g);
    const base=g.current_release_id?'/play/'+g.slug+'/'+g.current_release_id+'/':null;
    return {id:g.id,slug:g.slug,title:g.title,description:g.description,tags:JSON.parse(g.tags_json) as string[],
      sortOrder:g.sort_order,published:!!g.published,currentReleaseId:g.current_release_id,
      coverUrl:base&&manifest.cover?base+manifest.cover.split('/').map(encodeURIComponent).join('/'):null,
      launchUrl:base?base+'index.html':null,
      saveCapabilities:{maxSlots:Math.min(manifest.saveSlots,this.config.saveMaxSlots),maxBytes:this.config.saveMaxBytes,schemaVersion:manifest.saveSchemaVersion},
      createdAt:new Date(g.created_at).toISOString(),updatedAt:new Date(g.updated_at).toISOString()};
  }
  presentRelease(r:ReleaseRow) {
    return {id:r.id,gameId:r.game_id,sha256:r.archive_sha256,archiveBytes:r.archive_bytes,manifest:JSON.parse(r.manifest_json),
      fileCount:(JSON.parse(r.files_json) as unknown[]).length,createdAt:new Date(r.created_at).toISOString(),
      publishedAt:r.published_at===null?null:new Date(r.published_at).toISOString()};
  }
  list(query:{page?:number;pageSize?:number;q?:string;tag?:string},admin=false) {
    const page=query.page??1,pageSize=query.pageSize??20;
    const where=['1=1'];const args:(string|number)[]=[];
    if(!admin)where.push('g.published=1');
    if(query.q){where.push("(g.title LIKE ? ESCAPE '\\' OR g.description LIKE ? ESCAPE '\\')");const q='%'+query.q.replace(/[\\%_]/g,'\\$&')+'%';args.push(q,q);}
    if(query.tag){where.push('EXISTS (SELECT 1 FROM json_each(g.tags_json) WHERE value=?)');args.push(query.tag);}
    const sql=where.join(' AND ');
    const total=(this.db.prepare('SELECT COUNT(*) AS total FROM games g WHERE '+sql).get(...args) as {total:number}).total;
    const rows=this.db.prepare('SELECT g.* FROM games g WHERE '+sql+' ORDER BY sort_order,slug LIMIT ? OFFSET ?').all(...args,pageSize,(page-1)*pageSize) as GameRow[];
    return {items:rows.map(g=>this.present(g)),page,pageSize,total};
  }
  create(input:Static<typeof GameCreate>) {
    const now=this.config.now();
    try {this.db.prepare('INSERT INTO games(id,slug,title,description,tags_json,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(),input.slug,input.title,input.description??'',JSON.stringify(input.tags??[]),input.sortOrder??0,now,now);}
    catch(e){if((e as {code?:string}).code==='SQLITE_CONSTRAINT_UNIQUE')fail(409,'SLUG_TAKEN','游戏标识已存在');throw e;}
    return this.present(this.get(input.slug));
  }
  update(slug:string,input:Static<typeof GamePatch>) {
    const g=this.get(slug);
    this.db.prepare('UPDATE games SET title=?,description=?,tags_json=?,sort_order=?,updated_at=? WHERE id=?')
      .run(input.title??g.title,input.description??g.description,input.tags?JSON.stringify(input.tags):g.tags_json,input.sortOrder??g.sort_order,this.config.now(),g.id);
    return this.present(this.get(slug));
  }
  publish(slug:string,releaseId:string) {
    const g=this.get(slug),r=this.release(releaseId);
    if(r.game_id!==g.id)fail(404,'RELEASE_NOT_FOUND','版本不存在');
    if(!existsSync(path.join(this.config.dataDir,'releases',r.storage_key,'files','index.html')))fail(409,'RELEASE_FILES_MISSING','版本文件缺失');
    this.db.transaction(()=>{
      this.db.prepare('UPDATE game_releases SET published_at=COALESCE(published_at,?) WHERE id=?').run(this.config.now(),r.id);
      this.db.prepare('UPDATE games SET published=1,current_release_id=?,updated_at=? WHERE id=?').run(r.id,this.config.now(),g.id);
    }).immediate();
    return this.present(this.get(slug));
  }
  unpublish(slug:string) {
    const g=this.get(slug);
    this.db.prepare('UPDATE games SET published=0,updated_at=? WHERE id=?').run(this.config.now(),g.id);
    return this.present(this.get(slug));
  }
  forSaves(slug:string) {
    const g=this.get(slug);
    if(!this.db.prepare('SELECT 1 FROM game_releases WHERE game_id=? AND published_at IS NOT NULL LIMIT 1').get(g.id))fail(404,'GAME_NOT_FOUND','游戏尚未发布');
    return g;
  }
}
