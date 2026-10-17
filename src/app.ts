import Fastify, { type FastifyRequest, type FastifyReply, type HTTPMethods, type RouteHandlerMethod } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import serveStatic from '@fastify/static';
import { Type as T, type TSchema, type TUnknown, type Static } from '@sinclair/typebox';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import mime from 'mime-types';
import type { Config } from './config.js';
import { openDb, assertMigrated, type Db, type UserRow, type ReleaseRow, type FileRecord } from './db/index.js';
import { AppError, fail } from './errors.js';
import * as S from './schemas.js';
import { AuthService, publicUser, type ClerkIdentity } from './modules/auth.js';
import { createClerkGate } from './lib/clerk-gate/clerk-gate.js';
import { GameService } from './modules/games.js';
import { SaveService } from './modules/saves.js';
import { ReleaseService, safeRelative } from './modules/releases.js';

declare module 'fastify' {
  interface FastifyRequest { user:UserRow|null; clerk:ClerkIdentity|null; accountState:'link-required'|'disabled'|null }
  interface FastifyInstance { db:Db; services:{auth:AuthService;games:GameService;saves:SaveService;releases:ReleaseService} }
}
export async function buildApp(c:Config) {
  const app=Fastify({
    logger:c.logger?{level:c.logLevel,redact:['req.headers.cookie','req.headers.authorization','res.headers.set-cookie','password','password_hash']}:false,
    trustProxy:c.trustProxy?['127.0.0.1','::1']:false,
    bodyLimit:c.saveMaxBytes+65536,
    ajv:{customOptions:{removeAdditional:false,allErrors:false}},
    requestTimeout:120000,connectionTimeout:15000,
  });
  const db=openDb(c.dataDir);
  try {assertMigrated(db);}catch(e){db.close();throw e;}
  const auth=new AuthService(db,c);await auth.init();
  const games=new GameService(db,c),saves=new SaveService(db,c,games),releases=new ReleaseService(db,c,games);
  app.decorate('db',db);app.decorate('services',{auth,games,saves,releases});
  app.decorateRequest('user',null);app.decorateRequest('clerk',null);app.decorateRequest('accountState',null);
  // Shared Clerk login: verify the short-lived __session token with the public key only.
  const gate=c.clerk?createClerkGate({publishableKey:c.clerk.publishableKey,jwtKey:c.clerk.jwtKey,authorizedParties:[c.publicOrigin]}):null;
  const expire=()=>{const now=c.now();db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);db.prepare('DELETE FROM idempotency_keys WHERE expires_at<=?').run(now);};
  expire();const timer=setInterval(expire,3600000);timer.unref();
  app.addHook('onClose',async()=>{clearInterval(timer);db.close();});
  for(const schema of S.schemas)app.addSchema(schema);
  await app.register(swagger,{openapi:{openapi:'3.0.3',info:{title:'Game Hub API',version:'1.0.0',description:'独立小游戏平台后端；登录用 dkz12345.com 统一的 Clerk 账号（同域 __session Cookie）。所有写请求携带 X-GameHub-Request: 1。'},servers:[{url:c.publicOrigin}],
    components:{securitySchemes:{cookieAuth:{type:'apiKey',in:'cookie',name:gate?.cookieNames[0]??'__session'}}}},
    refResolver:{buildLocalReference:json=>String(json.$id)}});
  await app.register(cors,{origin:(origin,cb)=>cb(null,!origin||c.allowedOrigins.includes(origin)),
    credentials:true,methods:['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders:['Content-Type','X-GameHub-Request','Idempotency-Key','X-GameHub-User'],maxAge:600,strictPreflight:true});
  await app.register(cookie);
  await app.register(rateLimit,{global:true,max:300,timeWindow:'1 minute',errorResponseBuilder:()=>({statusCode:429,code:'RATE_LIMITED',error:'Too Many Requests',message:'请求过于频繁'})});
  await app.register(multipart,{limits:{fileSize:c.uploadMaxBytes,files:1,fields:0,parts:1},throwFileSizeLimit:true});
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin').header('X-Request-Id',req.id);
    if(req.url.startsWith('/api/'))reply.header('Cache-Control','no-store');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      if(req.headers['x-gamehub-request']!=='1')fail(403,'REQUEST_HEADER_REQUIRED','写请求必须携带 X-GameHub-Request: 1');
      const origin=req.headers.origin;
      if(origin!==undefined&&!c.allowedOrigins.includes(origin))fail(403,'ORIGIN_REJECTED','请求来源不允许');
    }
    if(gate&&req.url.startsWith('/api/')){
      const result=await gate.authenticate(req.headers);
      if(result.ok){
        const {id,email,username,name}=result.user;
        req.clerk={id,email,username,name};
        const row=auth.byClerk(id);
        if(!row)req.accountState='link-required';
        else if(row.disabled_at!==null)req.accountState='disabled';
        else req.user=id===c.clerk!.ownerUserId?{...row,role:'admin'}:row;
      }
    }
    const expected=req.headers['x-gamehub-user'];
    if(expected!==undefined&&expected!==req.user?.id)fail(409,'ACCOUNT_CHANGED','当前账号已变化，请重新读取登录状态');
  });
  app.setErrorHandler((error,req,reply)=>{
    const e=error as Error&{statusCode?:number;validation?:unknown;code?:string};
    let status=e instanceof AppError?e.status:(e.statusCode??500);
    let code=e instanceof AppError?e.code:'INTERNAL_ERROR',message=e instanceof AppError?e.message:'服务暂时不可用';
    if(e.validation){status=400;code='VALIDATION_ERROR';message='请求参数不符合接口定义';}
    else if(!(e instanceof AppError)&&status<500){
      code=status===413?'PAYLOAD_TOO_LARGE':status===429?'RATE_LIMITED':status===415?'UNSUPPORTED_MEDIA_TYPE':'INVALID_REQUEST';
      message=status===413?'请求超过大小限制':status===429?'请求过于频繁，请稍后重试':'请求格式不正确';
    }
    if((e as {code?:string}).code==='SQLITE_BUSY'){status=503;code='STORAGE_BUSY';message='存储繁忙，请稍后重试';}
    if(status>=500)req.log.error({err:error,requestId:req.id},'Request failed');
    reply.code(status).send({error:{code,message,...(e instanceof AppError&&e.details?{details:e.details}:{})},requestId:req.id});
  });
  function add<B extends TSchema=TUnknown,P extends TSchema=TUnknown,Q extends TSchema=TUnknown>(
    method:HTTPMethods,url:string,operationId:string,tag:string,
    opts:{body?:B;params?:P;query?:Q;response:TSchema;status?:number;auth?:'user'|'admin';max?:number;description?:string},
    handler:(req:FastifyRequest<{Body:Static<B>;Params:Static<P>;Querystring:Static<Q>}>,reply:FastifyReply)=>unknown,
  ){
    const writing=!['GET','HEAD'].includes(method),status=opts.status??200;
    app.route({method,url:'/api/v1'+url,config:{rateLimit:opts.max?{max:opts.max,timeWindow:'1 minute'}:undefined},
      schema:{operationId,tags:[tag],summary:operationId,description:opts.description,
        ...(opts.body?{body:opts.body}:{}),...(opts.params?{params:opts.params}:{}),...(opts.query?{querystring:opts.query}:{}),
        ...(writing?{headers:S.writeHeaders}:{}),
        security:opts.auth?[{cookieAuth:[]}]:[],response:S.responses(opts.response,status)},
      preHandler:async(req,reply)=>{
        if(opts.auth&&!req.user){
          if(req.accountState==='disabled')fail(403,'ACCOUNT_DISABLED','这个玩家档案已被停用');
          fail(401,'AUTH_REQUIRED','请先登录');
        }
        if(opts.auth==='admin'&&req.user?.role!=='admin')fail(403,'ADMIN_REQUIRED','需要管理员权限');
        reply.code(status);
      },handler:handler as RouteHandlerMethod});
  }
  const suggestedName=(i:ClerkIdentity)=>[...(i.name||i.username||i.email?.split('@')[0]||'')].slice(0,24).join('');
  const linking=(req:FastifyRequest)=>{
    if(!req.clerk)fail(401,'AUTH_REQUIRED','请先登录');
    if(req.accountState!=='link-required')fail(409,'ALREADY_LINKED','这个账号已经关联了玩家档案');
    return req.clerk;
  };
  add('GET','/auth/me','getCurrentUser','Auth',{response:T.Ref(S.UserEnvelope)},async req=>({
    user:req.user?publicUser(req.user):null,
    ...(req.accountState&&req.clerk?{account:{state:req.accountState,suggestedName:suggestedName(req.clerk)}}:{}),
  }));
  add('POST','/auth/link/new','linkNewPlayer','Auth',{body:S.LinkNew,response:T.Ref(S.UserEnvelope),status:201,max:10,description:'已用 Clerk 登录、还没有玩家档案时：新建一个。'},async req=>{
    const clerk=linking(req);
    if(!c.allowRegistration)fail(403,'REGISTRATION_DISABLED','暂未开放新玩家注册');
    return {user:publicUser(auth.linkNew(clerk,req.body.displayName))};
  });
  add('POST','/auth/link/claim','claimOldAccount','Auth',{body:S.Claim,response:T.Ref(S.UserEnvelope),max:5,description:'已用 Clerk 登录、还没有玩家档案时：用旧用户名和密码认领原来的档案（只需一次）。'},async req=>{
    const user=await auth.claim(linking(req),req.body.username,req.body.password);
    return {user:publicUser(user.clerk_user_id===c.clerk?.ownerUserId?{...user,role:'admin'}:user)};
  });
  add('PATCH','/auth/me','updateProfile','Auth',{body:T.Object({displayName:T.String({minLength:1,maxLength:24})},{additionalProperties:false}),response:T.Ref(S.UserEnvelope),auth:'user'},
    async req=>({user:publicUser(auth.updateName(req.user!,req.body.displayName))}));
  const gameQuery=T.Composite([S.Pagination,T.Object({q:T.Optional(T.String({maxLength:100})),tag:T.Optional(T.String({maxLength:32}))})],{additionalProperties:false});
  add('GET','/games','listGames','Games',{query:gameQuery,response:T.Ref(S.GamePage)},async req=>games.list(req.query));
  add('GET','/games/:slug','getGame','Games',{params:S.paramsGame,response:T.Ref(S.Game)},async req=>games.present(games.get(req.params.slug,true)));
  add('GET','/me/saves','listMySaves','Saves',{query:S.Pagination,response:T.Ref(S.SavePage),auth:'user'},async req=>saves.summaries(req.user!.id,req.query.page,req.query.pageSize));
  add('GET','/games/:slug/saves','listSaves','Saves',{params:S.paramsGame,response:T.Object({items:T.Array(T.Ref(S.SaveMeta))}),auth:'user'},async req=>saves.list(req.user!.id,req.params.slug));
  add('GET','/games/:slug/saves/:slot','getSave','Saves',{params:S.paramsSave,response:T.Ref(S.Save),auth:'user'},async req=>saves.read(req.user!.id,req.params.slug,req.params.slot));
  add('PUT','/games/:slug/saves/:slot','putSave','Saves',{params:S.paramsSave,body:S.SaveWrite,response:T.Ref(S.SaveMeta),auth:'user',max:120},async req=>saves.write(req.user!.id,req.params.slug,req.params.slot,req.body,req.headers['idempotency-key'] as string|undefined));
  add('DELETE','/games/:slug/saves/:slot','deleteSave','Saves',{params:S.paramsSave,query:T.Object({expectedRevision:S.Revision},{additionalProperties:false}),response:T.Ref(S.Ok),auth:'user'},
    async req=>saves.remove(req.user!.id,req.params.slug,req.params.slot,req.query.expectedRevision));
  add('GET','/admin/games','adminListGames','Admin',{query:gameQuery,response:T.Ref(S.GamePage),auth:'admin'},async req=>games.list(req.query,true));
  add('POST','/admin/games','createGame','Admin',{body:S.GameCreate,response:T.Ref(S.Game),auth:'admin',status:201},async req=>games.create(req.body));
  add('GET','/admin/games/:slug','adminGetGame','Admin',{params:S.paramsGame,response:T.Ref(S.Game),auth:'admin'},async req=>games.present(games.get(req.params.slug)));
  add('PATCH','/admin/games/:slug','updateGame','Admin',{params:S.paramsGame,body:S.GamePatch,response:T.Ref(S.Game),auth:'admin'},async req=>games.update(req.params.slug,req.body));
  add('GET','/admin/games/:slug/releases','listReleases','Admin',{params:S.paramsGame,response:T.Object({items:T.Array(T.Ref(S.Release))}),auth:'admin'},async req=>{
    const g=games.get(req.params.slug);
    return {items:(db.prepare('SELECT * FROM game_releases WHERE game_id=? ORDER BY created_at DESC,id').all(g.id) as ReleaseRow[]).map(r=>games.presentRelease(r))};
  });
  add('POST','/admin/games/:slug/releases','uploadRelease','Admin',{params:S.paramsGame,response:T.Ref(S.Release),auth:'admin',status:201,max:3,description:'multipart/form-data，唯一字段 file 为 ZIP；最大 50 MiB（可配置）。'},async req=>{
    if(!req.isMultipart())fail(415,'MULTIPART_REQUIRED','上传需要 multipart/form-data');
    const parts=req.parts();
    async function* content(){
      let found=false;
      for await(const part of parts){
        if(part.type!=='file'||part.fieldname!=='file'||found)fail(400,'INVALID_UPLOAD','请仅上传一个名为 file 的 ZIP 文件');
        found=true;for await(const chunk of part.file)yield chunk;
        if(part.file.truncated)fail(413,'UPLOAD_TOO_LARGE','ZIP 超过大小限制');
      }
      if(!found)fail(400,'FILE_REQUIRED','缺少 ZIP 文件');
    }
    return releases.importZip(req.params.slug,Readable.from(content(),{objectMode:false}));
  });
  add('POST','/admin/games/:slug/publish','publishRelease','Admin',{params:S.paramsGame,body:T.Object({releaseId:T.String({format:'uuid'})},{additionalProperties:false}),response:T.Ref(S.Game),auth:'admin'},async req=>games.publish(req.params.slug,req.body.releaseId));
  add('POST','/admin/games/:slug/unpublish','unpublishGame','Admin',{params:S.paramsGame,response:T.Ref(S.Game),auth:'admin'},async req=>games.unpublish(req.params.slug));

  app.get('/healthz',{schema:{hide:true}},async()=>({status:'ok'}));
  app.get('/readyz',{schema:{hide:true}},async()=>{db.prepare('SELECT 1').get();assertMigrated(db);return {status:'ready'};});
  app.get<{Params:{slug:string;releaseId:string;'*':string}}>('/play/:slug/:releaseId/*',{schema:{hide:true}},async(req,reply)=>{
    const game=games.get(req.params.slug,true),release=games.release(req.params.releaseId);
    if(release.game_id!==game.id||release.published_at===null)fail(404,'ASSET_NOT_FOUND','资源不存在');
    let file:string;
    try{file=safeRelative(req.params['*']||'index.html');}catch{fail(404,'ASSET_NOT_FOUND','资源不存在');}
    if(!(JSON.parse(release.files_json) as FileRecord[]).some(f=>f.path===file))fail(404,'ASSET_NOT_FOUND','资源不存在');
    const rel=release.storage_key+'/files/'+file,absolute=path.join(c.dataDir,'releases',rel);
    if(!existsSync(absolute))fail(503,'RELEASE_FILES_MISSING','游戏资源暂不可用');
    reply.header('Cache-Control','private, no-cache').header('Content-Security-Policy',"frame-ancestors 'self'");
    reply.type(mime.lookup(file)||'application/octet-stream');
    if(c.xAccelRedirect){reply.header('X-Accel-Redirect','/_gamehub_internal/'+rel.split('/').map(encodeURIComponent).join('/'));return reply.send();}
    return reply.send(createReadStream(absolute));
  });
  if(c.apiDocs){
    await app.register(swaggerUi,{
      routePrefix:'/docs',uiConfig:{persistAuthorization:false},staticCSP:true,
      // Swagger UI injects styles at runtime; retain strict script restrictions.
      transformStaticCSP:header=>header.replace(/style-src[^;]*;/,"style-src 'self' 'unsafe-inline';"),
    });
    app.get('/openapi.json',{schema:{hide:true}},async()=>app.swagger());
  }
  if(existsSync(c.sdkDir))await app.register(serveStatic,{root:c.sdkDir,prefix:'/sdk/',decorateReply:false,cacheControl:false,dotfiles:'deny'});
  if(existsSync(c.publicDir))await app.register(serveStatic,{root:c.publicDir,prefix:'/',decorateReply:false,cacheControl:false,dotfiles:'deny',
    allowedPath:file=>!/^\/?(api|play|docs|sdk|openapi\.json|healthz|readyz|_gamehub_internal)(\/|$)/.test(file)});
  app.setNotFoundHandler((req,reply)=>{
    const url=req.url.split('?')[0];
    if(c.spaFallback&&req.method==='GET'&&req.headers.accept?.includes('text/html')&&!/^\/(api|play|docs|sdk|openapi\.json|healthz|readyz|_gamehub_internal)(\/|$)/.test(url)&&existsSync(path.join(c.publicDir,'index.html')))
      return reply.type('text/html').send(createReadStream(path.join(c.publicDir,'index.html')));
    return reply.code(404).send({error:{code:'NOT_FOUND',message:'资源不存在'},requestId:req.id});
  });
  await app.ready();
  // File streams are validated by multipart, with an explicit contract for documentation and generated clients.
  const original=app.swagger.bind(app);
  const spec=original() as ReturnType<typeof original> & {paths:Record<string,{post?:{requestBody?:unknown}}>};
  const upload=spec.paths['/api/v1/admin/games/{slug}/releases']?.post;
  if(upload)upload.requestBody={required:true,content:{'multipart/form-data':{schema:{type:'object',required:['file'],properties:{file:{type:'string',format:'binary'}}}}}};
  return app;
}
