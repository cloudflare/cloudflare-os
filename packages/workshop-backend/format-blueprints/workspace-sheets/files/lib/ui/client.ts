/**
 * The DOM helpers this gadget's `client.ts` builds its chrome from. Shared by copy with the other
 * document-style blueprints (Docs, Sheets and Slides each carry the modules they use under
 * `lib/ui/`), so a change here belongs in each copy. DOM-only: nothing here talks RPC or storage.
 */

export { type ElChild, type ElProps, type ElPropValue, el, icon } from "./dom.ts";
export { ICONS, type IconName } from "./icons.ts";
export { PROMPT_STYLES, type PromptOptions, promptInline } from "./prompt.ts";
export { type StatusIndicator, type StatusOptions, statusIndicator } from "./status.ts";
export {
  type ClickHandler,
  type CustomSelect,
  type CustomSelectOptions,
  type SelectOption,
  type SelectValue,
  colorBtn,
  customSelect,
  group,
  iconBtn,
  segBtn,
} from "./toolbar.ts";
