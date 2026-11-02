export type NewsCategory = 'model' | 'pricing' | 'client'

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
  title: string
  summary: string
  url: string
  publishedAt: number
  categories: NewsCategory[]
  prerelease: boolean
}

export interface NewsSourceStatus {
  id: string
  topicId: string
  label: string
  url: string
  status: 'ok' | 'error' | 'idle'
  checkedAt?: number
  updatedAt?: number
  itemCount: number
  error?: string
}

export interface NewsOverview {
  topics: NewsTopic[]
  followedTopicIds: string[]
  followingMode: 'accounts' | 'recommended' | 'custom'
  readIds: string[]
  items: NewsItem[]
  sources: NewsSourceStatus[]
}

export interface NewsPreferencesInput {
  followedTopicIds?: string[]
  useSuggested?: boolean
  readIds?: string[]
  unreadIds?: string[]
}
