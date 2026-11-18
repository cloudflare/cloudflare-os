import { useRef } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { EyedropperIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'

/** One of the colours offered, by what it is kept as: a hex colour, or `''` for the app's own. */
export type AccentColorPreset = { label: string; value: string }

export type AccentColorMenuProps = {
  /** The colour kept, as a hex colour, or `''` for the app's own. */
  value: string
  /** The colours offered, the app's own among them. */
  presets: AccentColorPreset[]
  /** What the app's own colour is, to draw it by. */
  defaultColor: string
  onChange: (value: string) => void
}

// A colour as a swatch: what it is drawn in is the colour itself, which is what is being chosen.
const Swatch = ({ color, large = false }: { color: string; large?: boolean }) => (
  <span aria-hidden="true" className={cn('rounded-full ring-1 ring-kumo-line ring-inset', large ? 'size-7' : 'size-4')} style={{ backgroundColor: color }} />
)

/**
 * A colour chosen from a few, or any other: a menu that says which, opening to the few as
 * swatches, which stays open so that each is seen as it is chosen, and under them the way to any
 * colour at all, which is the system's own colour picker.
 */
export const AccentColorMenu = ({ value, presets, defaultColor, onChange }: AccentColorMenuProps) => {
  const input = useRef<HTMLInputElement>(null)
  const chosen = presets.find((preset) => preset.value === value)
  const said = chosen?.label ?? value
  return (
    <>
      <DropdownMenu
        label={<><Swatch color={value || defaultColor} /><span className="min-w-0 truncate">{said}</span></>}
        aria-label={`Accent color: ${said}`}
        caret
        // A field's corners, as a `Select`'s: what is chosen from is filled in.
        triggerClassName="max-w-full min-w-0 shrink rounded-xl px-3 font-normal"
        align="end"
        inPlace
      >
        <DropdownMenu.SwatchGroup aria-label="Accent color" value={chosen ? value : ''} onValueChange={onChange}>
          {presets.map((preset) => (
            <DropdownMenu.Swatch key={preset.label} value={preset.value} label={preset.label}>
              <Swatch color={preset.value || defaultColor} large />
            </DropdownMenu.Swatch>
          ))}
        </DropdownMenu.SwatchGroup>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={EyedropperIcon} onSelect={() => input.current?.showPicker?.()}>Custom color…</DropdownMenu.Item>
      </DropdownMenu>
      <input
        // Started afresh from the colour kept, whatever was passed over in the picker before.
        key={value}
        ref={(element) => {
          input.current = element
          if (!element) return
          // The picker's closing on a colour, rather than each colour passed over on the way, which
          // is all React's own `onChange` hears.
          const chose = () => {
            if (element.value !== (value || defaultColor)) onChange(element.value)
          }
          element.addEventListener('change', chose)
          return () => element.removeEventListener('change', chose)
        }}
        type="color"
        defaultValue={value || defaultColor}
        // Out of sight: only its picker is seen.
        className="pointer-events-none absolute size-0 opacity-0"
        tabIndex={-1}
        aria-hidden="true"
      />
    </>
  )
}
