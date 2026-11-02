import { build } from 'esbuild'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSharedRankingsApiKey } from './rankings-shared-key.mjs'

const root = process.cwd()
const sharedKey = await loadSharedRankingsApiKey(root)
const outfile = path.join(root, '.dev/server.mjs')
await build({
  entryPoints: [path.join(root, 'src/node/server.ts')],
  bundle: true, platform: 'node', target: 'node20', format: 'esm', outfile, sourcemap: true,
  loader: { '.json': 'json' },
  define: { __TOKENPANEL_AA_SHARED_API_KEY__: JSON.stringify(sharedKey) },
  logLevel: 'info',
})
await import(pathToFileURL(outfile).href)
