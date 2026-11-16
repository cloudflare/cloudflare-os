import { useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Button, InputArea, Radio } from '@cloudflare/kumo'
import {
  MAX_ISSUE_REPORT_TEXT_LENGTH,
  MAX_ISSUE_REPORT_THREAD_ENTRIES,
  type IssueReportEntry,
} from '@gadgets/workshop-shared/api'
import { issueFailure } from '../issue-reports/issueFailure'

type Visibility = IssueReportEntry['visibility']

// How close to the bound an entry gets before its length is shown.
const COUNTER_FROM = MAX_ISSUE_REPORT_TEXT_LENGTH - 200

// What each choice of who reads an entry says of itself, its field and its button.
const KINDS: Record<Visibility, { consequence: string; field: string; send: string; full: string }> = {
  admins: {
    consequence: 'Only admins read this note. The reporter never sees it.',
    field: 'Note for the admins',
    send: 'Add admins-only note',
    full: `This thread holds ${MAX_ISSUE_REPORT_THREAD_ENTRIES} admins-only notes, which is as many as it takes.`,
  },
  public: {
    consequence: 'The reporter will read this reply.',
    field: 'Reply to the reporter',
    send: 'Send public reply',
    full: `This thread holds ${MAX_ISSUE_REPORT_THREAD_ENTRIES} public replies from admins, which is as many as it takes.`,
  },
}

/**
 * Where an admin writes in the thread of an issue report: a note for the admins alone, or a reply
 * the reporter reads. It starts as a note, and is one again after each entry sent, so that nothing
 * is made public by a slip, and what is chosen says who will read it. The bound is counted as the
 * server counts it: the UTF-16 code units of the text once trimmed. The admins' entries of each
 * kind are bounded apart, and the composer says when those of the chosen kind are full; the
 * reporter's replies fill neither.
 */
export const ReportComposer = ({ entries, onAdd }: {
  /** The thread as last read. */
  entries: IssueReportEntry[]
  /** Writes the entry, and settles once the thread shows it. */
  onAdd: (text: string, visibility: Visibility) => Promise<void>
}) => {
  const [visibility, setVisibility] = useState<Visibility>('admins')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  const kind = KINDS[visibility]
  const trimmed = text.trim()
  const over = trimmed.length > MAX_ISSUE_REPORT_TEXT_LENGTH
  // An admin's entry says how their call reached the deployment, and a bare change of status has
  // no text and is not counted.
  const written = entries.filter((entry) =>
    entry.via !== undefined && entry.text !== '' && entry.visibility === visibility).length
  const full = written >= MAX_ISSUE_REPORT_THREAD_ENTRIES

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (full || trimmed === '' || over || sending) return
    setSending(true)
    setProblem(null)
    let sent = true
    try {
      await onAdd(trimmed, visibility)
    } catch (err) {
      sent = false
      setProblem(issueFailure(err, 'Couldn’t add to the thread.'))
    }
    flushSync(() => {
      if (sent) {
        // The field takes typing while the entry is sent: what was typed since is kept.
        setText((current) => (current === text ? '' : current))
        setVisibility('admins')
      }
      setSending(false)
    })
    // The button was disabled while the entry was sent, which takes focus from it, and stays
    // disabled once the field is empty. The field takes focus, for the next entry or another try,
    // unless focus has left the form since.
    const focused = document.activeElement
    if (focused === document.body || form.current?.contains(focused)) field.current?.focus()
  }

  return (
    <form ref={form} noValidate onSubmit={submit} className="grid gap-3">
      <Radio.Group
        legend="Who reads this"
        orientation="horizontal"
        disabled={sending}
        value={visibility}
        onValueChange={setVisibility}
      >
        <Radio.Item value="admins" label="Admins only" />
        <Radio.Item value="public" label="Public" />
      </Radio.Group>
      <p role="status" className="text-xs text-kumo-subtle">{kind.consequence}</p>
      <InputArea ref={field} label={kind.field} rows={3} value={text} onValueChange={setText} />
      {trimmed.length >= COUNTER_FROM && (
        <p role="status" className={`text-xs ${over ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
          {trimmed.length} of {MAX_ISSUE_REPORT_TEXT_LENGTH} characters
          {over && ': shorten it to send it'}
        </p>
      )}
      {full && <p className="text-sm text-kumo-subtle">{kind.full}</p>}
      {problem !== null && <p role="alert" className="text-sm text-kumo-danger">{problem}</p>}
      <div>
        <Button type="submit" variant="primary" size="sm" loading={sending} disabled={full || trimmed === '' || over}>
          {kind.send}
        </Button>
      </div>
    </form>
  )
}
