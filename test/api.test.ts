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
import { createTestSigner,TEST_PUBLISHABLE_KEY } from '../src/lib/clerk-gate/test-signer.js';

const password='test-password-29!';
// Clerk-shaped session tokens signed with a throwaway key: no network, no real instance.
const signer=createTestSigner();
const OWNER='user_owner';
async function fixture(overrides:Parameters<typeof createConfig>[0]={}) {
  await mkdir('.work/tests',{recursive:true});
  const dir=await mkdtemp(path.resolve('.work/tests/case-'));let now=Date.now();
  const config=createConfig({dataDir:dir,logger:false,now:()=>now,clerk:{publishableKey:TEST_PUBLISHABLE_KEY,jwtKey:signer.jwtKey,ownerUserId:OWNER},...overrides},{});
  const db=openDb(dir);migrate(db);migrate(db);db.close();
  let app=await buildApp(config);
  const call=(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,body?:unknown,cookie?:string,headers:Record<string,string>={})=>app.inject({
    method,url,headers:{'x-gamehub-request':'1',...(cookie?{cookie}:{}),...headers},...(body===undefined?{}:{payload:body as object}),
  });
  /** A __session cookie for Clerk user `sub`, minted for this site unless claims say otherwise. */
  const session=(sub:string,claims:Record<string,unknown>={})=>'__session='+signer.token({sub,azp:config.publicOrigin,email:sub.replace(/^user_/,'')+'@example.com',...claims});
  async function user(username='player_a') {
    const cookie=session('user_'+username);
    const result=await call('POST','/api/v1/auth/link/new',{},cookie);
    assert.equal(result.statusCode,201,result.body);
    return {cookie,user:result.json().user};
  }
  async function admin() {
    const cookie=session(OWNER);
    const result=await call('POST','/api/v1/auth/link/new',{},cookie);
    assert.equal(result.statusCode,201,result.body);assert.equal(result.json().user.role,'admin');return cookie;
  }
  async function game(slug='clicker',manifest?:Record<string,unknown>) {
    app.services.games.create({slug,title:'示例 '+slug});
    const files:Record<string,string>={'index.html':'<!doctype html><title>Game</title><p>Hello</p>'};
    if(manifest)files['game.json']=JSON.stringify(manifest);
    const release=await app.services.releases.importZip(slug,Readable.from(await zip(files)));
    const result=app.services.games.publish(slug,release.id);return {release,game:result};
  }
  return {get app(){return app;},config,dir,call,session,user,admin,game,
    advance(ms:number){now+=ms;},
    async restart(){await app.close();app=await buildApp(config);},
    async close(){await app.close();await rm(dir,{recursive:true,force:true});}};
}
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

test('Clerk sign-in: link-required state, new players, strict schemas, profile and role boundary',async()=>{
  const f=await fixture();try{
    assert.deepEqual((await f.call('GET','/api/v1/auth/me')).json(),{user:null});
    const fresh=f.session('user_newbie',{name:'新玩家'});
    assert.deepEqual((await f.call('GET','/api/v1/auth/me',undefined,fresh)).json(),{user:null,account:{state:'link-required',suggestedName:'新玩家'}});
    assert.equal((await f.call('PUT','/api/v1/games/clicker/saves/auto',save(),fresh)).json().error.code,'AUTH_REQUIRED');
    assert.equal((await f.call('POST','/api/v1/auth/link/new',{role:'admin'},fresh)).statusCode,400);
    const linked=await f.call('POST','/api/v1/auth/link/new',{displayName:'中文昵称'},fresh);
    assert.equal(linked.statusCode,201,linked.body);
    const u=linked.json().user;assert.equal(u.role,'player');assert.equal(u.username,'newbie');assert.equal(u.displayName,'中文昵称');
    assert.equal((await f.call('POST','/api/v1/auth/link/new',{},fresh)).json().error.code,'ALREADY_LINKED');
    assert.equal((await f.call('GET','/api/v1/auth/me',undefined,fresh)).json().user.id,u.id);
    // A second Clerk user whose email matches the same local part gets a free username.
    const twin=await f.call('POST','/api/v1/auth/link/new',{},f.session('user_other',{email:'newbie@elsewhere.example'}));
    assert.equal(twin.json().user.username,'newbie_2');
    assert.equal((await f.call('GET','/api/v1/admin/games',undefined,fresh)).statusCode,403);
    const profile=await f.call('PATCH','/api/v1/auth/me',{displayName:'改名'},fresh);
    assert.equal(profile.json().user.displayName,'改名');assert.ok(!('passwordHash' in profile.json().user));
    for(const route of ['/api/v1/auth/register','/api/v1/auth/login','/api/v1/auth/logout-all'])
      assert.equal((await f.call('POST',route,{username:'x',password},fresh)).statusCode,404,route);
    assert.equal((await f.call('PUT','/api/v1/auth/password',{oldPassword:password,newPassword:'x'.repeat(9)},fresh)).statusCode,404);
  }finally{await f.close();}
});

