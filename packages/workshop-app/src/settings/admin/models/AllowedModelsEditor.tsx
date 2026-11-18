import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { XIcon } from '@phosphor-icons/react'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'
import { Button } from '@/components/Button'
import { TextField } from '@/components/TextField'
import { addAllowedNames, PROVIDER_LABELS, type AllowedModelSuggestion } from './modelForm'

const POOL_DOCS = 'https://developers.cloudflare.com/ai-gateway/features/auto-router/#models'

const refusedProblem = (name: string) =>
  `“${name}” is not a gateway model name. Name each as provider/model, like anthropic/claude-sonnet-5.5, or a provider’s every model, like anthropic/*.`

export type AllowedModelsEditorProps = {
  modelName: string
  /** The list the server holds, or nothing while the router picks among the providers that are on. */
  allowedModels: string[] | undefined
  /** The providers that are on, whose models the router picks among while it lists none. */
  providers: readonly AiModelProvider[]
  /** The names offered as one is typed. Any other gateway name can still be added as typed. */
  suggestions: readonly AllowedModelSuggestion[]
  busy: boolean
  /** Keeps the list, or nothing to list none. Resolves to whether it was kept. */
  onSave: (allowedModels: string[] | undefined) => Promise<boolean>
}

/**
 * The gateway models the Auto Router model may pick, each a line with the way to take it out,
 * over a field to add another by, offered from the names that are known: Enter or a comma adds
 * what was typed, a list at once. Kept on Save. None listed leaves the router every model of the
 * providers that are on, which it says. Ported from `workshop-frontend`'s `AllowedModelsField`,
 * with the browser's own suggestions in place of its list box.
 */
export const AllowedModelsEditor = ({ modelName, allowedModels, providers, suggestions, busy, onSave }: AllowedModelsEditorProps) => {
  // What is listed here before it is kept, or nothing while it is the server's list.
  const [draft, setDraft] = useState<string[]>()
  const [typed, setTyped] = useState('')
  const [problem, setProblem] = useState<string>()
  const suggestionsId = useId()
  const names = draft ?? allowedModels ?? []
  const changed = draft !== undefined && draft.join(',') !== (allowedModels ?? []).join(',')

  // Adds what `text` names, leaving in the field what is not a name, under why.
  const add = (text: string) => {
    const { names: next, refused } = addAllowedNames(names, text)
    if (next.length !== names.length) setDraft(next)
    setTyped(refused.join(', '))
    setProblem(refused[0] === undefined ? undefined : refusedProblem(refused[0]))
    return refused.length === 0 ? next : undefined
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const list = typed.trim() ? add(typed) : names
    if (!list) return
    if (await onSave(list.length > 0 ? list : undefined)) setDraft(undefined)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    // Enter with something typed adds it; with nothing, it saves the list, as the form's.
    if (event.key === 'Enter' && typed.trim()) {
      event.preventDefault()
      add(typed)
    }
    if (event.key === 'Backspace' && typed === '' && names.length > 0) setDraft(names.slice(0, -1))
  }

  return (
    <form noValidate onSubmit={(event) => void save(event)} className="flex flex-col gap-3">
      <p className="font-medium text-kumo-default">Allowed models</p>
      {names.length > 0 && (
        <ul aria-label={`Allowed models of ${modelName}`} className="flex flex-col rounded-2xl bg-kumo-tint p-1.5">
          {names.map((name) => (
            <li key={name} className="flex min-h-(--control-size) items-center gap-2 ps-3">
              <span className="min-w-0 flex-1 font-mono text-sm wrap-anywhere text-kumo-default">{name}</span>
              <Button variant="ghost" icon={<XIcon weight="bold" />} aria-label={`Take ${name} out`} disabled={busy} className="text-kumo-subtle" onClick={() => setDraft(names.filter((other) => other !== name))} />
            </li>
          ))}
        </ul>
      )}
      <TextField
        aria-label={`Add an allowed model to ${modelName}`}
        list={suggestionsId}
        placeholder={names.length > 0 ? 'Add a model' : 'Every model of the providers that are on'}
        value={typed}
        invalid={problem !== undefined}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        onKeyDown={onKeyDown}
        onValueChange={(text) => {
          setProblem(undefined)
          // A comma ends a name, so a typed or pasted list is added as it comes.
          if (text.includes(',')) {
            const cut = text.lastIndexOf(',')
            add(text.slice(0, cut))
            setTyped((left) => [left, text.slice(cut + 1).trimStart()].filter(Boolean).join(', '))
          } else setTyped(text)
        }}
      />
      <datalist id={suggestionsId}>
        {suggestions.filter(({ name }) => !names.includes(name)).map(({ name, description }) => <option key={name} value={name}>{description}</option>)}
      </datalist>
      <p className="text-sm text-kumo-subtle">
        {problem && <span role="alert" className="block text-kumo-danger">{problem}</span>}
        {providers.length > 0
          ? <>With none listed, Auto picks from every model of the providers that are on ({providers.map((provider) => PROVIDER_LABELS[provider]).join(', ')}) in <a href={POOL_DOCS} target="_blank" rel="noreferrer" className="underline">Cloudflare’s model pool</a>.</>
          : <>No provider is on for Auto to pick from: turn one on under Providers.</>}
        {' '}Disabling a model doesn’t take it out of the pool; listing does. After saving, test it: a name the gateway doesn’t know fails every request.
      </p>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || (!changed && !typed.trim())}>Save</Button>
        {allowedModels !== undefined && (
          <Button variant="ghost" disabled={busy} onClick={() => void onSave(undefined).then((done) => done && setDraft(undefined))}>Reset</Button>
        )}
      </div>
    </form>
  )
}
