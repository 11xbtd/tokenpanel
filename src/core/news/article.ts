import { load } from 'cheerio/slim'
import type { NewsSource } from './catalog'

const BLOCK_TAGS = 'p,li,div,h1,h2,h3,h4,h5,blockquote,tr,td,section,article,ul,ol'
/** 正文至少要有这么多字才算抓到，否则多半是站点返回的提示页。 */
export const ARTICLE_BODY_MIN = 60

/** 保留段落换行的纯文本，用于在工具内展示正文。 */
export function richText(value: string, max = 6000): string {
  const $ = load(value, { xml: false })
  $('script,style,iframe,svg,noscript').remove()
  $('br').replaceWith('\n')
  $(BLOCK_TAGS).each((_, element) => { $(element).append('\n') })
  const text = $.root().text()
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    // 原文里被转义过的标签会变成文本，剔除后正文才干净。
    .replace(/<\s*\/?\s*[a-z][a-z0-9]*\b[^<>]{0,300}>/gi, '')
    .split('\n')
    .map(line => line.replace(/[ \t\u3000]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 从原文页面取正文；先按来源配置的选择器，再逐个兜底，避免站点临时反爬时取不到。 */
export function extractArticle(html: string, source: NewsSource): { title: string; content: string } {
  const $ = load(html)
  $('script,style,iframe,svg,noscript').remove()
  const title = $('h1').first().text().trim()
  const selectors = [source.articleSelector, 'article', '.article', '.post_content', '.post-content', '.content', 'main']
  for (const selector of selectors) {
    if (!selector) continue
    const node = $(selector).first()
    if (!node.length) continue
    const content = richText(node.html() ?? '', 20000)
    if (content.length >= ARTICLE_BODY_MIN) return { title, content }
  }
  return { title, content: '' }
}
