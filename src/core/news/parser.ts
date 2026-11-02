import { createHash } from 'node:crypto'
import { load } from 'cheerio/slim'
import type { NewsSource } from './catalog'
import { matchingNewsTopics, NEWS_TOPICS } from './catalog'
import type { NewsCategory, NewsItem } from './types'

function plain(value: string, max = 180): string {
  const $ = load(value, { xml: false })
  $('script,style,iframe,svg').remove()
  const text = $.root().text().replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function officialNewsUrl(value: string, source: NewsSource): string | undefined {
  try {
    if (!value || typeof value !== 'string' || !value.trim()) return undefined
    const url = new URL(value, source.url)
    if (url.protocol !== 'https:' || url.username || url.password || !source.allowedHosts.includes(url.hostname)) return undefined
    if (source.releasePrefix && !url.pathname.toLowerCase().startsWith(source.releasePrefix.toLowerCase())) return undefined
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key)
    url.pathname = url.pathname.replace(/\/$/, '') || '/'
    return url.href
  } catch { return undefined }
}

export function newsCategories(title: string, summary: string, client = false): NewsCategory[] {
  if (client) return ['client']
  title = title.replace(/[\u2010-\u2015\u2212]/g, '-')
  summary = summary.replace(/[\u2010-\u2015\u2212]/g, '-')
  const text = `${title} ${summary}`
  const categories: NewsCategory[] = []
  const pricingText = text.replace(/\b(?:pricing|prices?|quotas?|rate limits?)\s+(?:(?:will|remains?|are|is|stay(?:s)?|the)\s+)*(?:unchanged|same)\b/gi, '').replace(/(?:价格|定价|额度|配额)(?:保持|维持|仍然|均|暂)?不变/g, '')
  if (/\b(pric(?:e|es|ing)|quota|rate[- ]limits?|usage limits?|billing|discount|subscription)\b|价格|定价|降价|涨价|额度|配额|计费|订阅|资费|限额|限速|(?:\d+\s*(?:小时|天|周)|用量|使用|速率|请求|调用|token).{0,12}(?:限制|上限)/i.test(pricingText) || /\bcredits?\s+(?:for|in|on)\s+(?:codex|chatgpt|claude)\b/i.test(pricingText)) categories.push('pricing')
  const editorial = /model spec|system card|public benefit|\bIPO\b|\bS-1\b|\b(uses|helps|case study|responsibly|safely)\b|^how\b/i.test(title)
  const modelName = /\b(gpt[-\s]?\d|o[1345](?:\b|-)|gemini\s*\d|claude\s+(?:opus|sonnet|haiku)|kimi[-\s]?k\d|deepseek[-\s]?v\d|minimax[-\s]?(?:m|h|speech|music)\s*\d)/i
  const releaseHeading = /^(introducing|announcing|meet|new|launch|gpt|gemini|claude|kimi|deepseek|minimax|openai\s+o[1345])|\b(release|launch|update|available)\b|发布|推出|上线|更新/i.test(title)
  if (!editorial && ((modelName.test(title) && releaseHeading) || /\b(introducing|launch|release|new|update)[^.!?]{0,55}\bmodels?\b|模型发布|新模型|模型更新/i.test(title))) categories.push('model')
  if (!editorial && (releaseHeading || /^(codex|claude code|kimi code|opencode)\b/i.test(title)) && /\b(codex|claude code|kimi code|opencode|desktop|cli|mini app|browser extension)\b|客户端|桌面端|命令行|工具更新/i.test(title)) categories.push('client')
  return categories
}

