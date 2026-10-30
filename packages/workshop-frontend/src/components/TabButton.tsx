import type { ReactNode } from 'react'

type TabButtonProps = {
  active: boolean
  onClick: () => void
  children: ReactNode
  badgeCount?: number
  className?: string
}

export function TabButton({ active, onClick, children, badgeCount = 0, className = '' }: TabButtonProps) {
  const heightClassName = className.includes('h-') ? '' : 'h-full'

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`relative flex ${heightClassName} cursor-pointer items-center gap-1.5 text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
        active
          ? 'font-medium text-kumo-default'
          : 'font-normal text-kumo-subtle hover:text-kumo-default'
      } ${className}`}
    >
      {children}
      {badgeCount > 0 && (
        <span
          className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-kumo-contrast px-1 text-[10px] leading-none font-semibold text-kumo-inverse"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {badgeCount}
          <span className="sr-only"> pending</span>
        </span>
      )}
      <span
        className={`absolute inset-x-1 bottom-0 h-0.5 rounded-full transition-[opacity,transform] duration-150 ease-out ${
          active ? 'scale-x-100 opacity-100' : 'scale-x-75 opacity-0'
        }`}
        style={{ backgroundColor: 'color-mix(in srgb, var(--text-color-kumo-default) 70%, transparent)' }}
      />
    </button>
  )
}
