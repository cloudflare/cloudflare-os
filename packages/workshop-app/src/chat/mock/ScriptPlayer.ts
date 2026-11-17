import type { ScriptStep, Trigger } from './scenario'

export type PlayerSnapshot = {
  playing: boolean
  /** How many steps have run. */
  position: number
  total: number
  /** What the next step is waiting for the user to do; absent when it only follows on. */
  waitingFor?: Trigger[]
}

const triggersOf = (step: ScriptStep | undefined): Trigger[] | undefined =>
  step?.on === undefined ? undefined : Array.isArray(step.on) ? step.on : [step.on]

/**
 * Runs a scenario's steps in order. A step either follows the one before it after its delay, or
 * waits for a trigger; a trigger that nothing is waiting for is dropped, as a real server would
 * ignore it. Observable through `subscribe`/`getSnapshot` (for `useSyncExternalStore`).
 */
export class ScriptPlayer {
  #position = 0
  #playing = false
  // The trigger the next step waits for has fired, so the step may run.
  #released = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #listeners = new Set<() => void>()
  #snapshot: PlayerSnapshot

  constructor(
    private readonly steps: ScriptStep[],
    private readonly run: (step: ScriptStep) => void,
  ) {
    this.#snapshot = this.#read()
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  play = () => {
    this.#playing = true
    this.#schedule()
    this.#publish()
  }

  pause = () => {
    this.#playing = false
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#publish()
  }

  /** Runs the next step now, skipping its delay. A step still waiting for the user does not run. */
  step = () => {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#advance()
    if (this.#playing) this.#schedule()
    this.#publish()
  }

  /** Reports something the user did. */
  fire(trigger: Trigger) {
    if (this.#released || !triggersOf(this.steps[this.#position])?.includes(trigger)) return
    this.#released = true
    if (this.#playing) this.#schedule()
    this.#publish()
  }

  #blocked() {
    return triggersOf(this.steps[this.#position]) !== undefined && !this.#released
  }

  #advance() {
    const step = this.steps[this.#position]
    if (!step || this.#blocked()) return
    this.#position++
    this.#released = false
    this.run(step)
  }

  #schedule() {
    const step = this.steps[this.#position]
    if (!step || this.#blocked() || this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#advance()
      if (this.#playing) this.#schedule()
      this.#publish()
    }, step.delay ?? 0)
  }

  #read(): PlayerSnapshot {
    return {
      playing: this.#playing,
      position: this.#position,
      total: this.steps.length,
      waitingFor: this.#blocked() ? triggersOf(this.steps[this.#position]) : undefined,
    }
  }

  #publish() {
    this.#snapshot = this.#read()
    this.#listeners.forEach((listener) => listener())
  }
}
