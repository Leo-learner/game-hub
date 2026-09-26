import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type SaveMeta } from '../sdk/index.js';

test('debounced saves expose successful revisions, snapshot queued data and cancel on logout', {timeout:3000}, async()=>{
  let revision=0;
  const sent:Array<{expectedRevision:number;data:{score:number}}>=[];
  const client=createClient({fetch:async(_url,options)=>{
    const route=String(_url);
    if(route.endsWith('/auth/me'))return Response.json({user:{id:'owner-a',username:'owner',displayName:'Owner',role:'player',createdAt:new Date().toISOString()}});
    if(route.endsWith('/auth/logout'))return Response.json({ok:true});
    const body=JSON.parse(String(options?.body));sent.push(body);
    assert.equal(body.expectedRevision,revision);
    return Response.json({slot:'auto',schemaVersion:1,revision:++revision,updatedAt:new Date().toISOString(),sizeBytes:12});
  }});
  await client.auth.me();
  let resolveNext!:(saved:SaveMeta)=>void;
  let result=new Promise<SaveMeta>(resolve=>{resolveNext=resolve;});
  let callerRevision=0;
  const saver=client.createDebouncedSaver('clicker','auto',error=>{throw error;},5,saved=>{
    callerRevision=saved.revision;resolveNext(saved);
  });
  try{
    const input={data:{score:7},schemaVersion:1,expectedRevision:callerRevision};
    saver.schedule(input);input.data.score=99;
    assert.equal((await result).revision,1);
    assert.equal(sent[0].data.score,7);
    result=new Promise<SaveMeta>(resolve=>{resolveNext=resolve;});
    saver.schedule({data:{score:10},schemaVersion:1,expectedRevision:callerRevision});
    assert.equal((await result).revision,2);
    assert.equal(sent[1].expectedRevision,1);
    saver.schedule({data:{score:20},schemaVersion:1,expectedRevision:callerRevision});
    await client.auth.logout();
    assert.equal(await saver.flush(),undefined);
    assert.equal(sent.length,2);
  }finally{saver.dispose();}
});

test('a save response arriving after logout cannot update the new session', {timeout:3000}, async()=>{
  let finish!:(value:Response)=>void, started!:()=>void;
  const waiting=new Promise<void>(resolve=>{started=resolve;});
  const response=new Promise<Response>(resolve=>{finish=resolve;});
  const client=createClient({fetch:async url=>{
    if(String(url).endsWith('/auth/me'))return Response.json({user:{id:'owner-a',username:'owner',displayName:'Owner',role:'player',createdAt:new Date().toISOString()}});
    if(String(url).endsWith('/auth/logout'))return Response.json({ok:true});
    started();return response;
  }});
  await client.auth.me();
  const pending=client.saves.save('clicker','auto',{data:{score:7},schemaVersion:1,expectedRevision:0});
  await waiting;await client.auth.logout();
  const rejected=assert.rejects(pending,{code:'ACCOUNT_CHANGED'});
  finish(Response.json({slot:'auto',schemaVersion:1,revision:1,updatedAt:new Date().toISOString(),sizeBytes:12}));
  await rejected;
});

const owner={id:'owner-a',username:'owner',displayName:'Owner',role:'player',createdAt:new Date().toISOString()};
const unauthorized=(code:string)=>Response.json({error:{code,message:code}},{status:401});

test('a wrong old password keeps the session, auth state and in-flight saves', {timeout:3000}, async()=>{
  let finish!:(value:Response)=>void, started!:()=>void;
  const waiting=new Promise<void>(resolve=>{started=resolve;});
  const response=new Promise<Response>(resolve=>{finish=resolve;});
  let meCalls=0;
  const client=createClient({fetch:async url=>{
    const route=String(url);
    if(route.endsWith('/auth/me')){meCalls++;return Response.json({user:owner});}
    if(route.endsWith('/auth/password'))return unauthorized('INVALID_CREDENTIALS');
    started();return response;
  }});
  assert.deepEqual(await client.auth.me(),owner);
  const changes:unknown[]=[];client.onAuthChange(user=>changes.push(user));
  const pending=client.saves.save('clicker','auto',{data:{score:7},schemaVersion:1,expectedRevision:0});
  await waiting;
  await assert.rejects(client.auth.changePassword('wrong','new-password'),{status:401,code:'INVALID_CREDENTIALS'});
  finish(Response.json({slot:'auto',schemaVersion:1,revision:1,updatedAt:new Date().toISOString(),sizeBytes:12}));
  assert.equal((await pending).revision,1);
  assert.deepEqual(changes,[]);
  assert.equal(meCalls,1);
  assert.deepEqual(await client.auth.me(),owner);
  assert.deepEqual(changes,[]);
});

test('only a missing session clears the user; a failed login leaves a guest logged out', {timeout:3000}, async()=>{
  let user:typeof owner|null=null;
  const client=createClient({fetch:async url=>{
    const route=String(url);
    if(route.endsWith('/auth/me'))return Response.json({user});
    if(route.endsWith('/auth/login'))return unauthorized('INVALID_CREDENTIALS');
    return unauthorized('AUTH_REQUIRED');
  }});
  const changes:unknown[]=[];client.onAuthChange(value=>changes.push(value));
  assert.equal(await client.auth.me(),null);
  await assert.rejects(client.auth.login({username:'owner',password:'wrong'}),{code:'INVALID_CREDENTIALS'});
  await assert.rejects(client.saves.load('clicker','auto'),{code:'AUTH_REQUIRED'});
  assert.deepEqual(changes,[null]);
  user=owner;
  assert.deepEqual(await client.auth.me(),owner);
  await assert.rejects(client.auth.changePassword('old-password','new-password'),{code:'AUTH_REQUIRED'});
  assert.deepEqual(changes,[null,owner,null]);
});
