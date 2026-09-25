import { randomBytes, randomUUID, createHash } from 'node:crypto';
import argon2 from 'argon2';
import type { Db, UserRow } from '../db/index.js';
import type { Config } from '../config.js';
import { fail } from '../errors.js';

export const digest = (value:string|Buffer) => createHash('sha256').update(value).digest('hex');
export const publicUser = (u:UserRow) => ({id:u.id,username:u.username,displayName:u.display_name,role:u.role,createdAt:new Date(u.created_at).toISOString()});
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
  async create(username:string,password:string,displayName=username,role:'player'|'admin'='player') {
    if(this.db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) fail(409,'USERNAME_TAKEN','用户名已被使用');
    const hash=await this.hash(password);
    const user:UserRow={id:randomUUID(),username,display_name:displayName,password_hash:hash,role,created_at:this.config.now()};
    try {this.db.prepare('INSERT INTO users VALUES (@id,@username,@display_name,@password_hash,@role,@created_at)').run(user);}
    catch(e) {if((e as {code?:string}).code==='SQLITE_CONSTRAINT_UNIQUE') fail(409,'USERNAME_TAKEN','用户名已被使用');throw e;}
    return user;
  }
  async login(username:string,password:string) {
    const user=this.db.prepare('SELECT * FROM users WHERE username=?').get(username) as UserRow|undefined;
    const valid=await this.verify(password,user?.password_hash??this.dummyHash);
    if(!user||!valid) fail(401,'INVALID_CREDENTIALS','用户名或密码错误');
    const current=this.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id) as {password_hash:string}|undefined;
    if(current?.password_hash!==user.password_hash)fail(401,'INVALID_CREDENTIALS','账号凭证已变化，请重新登录');
    return user;
  }
  issue(userId:string, previousToken?:string) {
    const token=randomBytes(32).toString('base64url'), now=this.config.now();
    this.db.transaction(()=>{
      if(previousToken) this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(previousToken));
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token),userId,now+this.config.sessionTtlMs,now);
    }).immediate();
    return token;
  }
  lookup(token?:string) {
    if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row=this.db.prepare('SELECT u.*,s.expires_at,s.renewed_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(digest(token),this.config.now()) as (UserRow&{expires_at:number;renewed_at:number})|undefined;
    if(!row)return null;
    return {user:row,renew:row.renewed_at<=this.config.now()-86400000};
  }
  touch(token:string) {const now=this.config.now();this.db.prepare('UPDATE sessions SET expires_at=?,renewed_at=? WHERE token_hash=?').run(now+this.config.sessionTtlMs,now,digest(token));}
  logout(token?:string) {if(token)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));}
  logoutAll(userId:string) {this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);}
  updateName(user:UserRow,displayName:string) {
    this.db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName,user.id);
    return {...user,display_name:displayName};
  }
  async changePassword(user:UserRow,oldPassword:string,newPassword:string) {
    if(!await this.verify(oldPassword,user.password_hash))fail(401,'INVALID_CREDENTIALS','原密码错误');
    const hash=await this.hash(newPassword);
    this.db.transaction(()=>{
      const current=this.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id) as {password_hash:string}|undefined;
      if(current?.password_hash!==user.password_hash)fail(409,'ACCOUNT_CHANGED','账号状态已变化，请重新登录');
      this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,user.id);
      this.logoutAll(user.id);
    }).immediate();
  }
  async resetPassword(username:string,password:string) {
    const user=this.db.prepare('SELECT * FROM users WHERE username=?').get(username) as UserRow|undefined;
    if(!user)fail(404,'USER_NOT_FOUND','用户不存在');
    const hash=await this.hash(password);
    this.db.transaction(()=>{this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,user.id);this.logoutAll(user.id);}).immediate();
  }
}
