import { Books, Clock, Globe, type Icon } from '@phosphor-icons/react'

// The built-in connections have no vendor logo; a glyph reads better than their initial.
const BUILT_IN_GLYPHS: Record<string, Icon> = { scheduler: Clock, websearch: Globe, context: Books }

export function GatekeeperIcon({
  vendorId,
  fallbackText,
  logoUrl,
  color,
  size = 16,
  className = 'h-8 w-8 rounded-lg',
}: {
  vendorId?: string
  /** Text whose first letter is shown when no logo is available (e.g. the resource title). */
  fallbackText?: string
  logoUrl?: string
  /**
   * The vendor's own background colour, from `VendorDescription.color`.
   *
   * Applied only behind a logo, never behind the initial fallback. Several vendor logos are
   * single-colour glyphs drawn for a specific backdrop — MCP's is white — so on the neutral tint they
   * disappear. An initial is text in a theme colour and reads correctly on the tint already.
   */
  color?: string
  size?: number
  className?: string
}) {
  const fallback = fallbackText || vendorId || '?'

  if (logoUrl) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center overflow-hidden ${className}`}
        style={{ backgroundColor: color ?? 'var(--color-kumo-tint)' }}
      >
        <img src={logoUrl} alt="" className="h-full w-full object-contain p-1" />
      </div>
    )
  }

  const Glyph = vendorId ? BUILT_IN_GLYPHS[vendorId] : undefined
  if (Glyph) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center text-kumo-default ${className}`}
        style={{ backgroundColor: 'var(--color-kumo-tint)' }}
      >
        <Glyph size={Math.max(14, Math.round(size * 0.95))} aria-hidden="true" />
      </div>
    )
  }

  return (
    <div
      className={`flex shrink-0 items-center justify-center ${className}`}
      style={{ backgroundColor: 'var(--color-kumo-tint)' }}
    >
      <span className="font-medium text-kumo-strong" style={{ fontSize: Math.max(11, Math.round(size * 0.7)) }}>
        {fallback[0].toUpperCase()}
      </span>
    </div>
  )
}
