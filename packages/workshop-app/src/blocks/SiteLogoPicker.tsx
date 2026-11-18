import { useRef } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowCounterClockwiseIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LogoIcon } from '@/components/LogoIcon'

export type SiteLogoPickerProps = {
  /** The deployment's own logo, or none for the app's. */
  src?: string
  /** A new logo is on its way, or the old one is going. */
  busy?: boolean
  onChoose: (file: File) => void
  /** Takes the deployment's logo away, which goes back to the app's. */
  onRestore: () => void
}

/**
 * The deployment's logo on a tile, as an app's icon is, which opens the ways to change it when
 * clicked, as the user's picture does: choosing an image from the device, and going back to the
 * app's own mark from one of the deployment's.
 */
export const SiteLogoPicker = ({ src, busy = false, onChoose, onRestore }: SiteLogoPickerProps) => {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <DropdownMenu
        // In a span, so that it keeps its own size rather than taking the Button's size for an icon.
        icon={(
          <span className={cn('grid size-12 place-items-center rounded-[0.875rem] bg-kumo-base text-[1.75rem] ring-1 ring-kumo-line', busy && 'opacity-50')}>
            {src ? <img src={src} alt="" className="size-3/4 object-contain" /> : <LogoIcon />}
          </span>
        )}
        aria-label="Logo"
        triggerVariant="ghost"
        // A surface when pointed at, whose room is taken back out, so that the tile is where one
        // that cannot be changed would be.
        triggerClassName="-m-1.5 h-auto w-auto rounded-[1.25rem] p-1.5 not-data-disabled:hover:bg-kumo-contrast/5 data-popup-open:bg-kumo-contrast/5"
        keepTrigger
        align="end"
      >
        <DropdownMenu.Item icon={UploadSimpleIcon} disabled={busy} onSelect={() => input.current?.click()}>Upload</DropdownMenu.Item>
        <DropdownMenu.Item icon={ArrowCounterClockwiseIcon} disabled={busy || !src} onSelect={onRestore}>Restore default</DropdownMenu.Item>
      </DropdownMenu>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        hidden
        // The menu's item is what is reached and named.
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Emptied, so that choosing the same image again is still a change.
          event.target.value = ''
          if (file) onChoose(file)
        }}
      />
    </>
  )
}
