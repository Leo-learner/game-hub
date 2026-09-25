import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import type { HTTPMethods } from 'fastify';
import { createConfig } from '../src/config.js';
import { openDb,migrate } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { backup,restore,verifyBackup } from '../src/modules/backups.js';

const password='test-password-29!';
async function fixture(overrides:Parameters<typeof createConfig>[0]={}) {
  await mkdir('.work/tests',{recursive:true});
  const dir=await mkdtemp(path.resolve('.work/tests/case-'));let now=Date.now();
  const config=createConfig({dataDir:dir,logger:false,now:()=>now,...overrides},{});
  const db=openDb(dir);migrate(db);migrate(db);db.close();
  let app=await buildApp(config);
  const call=(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,body?:unknown,cookie?:string,headers:Record<string,string>={})=>app.inject({
    method,url,headers:{'x-gamehub-request':'1',...(cookie?{cookie}:{}),...headers},...(body===undefined?{}:{payload:body as object}),
  });
  async function user(username='player_a') {
    const result=await call('POST','/api/v1/auth/register',{username,password});
    assert.equal(result.statusCode,201,result.body);
    return {cookie:cookieOf(result.headers['set-cookie']),user:result.json().user};
  }
  async function admin() {
    await app.services.auth.create('owner',password,'Owner','admin');
    const result=await call('POST','/api/v1/auth/login',{username:'owner',password});
    assert.equal(result.statusCode,200,result.body);return cookieOf(result.headers['set-cookie']);
  }
  async function game(slug='clicker',manifest?:Record<string,unknown>) {
    app.services.games.create({slug,title:'示例 '+slug});
    const files:Record<string,string>={'index.html':'<!doctype html><title>Game</title><p>Hello</p>'};
    if(manifest)files['game.json']=JSON.stringify(manifest);
    const release=await app.services.releases.importZip(slug,Readable.from(await zip(files)));
    const result=app.services.games.publish(slug,release.id);return {release,game:result};
  }
  return {get app(){return app;},config,dir,call,user,admin,game,
    advance(ms:number){now+=ms;},
    async restart(){await app.close();app=await buildApp(config);},
    async close(){await app.close();await rm(dir,{recursive:true,force:true});}};
}
function cookieOf(value:string|string[]|undefined){assert.ok(value);return (Array.isArray(value)?value.at(-1)!:value).split(';')[0];}
async function zip(files:Record<string,string>,special?:(z:yazl.ZipFile)=>void) {
  const z=new yazl.ZipFile();for(const [name,data]of Object.entries(files))z.addBuffer(Buffer.from(data),name,{compress:false});
  special?.(z);z.end();const chunks:Buffer[]=[];for await(const chunk of z.outputStream as Readable)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);
}
function multipartBody(bytes:Buffer,extra=false){
  const boundary='game-hub-test-boundary';
  const pieces=[Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="game.zip"\r\nContent-Type: application/zip\r\n\r\n'),bytes,Buffer.from('\r\n')];
  if(extra)pieces.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="second.zip"\r\nContent-Type: application/zip\r\n\r\n'),bytes,Buffer.from('\r\n'));
  pieces.push(Buffer.from('--'+boundary+'--\r\n'));
  return {body:Buffer.concat(pieces),type:'multipart/form-data; boundary='+boundary};
}
const save=(expectedRevision=0,data:Record<string,unknown>={score:7})=>({data,schemaVersion:1,expectedRevision});

test('authentication, strict schemas, profile, role boundary and session revocation',async()=>{
  const f=await fixture();try{
    assert.deepEqual((await f.call('GET','/api/v1/auth/me')).json(),{user:null});
    const a=await f.user();
    assert.equal(a.user.role,'player');
    assert.equal((await f.call('POST','/api/v1/auth/register',{username:'PLAYER_A',password})).statusCode,409);
    assert.equal((await f.call('POST','/api/v1/auth/register',{username:'attacker',password,role:'admin'})).statusCode,400);
    assert.equal((await f.call('POST','/api/v1/auth/login',{username:'player_a',password:'wrong'})).statusCode,401);
    assert.equal((await f.call('GET','/api/v1/admin/games',undefined,a.cookie)).statusCode,403);
    const profile=await f.call('PATCH','/api/v1/auth/me',{displayName:'中文昵称'},a.cookie);
    assert.equal(profile.json().user.displayName,'中文昵称');assert.ok(!('passwordHash' in profile.json().user));
    const second=await f.call('POST','/api/v1/auth/login',{username:'PLAYER_A',password});const cookie2=cookieOf(second.headers['set-cookie']);
    const changed=await f.call('PUT','/api/v1/auth/password',{oldPassword:password,newPassword:'new-password-456'},a.cookie);
    assert.equal(changed.statusCode,200,changed.body);
    assert.equal((await f.call('GET','/api/v1/auth/me',undefined,cookie2)).json().user,null);
    assert.equal((await f.call('GET','/api/v1/auth/me',undefined,a.cookie)).json().user,null);
    const fresh=cookieOf(changed.headers['set-cookie']);
    assert.equal((await f.call('GET','/api/v1/auth/me',undefined,fresh)).json().user.id,a.user.id);
    await f.call('POST','/api/v1/auth/logout-all',undefined,fresh);
    assert.equal((await f.call('GET','/api/v1/auth/me',undefined,fresh)).json().user,null);
  }finally{await f.close();}
});

test('Cookie attributes, sliding renewal, expiration and CLI-style password reset',async()=>{
  const f=await fixture({cookieSecure:true,publicOrigin:'https://games.example.com'});try{
    const reg=await f.call('POST','/api/v1/auth/register',{username:'player_a',password});
    const raw=String(reg.headers['set-cookie']);assert.match(raw,/__Host-gamehub_sid=/);assert.match(raw,/HttpOnly/);assert.match(raw,/Secure/);assert.match(raw,/SameSite=Lax/);assert.doesNotMatch(raw,/Domain=/);
    const cookie=cookieOf(reg.headers['set-cookie']);
    f.advance(25*3600000);
    assert.ok((await f.call('GET','/api/v1/auth/me',undefined,cookie)).headers['set-cookie']);
    assert.equal((await f.call('GET','/api/v1/auth/me',undefined,cookie)).headers['set-cookie'],undefined);
    await f.app.services.auth.resetPassword('player_a','reset-password-456');
    assert.equal((await f.call('GET','/api/v1/auth/me',undefined,cookie)).json().user,null);
    const login=await f.call('POST','/api/v1/auth/login',{username:'player_a',password:'reset-password-456'});
    f.advance(31*86400000);
    assert.equal((await f.call('GET','/api/v1/auth/me',undefined,cookieOf(login.headers['set-cookie']))).json().user,null);
  }finally{await f.close();}
});

test('write-request header, origin allowlist and multipart are protected',async()=>{
  const f=await fixture();try{
    const bare=await f.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:'bad',password}});
    assert.equal(bare.statusCode,403);
    for(const origin of ['https://evil.example','null','http://localhost:3220.attacker.com']){
      assert.equal((await f.call('POST','/api/v1/auth/register',{username:'bad',password},undefined,{origin})).statusCode,403);
    }
    const cookie=await f.admin();f.app.services.games.create({slug:'upload',title:'Upload'});
    const m=multipartBody(await zip({'index.html':'test'}));
    const upload=await f.app.inject({method:'POST',url:'/api/v1/admin/games/upload/releases',headers:{cookie,'content-type':m.type},payload:m.body});
    assert.equal(upload.statusCode,403);
    assert.equal((await f.call('POST','/api/v1/auth/logout',undefined,cookie,{origin:'http://localhost:3220'})).statusCode,200);
  }finally{await f.close();}
});

