import { createDecipheriv } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Private build configuration; only the resulting Node bundles receive the shared key. */
export async function loadSharedRankingsApiKey(root) {
  let value = process.env.TOKENPANEL_AA_SHARED_API_KEY?.trim()
  if (value === undefined) {
    const dir = path.resolve(process.env.TOKENPANEL_AA_KEY_DIR || path.join(root, '.dev/aa-owner-data'))
    try {
      let settings
      try { settings = JSON.parse(await fs.readFile(path.join(dir, 'aa-settings.json'), 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') return ''; throw error }
      if (!settings.encryptedKey) return ''
      const key = Buffer.from((await fs.readFile(path.join(dir, 'secret.key'), 'utf8')).trim(), 'base64')
      const [version, iv, tag, ciphertext] = settings.encryptedKey.split('.')
      if (version !== 'v1' || key.length !== 32 || !iv || !tag || !ciphertext) throw new Error('Invalid private configuration')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
      decipher.setAuthTag(Buffer.from(tag, 'base64'))
      const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()])
      value = JSON.parse(plain.toString('utf8')).value
    } catch {
      // Never include underlying error data or credentials in build logs.
      throw new Error('无法读取 AA 共享 Key 的本地发布配置，请检查私有配置目录。')
    }
  }
  if (typeof value !== 'string' || (value && !/^[\x21-\x7e]{8,512}$/.test(value))) throw new Error('AA 共享 Key 的发布配置格式无效。')
  return value
}
