// The deployment's standard formats as rows in the composer's `+` menu.
//
// Picking one drops its name into the message at the caret (`onSelect`) rather than creating
// anything, and a request can name several, so this inserts rather than single-selects. A format
// that needs bindings wired up can't be expressed in a sentence, so it routes to the landing page.
//
// Returns null when the deployment promotes no formats, leaving the menu untouched.

import { DropdownMenu } from '@cloudflare/kumo'
import type { OutputFormatOffer } from '@gadgets/workshop-shared/api'
import { FormatGlyph } from './FormatVisuals'
import { useOutputFormats } from './useOutputFormats'

// Matches the surrounding items in the composer menu, which are quieter and rounder than the
// app-wide MENU_ITEM.
const COMPOSER_MENU_ITEM =
  '!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] ' +
  'text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default'

export default function ComposerFormatMenuItems({
  onSelect,
  showTrailingSeparator = false,
}: {
  onSelect: (format: OutputFormatOffer) => void
  showTrailingSeparator?: boolean
}) {
  const { formats, creating, create } = useOutputFormats()

  if (formats.length === 0) return null

  const choose = (format: OutputFormatOffer) =>
    format.requiresSetup ? create(format) : onSelect(format)

  return (
    <>
      <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase leading-4 tracking-[0.06em] text-kumo-inactive">
        Start with
      </p>
      {formats.map((format) => (
        <DropdownMenu.Item
          key={format.blueprintId}
          className={COMPOSER_MENU_ITEM}
          disabled={creating !== null}
          onClick={() => choose(format)}
        >
          <span className="mr-2 inline-flex h-4 w-4 items-center justify-center text-kumo-inactive">
            <FormatGlyph
              output={format.output}
              size="md"
              className={creating === format.blueprintId ? 'animate-pulse' : undefined}
            />
          </span>
          <span className="flex-1 truncate">
            {creating === format.blueprintId ? 'Creating…' : format.output.noun}
          </span>
        </DropdownMenu.Item>
      ))}
      {showTrailingSeparator && <div className="my-1 border-t border-kumo-line/70" />}
    </>
  )
}