test('per-IP login limits cannot be bypassed with untrusted forwarded headers',async()=>{
  const f=await fixture({trustProxy:true});try{
    let status=0;
    for(let i=0;i<12;i++){
      const response=await f.app.inject({method:'POST',url:'/api/v1/auth/login',remoteAddress:'203.0.113.50',
        headers:{'x-gamehub-request':'1','x-forwarded-for':'198.51.100.'+i},payload:{username:'unknown',password}});
      status=response.statusCode;
    }
    assert.equal(status,429);
  }finally{await f.close();}
});

test('cloud saves require login, isolate accounts and games, retain arbitrary nested JSON',async()=>{
  const f=await fixture();try{
    await f.game();await f.game('other');const a=await f.user(),b=await f.user('player_b');
    const url='/api/v1/games/clicker/saves/auto';
    assert.equal((await f.call('PUT',url,save())).statusCode,401);
    const data={score:10,inventory:[{item:'中文',count:3}],nested:{flags:[true,null,2.5]}};
    const result=await f.call('PUT',url,save(0,data),a.cookie);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().revision,1);
    assert.deepEqual((await f.call('GET',url,undefined,a.cookie)).json().data,data);
    assert.equal((await f.call('GET',url,undefined,b.cookie)).statusCode,404);
    assert.equal((await f.call('GET','/api/v1/games/other/saves/auto',undefined,a.cookie)).statusCode,404);
    const list=(await f.call('GET','/api/v1/games/clicker/saves',undefined,a.cookie)).json();
    assert.equal(list.items.length,1);assert.ok(!('data' in list.items[0]));
    const summary=(await f.call('GET','/api/v1/me/saves',undefined,a.cookie)).json();assert.equal(summary.items[0].slug,'clicker');
    const guarded=await f.call('PUT',url,save(1),b.cookie,{'x-gamehub-user':a.user.id});assert.equal(guarded.statusCode,409);
    assert.equal((await f.call('GET','/api/v1/auth/me',undefined,a.cookie)).headers['cache-control'],'no-store');
  }finally{await f.close();}
});

