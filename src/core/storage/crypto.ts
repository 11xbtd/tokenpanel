import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const KEY_FILE = 'secret.key'
const VERSION = 'v1'

export async function loadOrCreateKey(dataDir: string): Promise<Buffer> {
  const file = path.join(dataDir, KEY_FILE)
  try {
    const raw = (await fs.readFile(file, 'utf8')).trim()
    const key = Buffer.from(raw, 'base64')
    if (key.length === 32) return key
  } catch {
    // 首次运行或密钥损坏时重新生成
  }
  const key = randomBytes(32)
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(file, key.toString('base64'), { mode: 0o600 })
  return key
}

export function encryptJson(key: Buffer, value: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plain = Buffer.from(JSON.stringify(value), 'utf8')
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.')
}

export function decryptJson<T>(key: Buffer, payload: string): T {
  const [version, ivB64, tagB64, dataB64] = payload.split('.')
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) throw new Error('密文格式不正确')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()])
  return JSON.parse(plain.toString('utf8')) as T
}

export function encryptText(key: Buffer, text: string): string {
  return encryptJson(key, { value: text })
}

export function decryptText(key: Buffer, payload: string): string {
  return decryptJson<{ value: string }>(key, payload).value
}
