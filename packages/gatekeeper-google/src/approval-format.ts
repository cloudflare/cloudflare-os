/** Bound an approval title to one display-safe line. */
export function sanitizeApprovalTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

/** Fence an untrusted value so it cannot forge surrounding approval Markdown. */
export function formatApprovalField(label: string, value: string): string {
  let fence = "```";
  while (value.includes(fence)) fence += "`";
  return `**${label}:**\n\n${fence}\n${value}\n${fence}`;
}
