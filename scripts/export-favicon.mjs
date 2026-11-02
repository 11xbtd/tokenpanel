import { promises as fs } from 'node:fs'
import path from 'node:path'

// PNG frames preserve the generated icon's alpha at native browser favicon sizes.
const frames = await Promise.all([16, 32].map(async size => ({
  size, png: await fs.readFile(path.resolve(`public/favicon-${size}.png`)),
})))
const header = Buffer.alloc(6 + frames.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(frames.length, 4)
let offset = header.length
frames.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16
  header[entry] = size
  header[entry + 1] = size
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(png.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += png.length
})
await fs.writeFile(path.resolve('public/favicon.ico'), Buffer.concat([header, ...frames.map(frame => frame.png)]))
console.log('[icons] favicon.ico exported with 16px and 32px PNG frames')
