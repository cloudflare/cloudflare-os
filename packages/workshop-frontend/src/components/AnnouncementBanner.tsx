import { useState, useEffect, type CSSProperties } from 'react'
import { X } from '@phosphor-icons/react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { type BannerColor, DEFAULT_BANNER_COLOR } from '@gadgets/workshop-shared/api'
import { useServerConfig } from '../ServerConfigContext'

const DISMISS_KEY = 'dismissedBanner'

// Accent styles per color. Soft status tints (light background + accent text) so the banner doesn't
// read as an alert, plus a solid brand option.
const COLOR_STYLES: Record<BannerColor, CSSProperties> = {
  neutral: { background: 'var(--color-kumo-tint)', color: 'var(--text-color-kumo-default)' },
  info: { background: 'var(--color-kumo-info-tint)', color: 'var(--color-kumo-info)' },
  success: { background: 'var(--color-kumo-success-tint)', color: 'var(--color-kumo-success)' },
  warning: { background: 'var(--color-kumo-warning-tint)', color: 'var(--text-color-kumo-warning)' },
  danger: { background: 'var(--color-kumo-danger-tint)', color: 'var(--color-kumo-danger)' },
  brand: { background: 'var(--color-accent-100)', color: 'var(--text-color-kumo-inverse)' },
}

// Links inherit the banner's accent color and just underline.
const INLINE_MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <>{children}</>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline hover:opacity-80"
      style={{ color: 'inherit' }}
    >
      {children}
    </a>
  ),
}

/**
 * Deployment-wide full-width banner across the top of the app (logged in or not), configured by an
 * admin. Dismissible per-message: a changed banner re-appears after dismissal.
 */
export default function AnnouncementBanner() {
  const config = useServerConfig()
  const text = (config?.banner ?? '').trim()
  const color: BannerColor = config?.bannerColor ?? DEFAULT_BANNER_COLOR
  const [dismissed, setDismissed] = useState('')

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) ?? '')
    } catch {
      /* ignore */
    }
  }, [])

  if (!text || dismissed === text) return null

  const handleDismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, text)
    } catch {
      /* ignore */
    }
    setDismissed(text)
  }

  return (
    <div
      className="flex shrink-0 items-start gap-3 border-b border-kumo-line px-4 py-2.5"
      style={COLOR_STYLES[color] ?? COLOR_STYLES.info}
    >
      <div className="flex-1 text-sm leading-snug text-center [&_a]:font-medium">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={INLINE_MARKDOWN_COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
      <button
        onClick={handleDismiss}
        className="flex-shrink-0 rounded-md p-0.5 hover:bg-black/10 transition-colors"
        aria-label="Dismiss banner"
        title="Dismiss"
        style={{ color: 'inherit' }}
      >
        <X size={16} />
      </button>
    </div>
  )
}
