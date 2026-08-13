// Incrementally parses a JSON object from a tool-call input stream, with O(n) total cost.
// One designated string field is streamed: its decoded value grows as new tokens arrive.
// All fields preceding it are parsed once (via JSON.parse) when the streaming field starts.
//
// Usage:
//   let parser = new StreamingToolInputParser("content");
//   parser.append('{"filename": "foo.ts", "content": "hel');
//   parser.append('lo world"}');
//   parser.prefixFields   // => {filename: "foo.ts"}
//   parser.streamingValue // => "hello world"

const JSON_SIMPLE_ESCAPES: Record<string, string | undefined> = {
  '"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f',
  'n': '\n', 'r': '\r', 't': '\t',
};

function isJsonWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

type ToolInputParserPhase =
  | "initial"        // before opening {
  | "expectKey"      // after { or , — expecting a key string
  | "inKey"          // inside a key string
  | "expectColon"    // after key string, expecting :
  | "expectValue"    // after :, expecting a value
  | "inStringValue"  // inside a non-streaming string value (skipping)
  | "inOtherValue"   // inside a non-string value (skipping with depth tracking)
  | "afterValue"     // after a complete value, expecting , or }
  | "streaming"      // decoding the streaming field's string value incrementally
  | "done"           // object closed or streaming field complete
  | "error";         // parse error

export class StreamingToolInputParser {
  #streamingFieldName: string;
  #buffer: string = "";
  #pos: number = 0;
  #phase: ToolInputParserPhase = "initial";

  // Key accumulation during "inKey" phase.
  #currentKey: string = "";
  #keyStartPos: number = 0;

  // Non-string value depth tracking during "inOtherValue".
  #valueDepth: number = 0;
  #valueInString: boolean = false;

  // Prefix: set once the streaming field's opening quote is found.
  #prefixFields: Record<string, unknown> | null = null;

  // Streaming string decoder output.
  #decodedValue: string = "";
  #streamComplete: boolean = false;

  constructor(streamingFieldName: string) {
    this.#streamingFieldName = streamingFieldName;
  }

  /** Feed a new chunk of raw JSON text from the tool-call input stream. */
  append(delta: string): void {
    this.#buffer += delta;
    this.#scan();
  }

  /**
   * The parsed fields that precede the streaming field.  Non-null once the streaming
   * field's opening quote has been found (meaning all prefix fields are complete).
   */
  get prefixFields(): Record<string, unknown> | null {
    return this.#prefixFields;
  }

  /** The decoded value of the streaming field accumulated so far. */
  get streamingValue(): string {
    return this.#decodedValue;
  }

  /** Whether the streaming field's string value has been fully received. */
  get streamComplete(): boolean {
    return this.#streamComplete;
  }

  /** Whether a JSON parse error was encountered. */
  get hasError(): boolean {
    return this.#phase === "error";
  }

