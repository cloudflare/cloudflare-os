import { useState, type ReactNode } from 'react'
import styles from './transcript.module.css'

/**
 * One row of the transcript. A row that arrives while the chat is open (`live` when it first
 * renders) opens into place (see `.entryIn`); rows already there when the chat is opened, or
 * paged in above, simply appear.
 */
export function LiveEntry({ live, children }: { live: boolean; children: ReactNode }) {
  const [opening, setOpening] = useState(live)
  return (
    <div
      className={opening ? styles.entryIn : undefined}
      onAnimationEnd={opening ? (event) => {
        if (event.target === event.currentTarget) setOpening(false)
      } : undefined}
    >
      {children}
    </div>
  )
}
