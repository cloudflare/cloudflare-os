/**
 * Build the Cloudflare dashboard URL for adding AI Gateway credits. When the user's account id is
 * known we deep-link directly, skipping the dashboard's account picker.
 */
export function buildAddCreditsUrl(accountId?: string): string {
  const account = accountId || ":account";
  return `https://dash.cloudflare.com/?to=/${account}/ai/ai-gateway/credits`;
}
