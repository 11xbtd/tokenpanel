const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g,
  /nap_[A-Za-z0-9_-]{8,}/g,
  /fd-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /Cookie:\s*[^\s,;]{8,}/gi,
  /session[A-Za-z0-9._-]{16,}/gi,
]

export function redact(input: unknown, maxLength = 300): string {
  let text = typeof input === 'string' ? input : input instanceof Error ? input.message : String(input ?? '')
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[已脱敏]')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…`
  return text
}

export function maskSecret(value: string | undefined): string {
  if (!value) return ''
  const trimmed = value.trim()
  if (trimmed.length <= 8) return '••••••'
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`
}
