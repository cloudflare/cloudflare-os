/**
 * The ui library's browser entry (`@gadgets/bundled-blueprints/libraries/ui/client`): the DOM
 * helpers the document-style gadgets share, DOM-only -- nothing here talks RPC or storage. `el`
 * builds elements and `icon` draws an SVG from the `ICONS` paths; `iconBtn`, `segBtn`, `group`,
 * `colorBtn` and `customSelect` assemble a toolbar; `promptInline` stands in for the sandbox's
 * blocked `window.prompt`; `statusIndicator` is the save-status dot; `relativeTime` phrases a
 * timestamp; and the image helpers turn a picked or pasted file into a data URL that fits a budget.
 * Each is documented at its definition; the README lists the behaviour worth knowing before a
 * gadget adopts one.
 */

export { type ElChild, type ElProps, type ElPropValue, el, icon } from "./src/dom.ts";
export { ICONS, type IconName } from "./src/icons.ts";
export {
  DEFAULT_IMAGE_LIMITS,
  IMAGE_TYPES,
  type ImageLimits,
  type PrepareImageOptions,
  type PreparedImage,
  altFromFileName,
  imageFilesFrom,
  isImageFile,
  loadImage,
  prepareImage,
  readFileAsDataURL,
} from "./src/images.ts";
export { PROMPT_STYLES, type PromptOptions, promptInline } from "./src/prompt.ts";
export { type StatusIndicator, type StatusOptions, statusIndicator } from "./src/status.ts";
export { relativeTime } from "./src/time.ts";
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
} from "./src/toolbar.ts";
