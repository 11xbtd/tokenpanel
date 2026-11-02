import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { numberValue } from '../util/json'

export { numberValue }

export const MAX_LOG_FILE_BYTES = 80 * 1024 * 1024

export function hashId(...parts: Array<string | number | undefined>): string {
  return createHash('sha1').update(parts.filter((part) => part !== undefined).join('|')).digest('hex').slice(0, 20)
}

export function displayPath(value: string): string {
  const home = os.homedir()
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value
}

export function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim()
    if (/^\d+$/.test(text)) return timestampMs(Number(text))
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

export async function statFile(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return null
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    if (!raw.trim()) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function readJsonLines(file: string): Promise<unknown[]> {
  const raw = await fs.readFile(file, 'utf8')
  const items: unknown[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      items.push(JSON.parse(trimmed))
    } catch {
      // 日志里可能存在被截断的尾部，跳过坏行
    }
  }
  return items
}

export async function listDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
  } catch {
    return []
  }
}

export async function listFiles(root: string, predicate: (name: string) => boolean, depth = 4): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, remaining: number) => {
    if (remaining < 0) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, remaining - 1)
      } else if (predicate(entry.name)) {
        found.push(full)
      }
    }
  }
  await walk(root, depth)
  return found
}

export function windowsAppData(): string {
  return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
}

export function ascii(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '').trim() || 'unknown'
}
