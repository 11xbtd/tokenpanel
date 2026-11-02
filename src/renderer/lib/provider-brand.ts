/** 浅色模式取内置彩色标识的原色；深色模式提高亮度，保留同一色相。 */
const PALETTES = {
  deepseek: ['#4d6bfe', '#91a2ff'],
  kimi: ['#121212', '#e4e4e7'],
  stepfun: ['#0160ff', '#78a5ff'],
  ai302: ['#8e47ff', '#bc95ff'],
  aihubmix: ['#006ffb', '#83b1ff'],
  novita: ['#23d57c', '#62eaa4'],
  openrouter: ['#c8ff00', '#c8ff00'],
  neutral: ['#424b59', '#d0d8e5'],
  openai: ['#10a37f', '#62d2b2'],
  claude: ['#d97757', '#eda58a'],
  glm: ['#504af4', '#a39bff'],
  minimax: ['#e2167e', '#fa83b9'],
  newapi: ['#c738fb', '#df98ff'],
  gemini: ['#3186ff', '#8bb4ff'],
  groq: ['#f55036', '#ff9a87'],
  aliyun: ['#7347ff', '#b49bff'],
  volcengine: ['#006eff', '#86adff'],
  baidu: ['#2464f5', '#91a6ff'],
  tencent: ['#0055e9', '#83b5ff'],
  sensenova: ['#5b2ad8', '#af91f5'],
  together: ['#ef2cc1', '#fa8cde'],
  fireworks: ['#5019c5', '#af8aef'],
  mistral: ['#ff8205', '#ffb15f'],
} satisfies Record<string, [string, string]>

const PROVIDER_PALETTES: Record<string, keyof typeof PALETTES> = {
  deepseek: 'deepseek',
  'kimi-cn': 'kimi',
  'kimi-global': 'kimi',
  'kimi-code-plan': 'kimi',
  stepfun: 'stepfun',
  '302ai': 'ai302',
  aihubmix: 'aihubmix',
  novita: 'novita',
  openrouter: 'openrouter',
  xai: 'neutral',
  'openai-usage': 'openai',
  'codex-plan': 'openai',
  'anthropic-usage': 'claude',
  'claude-plan': 'claude',
  'glm-plan': 'glm',
  'zhipu-balance': 'glm',
  'zai-plan': 'neutral',
  'minimax-plan': 'minimax',
  'minimax-balance': 'minimax',
  newapi: 'newapi',
  'opencode-go': 'neutral',
  'opencode-balance': 'neutral',
  gemini: 'gemini',
  groq: 'groq',
  'aliyun-bailian': 'aliyun',
  'volcengine-ark': 'volcengine',
  'baidu-qianfan': 'baidu',
  'tencent-hunyuan': 'tencent',
  sensenova: 'sensenova',
  together: 'together',
  fireworks: 'fireworks',
  mistral: 'mistral',
}

export function providerColor(providerId: string, dark = false, fallback = 'var(--accent)'): string {
  const palette = PROVIDER_PALETTES[providerId]
  return palette ? PALETTES[palette][dark ? 1 : 0] : fallback
}

/** 荧光品牌色用于识别装饰；白底上的走势与操作文字使用同色相的深色。 */
export function providerInkColor(providerId: string, dark = false, fallback = 'var(--accent)'): string {
  if (dark && PROVIDER_PALETTES[providerId] === 'openrouter') return '#b3d84c'
  if (!dark) {
    const palette = PROVIDER_PALETTES[providerId]
    if (palette === 'openrouter') return '#617b00'
    if (palette === 'novita') return '#13814c'
    if (palette === 'mistral') return '#b55b00'
  }
  return providerColor(providerId, dark, fallback)
}
