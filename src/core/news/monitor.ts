import { createHash } from 'node:crypto'
import { load } from 'cheerio/slim'
import type { NewsSource } from './catalog'
import type { NewsItem } from './types'

export interface PriceBaseline { hash: string; signature: string; lines: string[]; initializedAt: number; changedAt?: number }

const clean = (text: string) => text.normalize('NFKC').replace(/[\u200b-\u200d\ufeff\ue000-\uf8ff]/g, '').replace(/\s+/g, ' ').trim()

/** Compare only the documented price content, excluding navigation and site chrome. */
export function priceSnapshot(body: string, source: NewsSource): string[] {
  if (!source.watch) throw new Error('未配置价格页提取规则')
  const $ = load(body)
  $('script,style,svg,nav,aside,button,iframe,[aria-hidden="true"]').remove()
  const root = $(source.watch.selector).first()
  if (!root.length) throw new Error('价格页结构已变化，已保留上次基线')
  for (const id of source.watch.excludeSections ?? []) {
    const heading = root.find(`[id="${id}"]`)
    heading.nextUntil('h2').remove()
    heading.remove()
  }
  let lines: string[]
  if (source.watch.tablesOnly) {
    lines = root.find('table').map((index, table) => $(table).find('tr').map((_, row) => `表 ${index + 1}：${$(row).find('th,td').map((_, cell) => clean($(cell).text())).get().join(' | ')}`).get()).get()
    if (!lines.length) throw new Error('未读取到价格表，已保留上次基线')
  } else {
    // Preserve meaningful block boundaries while ignoring HTML formatting changes.
    root.find('img[src]').each((_, image) => {
      const element = $(image)
      const raw = element.attr('src') ?? ''
      try {
        const url = new URL(raw, source.url)
        if (url.protocol === 'https:') element.replaceWith(`\n价目图：${url.origin}${url.pathname}\n`)
      } catch { element.remove() }
    })
    root.find('h1,h2,h3,h4,p,li,tr,div[data-as="p"],span[data-as="p"]').each((_, element) => { $(element).append('\n') })
    lines = root.text().split('\n').map(clean).filter(Boolean)
  }
  lines = lines.map(clean).filter(Boolean)
  const text = lines.join('\n')
  if (text.length < 50 || text.length > 100_000 || !/\d|\$|¥|免费|Free/i.test(text)) throw new Error('未读取到完整的价格额度正文，已保留上次基线')
  return lines
}

export function checkPricePage(body: string, source: NewsSource, previous: PriceBaseline | undefined, now: number): { baseline: PriceBaseline; item?: NewsItem } {
  const lines = priceSnapshot(body, source)
  const signature = createHash('sha256').update(JSON.stringify(source.watch)).digest('hex')
  // Updating an extractor must not masquerade as a change on the vendor website.
  if (previous?.signature !== signature) previous = undefined
  const hash = createHash('sha256').update(lines.join('\n')).digest('hex')
  const baseline: PriceBaseline = { hash, signature, lines, initializedAt: previous?.initializedAt ?? now, changedAt: previous?.changedAt }
  if (!previous || previous.hash === hash) return { baseline }
  baseline.changedAt = now
  const removed = previous.lines.filter(line => !lines.includes(line))
  const added = lines.filter(line => !previous.lines.includes(line))
  const excerpt = (values: string[]) => values.map(value => /^价目图[:：]/.test(value) ? '官方价目图片已更新，请打开原文核对' : value).join(' · ').slice(0, 450)
  const id = createHash('sha256').update(`${source.id}:${previous.hash}:${hash}:${now}`).digest('hex').slice(0, 24)
  return { baseline, item: {
    id, sourceId: source.id, topicId: source.topicId, relatedTopicIds: [source.topicId], stream: 'official',
    title: `${source.label} · 页面发现变更`, summary: '与上次成功检查相比，官方价格或额度规则页面的正文发生了变化。请以原文为准。',
    url: source.website, publishedAt: now, categories: ['pricing'], prerelease: false,
    change: { before: excerpt(removed), after: excerpt(added) },
  } }
}
