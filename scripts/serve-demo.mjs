import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const fresh = process.argv.includes('--fresh')
const serverEntry = path.join(root, 'dist/server/server.mjs')
const webEntry = path.join(root, 'dist/web/index.html')

if (!existsSync(serverEntry) || !existsSync(webEntry)) {
  console.log('[demo] 首次运行，先构建…')
  const result = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true, cwd: root })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (fresh) {
  await fs.rm(path.join(root, '.demo-data'), { recursive: true, force: true })
}

const child = spawn(process.execPath, [serverEntry, '--demo', '--open'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TOKENPANEL_DEMO: '1',
    TOKENPANEL_DATA_DIR: path.join(root, '.demo-data'),
    TOKENPANEL_PORT: process.env.TOKENPANEL_PORT ?? '5189',
    TOKENPANEL_OPEN: '1',
  },
  cwd: root,
})
child.on('exit', (code) => process.exit(code ?? 0))
