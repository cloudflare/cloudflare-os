import type { ConsoleLogEvent } from '@gadgets/workshop-shared/api'

/** A console call a gadget made, on its server side or in its page. */
export type CapturedLog = ConsoleLogEvent & { source: 'server' | 'page' }

/** What a chat has captured, as the chat shows it: how many, and the worst of them. */
export type CapturedSummary = { count: number; severity: 'error' | 'warning' | 'log' }

/** Kept per chat, the latest; a gadget logging in a loop would otherwise make a draft of it. */
const LIMIT = 200
const NONE: CapturedSummary = { count: 0, severity: 'log' }

const severityOf = (logs: readonly CapturedLog[]): CapturedSummary['severity'] =>
  logs.some(({ level }) => level === 'error') ? 'error' : logs.some(({ level }) => level === 'warn') ? 'warning' : 'log'

/** The logs as they are put in a message, one line each, for the agent to read. */
export const formatCapturedLogs = (logs: readonly CapturedLog[]) =>
  ['Console logs:', ...logs.map(({ source, level, message }) => `[${source} ${level}] ${message.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')}`)].join('\n')

/**
 * What the gadgets shown with a chat logged since it was last sent or put away, per chat, so that
 * it can be sent to the chat's agent (as main's Workshop offers). Logs are not stored by the
 * server, so only what was seen while the app was open is here.
 */
export class CapturedLogs {
  #logs = new Map<string, CapturedLog[]>()
  #summaries = new Map<string, CapturedSummary>()
  #listeners = new Map<string, Set<() => void>>()

  static key = (workspaceId: string, chatId: number) => `${workspaceId}/${chatId}`

  add(key: string, logs: readonly CapturedLog[]) {
    if (!logs.length) return
    const next = [...(this.#logs.get(key) ?? []), ...logs].slice(-LIMIT)
    this.#logs.set(key, next)
    this.#changed(key, { count: next.length, severity: severityOf(next) })
  }

  /** Takes them, formatted to be sent; empty when there are none. */
  take(key: string) {
    const logs = this.#logs.get(key) ?? []
    this.discard(key)
    return logs.length ? formatCapturedLogs(logs) : ''
  }

  /** What `take` would give, leaving them. */
  peek(key: string) {
    const logs = this.#logs.get(key) ?? []
    return logs.length ? formatCapturedLogs(logs) : ''
  }

  discard(key: string) {
    if (!this.#logs.delete(key)) return
    this.#changed(key, NONE)
  }

  summary = (key: string) => this.#summaries.get(key) ?? NONE

  subscribe = (key: string, listener: () => void) => {
    const listeners = this.#listeners.get(key) ?? new Set()
    this.#listeners.set(key, listeners.add(listener))
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.#listeners.delete(key)
    }
  }

  #changed(key: string, summary: CapturedSummary) {
    if (summary.count) this.#summaries.set(key, summary)
    else this.#summaries.delete(key)
    this.#listeners.get(key)?.forEach((listener) => listener())
  }
}

/** The app's, which the gadget's page and its server side add to, and a chat sends from. */
export const capturedLogs = new CapturedLogs()