test('atomic competing writes, required revision, tombstones and idempotent retries',async()=>{
  const f=await fixture();try{
    await f.game();const a=await f.user();const url='/api/v1/games/clicker/saves/auto';
    assert.equal((await f.call('PUT',url,{data:{},schemaVersion:1},a.cookie)).statusCode,400);
    const headers={'idempotency-key':'request-key-1'};
    const first=await f.call('PUT',url,save(),a.cookie,headers);
    const again=await f.call('PUT',url,save(),a.cookie,headers);
    assert.deepEqual(first.json(),again.json());assert.equal(again.statusCode,200);
    assert.equal((await f.call('PUT',url,save(0,{score:9}),a.cookie,headers)).json().error.code,'IDEMPOTENCY_CONFLICT');
    const results=await Promise.all([f.call('PUT',url,save(1,{score:20}),a.cookie),f.call('PUT',url,save(1,{score:30}),a.cookie)]);
    assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
    assert.equal((await f.call('DELETE',url+'?expectedRevision=1',undefined,a.cookie)).statusCode,409);
    assert.equal((await f.call('DELETE',url+'?expectedRevision=2',undefined,a.cookie)).statusCode,200);
    const recreated=await f.call('PUT',url,save(),a.cookie);assert.equal(recreated.json().revision,4,recreated.body);
    assert.equal((await f.call('PUT',url,save(2),a.cookie)).statusCode,409);
    await f.restart();
    assert.equal((await f.call('GET',url,undefined,a.cookie)).json().revision,4);
    assert.equal((await f.call('PUT',url,save(),a.cookie,headers)).json().revision,1);
  }finally{await f.close();}
});

test('UTF-8 byte limits and per-game slot limits, including lower limits after publication',async()=>{
  const f=await fixture({saveMaxBytes:100,saveMaxSlots:2});try{
    await f.game();const a=await f.user();const base='/api/v1/games/clicker/saves/';
    assert.equal((await f.call('PUT',base+'huge',save(0,{text:'中'.repeat(40)}),a.cookie)).statusCode,413);
    assert.equal((await f.call('PUT',base+'a',save(),a.cookie)).statusCode,200);
    assert.equal((await f.call('PUT',base+'b',save(),a.cookie)).statusCode,200);
    assert.equal((await f.call('PUT',base+'c',save(),a.cookie)).json().error.code,'SAVE_SLOT_LIMIT');
    const r=await f.app.services.releases.importZip('clicker',Readable.from(await zip({'index.html':'v2','game.json':JSON.stringify({manifestVersion:1,saveSlots:1})})));
    f.app.services.games.publish('clicker',r.id);
    assert.equal((await f.call('PUT',base+'b',save(1),a.cookie)).statusCode,200);
    assert.equal((await f.call('GET',base.slice(0,-1),undefined,a.cookie)).json().items.length,2);
  }finally{await f.close();}
});

test('multipart upload, release boundaries, rollback and unpublish preserve saves',async()=>{
  const f=await fixture();try{
    const admin=await f.admin();const player=await f.user();
    assert.equal((await f.call('POST','/api/v1/admin/games',{slug:'live',title:'Game'},admin)).statusCode,201);
    const upload=async(bytes:Buffer,extra=false)=>{
      const m=multipartBody(bytes,extra);
      return f.app.inject({method:'POST',url:'/api/v1/admin/games/live/releases',headers:{cookie:admin,'x-gamehub-request':'1','content-type':m.type},payload:m.body});
    };
    const response=await upload(await zip({'index.html':'<p>version one</p>','game.json':JSON.stringify({manifestVersion:1})}));
    assert.equal(response.statusCode,201,response.body);const release=response.json();
    assert.equal((await f.call('GET','/play/live/'+release.id+'/index.html')).statusCode,404);
    const publish=await f.call('POST','/api/v1/admin/games/live/publish',{releaseId:release.id},admin);
    assert.equal(publish.statusCode,200,publish.body);const url=publish.json().launchUrl;
    assert.match((await f.call('GET',url)).body,/version one/);
    const saveUrl='/api/v1/games/live/saves/auto';await f.call('PUT',saveUrl,save(),player.cookie);
    const second=await upload(await zip({'index.html':'<p>version two</p>'}));
    await f.call('POST','/api/v1/admin/games/live/publish',{releaseId:second.json().id},admin);
    assert.match((await f.call('GET',url)).body,/version one/);
    await f.call('POST','/api/v1/admin/games/live/publish',{releaseId:release.id},admin);
    const bad=await upload(await zip({'index.html':'x'}),true);assert.equal(bad.statusCode,413,bad.body);
    assert.equal((await f.call('GET','/api/v1/admin/games/live/releases',undefined,admin)).json().items.length,2);
    await f.call('POST','/api/v1/admin/games/live/unpublish',undefined,admin);
    assert.equal((await f.call('GET',url)).statusCode,404);
    assert.equal((await f.call('GET','/api/v1/games')).json().items.length,0);
    assert.equal((await f.call('GET',saveUrl,undefined,player.cookie)).statusCode,200);
    assert.equal((await f.call('PUT',saveUrl,save(1),player.cookie)).statusCode,200);
    assert.equal((await f.call('GET','/_gamehub_internal/anything')).statusCode,404);
  }finally{await f.close();}
});

