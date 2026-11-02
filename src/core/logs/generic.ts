import os from 'node:os'
import path from 'node:path'
import { exists, displayPath, windowsAppData } from './util'

export interface UnadaptedSource {
  id: string
  name: string
  paths: string[]
  note: string
}

interface Candidate {
  id: string
  name: string
  note: string
  roots: string[]
}

export async function detectUnadaptedSources(): Promise<UnadaptedSource[]> {
  const home = os.homedir()
  const appData = windowsAppData()
  const candidates: Candidate[] = [
    {
      id: 'cursor',
      name: 'Cursor',
      note: '本地 SQLite token 多数需要估算，暂未适配。',
      roots: [path.join(home, '.cursor'), path.join(appData, 'Cursor')],
    },
    {
      id: 'copilot',
      name: 'GitHub Copilot',
      note: 'SQLite/OTel 存储，字段与鉴权较复杂，暂未适配。',
      roots: [path.join(home, '.copilot'), path.join(appData, 'Code', 'User', 'globalStorage', 'github.copilot-chat')],
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      note: '编辑器数据库格式未确认，暂未适配。',
      roots: [path.join(home, '.codeium', 'windsurf'), path.join(appData, 'Windsurf')],
    },
    {
      id: 'amp',
      name: 'Amp',
      note: '论坛/源码有字段线索，但未验证，暂未适配。',
      roots: [path.join(home, '.local', 'share', 'amp')],
    },
    {
      id: 'droid',
      name: 'Droid',
      note: '会话级 tokenUsage，暂未适配。',
      roots: [path.join(home, '.factory')],
    },
    {
      id: 'iflow',
      name: 'iFlow',
      note: '目录发现，格式未验证，暂未适配。',
      roots: [path.join(home, '.iflow')],
    },
  ]

  const found: UnadaptedSource[] = []
  for (const candidate of candidates) {
    const paths: string[] = []
    for (const root of candidate.roots) {
      if (await exists(root)) paths.push(displayPath(root))
    }
    if (paths.length > 0) {
      found.push({ id: candidate.id, name: candidate.name, note: candidate.note, paths })
    }
  }
  return found
}