  #scan(): void {
    while (this.#pos < this.#buffer.length) {
      let ch = this.#buffer[this.#pos];

      switch (this.#phase) {
        case "initial":
          if (isJsonWhitespace(ch)) { this.#pos++; break; }
          if (ch === "{") { this.#phase = "expectKey"; this.#pos++; break; }
          this.#phase = "error";
          return;

        case "expectKey":
          if (isJsonWhitespace(ch)) { this.#pos++; break; }
          if (ch === "}") { this.#phase = "done"; this.#pos++; return; }
          if (ch === '"') {
            this.#keyStartPos = this.#pos;
            this.#currentKey = "";
            this.#phase = "inKey";
            this.#pos++; // skip opening "
            break;
          }
          this.#phase = "error";
          return;

        case "inKey":
          if (ch === '\\') {
            // Leave pos at '\' — retry when more data arrives if incomplete.
            if (this.#pos + 1 >= this.#buffer.length) return;
            let esc = this.#buffer[this.#pos + 1];
            if (esc === 'u') {
              if (this.#pos + 6 > this.#buffer.length) return;
              let hex = this.#buffer.slice(this.#pos + 2, this.#pos + 6);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) { this.#phase = "error"; return; }
              this.#currentKey += String.fromCharCode(parseInt(hex, 16));
              this.#pos += 6;
            } else {
              let decoded = JSON_SIMPLE_ESCAPES[esc];
              if (decoded === undefined) { this.#phase = "error"; return; }
              this.#currentKey += decoded;
              this.#pos += 2;
            }
            break;
          }
          if (ch === '"') {
            this.#phase = "expectColon";
            this.#pos++;
            break;
          }
          this.#currentKey += ch;
          this.#pos++;
          break;

        case "expectColon":
          if (isJsonWhitespace(ch)) { this.#pos++; break; }
          if (ch === ':') { this.#phase = "expectValue"; this.#pos++; break; }
          this.#phase = "error";
          return;

        case "expectValue":
          if (isJsonWhitespace(ch)) { this.#pos++; break; }
          if (this.#currentKey === this.#streamingFieldName) {
            if (ch !== '"') { this.#phase = "error"; return; }
            this.#pos++; // skip opening "
            this.#phase = "streaming";
            this.#extractPrefix();
            break;
          }
          if (ch === '"') {
            this.#phase = "inStringValue";
            this.#pos++; // skip opening "
            break;
          }
          this.#valueDepth = (ch === '{' || ch === '[') ? 1 : 0;
          this.#valueInString = false;
          this.#phase = "inOtherValue";
          this.#pos++;
          break;

        case "inStringValue":
          if (ch === '\\') {
            // Leave pos at '\' if we don't have the next char yet.
            if (this.#pos + 1 >= this.#buffer.length) return;
            this.#pos += 2; // skip \ and escaped char
            break;
          }
          if (ch === '"') { this.#phase = "afterValue"; this.#pos++; break; }
          this.#pos++;
          break;

        case "inOtherValue":
          if (this.#valueInString) {
            if (ch === '\\') {
              if (this.#pos + 1 >= this.#buffer.length) return;
              this.#pos += 2;
              break;
            }
            if (ch === '"') { this.#valueInString = false; this.#pos++; break; }
            this.#pos++;
            break;
          }
          if (ch === '"') { this.#valueInString = true; this.#pos++; break; }
          if (ch === '{' || ch === '[') { this.#valueDepth++; this.#pos++; break; }
          if (ch === '}' || ch === ']') {
            if (this.#valueDepth > 0) {
              this.#valueDepth--;
              this.#pos++;
              if (this.#valueDepth === 0) this.#phase = "afterValue";
              break;
            }
            // Scalar at depth 0 — this char belongs to enclosing structure.
            this.#phase = "afterValue";
            break;
          }
          if (this.#valueDepth === 0 && (ch === ',' || isJsonWhitespace(ch))) {
            this.#phase = "afterValue";
            break;
          }
          this.#pos++;
          break;

        case "afterValue":
          if (isJsonWhitespace(ch)) { this.#pos++; break; }
          if (ch === ',') { this.#phase = "expectKey"; this.#pos++; break; }
          if (ch === '}') { this.#phase = "done"; this.#pos++; return; }
          this.#phase = "error";
          return;

        case "streaming":
          this.#decodeStreaming();
          return;

        case "done":
        case "error":
          return;
      }
    }
  }

  // Parse everything before the streaming field's key as JSON to extract prefix fields.
  #extractPrefix(): void {
    let prefix = this.#buffer.slice(0, this.#keyStartPos).trimEnd();
    if (prefix.endsWith(',')) prefix = prefix.slice(0, -1);
    prefix += '}';
    try {
      this.#prefixFields = JSON.parse(prefix);
    } catch {
      this.#prefixFields = {};
    }
  }

  // Decode the streaming field's string value incrementally.  Only processes characters
  // from #pos onward; escape sequences that straddle a chunk boundary are retried on
  // the next append() by leaving #pos at the '\'.
  #decodeStreaming(): void {
    let start = this.#pos;
    while (this.#pos < this.#buffer.length) {
      let ch = this.#buffer[this.#pos];
      if (ch === '"') {
        if (this.#pos > start) {
          this.#decodedValue += this.#buffer.slice(start, this.#pos);
        }
        this.#streamComplete = true;
        this.#phase = "done";
        this.#pos++;
        return;
      }
      if (ch === '\\') {
        // Flush any plain text accumulated before this escape.
        if (this.#pos > start) {
          this.#decodedValue += this.#buffer.slice(start, this.#pos);
        }
        if (this.#pos + 1 >= this.#buffer.length) return;
        let esc = this.#buffer[this.#pos + 1];
        let decoded = JSON_SIMPLE_ESCAPES[esc];
        if (decoded !== undefined) {
          this.#decodedValue += decoded;
          this.#pos += 2;
        } else if (esc === 'u') {
          if (this.#pos + 6 > this.#buffer.length) return;
          let hex = this.#buffer.slice(this.#pos + 2, this.#pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) { this.#phase = "error"; return; }
          this.#decodedValue += String.fromCharCode(parseInt(hex, 16));
          this.#pos += 6;
        } else {
          this.#phase = "error";
          return;
        }
        start = this.#pos;
        continue;
      }
      this.#pos++;
    }
    // Flush remaining plain text.
    if (this.#pos > start) {
      this.#decodedValue += this.#buffer.slice(start, this.#pos);
    }
  }
}
