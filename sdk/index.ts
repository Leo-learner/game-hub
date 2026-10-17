import type { components,operations } from './generated.js';
export type { components,operations,paths } from './generated.js';
export type User=components['schemas']['User'];
export type Game=components['schemas']['Game'];
export type Save=components['schemas']['Save'];
export type SaveMeta=components['schemas']['SaveMeta'];
export type SaveWrite=components['schemas']['SaveWrite'];
export type GameCreate=components['schemas']['GameCreate'];
export type GamePatch=components['schemas']['GamePatch'];
export type Release=components['schemas']['Release'];
export type GamePage=components['schemas']['GamePage'];
export type SavePage=components['schemas']['SavePage'];

export class ApiError extends Error {
  constructor(public status:number,public code:string,message:string,public details?:Record<string,unknown>,public requestId?:string){super(message);this.name='ApiError';}
}
export interface ClientOptions { baseUrl?:string; fetch?:typeof fetch }
export type AccountEnvelope=components['schemas']['UserEnvelope'];
type RefreshHook=()=>Promise<unknown>;
// The hub page keeps the short-lived Clerk session cookie fresh and exposes this
// hook; games in the same-origin iframe borrow it when a request comes back 401.
function refreshHook():RefreshHook|undefined{
  const own=(globalThis as {__gameHubRefreshAuth?:RefreshHook}).__gameHubRefreshAuth;
  if(own)return own;
  try{return (globalThis.parent as unknown as {__gameHubRefreshAuth?:RefreshHook}|undefined)?.__gameHubRefreshAuth;}catch{return undefined;}
}
export interface SaveOptions { idempotencyKey?:string; signal?:AbortSignal; retries?:number }
export function createClient(options:ClientOptions={}) {
  const base=(options.baseUrl??'/api/v1').replace(/\/$/,'');
  const fetcher=options.fetch??globalThis.fetch.bind(globalThis);
  let known=false,currentUser:User|null=null,epoch=0;
  const listeners=new Set<(user:User|null)=>void>();
  function setUser(user:User|null){const changed=!known||currentUser?.id!==user?.id;known=true;currentUser=user;if(changed){epoch++;for(const listener of listeners)listener(user);}}
  async function request<R>(method:string,route:string,body?:unknown,extra:RequestInit={},retried=false):Promise<R>{
    const headers=new Headers(extra.headers);
    if(method!=='GET')headers.set('X-GameHub-Request','1');
    let payload:BodyInit|undefined;
    if(body instanceof FormData)payload=body;
    else if(body!==undefined){headers.set('Content-Type','application/json');payload=JSON.stringify(body);}
    const response=await fetcher(base+route,{...extra,method,headers,body:payload,credentials:'include'});
    const value=await response.json().catch(()=>null);
    if(!response.ok){
      const err=value?.error;
      if(response.status===401&&err?.code==='AUTH_REQUIRED'){
        // The Clerk token lives about a minute; refresh it once and retry before treating this as signed out.
        const refresh=retried?undefined:refreshHook();
        if(refresh&&!extra.signal?.aborted){await refresh().catch(()=>undefined);return request<R>(method,route,body,extra,true);}
        // Only a missing/expired session means logged out; INVALID_CREDENTIALS (wrong old password) leaves the state intact.
        setUser(null);
      }
      throw new ApiError(response.status,err?.code??'HTTP_ERROR',err?.message??'请求失败',err?.details,value?.requestId);
    }
    return value as R;
  }
  const segment=(value:string)=>encodeURIComponent(value);
  const game=(slug:string)=>'/games/'+segment(slug);
  const query=(params:Record<string,string|number|undefined>)=>{const q=new URLSearchParams();for(const [key,value]of Object.entries(params))if(value!==undefined)q.set(key,String(value));return q.size?'?'+q.toString():'';};
  // Signing in and out happens on the shared Clerk account (accounts.dkz12345.com);
  // these calls only read or create this site's player profile.
  const auth={
    async me(){const result=await request<AccountEnvelope>('GET','/auth/me');setUser(result.user);return result.user;},
    /** Like me(), plus whether a signed-in Clerk user still has to pick "new player" or claim an old account. */
    async account(){const result=await request<AccountEnvelope>('GET','/auth/me');setUser(result.user);return result;},
    async linkNew(displayName?:string){const result=await request<{user:User}>('POST','/auth/link/new',displayName?{displayName}:{});setUser(result.user);return result.user;},
    async claim(username:string,password:string){const result=await request<{user:User}>('POST','/auth/link/claim',{username,password});setUser(result.user);return result.user;},
    async updateProfile(displayName:string){const r=await request<{user:User}>('PATCH','/auth/me',{displayName});setUser(r.user);return r.user;},
    /** Call after the page signed out of Clerk, so listeners drop the user and pending saves. */
    forget(){setUser(null);},
  };
  async function owner(){if(!known)await auth.me();if(!currentUser)throw new ApiError(401,'AUTH_REQUIRED','请先登录后再使用云存档');return currentUser.id;}
  const saves={
    async list(slug:string){return request<{items:SaveMeta[]}>('GET',game(slug)+'/saves');},
    async listAll(page=1,pageSize=20){return request<SavePage>('GET','/me/saves'+query({page,pageSize}));},
    async load<T extends Record<string,unknown>=Record<string,unknown>>(slug:string,slot:string):Promise<(Omit<Save,'data'>&{data:T})|null>{
      const userId=await owner(),startedEpoch=epoch;
      try{
        const value=await request<Omit<Save,'data'>&{data:T}>('GET',game(slug)+'/saves/'+segment(slot),undefined,{headers:{'X-GameHub-User':userId}});
        if(epoch!==startedEpoch)throw new ApiError(409,'ACCOUNT_CHANGED','账号已变化，本次读取结果已丢弃');
        return value;
      }
      catch(e){if(e instanceof ApiError&&e.code==='SAVE_NOT_FOUND')return null;throw e;}
    },
    async save(slug:string,slot:string,input:SaveWrite,opts:SaveOptions={}):Promise<SaveMeta>{
      const snapshot=structuredClone(input);
      const userId=await owner(),startedEpoch=epoch;
      const key=opts.idempotencyKey??crypto.randomUUID();
      const maxRetries=Math.min(Math.max(opts.retries??1,0),3);
      for(let attempt=0;;attempt++){
        if(epoch!==startedEpoch)throw new ApiError(409,'ACCOUNT_CHANGED','账号已变化，本次保存已取消');
        try{
          const value=await request<SaveMeta>('PUT',game(slug)+'/saves/'+segment(slot),snapshot,{signal:opts.signal,headers:{'Idempotency-Key':key,'X-GameHub-User':userId}});
          if(epoch!==startedEpoch)throw new ApiError(409,'ACCOUNT_CHANGED','账号已变化，本次保存结果已丢弃');
          return value;
        }
        catch(e){
          const retryable=(e instanceof TypeError)||(e instanceof ApiError&&[502,503,504].includes(e.status));
          if(!retryable||attempt>=maxRetries||opts.signal?.aborted)throw e;
          await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
        }
      }
    },
    async remove(slug:string,slot:string,expectedRevision:number){const userId=await owner();return request<{ok:true}>('DELETE',game(slug)+'/saves/'+segment(slot)+query({expectedRevision}),undefined,{headers:{'X-GameHub-User':userId}});},
  };
  return {
    auth,saves,
    games:{
      list(params:{q?:string;tag?:string;page?:number;pageSize?:number}={}){return request<GamePage>('GET','/games'+query(params));},
      get(slug:string){return request<Game>('GET',game(slug));},
    },
    admin:{
      listGames(params:{q?:string;tag?:string;page?:number;pageSize?:number}={}){return request<GamePage>('GET','/admin/games'+query(params));},
      createGame(input:GameCreate){return request<Game>('POST','/admin/games',input);},
      getGame(slug:string){return request<Game>('GET','/admin'+game(slug));},
      updateGame(slug:string,input:GamePatch){return request<Game>('PATCH','/admin'+game(slug),input);},
      listReleases(slug:string){return request<{items:Release[]}>('GET','/admin'+game(slug)+'/releases');},
      uploadRelease(slug:string,file:Blob,filename='game.zip'){const data=new FormData();data.append('file',file,filename);return request<Release>('POST','/admin'+game(slug)+'/releases',data);},
      publish(slug:string,releaseId:string){return request<Game>('POST','/admin'+game(slug)+'/publish',{releaseId});},
      unpublish(slug:string){return request<Game>('POST','/admin'+game(slug)+'/unpublish');},
    },
    onAuthChange(listener:(user:User|null)=>void){listeners.add(listener);return()=>listeners.delete(listener);},
    createDebouncedSaver(slug:string,slot:string,onError:(error:unknown)=>void,delayMs=1000,onSaved?:(saved:SaveMeta)=>void){
      let timer:ReturnType<typeof setTimeout>|undefined,pending:SaveWrite|undefined,pendingEpoch=epoch;
      const cancel=()=>{clearTimeout(timer);pending=undefined;};
      const unsubscribe=()=>listeners.delete(cancel);listeners.add(cancel);
      const flush=async()=>{clearTimeout(timer);const input=pending;pending=undefined;if(!input)return;if(epoch!==pendingEpoch)throw new ApiError(409,'ACCOUNT_CHANGED','账号已变化');const saved=await saves.save(slug,slot,input);onSaved?.(saved);return saved;};
      return {schedule(input:SaveWrite){clearTimeout(timer);pending=structuredClone(input);pendingEpoch=epoch;timer=setTimeout(()=>{void flush().catch(onError);},delayMs);},flush,cancel,dispose(){cancel();unsubscribe();}};
    },
  };
}
