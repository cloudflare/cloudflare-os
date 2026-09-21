import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Popover, Tooltip } from '@cloudflare/kumo'
import { RpcStub, RpcTarget } from 'capnweb'
import { Overseer, AuthenticatedApi, PresenceParticipant, PresenceSubscriber } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from './PersonAvatar'

const MAX_VISIBLE = 3

const ROLE_LABELS: Record<PresenceParticipant['role'], string> = {
  build: 'Workspace',
  use: 'Gadget only',
}

export function GadgetPresence({
  overseer,
  authenticatedApi,
  currentUserId,
}: {
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  currentUserId: string | null
}) {
  const [participants, setParticipants] = useState<PresenceParticipant[]>([])

  useEffect(() => {
    let cancelled = false
    let sub: RpcStub<{}> | null = null
    const roster = new Map<string, PresenceParticipant>()
    const flush = () => {
      if (!cancelled) setParticipants([...roster.values()])
    }

    class PresenceSubscriberImpl extends RpcTarget implements PresenceSubscriber {
      init(list: PresenceParticipant[]) {
        roster.clear()
        for (const p of list) roster.set(p.key, p)
        flush()
      }
      add(p: PresenceParticipant) {
        roster.set(p.key, p)
        flush()
      }
      remove(key: string) {
        roster.delete(key)
        flush()
      }
    }

    const promise = overseer.subscribeToPresence(
      new PresenceSubscriberImpl() as unknown as RpcStub<PresenceSubscriber>,
    )

    promise.then((stub) => {
      if (cancelled) {
        stub[Symbol.dispose]()
      } else {
        sub = stub
      }
    }).catch(() => {})

    return () => {
      cancelled = true
      sub?.[Symbol.dispose]()
    }
  }, [overseer])

  // Avoid briefly showing the current user while whoami() is pending.
  const others = useMemo(
    () => (currentUserId == null ? [] : participants.filter((p) => p.user.id !== currentUserId)),
    [participants, currentUserId],
  )

  // Keep departed participants mounted until their exit animation finishes.
  const [display, setDisplay] = useState<PresenceParticipant[]>([])
  const [exiting, setExiting] = useState<Set<string>>(new Set())
  const exitTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const displayRef = useRef(display)
  displayRef.current = display

  // Animate surviving avatars from their previous positions after the stack reflows.
  const stackRef = useRef<HTMLSpanElement>(null)
  const flipPositions = useRef(new Map<string, number>())
  const flipAnimations = useRef(new Map<string, Animation>())

  useLayoutEffect(() => {
    const container = stackRef.current
    if (!container) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const els = container.querySelectorAll<HTMLElement>('[data-flip-id]')

    els.forEach((el) => {
      const id = el.dataset.flipId!
      flipAnimations.current.get(id)?.cancel()
    })

    const prev = flipPositions.current
    const next = new Map<string, number>()
    els.forEach((el) => {
      const id = el.dataset.flipId!
      const left = el.getBoundingClientRect().left
      next.set(id, left)
      const last = prev.get(id)
      if (!reduce && last !== undefined) {
        const dx = last - left
        if (Math.abs(dx) > 0.5) {
          const anim = el.animate(
            [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }],
            { duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
          )
          flipAnimations.current.set(id, anim)
          anim.finished.then(() => {
            if (flipAnimations.current.get(id) === anim) flipAnimations.current.delete(id)
          }).catch(() => {})
        }
      }
    })
    flipPositions.current = next
  })

  useEffect(() => {
    const presentIds = new Set(others.map((p) => p.user.id))

    const returned: string[] = []
    for (const [id, timer] of exitTimers.current) {
      if (presentIds.has(id)) {
        clearTimeout(timer)
        exitTimers.current.delete(id)
        returned.push(id)
      }
    }

    const departed: string[] = []
    for (const p of displayRef.current) {
      if (!presentIds.has(p.user.id) && !exitTimers.current.has(p.user.id)) {
        departed.push(p.user.id)
        const timer = setTimeout(() => {
          exitTimers.current.delete(p.user.id)
          setDisplay((d) => d.filter((x) => x.user.id !== p.user.id))
          setExiting((s) => {
            const next = new Set(s)
            next.delete(p.user.id)
            return next
          })
        }, 170)
        exitTimers.current.set(p.user.id, timer)
      }
    }

    if (returned.length || departed.length) {
      setExiting((prev) => {
        const next = new Set(prev)
        for (const id of returned) next.delete(id)
        for (const id of departed) next.add(id)
        return next
      })
    }

    setDisplay((prev) => {
      const prevIds = new Set(prev.map((p) => p.user.id))
      const merged = prev.map((p) => others.find((o) => o.user.id === p.user.id) ?? p)
      for (const o of others) {
        if (!prevIds.has(o.user.id)) merged.push(o)
      }
      return merged
    })
  }, [others])

  useEffect(() => {
    const timers = exitTimers.current
    const anims = flipAnimations.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const anim of anims.values()) anim.cancel()
      anims.clear()
    }
  }, [])

  if (display.length === 0) return null

  const visible = display.slice(0, MAX_VISIBLE)
  const overflow = display.length - visible.length
  const count = display.length
  const label = `${count} ${count === 1 ? 'person' : 'people'} here now`
  const ariaLabel = `${count} ${count === 1 ? 'person' : 'people'} viewing this workspace`

  return (
    <Popover>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="inline-flex shrink-0 cursor-pointer items-center rounded-full border border-kumo-line bg-kumo-base/60 p-0.5 transition-[background-color,transform] duration-150 ease-out hover:bg-kumo-tint focus-visible:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring active:scale-[0.97]"
            aria-label={ariaLabel}
          >
            <span ref={stackRef} className="relative inline-flex">
              <span className="flex -space-x-2">
                {visible.map((p) => (
                  <Tooltip key={p.user.id} content={`${p.user.name} · ${ROLE_LABELS[p.role]}`} asChild>
                    {/* Outer span = FLIP target (translateX slide). Inner span = scale/opacity pop.
                        Kept on separate elements so the two transforms don't overwrite each other. */}
                    <span data-flip-id={p.user.id} className="inline-flex cursor-pointer">
                      <span
                        className={`rounded-full ring-2 ring-kumo-base ${exiting.has(p.user.id) ? 'presence-pop-out' : 'presence-pop-in'}`}
                      >
                        <PersonAvatar
                          api={authenticatedApi}
                          userId={p.user.id}
                          name={p.user.name}
                          size={26}
                        />
                      </span>
                    </span>
                  </Tooltip>
                ))}
                {overflow > 0 && (
                  <span data-flip-id="__overflow" className="inline-flex cursor-pointer">
                    <span
                      className="presence-pop-in grid h-[26px] w-[26px] place-items-center rounded-full bg-kumo-tint text-[10px] font-semibold text-kumo-strong ring-2 ring-kumo-base"
                    >
                      +{overflow}
                    </span>
                  </span>
                )}
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-kumo-success ring-2 ring-kumo-base" />
            </span>
          </button>
        }
      />
      <Popover.Content
        align="end"
        sideOffset={6}
        className="!z-[1100] !w-[260px] !min-w-0 flex max-h-[min(60vh,420px)] flex-col overflow-hidden rounded-2xl bg-kumo-base p-1 shadow-lg shadow-kumo-tip-shadow"
      >
        <Popover.Title className="shrink-0 px-2.5 pt-1.5 pb-1 text-[11px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle">
          {label}
        </Popover.Title>
        <div className="presence-scroll min-h-0 flex-1 overflow-y-auto">
          {display.map((p) => (
            <div
              key={p.user.id}
              className="flex items-center gap-2.5 rounded-xl px-2.5 py-1.5"
            >
              <PersonAvatar
                api={authenticatedApi}
                userId={p.user.id}
                name={p.user.name}
                size={28}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] leading-4 font-medium text-kumo-default">
                  {p.user.name}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 font-normal text-kumo-subtle">
                  {ROLE_LABELS[p.role]}
                </span>
              </span>
            </div>
          ))}
        </div>
      </Popover.Content>
    </Popover>
  )
}
