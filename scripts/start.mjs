import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const serverEntry = path.join(root, 'dist/server/server.mjs')
const webEntry = path.join(root, 'dist/web/index.html')

if (!existsSync(serverEntry) || !existsSync(webEntry)) {
  console.log('[start] 首次启动，先构建（约 10-30 秒）…')
  const result = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true, cwd: root })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const child = spawn(process.execPath, [serverEntry, '--open'], {
  stdio: 'inherit',
  env: { ...process.env, TOKENPANEL_OPEN: process.env.TOKENPANEL_OPEN ?? '1' },
  cwd: root,
})
child.on('exit', (code) => process.exit(code ?? 0))
