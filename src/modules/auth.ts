import { randomBytes, randomUUID, createHash } from 'node:crypto';
import argon2 from 'argon2';
import type { Db, UserRow } from '../db/index.js';
import type { Config } from '../config.js';
import { fail } from '../errors.js';

export const digest = (value:string|Buffer) => createHash('sha256').update(value).digest('hex');
export const publicUser = (u:UserRow) => ({id:u.id,username:u.username,displayName:u.display_name,role:u.role,createdAt:new Date(u.created_at).toISOString()});
/** Profile fields from the verified Clerk session token. */
export interface ClerkIdentity { id:string; email:string|null; username:string|null; name:string|null }

// Browser sign-in is Clerk's job now. Local rows keep game data (saves, roles)
// and are linked to one Clerk user; old passwords only serve the one-time claim.
export class AuthService {
  private activeHashes=0;
  private dummyHash='';
  constructor(private db:Db, private config:Config) {}
  async init() { this.dummyHash=await this.hash(randomBytes(32).toString('hex')); }
  async hash(password:string) {
    if (this.activeHashes>=2) fail(429,'AUTH_BUSY','认证请求繁忙，请稍后重试');
    this.activeHashes++;
    try {return await argon2.hash(password,{type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1});}
    finally {this.activeHashes--;}
  }
  async verify(password:string, hash:string) {
    if(this.activeHashes>=2) fail(429,'AUTH_BUSY','认证请求繁忙，请稍后重试');
    this.activeHashes++;
    try {return await argon2.verify(hash,password);} finally {this.activeHashes--;}
  }
  private insert(user:UserRow) {
    try {this.db.prepare(`INSERT INTO users (id,username,display_name,password_hash,role,created_at,clerk_user_id,linked_at,disabled_at)
      VALUES (@id,@username,@display_name,@password_hash,@role,@created_at,@clerk_user_id,@linked_at,@disabled_at)`).run(user);}
    catch(e) {if((e as {code?:string}).code==='SQLITE_CONSTRAINT_UNIQUE') fail(409,'USERNAME_TAKEN','用户名已被使用');throw e;}
    return user;
  }
  /** A password account that is not linked yet (tests and the CLI; players can no longer register this way). */
  async create(username:string,password:string,displayName=username,role:'player'|'admin'='player') {
    if(this.db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) fail(409,'USERNAME_TAKEN','用户名已被使用');
    return this.insert({id:randomUUID(),username,display_name:displayName,password_hash:await this.hash(password),role,
      created_at:this.config.now(),clerk_user_id:null,linked_at:null,disabled_at:null});
  }
  byClerk(clerkUserId:string) {
    return this.db.prepare('SELECT * FROM users WHERE clerk_user_id=?').get(clerkUserId) as UserRow|undefined;
  }
  private freeUsername(identity:ClerkIdentity) {
    const raw=identity.username??identity.email?.split('@')[0]??'';
    let base=raw.replace(/[^A-Za-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').slice(0,16);
    if(base.length<3)base='player';
    const taken=(name:string)=>!!this.db.prepare('SELECT 1 FROM users WHERE username=?').get(name);
    if(!taken(base))return base;
    for(let n=2;n<10000;n++){const name=`${base}_${n}`;if(!taken(name))return name;}
    return 'player_'+randomBytes(4).toString('hex');
  }
  /** "I'm a new player": a fresh local account for this Clerk user. */
  linkNew(identity:ClerkIdentity,displayName?:string) {
    if(this.byClerk(identity.id))fail(409,'ALREADY_LINKED','这个账号已经关联了玩家档案');
    const username=this.freeUsername(identity);
    const name=[...(displayName?.trim()||identity.name||identity.username||username)].slice(0,24).join('');
    const now=this.config.now();
    const role=identity.id===this.config.clerk?.ownerUserId?'admin':'player';
    return this.insert({id:randomUUID(),username,display_name:name,password_hash:'',role,created_at:now,clerk_user_id:identity.id,linked_at:now,disabled_at:null});
  }
  /** "I have an old account": prove it once with the old username and password, then link it. */
  async claim(identity:ClerkIdentity,username:string,password:string) {
    if(this.byClerk(identity.id))fail(409,'ALREADY_LINKED','这个账号已经关联了玩家档案');
    const user=this.db.prepare('SELECT * FROM users WHERE username=? AND clerk_user_id IS NULL').get(username) as UserRow|undefined;
    const hash=user?.password_hash||this.dummyHash;
    const valid=await this.verify(password,hash);
    if(!user||!user.password_hash||!valid) fail(401,'INVALID_CREDENTIALS','旧账号的用户名或密码不正确，或这个账号已被认领');
    const now=this.config.now();
    this.db.transaction(()=>{
      const changed=this.db.prepare('UPDATE users SET clerk_user_id=?,linked_at=? WHERE id=? AND clerk_user_id IS NULL AND password_hash=?')
        .run(identity.id,now,user.id,user.password_hash).changes;
      if(!changed)fail(409,'ALREADY_LINKED','这个旧账号刚刚已被认领');
      this.logoutAll(user.id);
    }).immediate();
    return {...user,clerk_user_id:identity.id,linked_at:now};
  }
  setDisabled(userId:string,disabled:boolean) {
    this.db.prepare('UPDATE users SET disabled_at=? WHERE id=?').run(disabled?this.config.now():null,userId);
  }
  logoutAll(userId:string) {this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);}
  updateName(user:UserRow,displayName:string) {
    this.db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName,user.id);
    return {...user,display_name:displayName};
  }
  /** CLI: lets someone who forgot an old password still claim that account. */
  async resetPassword(username:string,password:string) {
    const user=this.db.prepare('SELECT * FROM users WHERE username=? AND clerk_user_id IS NULL').get(username) as UserRow|undefined;
    if(!user)fail(404,'USER_NOT_FOUND','没有这个未认领的旧账号');
    const hash=await this.hash(password);
    this.db.transaction(()=>{this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,user.id);this.logoutAll(user.id);}).immediate();
  }
}
