# Office content

Reads Office Open XML files with no dependencies, using only APIs that Workers and browsers share
(`DecompressionStream`, `TextDecoder`). It is a library, not a deployable Worker.

| Module | What it does |
|---|---|
| `@gadgets/office-content` | `convertToText()`: a file's readable text, choosing the converter by name and type |
| `…/docx`, `…/pptx` | Word and PowerPoint to Markdown |
| `…/xlsx-sheets` | An Excel workbook's sheets as they look: formatted values, cell styles, sizes, merges |
| `…/zip`, `…/xml`, `…/ooxml` | The ZIP reader, XML parser and package plumbing the readers share |
| `…/markdown`, `…/text`, `…/errors` | Markdown writing, text decoding, and the conversion error type |
| `…/test-fixtures` | Test-only builders for minimal packages; never imported by production code |

Files come from people and from other organisations' tenants, so every reader treats its input as
hostile: archives are bounded by entry count and inflated size, XML by depth and element count,
DOCTYPE declarations are skipped and their entities never expanded, and encrypted files are
refused rather than guessed at.

The Microsoft gatekeeper (`packages/gatekeeper-microsoft`) uses this to read files for agents, and
keeps the code that writes and edits Office files. The Workshop frontend uses it to preview chat
attachments (`packages/workshop-frontend/src/features/chat/attachments`).

```bash
pnpm --filter @gadgets/office-content test:run
```
