import { createHash } from "node:crypto";
import type { ConfiguratorModule } from "./module.ts";
import type { ConfiguratorRuntime } from "./runtime.ts";

/**
 * `text` as the HTML parser will hand it to the script or style element it is inlined in: newlines
 * normalized, as the parser normalizes them, so the hash the build computes is the one the browser
 * does. Refuses text that would end its element early or open an HTML comment inside it, rather
 * than escaping it, so the shipped script stays byte-for-byte what its source map describes.
 */
const inlined = (text: string, element: "script" | "style"): string => {
  // Style text is raw: only its end tag matters. Script text also has escape states, which `<!--`
  // enters and which can stop `</script>` from ending it.
  const sequence = (element === "script" ? /<\/script|<!--/i : /<\/style/i).exec(text);
  if (sequence) {
    throw new Error(`Cannot inline a ${element} containing "${sequence[0]}". ` +
      `Write it another way, e.g. "<\\/${element}" in a string.`);
  }
  return text.replace(/\r\n?/g, "\n");
};

const scriptHash = (script: string): string =>
  `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;

/**
 * The frame's whole policy. Scripts are allowed by hash alone, so nothing can run that the build
 * did not write: no inline handlers, `javascript:` URLs, `eval` or injected `<script>`s. Nothing
 * may be fetched, so nothing the user selects or sees can leave the frame except through the RPC
 * session the Workshop hands it.
 */
const contentSecurityPolicy = (scripts: string[]): string => [
  "default-src 'none'",
  `script-src ${scripts.map(scriptHash).join(" ")}`,
  // Kumo and Base UI set inline styles, and the stylesheet is inline.
  "style-src 'unsafe-inline'",
  "img-src data:",
  "media-src data:",
  "font-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The complete document for one configurator: the runtime, its styles and the module. */
export const configuratorHtml = (runtime: ConfiguratorRuntime, module: ConfiguratorModule): string => {
  const moduleScript = inlined(module.script, "script");
  const runtimeScript = inlined(runtime.script, "script");
  const css = inlined(runtime.css, "style");
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy([moduleScript, runtimeScript])}">
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${moduleScript}</script>
<script>${runtimeScript}</script>
</body>
</html>
`;
};
