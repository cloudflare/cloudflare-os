import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { MAX_ISSUE_REPORT_LINKS, MAX_ISSUE_REPORT_LINK_LENGTH } from '@gadgets/workshop-shared/api'
import { issueFailure } from '../issue-reports/issueFailure'

// Whether `link` is one a browser follows over http or https. The server keeps no other kind; one
// that is not is shown as text all the same, never as something to press.
const isWebLink = (link: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(link).protocol)
  } catch {
    return false
  }
}

// Why a typed link cannot be attached, or null when it can be sent.
const refusalOf = (link: string): string | null => {
  if (link.length > MAX_ISSUE_REPORT_LINK_LENGTH) {
    return `A link can be at most ${MAX_ISSUE_REPORT_LINK_LENGTH} characters.`
  }
  return isWebLink(link) ? null : 'Enter a link that starts with http:// or https://.'
}

/**
 * The links admins attached to an issue report (a ticket, a pull request), which only admins see.
 * Each is shown exactly as the server returned it and opens in another tab, without telling the
 * site it leads to where the reader came from. A link is added or removed by replacing the list.
 */
export const ReportLinks = ({ links, onSave }: {
  /** The links the report holds, as the server returned them. */
  links: string[]
  /** Replaces the report's links, and settles once `links` is what the server then holds. */
  onSave: (links: string[]) => Promise<void>
}) => {
  const [typed, setTyped] = useState('')
  // Which change is being saved, if one is.
  const [saving, setSaving] = useState<'attach' | 'remove' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const headingId = useId()
  const full = links.length >= MAX_ISSUE_REPORT_LINKS

  // A save disables the buttons, and a removed link takes its button with it. Either drops focus,
  // which then goes to the field a link is added in, or to the heading once the list is full.
  const wasSaving = useRef(false)
  useEffect(() => {
    if (saving !== null) {
      wasSaving.current = true
      return
    }
    if (!wasSaving.current) return
    wasSaving.current = false
    if (document.activeElement === document.body) (field.current ?? heading.current)?.focus()
  }, [saving])

  // Resolves whether the server took the list.
  const save = async (change: 'attach' | 'remove', next: string[], failure: string): Promise<boolean> => {
    setSaving(change)
    setProblem(null)
    try {
      await onSave(next)
      return true
    } catch (err) {
      setProblem(issueFailure(err, failure))
      return false
    } finally {
      setSaving(null)
    }
  }

  const add = async (event: FormEvent) => {
    event.preventDefault()
    const link = typed.trim()
    if (link === '' || saving !== null || full) return
    const refusal = refusalOf(link)
    if (refusal !== null) {
      setProblem(refusal)
      return
    }
    // The field takes typing while the link is saved: what was typed since is kept.
    if (await save('attach', [...links, link], 'Couldn’t attach the link.')) {
      setTyped((current) => (current === typed ? '' : current))
    }
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h3 id={headingId} ref={heading} tabIndex={-1} className="text-sm font-semibold text-kumo-strong focus:outline-none">
          Links
        </h3>
        <p className="text-xs text-kumo-subtle">A ticket or a pull request, for example. Only admins see them.</p>
      </div>
      {links.length > 0 && (
        <ul className="space-y-1">
          {links.map((link, index) => (
            // A list can hold a link twice, so a row is told apart by its place as well.
            <li key={`${index}:${link}`} className="flex items-start gap-2">
              {isWebLink(link) ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="min-w-0 flex-1 break-all text-sm text-kumo-brand hover:underline"
                >
                  {link}
                </a>
              ) : (
                <span className="min-w-0 flex-1 break-all text-sm text-kumo-default">{link}</span>
              )}
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={X}
                aria-label={`Remove the link ${link}`}
                disabled={saving !== null}
                onClick={() =>
                  void save('remove', links.filter((_, other) => other !== index), 'Couldn’t remove the link.')}
              />
            </li>
          ))}
        </ul>
      )}
      {full ? (
        <p className="text-xs text-kumo-subtle">A report holds at most {MAX_ISSUE_REPORT_LINKS} links.</p>
      ) : (
        <form noValidate onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <Input
              ref={field}
              label="Add a link"
              placeholder="https://…"
              autoComplete="off"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value)
                setProblem(null)
              }}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            loading={saving === 'attach'}
            disabled={typed.trim() === '' || saving === 'remove'}
          >
            Attach
          </Button>
        </form>
      )}
      {problem !== null && <p role="alert" className="text-sm text-kumo-danger">{problem}</p>}
    </section>
  )
}
