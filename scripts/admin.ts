import { createConfig,loadEnv } from '../src/config.js';
import { openDb,migrate,assertMigrated } from '../src/db/index.js';
import { AuthService,publicUser } from '../src/modules/auth.js';
import { GameService } from '../src/modules/games.js';
import { ReleaseService } from '../src/modules/releases.js';
import { backup,verifyBackup,restore } from '../src/modules/backups.js';
import { AppError } from '../src/errors.js';
import { emitKeypressEvents } from 'node:readline';
import { resolve } from 'node:path';

loadEnv();
const [command,...args]=process.argv.slice(2);
const c=createConfig();
async function password():Promise<string> {
  let value:string;
  if(args.includes('--password-stdin')){
    const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
    value=Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/,'');
  }else{
    if(!process.stdin.isTTY)throw new Error('Use an interactive terminal, or --password-stdin. Never pass passwords as command arguments.');
    process.stdout.write('Password (input hidden): ');
    emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
    value=await new Promise<string>((resolve,reject)=>{
      let buffer='';
      const finish=()=>{process.stdin.off('keypress',onKey);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};
      const onKey=(text:string,key:{name?:string;ctrl?:boolean})=>{
        if(key.ctrl&&key.name==='c'){finish();reject(new Error('Cancelled'));return;}
        if(key.name==='return'){finish();resolve(buffer);return;}
        if(key.name==='backspace'){buffer=Array.from(buffer).slice(0,-1).join('');return;}
        if(text&&!key.ctrl)buffer+=text;
      };
      process.stdin.on('keypress',onKey);
    });
  }
  if(Array.from(value).length<8||Array.from(value).length>128)throw new Error('Password must contain 8–128 characters.');
  return value;
}
async function main() {
  if(command==='verify-backup'){console.log(JSON.stringify(await verifyBackup(resolve(args[0])),null,2));return;}
  if(command==='restore'){
    if(!args[0]||!args[1])throw new Error('restore <backup-directory> <empty-target-directory>');
    await restore(resolve(args[0]),resolve(args[1]));console.log('Restore completed and verified.');return;
  }
  if(!['migrate','create-admin','reset-password','users','games','backup'].includes(command??'')){
    console.log('Commands:\n  migrate\n  create-admin <username> [--password-stdin]\n  reset-password <username> [--password-stdin]\n  users list\n  games create <slug> <title>\n  games import <directory> --game <slug>\n  games publish <slug> <releaseId>\n  games unpublish <slug>\n  backup [destination]\n  verify-backup <directory>\n  restore <backup-directory> <empty-target-directory>');
    return;
  }
  const db=openDb(c.dataDir);
  try{
    if(command==='migrate'){migrate(db);console.log('Database migrated.');return;}
    assertMigrated(db);
    const auth=new AuthService(db,c),games=new GameService(db,c),releases=new ReleaseService(db,c,games);
    if(command==='create-admin'){
      if(!/^[A-Za-z0-9_]{3,20}$/.test(args[0]??''))throw new Error('Username must contain 3–20 letters, digits or underscores.');
      console.log(JSON.stringify(publicUser(await auth.create(args[0],await password(),args[0],'admin')),null,2));
    }else if(command==='reset-password'){
      if(!args[0])throw new Error('Missing username');
      await auth.resetPassword(args[0],await password());console.log('Password reset; all previous sessions revoked.');
    }else if(command==='users'&&args[0]==='list'){
      console.log(JSON.stringify(db.prepare('SELECT id,username,display_name AS displayName,role,created_at AS createdAt FROM users ORDER BY created_at').all(),null,2));
    }else if(command==='games'){
      if(args[0]==='create'){
        if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args[1]??'')||args[1].length>64||!args[2]||args[2].length>100)throw new Error('games create <slug> <title>');
        console.log(JSON.stringify(games.create({slug:args[1],title:args[2]}),null,2));
      }else if(args[0]==='import'){
        const index=args.indexOf('--game');if(index<0||!args[index+1]||!args[1])throw new Error('games import <directory> --game <slug>');
        console.log(JSON.stringify(await releases.importDirectory(args[index+1],args[1]),null,2));
      }else if(args[0]==='publish'&&args[1]&&args[2])console.log(JSON.stringify(games.publish(args[1],args[2]),null,2));
      else if(args[0]==='unpublish'&&args[1])console.log(JSON.stringify(games.unpublish(args[1]),null,2));
      else throw new Error('Unknown games command');
    }else if(command==='backup')console.log(await backup(db,c,args[0]?resolve(args[0]):undefined));
    else throw new Error('Unknown command');
  }finally{db.close();}
}
main().catch(e=>{console.error(e instanceof AppError?e.code+': '+e.message:e.message);process.exitCode=1;});
