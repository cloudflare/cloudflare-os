import type { CSSProperties } from 'react'

/**
 * A one-colour icon from an image's address, drawn in the text's colour as a Phosphor icon is, so
 * that it is subtle, current or pointed at as the icons beside it are. As big as one of those.
 */
export const MaskIcon = ({ src }: { src: string }) => {
  // Quoted and escaped, as it goes into `url("…")`.
  const mask = `url("${src.replace(/[\\"]/g, '\\$&')}") center / contain no-repeat`
  const style: CSSProperties = { mask, WebkitMask: mask }
  return <span aria-hidden="true" className="size-[1.125em] shrink-0 bg-current" style={style} />
}
