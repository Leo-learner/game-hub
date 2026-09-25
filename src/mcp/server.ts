import { loadEnv, createConfig } from '../config.js';
import { buildMcpApp } from './app.js';

loadEnv();
const config = createConfig();
const port = Number(process.env.MCP_PORT ?? 3221);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === config.port) throw new Error('Invalid MCP_PORT');
const app = await buildMcpApp(config);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {await app.close(); process.exit(0);});
await app.listen({host: '127.0.0.1', port});
