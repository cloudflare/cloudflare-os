import { useEffect, useRef } from 'react'

/**
 * Keeps focus on the control that started an operation. An operation disables that control, and a
 * browser takes focus from a control that becomes disabled without giving it back. The function
 * returned is called as an operation begins: the control that has focus then gets it again once
 * `running` is false, unless focus has gone elsewhere since.
 */
export const useFocusAfterOperation = (running: boolean): (() => void) => {
  const focusBefore = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (running) return
    if (document.activeElement === document.body) focusBefore.current?.focus()
    focusBefore.current = null
  }, [running])
  return () => {
    focusBefore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
}
