import { describe, expect, it } from 'vitest'
import { withoutDataUrls } from './dataUrls'

const BUNDLE_URL = 'data:text/javascript;base64,Y29uc29sZS5sb2coMSk='
const PATHS = new Map([[BUNDLE_URL, 'client.js'], ['gadget:client.js', 'client.js']])

// A line of `n` "data:" candidates, each one a pattern would read a header from, inside a run of
// parameters that never reaches a comma: a matcher that reads the parameters on from each
// candidate reads the rest of the line once per candidate.
const candidates = (n: number) => 'data:a/b;p='.repeat(n)
const msToClean = (text: string) => {
  const start = performance.now()
  withoutDataUrls(text, PATHS)
  return performance.now() - start
}

describe('withoutDataUrls', () => {
  it("names the bundle's modules by their file and elides other data: URLs in stack frames", () => {
    expect(withoutDataUrls(`Error: x\n    at f (${BUNDLE_URL}:3:9)`, PATHS))
      .toBe('Error: x\n    at f (client.js:3:9)')
    for (const url of [
      'data:text/javascript;base64,QUJDRA==',
      `data:text/javascript,${encodeURIComponent("export const s = 'it (was) here: x';")}`,
      "data:text/javascript,export const s = 'a secret (here)';",
      // Headers Chromium accepts that no media-type pattern reads: a space, a quoted parameter.
      'data: text/javascript,export const s = 1;',
      'data:text/javascript;x="a;b",export const s = 1;',
    ]) {
      expect.soft(withoutDataUrls(`    at g (${url}:1:2)`, PATHS)).toBe('    at g (data:…:1:2)')
      expect.soft(withoutDataUrls(`    at ${url}:8:1`, PATHS)).toBe('    at data:…:8:1')
      // Firefox's frame: function@URL:line:column.
      expect.soft(withoutDataUrls(`render@${url}:3:5`, PATHS)).toBe('render@data:…:3:5')
    }
  })

  it('elides a data: URL outside a stack frame by its header, to the end of the text', () => {
    expect(withoutDataUrls('Failed to load data:text/javascript,secret source\nnext', PATHS))
      .toBe('Failed to load data:…')
    expect(withoutDataUrls(`Failed to load ${BUNDLE_URL}\nnext`, PATHS)).toBe('Failed to load client.js\nnext')
  })

  it("names a failed import's module as a location: the bundle's file, no data: payload, no query", () => {
    const failed = (url: string) => `TypeError: Failed to fetch dynamically imported module: ${url}`
    expect(withoutDataUrls(failed(BUNDLE_URL), PATHS)).toBe(failed('client.js'))
    expect(withoutDataUrls(failed('data:,export const s = 1'), PATHS)).toBe(failed('data:…'))
    expect(withoutDataUrls(failed('data:;base64,QUJD'), PATHS)).toBe(failed('data:…'))
    expect(withoutDataUrls(failed('https://cdn.example/x.js?ticket=abc#f'), PATHS))
      .toBe(failed('https://cdn.example/x.js'))
  })

  it("reads only the browser's message as a failed import, not the words in a module's source", () => {
    const source = 'data:text/javascript,// failed to load an imported module: x%0Athrow 1'
    expect(withoutDataUrls(`Uncaught Error: 1\n    at ${source}:2:1`, PATHS))
      .toBe('Uncaught Error: 1\n    at data:…:2:1')
    expect(withoutDataUrls('Error: the imported module: config is missing', PATHS))
      .toBe('Error: the imported module: config is missing')
    expect(withoutDataUrls(
      'Unhandled promise rejection: TypeError: Failed to fetch dynamically imported module: data:,x', PATHS))
      .toBe('Unhandled promise rejection: TypeError: Failed to fetch dynamically imported module: data:…')
  })

  it("keeps a missing export's reason and name, naming or eliding its module", () => {
    const missing = (url: string) =>
      `SyntaxError: The requested module '${url}' does not provide an export named 'absent'`
    expect(withoutDataUrls(missing(BUNDLE_URL), PATHS)).toBe(missing('client.js'))
    // The module's source may hold the words too: the last reason ends the URL.
    const source = "data:text/javascript,// ' does not provide an export named 'x'%0Aexport const y = 1"
    expect(withoutDataUrls(missing(source), PATHS)).toBe(missing('data:…'))
    expect(withoutDataUrls(`Uncaught ${missing(BUNDLE_URL)}`, PATHS)).toBe(`Uncaught ${missing('client.js')}`)
    // Cut before its reason, the rest of the line is the URL: a header no pattern reads included.
    expect(withoutDataUrls("SyntaxError: The requested module 'data: text/javascript,export const s", PATHS))
      .toBe("SyntaxError: The requested module 'data:…")
    // Clipped, any reason may be the module's own words, since the URL may span lines: nothing
    // after the URL's start is kept.
    const cut = `${missing(source)}`.slice(0, -"' does not provide an export named 'absent'".length)
    expect(withoutDataUrls(cut, PATHS, true)).toBe("SyntaxError: The requested module 'data:…")
    expect(withoutDataUrls(`Error: first\n${missing(BUNDLE_URL)}\n${cut}`, PATHS, true))
      .toBe("Error: first\nSyntaxError: The requested module 'data:…")
    // Chromium names a module the import map maps by its specifier.
    expect(withoutDataUrls(missing('gadget:client.js'), PATHS)).toBe(missing('client.js'))
    expect(withoutDataUrls(missing('gadget:unknown.js'), PATHS)).toBe(missing('…'))
    // Firefox's wording.
    const firefox = (url: string) => `SyntaxError: The requested module '${url}' doesn't provide an export named: 'absent'`
    expect(withoutDataUrls(firefox('gadget:client.js'), PATHS)).toBe(firefox('client.js'))
    expect(withoutDataUrls(firefox(source), PATHS)).toBe(firefox('data:…'))
    // A module's URL can hold newlines: it runs to the last reason, whatever lines it spans.
    const multiline = 'data:text/javascript,// first%0A\nsecret source\nexport const y = 1'
    expect(withoutDataUrls(`${missing(multiline)}\n    at x (https://example.test/a.js:1:2)`, PATHS))
      .toBe(`${missing('data:…')}\n    at x (https://example.test/a.js:1:2)`)
    expect(withoutDataUrls(`SyntaxError: The requested module '${multiline}`, PATHS))
      .toBe("SyntaxError: The requested module 'data:…")
    // A stack frame whose module's source holds the words is a location, elided whole.
    const framed = "data:text/javascript,// The requested module 'x' does not provide an export named 'y'"
    expect(withoutDataUrls(`    at ${framed}:1:1`, PATHS)).toBe('    at data:…:1:1')
  })

  it('takes the rest of the text as part of a data: URL that may hold newlines', () => {
    const frame = '    at y (https://example.test/b.js:3:4)'
    // A frame's URL with no position on its line runs on.
    expect(withoutDataUrls('Error: x\n    at data:text/javascript,a\nsecret source:1:2\n' + frame, PATHS))
      .toBe('Error: x\n    at data:…')
    expect(withoutDataUrls('TypeError: Failed to fetch dynamically imported module: data:,a\nsecret', PATHS))
      .toBe('TypeError: Failed to fetch dynamically imported module: data:…')
    // The bundle's own URLs, and frames a position ends, end on their line.
    expect(withoutDataUrls(`TypeError: Failed to fetch dynamically imported module: ${BUNDLE_URL}\n${frame}`, PATHS))
      .toBe(`TypeError: Failed to fetch dynamically imported module: client.js\n${frame}`)
    expect(withoutDataUrls(`Error: x\n    at data:text/javascript,a:1:2\n${frame}`, PATHS))
      .toBe(`Error: x\n    at data:…:1:2\n${frame}`)
  })

  it("cuts a stack frame's http(s) location to its origin and path, keeping its position", () => {
    expect(withoutDataUrls('Error: x\n    at f (https://cdn.example/a.js?ticket=abc#frag:1:2)', PATHS))
      .toBe('Error: x\n    at f (https://cdn.example/a.js:1:2)')
    expect(withoutDataUrls('    at https://cdn.example/a.js?ticket=abc:3:4', PATHS))
      .toBe('    at https://cdn.example/a.js:3:4')
    expect(withoutDataUrls('f@https://cdn.example/a.js#k=v:5:6', PATHS)).toBe('f@https://cdn.example/a.js:5:6')
    // With no position, to the next space, so that prose after a URL keeps its reason.
    expect(withoutDataUrls('    at https://cdn.example/a.js?ticket=abc', PATHS)).toBe('    at https://cdn.example/a.js')
    expect(withoutDataUrls('Error: request failed at https://cdn.example/a.js?version=2: disk is full', PATHS))
      .toBe('Error: request failed at https://cdn.example/a.js: disk is full')
    expect(withoutDataUrls('Error: failed (https://api.example/x?token=abc), retrying', PATHS))
      .toBe('Error: failed (https://api.example/x), retrying')
    // A URL a message quotes, as a Worker's SecurityError does its script's.
    expect(withoutDataUrls(
      "SecurityError: Script at 'https://cdn.example/w.js?ticket=abc#f' cannot be accessed from origin 'null'.", PATHS))
      .toBe("SecurityError: Script at 'https://cdn.example/w.js' cannot be accessed from origin 'null'.")
    // An IPv6 host keeps its closing bracket.
    expect(withoutDataUrls('Loading failed at http://[::1]', PATHS)).toBe('Loading failed at http://[::1]/')
    expect(withoutDataUrls('    at f (http://[::1]:8080/a.js?t=1:1:2)', PATHS)).toBe('    at f (http://[::1]:8080/a.js:1:2)')
    // A bracket in a query is not a host's.
    expect(withoutDataUrls('    at f (https://x.example/a.js?k[]=secret:1:2)', PATHS)).toBe('    at f (https://x.example/a.js:1:2)')
    // Every one on a line, and a data: URL after one is still elided.
    expect(withoutDataUrls('from https://a.example/x?k=1 to https://b.example/y#t then data:,secret', PATHS))
      .toBe('from https://a.example/x to https://b.example/y then data:…')
    // A data: location that comes first is still elided, an http(s) URL in its source with it.
    expect(withoutDataUrls("    at data:text/javascript,import('https://x/y?k=1'):1:2", PATHS))
      .toBe('    at data:…:1:2')
  })

  it("reads a bracket or an \"@\" before data: as a location only on a stack frame's line", () => {
    const frames = '\n    at decode (data:text/javascript,secret:1:2)\nf@data:text/javascript,secret:3:4'
    expect(withoutDataUrls(`TypeError: Schema validation failed (data: expected an object)${frames}`, PATHS))
      .toBe('TypeError: Schema validation failed (data: expected an object)\n    at decode (data:…:1:2)\nf@data:…:3:4')
    expect(withoutDataUrls('Error: mail me@data: nothing here', PATHS)).toBe('Error: mail me@data: nothing here')
  })

  it('elides a data: URL with no media type outside a frame', () => {
    expect(withoutDataUrls('loading data:,secret then', PATHS)).toBe('loading data:…')
    expect(withoutDataUrls('loading data:;base64,c2VjcmV0', PATHS)).toBe('loading data:…')
  })

  it('keeps prose that only says "data:"', () => {
    for (const text of ['Error: Invalid metadata: missing upload timestamp', 'bad data: expected a number']) {
      expect(withoutDataUrls(text, PATHS)).toBe(text)
    }
  })

  // The text is the frame's: one built to make a matcher read the rest of a line again from each
  // candidate must not cost more than its length.
  it('reads each line once, however many "data:" candidates it holds', () => {
    msToClean(candidates(1_000))
    // About the reporter's whole window of a part, and a quarter of it.
    const small = msToClean(candidates(1_450))
    const large = msToClean(candidates(5_800))
    // Four times the text costs about four times the time, not sixteen.
    expect(large).toBeLessThan(Math.max(small, 1) * 10)
    expect(large).toBeLessThan(50)
  })
})
