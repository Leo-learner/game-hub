import { cp,mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

await mkdir('dist/src/db/migrations',{recursive:true});
await cp('src/db/migrations','dist/src/db/migrations',{recursive:true});
function run(args){const p=spawnSync(process.execPath,args,{stdio:'inherit'});if(p.status!==0)process.exit(p.status??1);}
run(['dist/scripts/generate-contract.js']);
await mkdir('public/sdk',{recursive:true});
const common={entryPoints:['sdk/index.ts'],bundle:true,target:'es2022',sourcemap:true};
await build({...common,format:'esm',outfile:'public/sdk/game-hub.js'});
await build({...common,format:'iife',globalName:'GameHub',outfile:'public/sdk/game-hub.global.js'});
run(['node_modules/typescript/bin/tsc','-p','tsconfig.sdk.json']);
console.log('Server and browser SDK built.');
