import { useState } from 'react'
import { Dialog, Button, Input } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { Connection, ConnectionResource } from '../../data/sample'
import { logoComponents } from '../ConnectionLogos'
import { isImeComposing } from '../../keyboardEvent'

export default function ConnectionConfigModal({
  connection,
  open,
  onOpenChange,
  onSave,
}: {
  connection: Connection
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave?: (resources: ConnectionResource[]) => void
}) {
  const [resources, setResources] = useState<ConnectionResource[]>(
    connection.resources ?? []
  )
  const [inputValue, setInputValue] = useState('')

  const Logo = logoComponents[connection.logo]
  const config = connection.resourceConfig

  function handleAdd() {
    const v = inputValue.trim()
    if (!v || !config) return
    setResources((prev) => [
      ...prev,
      { id: `r-${Date.now()}`, label: v, value: v, type: config.resourceType, active: true },
    ])
    setInputValue('')
  }

  function handleRemove(id: string) {
    setResources((prev) => prev.filter((r) => r.id !== id))
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="responsive-dialog overflow-hidden p-0">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: connection.bgColor }}
          >
            {Logo && <Logo size={18} />}
          </div>
          <div className="flex-1 min-w-0">
            <Dialog.Title className="text-sm font-semibold text-kumo-default">
              {connection.name}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-kumo-subtle">
              {connection.description}
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <button
                {...props}
                className="p-1 text-kumo-subtle hover:text-kumo-default rounded-md hover:bg-kumo-tint transition-colors"
              >
                <X size={14} />
              </button>
            )}
          />
        </div>

        <div className="border-t border-kumo-fill" />

        {/* Add resource */}
        {config && (
          <div className="px-5 py-4">
            <div className="flex gap-2">
              <div className="flex-1">
                <Input
                  size="sm"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (isImeComposing(e)) return
                    if (e.key === 'Enter') handleAdd()
                  }}
                  placeholder={config.placeholder}
                  aria-label={config.inputLabel}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={handleAdd}
                disabled={!inputValue.trim()}
              >
                Add
              </Button>
            </div>
          </div>
        )}

        {/* Resource list */}
        <div className="max-h-56 overflow-y-auto px-5 pb-4">
          {resources.length === 0 ? (
            <p className="text-sm text-kumo-inactive text-center py-4">
              No resources added yet
            </p>
          ) : (
            <div className="space-y-1">
              {resources.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-kumo-tint group"
                >
                  <span className="text-sm text-kumo-default flex-1 min-w-0 truncate">
                    {r.label}
                  </span>
                  <button
                    onClick={() => handleRemove(r.id)}
                    className="p-0.5 text-kumo-inactive opacity-0 group-hover:opacity-100 hover:text-kumo-danger rounded transition-all"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-kumo-fill px-5 py-3 flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="outline" size="sm">
                Cancel
              </Button>
            )}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onSave?.(resources)
              onOpenChange(false)
            }}
          >
            Save
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
