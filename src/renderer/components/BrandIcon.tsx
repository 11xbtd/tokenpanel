import { BRAND_ICONS } from '../lib/brands'
import { providerColor } from '../lib/provider-brand'
import { useDark } from '../lib/theme'

/**
 * 彩色标识保留原色，并放在独立底板上；单色图标走 CSS mask 上色，保证深色底也能看清；
 * 没有对应图标时回退成账户名首字母，不拿别的品牌图凑数。
 */
export function BrandIcon({
  providerId,
  label,
  color,
  size = 36,
  radius = 10,
}: {
  providerId: string
  label: string
  color?: string
  size?: number
  radius?: number
}) {
  const mark = BRAND_ICONS[providerId]
  const dark = useDark()
  const glyph = Math.round(size * 0.62)
  const tint = providerColor(providerId, dark, mark?.tint ?? color)
  const tile = providerId === 'openrouter' || providerId === 'novita'
    ? '#18231e'
    : mark && !mark.mono ? '#ffffff' : `color-mix(in srgb, ${tint} 12%, var(--surface))`
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: tile,
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--text) 6%, transparent)',
        color: tint,
      }}
    >
      {mark ? (
        mark.mono ? (
          <span
            aria-hidden="true"
            style={{
              width: glyph,
              height: glyph,
              background: tint,
              maskImage: `url("${mark.src}")`,
              WebkitMaskImage: `url("${mark.src}")`,
              maskSize: 'contain',
              WebkitMaskSize: 'contain',
              maskRepeat: 'no-repeat',
              WebkitMaskRepeat: 'no-repeat',
              maskPosition: 'center',
              WebkitMaskPosition: 'center',
            }}
          />
        ) : (
          <img src={mark.src} alt="" width={glyph + 2} height={glyph + 2} style={{ objectFit: 'contain' }} />
        )
      ) : (
        <span className="text-[13px] font-semibold" style={{ fontSize: Math.round(size * 0.38) }}>
          {label.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  )
}
