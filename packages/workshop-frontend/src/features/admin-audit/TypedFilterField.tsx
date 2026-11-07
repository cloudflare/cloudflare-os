import { useState, type KeyboardEvent } from 'react'
import { Autocomplete } from '@cloudflare/kumo'

/**
 * A filter typed as a user id, with `suggestions` offered as it is typed in. It applies on Enter or
 * once a suggestion is picked; applying nothing clears it, and Escape abandons what was typed. Once `value` changes from elsewhere (a
 * name picked in the log), or `clears` grows (every filter cleared), the field shows `value`,
 * whatever was typed and not applied.
 */
export const TypedFilterField = ({ label, placeholder, value, clears, suggestions, onApply }: {
  label: string
  placeholder: string
  value: string | undefined
  clears: number
  suggestions: string[]
  onApply: (value: string | undefined) => void
}) => {
  // What is typed, for the value and the clear it was typed over. Dropped as soon as either changes,
  // during that render, so coming back to an earlier value does not bring back what was typed.
  const [typed, setTyped] = useState({ over: value, clears, text: value ?? '' })
  if (typed.over !== value || typed.clears !== clears) setTyped({ over: value, clears, text: value ?? '' })
  const shown = typed.over === value && typed.clears === clears ? typed.text : (value ?? '')

  const apply = (text: string) => {
    const applied = text.trim() || undefined
    setTyped({ over: applied, clears, text: applied ?? '' })
    onApply(applied)
  }
  // Base UI gives the Autocomplete a hidden text input of its own, and a form of several text
  // inputs and no submit button is never submitted by Enter, so the key is handled here. While a
  // suggestion is highlighted, Enter picks it instead.
  const applyOnEnter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    if (event.target instanceof HTMLElement && event.target.getAttribute('aria-activedescendant')) return
    event.preventDefault()
    apply(shown)
  }

  return (
    <div onKeyDown={applyOnEnter}>
      <Autocomplete<string>
        label={label}
        items={suggestions}
        value={shown}
        onValueChange={(text, { reason }) => {
          // Escape, with the list closed, asks to empty the field: it abandons what was typed
          // instead, showing the filter applied, so the field never says "any" while the log is
          // filtered.
          if (reason === 'escape-key') {
            setTyped({ over: value, clears, text: value ?? '' })
            return
          }
          setTyped({ over: value, clears, text })
          if (reason === 'item-press') apply(text)
        }}
      >
        <Autocomplete.InputGroup placeholder={placeholder} />
        <Autocomplete.Content>
          <Autocomplete.List>
            {(suggestion: string) => (
              <Autocomplete.Item key={suggestion} value={suggestion}>{suggestion}</Autocomplete.Item>
            )}
          </Autocomplete.List>
        </Autocomplete.Content>
      </Autocomplete>
    </div>
  )
}
