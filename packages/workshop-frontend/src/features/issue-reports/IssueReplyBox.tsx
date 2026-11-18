import { useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Button, InputArea } from '@cloudflare/kumo'
import { MAX_ISSUE_REPORT_TEXT_LENGTH } from '@gadgets/workshop-shared/api'
import { issueFailure } from './issueFailure'

// How close to the bound a reply gets before its length is shown.
const COUNTER_FROM = MAX_ISSUE_REPORT_TEXT_LENGTH - 200

/**
 * Where a reporter replies in the thread of their issue report. The bound is counted as the
 * server counts it: the UTF-16 code units of the text once trimmed. A closed report takes no
 * reply, and the box says so.
 */
export const IssueReplyBox = ({ closed, onReply }: {
  closed: boolean
  /** Sends the reply, and settles once the thread shows it. */
  onReply: (text: string) => Promise<void>
}) => {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  const trimmed = text.trim()
  const over = trimmed.length > MAX_ISSUE_REPORT_TEXT_LENGTH

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (closed || trimmed === '' || over || sending) return
    setSending(true)
    setProblem(null)
    let sent = true
    try {
      await onReply(trimmed)
    } catch (err) {
      sent = false
      setProblem(issueFailure(err, 'Couldn’t send your reply.'))
    }
    flushSync(() => {
      // The field takes typing while the reply is sent: what was typed since is kept.
      if (sent) setText((current) => (current === text ? '' : current))
      setSending(false)
    })
    // The button was disabled while the reply was sent, which takes focus from it, and stays
    // disabled once the field is empty. The field takes focus, for the next reply or another try,
    // unless focus has left the form since.
    const focused = document.activeElement
    if (focused === document.body || form.current?.contains(focused)) field.current?.focus()
  }

  return (
    <form ref={form} noValidate onSubmit={submit} className="grid gap-2">
      <InputArea
        ref={field}
        label="Reply to the admins"
        rows={3}
        disabled={closed}
        description={closed
          ? 'This report is closed, so it takes no more replies. File another report if the problem is back.'
          : undefined}
        value={text}
        onValueChange={setText}
      />
      {trimmed.length >= COUNTER_FROM && (
        <p role="status" className={`text-xs ${over ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
          {trimmed.length} of {MAX_ISSUE_REPORT_TEXT_LENGTH} characters
          {over && ': shorten your reply to send it'}
        </p>
      )}
      {problem !== null && <p role="alert" className="text-sm text-kumo-danger">{problem}</p>}
      <div>
        <Button type="submit" variant="primary" size="sm" loading={sending} disabled={closed || trimmed === '' || over}>
          Send reply
        </Button>
      </div>
    </form>
  )
}
