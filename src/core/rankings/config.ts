// Injected into the Node server and uTools preload during builds, never into renderer assets.
declare const __TOKENPANEL_AA_SHARED_API_KEY__: string

export function defaultRankingsApiKey(): string {
  return process.env.TOKENPANEL_AA_SHARED_API_KEY?.trim()
    ?? (typeof __TOKENPANEL_AA_SHARED_API_KEY__ === 'string' ? __TOKENPANEL_AA_SHARED_API_KEY__ : '')
}
