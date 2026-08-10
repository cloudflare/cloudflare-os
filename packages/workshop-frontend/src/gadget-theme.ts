import {
  GADGET_THEME_TOKEN_NAMES,
  type GadgetThemeSnapshot,
  type GadgetThemeTokenName,
} from '@gadgets/workshop-shared/gadget-ui-theme'

const PARENT_THEME_TOKENS: Record<GadgetThemeTokenName, string> = {
  '--gadget-color-bg': '--color-kumo-base',
  '--gadget-color-panel': '--color-kumo-control',
  '--gadget-color-panel-muted': '--color-kumo-elevated',
  '--gadget-color-recessed': '--color-kumo-tint',
  '--gadget-color-line': '--color-kumo-line',
  '--gadget-color-line-strong': '--color-kumo-ring',
  '--gadget-color-text': '--text-color-kumo-default',
  '--gadget-color-text-strong': '--text-color-kumo-strong',
  '--gadget-color-muted': '--text-color-kumo-subtle',
  '--gadget-color-disabled': '--text-color-kumo-inactive',
  '--gadget-color-accent': '--color-kumo-brand',
  '--gadget-color-accent-hover': '--color-kumo-brand-hover',
  '--gadget-color-accent-text': '--text-color-kumo-inverse',
  '--gadget-color-focus': '--text-color-kumo-brand',
  '--gadget-color-selection-bg': '--color-selection-bg',
  '--gadget-color-success': '--text-color-kumo-success',
  '--gadget-color-success-bg': '--color-kumo-success-tint',
  '--gadget-color-warning': '--text-color-kumo-warning',
  '--gadget-color-warning-bg': '--color-kumo-warning-tint',
  '--gadget-color-danger': '--text-color-kumo-danger',
  '--gadget-color-danger-bg': '--color-kumo-danger-tint',
}

export function readGadgetThemeSnapshot(
  root: HTMLElement = document.documentElement,
): GadgetThemeSnapshot {
  const computed = getComputedStyle(root)
  const tokens: GadgetThemeSnapshot['tokens'] = {}
  for (const name of GADGET_THEME_TOKEN_NAMES) {
    const value = computed.getPropertyValue(PARENT_THEME_TOKENS[name]).trim()
    if (value) tokens[name] = value
  }
  return {
    mode: root.dataset.mode === 'dark' ? 'dark' : 'light',
    tokens,
  }
}

export function observeGadgetTheme(callback: () => void): () => void {
  const observer = new MutationObserver(callback)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-mode', 'style'],
  })
  return () => observer.disconnect()
}
