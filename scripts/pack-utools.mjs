import JSZip from 'jszip'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const source = path.join(root, 'dist/utools')

const pluginFile = path.join(source, 'plugin.json')
const exists = await fs
  .access(pluginFile)
  .then(() => true)
  .catch(() => false)
if (!exists) {
  console.error('找不到 dist/utools/plugin.json，请先运行 npm run build')
  process.exit(1)
}

async function addDirectory(zip, relative = '') {
  const entries = await fs.readdir(path.join(source, relative), { withFileTypes: true })
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await addDirectory(zip, child)
    } else {
      zip.file(child, await fs.readFile(path.join(source, child)))
    }
  }
}

const zip = new JSZip()
await addDirectory(zip)
const buffer = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
})

const releaseDir = path.join(root, 'release')
await fs.mkdir(releaseDir, { recursive: true })
const target = path.join(releaseDir, `tokenpanel-utools-${pkg.version}.zip`)
await fs.writeFile(target, buffer)
console.log(`[pack] ${path.relative(root, target)} ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)
