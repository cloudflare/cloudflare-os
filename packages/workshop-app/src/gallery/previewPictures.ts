// Pictures of made-up gadget screens, for the gallery's blueprints: a title bar, a heading and a
// few rows, in the colours given, drawn as an SVG so that nothing is fetched.
const screen = (accent: string, surface: string, rows: number) => {
  const lines = Array.from({ length: rows }, (_, row) => {
    const y = 300 + row * 92
    return `<rect x="96" y="${y}" width="1088" height="64" rx="16" fill="#ffffff" fill-opacity="0.9"/><rect x="128" y="${y + 22}" width="${360 + ((row * 173) % 420)}" height="20" rx="10" fill="${accent}" fill-opacity="0.35"/>`
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"><rect width="1280" height="800" fill="${surface}"/><rect width="1280" height="72" fill="#ffffff" fill-opacity="0.7"/><circle cx="48" cy="36" r="10" fill="${accent}"/><rect x="96" y="150" width="520" height="56" rx="14" fill="${accent}"/><rect x="96" y="222" width="320" height="22" rx="11" fill="${accent}" fill-opacity="0.4"/>${lines}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** A tip jar's screen, in warm orange. */
export const PREVIEW_TIP_JAR = screen('#f6821f', '#fff4e8', 4)
/** A standup board's screen, in blue. */
export const PREVIEW_STANDUP = screen('#2c7cb0', '#eaf3fa', 5)
/** A budget's screen, in green. */
export const PREVIEW_BUDGET = screen('#2f8f5b', '#eaf6ef', 3)
