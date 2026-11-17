import type { ReactNode } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { ServiceLogo } from '@/components/ServiceLogo'

export type ServiceDialogHeaderProps = {
  /** What the service is called. */
  name: string
  logoUrl?: string
  /** The service's own colour, for behind its logo. */
  color?: string
  /** What the dialog is called. */
  title: string
  /** What is said under that, on a line. */
  children?: ReactNode
  /** Something asked for is on its way, until when the dialog is not put away. */
  pending: boolean
}

/** The top of a dialog about a service: its logo, what the dialog is called over a line about it, and the way out. */
export const ServiceDialogHeader = ({ name, logoUrl, color, title, children, pending }: ServiceDialogHeaderProps) => (
  <header className="flex items-start gap-3 p-6">
    <ServiceLogo name={name} src={logoUrl} color={color} />
    <div className="flex min-h-12 min-w-0 flex-1 flex-col justify-center gap-0.5 leading-snug">
      <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">{title}</Dialog.Title>
      {children}
    </div>
    <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
  </header>
)
