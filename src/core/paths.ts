import os from 'node:os'
import path from 'node:path'

export function defaultDataDir(): string {
  const override = process.env.TOKENPANEL_DATA_DIR
  if (override) return path.resolve(override)
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'TokenPanel')
  }
  return path.join(os.homedir(), '.tokenpanel')
}

export function legacyDataDirs(cwd = process.cwd()): string[] {
  return [path.join(cwd, 'data')]
}
