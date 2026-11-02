import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const fileQueues = new Map<string, Promise<void>>()

function serialize<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(file) ?? Promise.resolve()
  const result = previous.then(task, task)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  fileQueues.set(file, settled)
  void settled.then(() => {
    if (fileQueues.get(file) === settled) fileQueues.delete(file)
  })
  return result
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

export function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  return serialize(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    const body = `${JSON.stringify(value, null, 2)}\n`
    await fs.writeFile(tmp, body, 'utf8')
    try {
      await fs.rename(tmp, file)
    } catch {
      await fs.rm(file, { force: true })
      await fs.rename(tmp, file)
    }
  })
}

export async function readNdjson<T>(file: string): Promise<{ items: T[]; skipped: number }> {
  let raw = ''
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], skipped: 0 }
    throw error
  }
  const items: T[] = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      items.push(JSON.parse(trimmed) as T)
    } catch {
      skipped++
    }
  }
  return { items, skipped }
}

export function appendNdjson(file: string, items: unknown[]): Promise<void> {
  if (items.length === 0) return Promise.resolve()
  return serialize(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const body = items.map((item) => JSON.stringify(item)).join('\n') + '\n'
    await fs.appendFile(file, body, 'utf8')
  })
}

export function writeNdjson(file: string, items: unknown[]): Promise<void> {
  return serialize(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    const body = items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '')
    await fs.writeFile(tmp, body, 'utf8')
    try {
      await fs.rename(tmp, file)
    } catch {
      await fs.rm(file, { force: true })
      await fs.rename(tmp, file)
    }
  })
}
