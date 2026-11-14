// Renders Office files the way Microsoft 365 does, for looking at what the writers produce:
// uploads each file to a scratch folder in the contract tenant's first user's OneDrive, has
// SharePoint convert it to PDF (which also proves Office for the web can open it), saves the PDF and
// a PNG of every page, then deletes the scratch folder.
//
//   node scripts/office-render.ts <file.docx|.xlsx|.pptx>... [--out dir] [--keep]
//
// Needs what the contract suite needs: the app credentials in the root `.dev.vars` and refresh
// tokens in `MICROSOFT_CONTRACT_TOKENS` (default ~/.config/gadgets-microsoft-contract/tokens.json), whose
// rotated token it writes back. PNGs are drawn by macOS's PDFKit through `swift`.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TOKENS_FILE = process.env.MICROSOFT_CONTRACT_TOKENS ?? join(homedir(), ".config", "gadgets-microsoft-contract", "tokens.json");
const GRAPH = "https://graph.microsoft.com/v1.0";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const outIndex = args.indexOf("--out");
const out = resolve(outIndex >= 0 ? args[outIndex + 1]! : join(tmpdir(), "m365-render"));
const files = args.filter((arg, index) => !arg.startsWith("--") && (outIndex < 0 || index !== outIndex + 1));
if (files.length === 0) {
  console.error("usage: node scripts/office-render.ts <file>... [--out dir] [--keep]");
  process.exit(2);
}

const vars = Object.fromEntries(readFileSync(join(ROOT, ".dev.vars"), "utf8").split("\n")
  .map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line)).filter(match => match !== null).map(match => [match![1], match![2]!.trim()]));
const stored = JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as Record<string, { refresh_token: string }>;
const [label, user] = Object.entries(stored)[0]!;
const tokenResponse = await fetch(`https://login.microsoftonline.com/${vars.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`, {
  method: "POST",
  body: new URLSearchParams({
    client_id: vars.MICROSOFT_CLIENT_ID!, client_secret: vars.MICROSOFT_CLIENT_SECRET!, grant_type: "refresh_token",
    refresh_token: user.refresh_token, scope: "offline_access https://graph.microsoft.com/Files.ReadWrite.All",
  }),
});
const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; error?: string };
if (!token.access_token || !token.refresh_token) throw new Error(`Couldn't redeem ${label}'s refresh token: ${token.error}`);
user.refresh_token = token.refresh_token;
writeFileSync(TOKENS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
chmodSync(TOKENS_FILE, 0o600);

async function graph(method: string, path: string, body?: RequestInit["body"], contentType = "application/json"): Promise<Response> {
  const response = await fetch(path.startsWith("https:") ? path : GRAPH + path, {
    method, headers: { Authorization: `Bearer ${token.access_token}`, ...(body ? { "Content-Type": contentType } : {}) }, body,
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response;
}

const folderName = `office-render-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const folder = await (await graph("POST", "/me/drive/root/children",
  JSON.stringify({ name: folderName, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }))).json() as { id: string };
mkdirSync(out, { recursive: true });
let failed = false;
try {
  for (const file of files) {
    const name = basename(file);
    const stem = name.replace(/\.[^.]+$/, "");
    const item = await (await graph("PUT", `/me/drive/items/${folder.id}:/${encodeURIComponent(name)}:/content`,
      readFileSync(file), "application/octet-stream")).json() as { id: string; webUrl: string };
    try {
      const pdf = new Uint8Array(await (await graph("GET", `/me/drive/items/${item.id}/content?format=pdf`)).arrayBuffer());
      if (new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") throw new Error("not a PDF");
      const pdfPath = join(out, `${stem}.pdf`);
      writeFileSync(pdfPath, pdf);
      const pages = renderPages(pdfPath, join(out, stem));
      console.log(`${name}: rendered ${pages} page${pages === 1 ? "" : "s"} → ${join(out, stem)}-N.png (${item.webUrl})`);
    } catch (error) {
      failed = true;
      console.log(`${name}: Microsoft 365 could NOT render it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  if (!keep) await graph("DELETE", `/me/drive/items/${folder.id}`);
  else console.log(`kept the scratch folder ${folderName} in OneDrive`);
}
process.exit(failed ? 1 : 0);

/** Draws every page of a PDF to `<prefix>-<n>.png` with PDFKit, at 1.5x, on white. */
function renderPages(pdfPath: string, prefix: string): number {
  const script = join(tmpdir(), "m365-render-pages.swift");
  if (!existsSync(script)) {
    writeFileSync(script, `
import AppKit
import PDFKit
let args = CommandLine.arguments
guard let document = PDFDocument(url: URL(fileURLWithPath: args[1])) else { exit(1) }
for index in 0..<document.pageCount {
  guard let page = document.page(at: index) else { continue }
  let bounds = page.bounds(for: .mediaBox)
  let scale: CGFloat = 1.5
  let size = NSSize(width: bounds.width * scale, height: bounds.height * scale)
  let image = NSImage(size: size)
  image.lockFocus()
  NSColor.white.setFill()
  NSRect(origin: .zero, size: size).fill()
  let context = NSGraphicsContext.current!.cgContext
  context.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: context)
  image.unlockFocus()
  let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\\(args[2])-\\(index + 1).png"))
}
print(document.pageCount)
`);
  }
  return Number(execFileSync("swift", [script, pdfPath, prefix], { encoding: "utf8" }).trim());
}
