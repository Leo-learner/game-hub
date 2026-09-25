import {rm} from 'node:fs/promises';
// Both directories contain generated output only.
await rm('dist', {recursive: true, force: true});
await rm('public/sdk', {recursive: true, force: true});