test('malformed, traversal, symlink, duplicate, corrupted and oversized ZIP rejection',async()=>{
  const f=await fixture({extractMaxBytes:2048,uploadMaxFiles:4});try{
    f.app.services.games.create({slug:'badzip',title:'Bad zip'});
    const reject=async(buffer:Buffer,code?:string)=>assert.rejects(f.app.services.releases.importZip('badzip',Readable.from(buffer)),(e:unknown)=>!code||(e as {code:string}).code===code);
    await reject(Buffer.from('not a zip'),'INVALID_ZIP');
    await reject(await zip({'wrong.html':'x'}),'ENTRY_MISSING');
    await reject(await zip({'index.html':'x','game.json':'{"published":true}'}),'INVALID_MANIFEST');
    const traversal=await zip({'aa/evil.txt':'evil','index.html':'x'});
    await reject(Buffer.from(traversal.toString('binary').replaceAll('aa/evil.txt','../evil.txt'),'binary'));
    await reject(await zip({'index.html':'x'},z=>z.addBuffer(Buffer.from('target'),'link',{mode:0o120777})),'INVALID_ARCHIVE_PATH');
    await reject(await zip({'index.html':'x'},z=>z.addBuffer(Buffer.from('again'),'index.html')),'INVALID_ARCHIVE_PATH');
    await reject(await zip({'index.html':'x'.repeat(2049)}),'ARCHIVE_LIMIT');
    const corrupt=await zip({'index.html':'unique-data-to-corrupt'});
    const position=corrupt.indexOf(Buffer.from('unique-data-to-corrupt'));assert.ok(position>0);corrupt[position]=0x58;
    await reject(corrupt,'INVALID_ZIP');
    assert.equal((f.app.db.prepare('SELECT COUNT(*) AS n FROM game_releases').get() as {n:number}).n,0);
  }finally{await f.close();}
});

test('OpenAPI documents generated interfaces and private responses without SPA fallback',async()=>{
  const f=await fixture({spaFallback:true});try{
    const spec=(await f.call('GET','/openapi.json')).json();
    assert.equal(spec.openapi,'3.0.3');
    assert.ok(spec.paths['/api/v1/admin/games/{slug}/releases'].post.requestBody.content['multipart/form-data']);
    assert.ok(spec.components.schemas.SaveWrite.required.includes('expectedRevision'));
    assert.ok(spec.paths['/api/v1/auth/me'].get.operationId);
    assert.equal((await f.call('GET','/api/v1/missing',undefined,undefined,{accept:'text/html'})).statusCode,404);
    assert.equal((await f.call('GET','/sdk/missing.js',undefined,undefined,{accept:'text/html'})).statusCode,404);
    assert.equal((await f.call('GET','/readyz')).json().status,'ready');
  }finally{await f.close();}
});

test('backup integrity verification and restoration retain accounts, versions and saves',async()=>{
  const f=await fixture();let restored:ReturnType<typeof openDb>|undefined;
  try{
    await f.game();const a=await f.user();await f.call('PUT','/api/v1/games/clicker/saves/auto',save(0,{score:99}),a.cookie);
    const directory=await backup(f.app.db,f.config);
    assert.equal((await verifyBackup(directory)).releaseCount,1);
    const target=path.join(f.dir,'restored');await restore(directory,target);restored=openDb(target);
    assert.equal((restored.prepare('SELECT username FROM users WHERE id=?').get(a.user.id) as {username:string}).username,'player_a');
    assert.deepEqual(JSON.parse((restored.prepare('SELECT data_json FROM saves').get() as {data_json:string}).data_json),{score:99});
    await assert.rejects(restore(directory,target));
    const snapshot=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));snapshot.databaseSha256='bad';
    await writeFile(path.join(directory,'manifest.json'),JSON.stringify(snapshot));
    await assert.rejects(verifyBackup(directory));
  }finally{restored?.close();await f.close();}
});
