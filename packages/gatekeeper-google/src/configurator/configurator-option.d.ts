/**
 * Autocomplete row a configurator RPC returns. Local so server code can import
 * configurator types without pulling `@gadgets/configurator-ui`'s global `JSX`.
 */
export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};
