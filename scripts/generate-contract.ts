import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import openapiTS,{astToString,type OpenAPI3} from 'openapi-typescript';
import { createConfig } from '../src/config.js';
import { openDb,migrate } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

await mkdir('.work',{recursive:true});await mkdir('docs',{recursive:true});await mkdir('sdk',{recursive:true});
const dataDir=await mkdtemp(path.resolve('.work/contract-'));
const config=createConfig({dataDir,logger:false,publicOrigin:'https://games.dkz12345.com',cookieSecure:true});
const db=openDb(dataDir);migrate(db);db.close();
const app=await buildApp(config);
try {
  const document=app.swagger();
  await writeFile('docs/openapi.json',JSON.stringify(document,null,2)+'\n');
  const ast=await openapiTS(document as OpenAPI3);
  await writeFile('sdk/generated.ts','// Generated from docs/openapi.json. Do not edit manually.\n'+astToString(ast));
  console.log('OpenAPI contract and SDK types generated.');
}finally{await app.close();await rm(dataDir,{recursive:true,force:true});}