test('Clerk tokens are only accepted when fresh, signed by the instance and minted for this site',async()=>{
  const f=await fixture();try{
    await f.user('player_a');
    const now=Math.floor(Date.now()/1000);
    const me=(cookie:string)=>f.call('GET','/api/v1/auth/me',undefined,cookie).then(r=>r.json().user);
    assert.ok(await me(f.session('user_player_a')));
    assert.equal(await me(f.session('user_player_a',{azp:'https://aichat.dkz12345.com'})),null);
    assert.equal(await me(f.session('user_player_a',{iat:now-600,nbf:now-600,exp:now-300})),null);
    assert.equal(await me(f.session('user_player_a',{iss:'https://clerk.example.com'})),null);
    assert.equal(await me('__session='+createTestSigner().token({sub:'user_player_a',azp:f.config.publicOrigin})),null);
    const bearer=await f.call('GET','/api/v1/auth/me',undefined,undefined,{authorization:'Bearer '+f.session('user_player_a').slice('__session='.length)});
    assert.ok(bearer.json().user);
  }finally{await f.close();}
});

test('claiming an old account links it once, keeps its saves and never leaks which part was wrong',async()=>{
  const f=await fixture();try{
    await f.game();
    const legacy=await f.app.services.auth.create('legacy',password,'旧玩家');
    f.app.db.prepare("INSERT INTO saves (user_id,game_id,slot,data_json,schema_version,size_bytes,revision,updated_at) SELECT ?,id,'auto','{\"score\":5}',1,11,1,? FROM games").run(legacy.id,Date.now());
    const clerk=f.session('user_returning');
    // Each attempt from its own address: the per-IP claim limit (5/min) has its own test.
    let ip=0;
    const claim=(body:Record<string,string>,cookie=clerk)=>f.app.inject({method:'POST',url:'/api/v1/auth/link/claim',remoteAddress:'10.0.0.'+(++ip),
      headers:{'x-gamehub-request':'1',...(cookie?{cookie}:{})},payload:body});
    assert.equal((await claim({username:'legacy',password:'wrong-password'})).json().error.code,'INVALID_CREDENTIALS');
    assert.equal((await claim({username:'nobody',password})).json().error.code,'INVALID_CREDENTIALS');
    assert.equal((await claim({username:'legacy',password},'')).json().error.code,'AUTH_REQUIRED');
    const ok=await claim({username:'LEGACY',password});
    assert.equal(ok.statusCode,200,ok.body);assert.equal(ok.json().user.id,legacy.id);assert.equal(ok.json().user.displayName,'旧玩家');
    assert.deepEqual((await f.call('GET','/api/v1/games/clicker/saves/auto',undefined,clerk)).json().data,{score:5});
    assert.equal((await claim({username:'legacy',password})).json().error.code,'ALREADY_LINKED');
    assert.equal((await claim({username:'legacy',password},f.session('user_thief'))).json().error.code,'INVALID_CREDENTIALS');
    // Clerk-created players have no password and can never be claimed.
    const fresh=await f.user('player_b');
    assert.equal((await claim({username:fresh.user.username,password:''},f.session('user_x'))).statusCode,400);
    assert.equal((await claim({username:fresh.user.username,password},f.session('user_x'))).json().error.code,'INVALID_CREDENTIALS');
  }finally{await f.close();}
});

test('the owner is admin, disabled players are blocked, and registration can be closed',async()=>{
  const f=await fixture({allowRegistration:false});try{
    const old=await f.app.services.auth.create('old_player',password);
    const owner=f.session(OWNER);
    assert.equal((await f.call('POST','/api/v1/auth/link/new',{},f.session('user_someone'))).json().error.code,'REGISTRATION_DISABLED');
    const claimed=await f.call('POST','/api/v1/auth/link/claim',{username:'old_player',password},owner);
    assert.equal(claimed.json().user.role,'admin');
    assert.equal((await f.call('GET','/api/v1/admin/games',undefined,owner)).statusCode,200);
    f.app.services.auth.setDisabled(old.id,true);
    assert.deepEqual((await f.call('GET','/api/v1/auth/me',undefined,owner)).json().account,{state:'disabled',suggestedName:'owner'});
    assert.equal((await f.call('GET','/api/v1/me/saves',undefined,owner)).json().error.code,'ACCOUNT_DISABLED');
    f.app.services.auth.setDisabled(old.id,false);
    assert.ok((await f.call('GET','/api/v1/auth/me',undefined,owner)).json().user);
  }finally{await f.close();}
});

test('write-request header, origin allowlist and multipart are protected',async()=>{
  const f=await fixture();try{
    const clerk=f.session('user_bad');
    const bare=await f.app.inject({method:'POST',url:'/api/v1/auth/link/new',headers:{cookie:clerk},payload:{}});
    assert.equal(bare.statusCode,403);
    for(const origin of ['https://evil.example','null','http://localhost:3220.attacker.com']){
      assert.equal((await f.call('POST','/api/v1/auth/link/new',{},clerk,{origin})).statusCode,403);
    }
    const cookie=await f.admin();f.app.services.games.create({slug:'upload',title:'Upload'});
    const m=multipartBody(await zip({'index.html':'test'}));
    const upload=await f.app.inject({method:'POST',url:'/api/v1/admin/games/upload/releases',headers:{cookie,'content-type':m.type},payload:m.body});
    assert.equal(upload.statusCode,403);
    assert.equal((await f.call('PATCH','/api/v1/auth/me',{displayName:'Owner'},cookie,{origin:'http://localhost:3220'})).statusCode,200);
  }finally{await f.close();}
});

test('per-IP claim limits cannot be bypassed with untrusted forwarded headers',async()=>{
  const f=await fixture({trustProxy:true});try{
    let status=0;
    for(let i=0;i<8;i++){
      const response=await f.app.inject({method:'POST',url:'/api/v1/auth/link/claim',remoteAddress:'203.0.113.50',
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
