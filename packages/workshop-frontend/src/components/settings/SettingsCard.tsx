import type { ReactNode } from 'react'

/** The Settings buttons (Figma "Frame 588"): a small white pill with a hairline, 12px corners. */
export const SETTING_BUTTON = 'inline-flex h-[33px] shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-kumo-base px-2.5 text-[14px] font-medium leading-[17px] ring-1 ring-kumo-line transition-colors hover:bg-kumo-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-50'

/** One setting (Figma "Frame 679"): its name and what it does, and its control at the far end. */
export function Setting({ title, description, danger = false, center = true, children }: {
  title: string
  description: ReactNode
  danger?: boolean
  center?: boolean
  children: ReactNode
}) {
  return (
    <div className={`flex justify-between gap-6 max-sm:flex-col max-sm:gap-3 ${center ? 'sm:items-center' : ''}`}>
      <div className="flex max-w-[338px] flex-col gap-1">
        <span className={`text-[14px] font-medium leading-[17px] ${danger ? 'text-kumo-danger' : 'text-kumo-default'}`}>{title}</span>
        <span className="text-[13px] leading-4 text-kumo-subtle">{description}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">{children}</div>
    </div>
  )
}

/** The hairline between settings in a card (Figma "Line 33"). */
export const SettingsDivider = () => <div className="h-px bg-kumo-line" />


/** A grey card of settings (Figma "Frame 679"), each separated by a hairline. */
export const SettingsCard = ({ children }: { children: ReactNode }) =>
  <div className="flex flex-col gap-6 rounded-[20px] bg-kumo-contrast/[0.03] p-5">{children}</div>