export function parseNews(body: string, source: NewsSource, now = Date.now()): NewsItem[] {
  const result = new Map<string, NewsItem>()
  const client = Boolean(source.releasePrefix)
  const add = (rawTitle: string, rawUrl: string, rawDate: string, rawSummary = '') => {
    let title = plain(rawTitle, 220)
    const url = officialNewsUrl(rawUrl, source)
    const publishedAt = Date.parse(/^\d{4}-\d\d-\d\d$/.test(rawDate.trim()) ? `${rawDate.trim()}T00:00:00Z` : rawDate)
    if (!title || !url || !Number.isFinite(publishedAt) || publishedAt > now + 86_400_000) return
    let summary = plain(rawSummary)
    if (client && summary.toLowerCase().replace(/^release:\s*/, '') === title.toLowerCase()) summary = ''
    const stream = source.stream ?? 'official'
    const relatedTopicIds = stream === 'official' ? [source.topicId] : matchingNewsTopics(`${title} ${plain(rawSummary, 1800)}`)
    if (!relatedTopicIds.length) return
    const categories = newsCategories(title, plain(rawSummary, 1800), client)
    if (!categories.length && stream !== 'official') categories.push('related')
    if (source.parser === 'minimax-notes' && !categories.includes('model')) categories.push('model')
    if (categories.length === 0) return
    const prerelease = client && /(?:alpha|beta|canary|nightly|preview|(?:^|[.-])rc)(?:[.\d-]|$)/i.test(title)
    if (client) {
      title = title.replace(/^@moonshot-ai\/kimi-code@/, '')
      title = `${NEWS_TOPICS.find(topic => topic.id === source.topicId)?.label ?? source.topicId} ${title}`
    }
    const id = createHash('sha256').update(url).digest('hex').slice(0, 24)
    const topicId = stream === 'official' ? source.topicId : relatedTopicIds.find(id => NEWS_TOPICS.find(topic => topic.id === id)?.kind === 'tool') ?? relatedTopicIds[0]
    result.set(id, { id, sourceId: source.id, topicId, relatedTopicIds, stream, title, summary, url, publishedAt, categories, prerelease })
  }

  if (source.parser === 'feed') {
    const $ = load(body, { xml: true })
    if (!$('rss,feed').length) throw new Error('来源未返回可识别的 RSS / Atom 内容')
    $('item,entry').slice(0, 500).each((_, element) => {
      const item = $(element)
      const link = item.children('link[rel="alternate"]').attr('href') ?? item.children('link').attr('href') ?? item.children('link').text()
      const description = item.children('description,summary,content').first().text()
      const summary = client ? (() => {
        const html = load(description)
        return html('li').slice(0, 2).map((_, el) => html(el).text().trim().replace(/^#\d+\s+[a-f0-9]{7,40}\s+Thanks\s+@[\w-]+!\s*[-–:]\s*/i, '').replace(/ by @.*$/, '').replace(/\s*\(#[\d,\s#]+\)\s*$/, '')).get().join(' · ') || html.root().text().replace(/^(What.s Changed|New Features|What.s changed)\s*/i, '')
      })() : description
      add(item.children('title').text(), link, item.children('pubDate,published,updated').first().text(), summary)
    })
  } else {
    const $ = load(body)
    if (source.parser === 'minimax') {
      $('a[href*="/blog/"]').each((_, element) => {
        const item = $(element)
        const time = item.find('time').first()
        add(item.find('h2,h3').first().text(), item.attr('href') ?? '', time.attr('datetime') ?? time.text(), item.find('p').first().text())
      })
    } else if (source.parser === 'kimi') {
      $('.menu-card').each((_, element) => {
        const item = $(element)
        add(item.find('.card-title').text(), item.find('a[href]').first().attr('href') ?? '', item.find('.card-date').text())
      })
    } else if (source.parser === 'anthropic') {
      $('main article').each((_, element) => {
        const item = $(element)
        const heading = item.find('h2,h3,h4').first()
        const link = heading.closest('a[href]')
        const time = item.find('time').first()
        add(heading.text(), link.attr('href') ?? '', time.attr('datetime') ?? time.text(), link.find('p').first().text())
      })
    } else if (source.parser === 'minimax-notes') {
      $('.mdx-content h4').each((_, element) => {
        const heading = $(element)
        const date = heading.text().replace(/[\u200b-\u200d\ufeff]/g, '').trim()
        // Month-only entries have no exact publication date; do not invent a day.
        if (!/\b\d{1,2},\s*\d{4}$/.test(date)) return
        const card = heading.next()
        add(card.find('h2').first().text(), `${source.website}#${heading.attr('id') ?? ''}`, date, card.find('[data-as="p"],p').first().text())
      })
    } else if (source.parser === 'deepseek') {
      let date = ''
      $('article h2,article h3').each((_, element) => {
        const heading = $(element)
        if (element.name === 'h2') {
          date = heading.text().match(/\d{4}-\d\d-\d\d/)?.[0] ?? ''
          if (heading.nextUntil('h2').filter('h3').length) return
        }
        const title = element.name === 'h3' ? heading.clone().find('a').remove().end().text() : `DeepSeek 更新 · ${date}`
        const summary = heading.nextUntil('h2,h3').text()
        add(title, `${source.website}#${heading.attr('id') ?? ''}`, date, summary)
      })
    }
    // A changed page layout should retain the last good cache and surface an error.
    if (result.size === 0) throw new Error('未解析到可识别的带日期动态，已保留上次结果')
  }
  return [...result.values()].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 60)
}
