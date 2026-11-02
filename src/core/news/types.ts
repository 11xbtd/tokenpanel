export type NewsCategory = 'model' | 'pricing' | 'client' | 'related'
export type NewsStream = 'official' | 'media'

export interface NewsTopic {
  id: string
  label: string
  kind: 'vendor' | 'tool'
  providerId: string
  description: string
}

export interface NewsItem {
  id: string
  sourceId: string
  topicId: string
  relatedTopicIds: string[]
  stream: NewsStream
  title: string
  summary: string
  url: string
  publishedAt: number
  categories: NewsCategory[]
  prerelease: boolean
  change?: { before: string; after: string }
}

export interface NewsSourceStatus {
  id: string
  topicId: string
  stream: NewsStream
  label: string
  url: string
  status: 'ok' | 'error' | 'idle'
  checkedAt?: number
  updatedAt?: number
  itemCount: number
  error?: string
  isMonitor?: boolean
  note?: string
  monitor?: { initializedAt: number; changedAt?: number }
}

export interface NewsOverview {
  stream: NewsStream
  topics: NewsTopic[]
  followedTopicIds: string[]
  followingMode: 'accounts' | 'recommended' | 'custom'
  readIds: string[]
  items: NewsItem[]
  sources: NewsSourceStatus[]
}

export interface NewsPreferencesInput {
  stream?: NewsStream
  followedTopicIds?: string[]
  useSuggested?: boolean
  readIds?: string[]
  unreadIds?: string[]
}
