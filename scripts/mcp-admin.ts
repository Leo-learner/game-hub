import { z } from 'zod';
import { loadEnv, createConfig } from '../src/config.js';
import { openDb, assertMigrated } from '../src/db/index.js';
import { migrateMcp, McpStore, scopes, type Scope } from '../src/mcp/store.js';

loadEnv();
const db = openDb(createConfig().dataDir);
try {
  assertMigrated(db);
  const [command, ...args] = process.argv.slice(2);
  if (command === 'migrate' && !args.length) {migrateMcp(db); console.log('MCP schema ready');}
  else {
    const store = new McpStore(db);
    if (command === 'create-token') {
      const [label, permissions, days] = args;
      if (args.length !== 3 || !label || !permissions || !days || process.stdin.isTTY) throw new Error('create-token LABEL read,content,accounts,ops DAYS < secret-file (ghm_ + 32 random bytes base64url)');
      let secret = '';
      for await (const chunk of process.stdin) {secret += chunk; if (secret.length > 128) throw new Error('Invalid secret length');}
      const requested = permissions.split(',');
      if (requested.some(s => !scopes.includes(s as Scope))) throw new Error('Invalid scope');
      console.log(JSON.stringify(store.createToken(label, secret.trim(), requested as Scope[], Number(days))));
    } else if (command === 'list-tokens' && !args.length) console.log(JSON.stringify(store.listTokens(), null, 2));
    else if (command === 'revoke-token' && args.length === 1) {
      const id = z.uuid().parse(args[0]); console.log(JSON.stringify({id, revoked: store.revoke(id) === 1}));
    } else throw new Error('Usage: mcp:admin migrate | create-token LABEL SCOPES DAYS < secret-file | list-tokens | revoke-token UUID');
  }
} catch (e) {console.error(e instanceof Error ? e.message : 'MCP admin failed'); process.exitCode = 1;}
finally {db.close();}
