import { loadEnv, createConfig } from './config.js';
import { buildApp } from './app.js';

loadEnv();
const config=createConfig();
const app=await buildApp(config);
let closing=false;
async function shutdown() {
  if(closing)return;closing=true;
  try{await app.close();process.exitCode=0;}catch(e){app.log.error(e);process.exitCode=1;}
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
try{await app.listen({host:config.host,port:config.port});}catch(e){app.log.error(e);await app.close();process.exitCode=1;}
