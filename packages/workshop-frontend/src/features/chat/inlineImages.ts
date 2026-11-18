/** Recognize an SVG header with a linear scan of XML processing instructions, comments and DOCTYPE declarations. */
export function isSvgImage(head: string | Uint8Array): boolean {
  if (typeof head !== 'string') {
    const encoding = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le'
      : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8'
    head = new TextDecoder(encoding).decode(head)
  }
  let text = head.trimStart()
  while (true) {
    if (text.startsWith('<?')) {
      const end = text.indexOf('?>')
      if (end === -1) return false
      text = text.slice(end + 2).trimStart()
      continue
    }
    if (text.startsWith('<!--')) {
      const end = text.indexOf('-->')
      if (end === -1) return false
      text = text.slice(end + 3).trimStart()
      continue
    }
    if (!/^<!DOCTYPE\s+(?:[\w.-]+:)?svg[\s>]/i.test(text)) break
    // A '>' inside a quoted identifier or an internal subset doesn't end the DOCTYPE.
    let quote = '', subset = 0, end = -1
    for (let i = 9; i < text.length; i++) {
      const char = text[i]
      if (quote) {
        if (char === quote) quote = ''
      } else if (text.startsWith('<!--', i)) {
        const commentEnd = text.indexOf('-->', i + 4)
        if (commentEnd === -1) return false
        i = commentEnd + 2
      } else if (char === '"' || char === "'") quote = char
      else if (char === '[') subset++
      else if (char === ']') subset--
      else if (char === '>' && subset === 0) { end = i; break }
    }
    if (end === -1) return false
    text = text.slice(end + 1).trimStart()
  }
  return /^<(?:[\w.-]+:)?svg[\s/>]/i.test(text)
}
