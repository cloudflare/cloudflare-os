// Derive a document description from its own content. Add tiny, dependency-free extractors here.

type DescriptionExtractor = {
  appliesTo: (contentType: string) => boolean;
  extract: (body: string) => string | null;
};

// Cap for the per-keystroke JSON parse in the JSON extractor.
const MAX_JSON_EXTRACT_BYTES = 64 * 1024;

// First non-empty, trimmed string from the candidates.
function firstNonEmpty(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

// Read a top-level YAML-ish scalar, including simple quoted and block forms.
function readYamlKey(lines: string[], key: string): string | null {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    let val = m[1].trim();
    // Block scalar: gather the following more-indented lines.
    if (/^[>|][+-]?$/.test(val)) {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[ \t]+/.test(lines[j])) block.push(lines[j].replace(/^[ \t]+/, ""));
        else if (lines[j].trim() === "") block.push("");
        else break;
      }
      return firstNonEmpty(val.startsWith("|") ? block.join("\n") : block.join(" "));
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return firstNonEmpty(val);
  }
  return null;
}

// A `description` (or `summary`) key from YAML lines.
function yamlDescription(lines: string[]): string | null {
  return readYamlKey(lines, "description") ?? readYamlKey(lines, "summary");
}

// Leading YAML comment block.
function leadingYamlComment(lines: string[]): string | null {
  const block: string[] = [];
  let started = false;
  for (const line of lines) {
    if (/^[ \t]*#/.test(line)) {
      started = true;
      block.push(line.replace(/^[ \t]*#[ \t]?/, ""));
    } else if (!started && line.trim() === "") {
      continue; // allow blank lines before the comment block
    } else {
      break; // first non-comment content ends the leading block
    }
  }
  return firstNonEmpty(block.join(" "));
}

// Matches a leading YAML frontmatter block (`--- … ---`), capturing its inner text.
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Split leading YAML frontmatter from markdown content. The rich editor can't round-trip it. */
export function splitFrontmatter(body: string): { frontmatter: string | null; content: string } {
  const m = FRONTMATTER_RE.exec(body);
  if (!m) return { frontmatter: null, content: body };
  return { frontmatter: m[1], content: body.slice(m[0].length) };
}

/** Recombine frontmatter with content. */
export function joinFrontmatter(frontmatter: string | null, content: string): string {
  if (frontmatter === null) return content;
  return `---\n${frontmatter}\n---\n\n${content.replace(/^\s*\n/, "")}`;
}

// Order matters: the first applicable extractor that finds a value wins.
const extractors: DescriptionExtractor[] = [
  // Markdown skill files: a description/summary key in the YAML frontmatter.
  {
    appliesTo: (ct) => ct === "text/markdown",
    extract: (body) => {
      const m = FRONTMATTER_RE.exec(body);
      return m ? yamlDescription(m[1].split(/\r?\n/)) : null;
    },
  },
  // YAML data files: a top-level description/summary key, else the leading `#` comment block.
  {
    appliesTo: (ct) => ct === "application/yaml" || ct === "application/x-yaml" || ct === "text/yaml",
    extract: (body) => {
      const lines = body.split(/\r?\n/);
      return yamlDescription(lines) ?? leadingYamlComment(lines);
    },
  },
  // JSON files: a top-level `_comment` (Cloudflare OS convention), else description/summary.
  {
    appliesTo: (ct) => ct === "application/json",
    extract: (body) => {
      // Runs live on every keystroke, so skip parsing large files.
      if (body.length > MAX_JSON_EXTRACT_BYTES) return null;
      try {
        const obj = JSON.parse(body) as Record<string, unknown>;
        if (obj && typeof obj === "object") return firstNonEmpty(obj._comment, obj.description, obj.summary);
      } catch {
        // Incomplete/invalid JSON (e.g. mid-edit) — no description yet.
      }
      return null;
    },
  },
];

/** Return a derived description, or null when the author must supply one. */
export function extractDescription(contentType: string, body: string): string | null {
  for (const ex of extractors) {
    if (ex.appliesTo(contentType)) {
      const value = ex.extract(body);
      if (value) return value;
    }
  }
  return null;
}
