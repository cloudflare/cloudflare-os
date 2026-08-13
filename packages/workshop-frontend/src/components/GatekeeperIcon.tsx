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
