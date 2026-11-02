import { promises as fs } from 'node:fs'
import path from 'node:path'

const MIGRATED_FILES = [
  'config.json',
  'secret.key',
  'usage.ndjson',
  'snapshots.ndjson',
  'ledger.ndjson',
  'alerts.ndjson',
  'state.json',
  'refresh-log.ndjson',
  'prices-overrides.json',
  'log-file-cache.json',
]

export async function migrateLegacyData(targetDir: string, legacyDirs: string[]): Promise<string | undefined> {
  const targetConfig = path.join(targetDir, 'config.json')
  const targetExists = await fs
    .access(targetConfig)
    .then(() => true)
    .catch(() => false)
  if (targetExists) return undefined

  for (const legacyDir of legacyDirs) {
    const legacyConfig = path.join(legacyDir, 'config.json')
    const legacyExists = await fs
      .access(legacyConfig)
      .then(() => true)
      .catch(() => false)
    if (!legacyExists) continue

    await fs.mkdir(targetDir, { recursive: true })
    for (const file of MIGRATED_FILES) {
      const from = path.join(legacyDir, file)
      const to = path.join(targetDir, file)
      const exists = await fs
        .access(from)
        .then(() => true)
        .catch(() => false)
      if (!exists) continue
      await fs.copyFile(from, to)
    }
    return legacyDir
  }
  return undefined
}
