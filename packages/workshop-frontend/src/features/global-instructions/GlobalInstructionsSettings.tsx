import { Button, Textarea } from '@cloudflare/kumo'
import { useEffect, useRef, useState } from 'react'
import { MAX_GLOBAL_INSTRUCTIONS_LENGTH } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'

const GlobalInstructionsEditor = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    setSaved(null)
    setDraft('')
    setError(null)
    authenticatedApi.getOwnGlobalInstructions().then(value => {
      if (cancelled) return
      setSaved(value)
      setDraft(value)
    }).catch(() => {
      if (!cancelled) setError('Could not load your global instructions. Try again.')
    })
    return () => { cancelled = true }
  }, [authenticatedApi, loadAttempt])

  const save = async (value: string) => {
    if (saving || value.length > MAX_GLOBAL_INSTRUCTIONS_LENGTH) return
    setSaving(true)
    setError(null)
    setStatus('')
    try {
      await authenticatedApi.setOwnGlobalInstructions(value)
      if (!mounted.current) return
      setSaved(value)
      setDraft(value)
      setConfirmClear(false)
      setStatus(value ? 'Saved. Applies to your next agent turn.' : 'Global instructions cleared.')
    } catch {
      if (mounted.current) setError('Could not save your global instructions. Your edits are still here.')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const tooLong = draft.length > MAX_GLOBAL_INSTRUCTIONS_LENGTH
  const limit = MAX_GLOBAL_INSTRUCTIONS_LENGTH.toLocaleString()
  return (
    <section className="flex flex-col gap-3" aria-labelledby="global-instructions-heading">
      <h2 id="global-instructions-heading" className="px-1 text-xs font-medium uppercase tracking-wide text-kumo-subtle">
        Personal global instructions
      </h2>
      <div className="flex flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
        <p id="global-instructions-description" className="text-sm text-kumo-subtle">
          Defaults for your agent turns across workspaces. Task instructions and deployment policy take precedence.
        </p>
        <p className="text-sm text-kumo-subtle">
          Private to your account, but the model receives it and may disclose it in shared outputs. Do not store secrets here.
        </p>
        {saved === null ? (
          error ? <Button onClick={() => setLoadAttempt(n => n + 1)}>Retry loading instructions</Button>
            : <p role="status" className="text-sm text-kumo-subtle">Loading instructions…</p>
        ) : (
          <>
            <Textarea
              aria-label="Personal global instructions"
              aria-describedby="global-instructions-description global-instructions-limit"
              className="w-full"
              rows={8}
              value={draft}
              onValueChange={value => { setDraft(value); setStatus(''); setConfirmClear(false) }}
              disabled={saving}
              placeholder="For example: Use British English and keep summaries concise."
              error={tooLong ? `Reduce to ${limit} characters or fewer.` : undefined}
            />
            <p id="global-instructions-limit" className="text-xs text-kumo-subtle">
              {draft.length.toLocaleString()} / {limit} characters. Saves apply to future turns.
              Long instructions may exceed smaller models’ budgets; they are never truncated.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" loading={saving} disabled={saving || tooLong || draft === saved}
                onClick={() => save(draft)}>Save instructions</Button>
              <Button variant="ghost" disabled={saving || draft === saved}
                onClick={() => { setDraft(saved); setError(null); setStatus(''); setConfirmClear(false) }}>
                Discard edits
              </Button>
              <Button variant="ghost" disabled={saving || saved === ''}
                onClick={() => setConfirmClear(true)}>Clear saved instructions</Button>
            </div>
            {confirmClear && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-kumo-subtle">Remove your saved instructions from future turns?</p>
                <Button variant="destructive" disabled={saving} onClick={() => save('')}>Confirm clear</Button>
                <Button variant="ghost" disabled={saving} onClick={() => setConfirmClear(false)}>Cancel</Button>
              </div>
            )}
          </>
        )}
        {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
        {status && <p role="status" className="text-sm text-kumo-subtle">{status}</p>}
      </div>
    </section>
  )
}

/** A reconnect must confirm the account before mounting its private editor state. */
export const GlobalInstructionsSettings = () => {
  const { currentUser, isCurrentUserConfirmed } = useAuthenticatedApi()
  if (!isCurrentUserConfirmed || !currentUser) return null
  return <GlobalInstructionsEditor key={currentUser.id} />
}
