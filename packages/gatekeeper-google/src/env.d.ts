// Project-specific Env augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // The AI Gateway Drive PDF conversion goes through, when set. It is not in the config, because
    // previews upload a backend secret under this name.
    CF_AI_GATEWAY?: string;
  }
}
