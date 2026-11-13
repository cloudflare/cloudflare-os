// Excel number formats: turns a stored number (or text) and a format code such as
// `#,##0.00;[Red](#,##0.00)` into the text Excel would show in the cell. Covers the section rules,
// digit placeholders, scaling, literals, colours, simple conditions, currency tags, fractions,
// scientific notation, dates, times and elapsed time, in English.

/** What a cell shows. */
export interface FormattedValue {
  readonly text: string;
  /** The colour a format section asks for (`[Red]`), as `#RRGGBB`. */
  readonly color?: string;
}

/** A parsed format code. */
export interface NumberFormat {
  /** True when the code shows numbers as dates or times, so its cells hold serial dates. */
  readonly isDate: boolean;
  /** Formats a number; `date1904` selects the workbook's date system for date codes. */
  format(value: number, date1904?: boolean): FormattedValue;
  /** Formats a text value, through the code's text section if it has one. */
  formatText(text: string): FormattedValue;
}

type DatePart =
  | "yy" | "yyyy" | "m" | "mm" | "mmm" | "mmmm" | "mmmmm" | "d" | "dd" | "ddd" | "dddd"
  | "h" | "hh" | "min" | "minmin" | "s" | "ss" | "ampm" | "ap" | "[h]" | "[m]" | "[s]";

type Token =
  | { readonly kind: "literal"; readonly text: string }
  /** `0`, `#` or `?`. */
  | { readonly kind: "digit"; readonly char: string }
  | { readonly kind: "point" }
  | { readonly kind: "comma" }
  | { readonly kind: "percent" }
  | { readonly kind: "exponent"; readonly plus: boolean }
  | { readonly kind: "slash" }
  | { readonly kind: "general" }
  | { readonly kind: "text" }
  | { readonly kind: "date"; readonly part: DatePart; readonly width: number; readonly upper?: boolean }
  /** Fractional seconds: `.000` after seconds. */
  | { readonly kind: "subsecond"; readonly digits: number };

interface Condition {
  readonly operator: string;
  readonly operand: number;
}

interface Section {
  readonly tokens: readonly Token[];
  readonly color?: string;
  readonly condition?: Condition;
  readonly isDate: boolean;
  readonly hasText: boolean;
}

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: "#000000", blue: "#0000FF", cyan: "#00FFFF", green: "#00FF00",
  magenta: "#FF00FF", red: "#FF0000", white: "#FFFFFF", yellow: "#FFFF00",
};

/**
 * The legacy 64-colour palette `indexed` colours and `[ColorN]` format tags refer to (ECMA-376
 * Part 1, 18.8.27). `[Color1]` is entry 8.
 */
export const INDEXED_COLORS: readonly string[] = (
  "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF " +
  "800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF " +
  "000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 " +
  "3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333"
).split(" ").map(hex => `#${hex}`);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The codes of the built-in format ids, which a file uses without declaring them (ECMA-376 Part 1,
 * 18.8.30), as Excel shows them in English (United States): id 14 is the short date `m/d/yyyy`
 * there, not the `mm-dd-yy` the standard lists. Ids 27 to 36 and 50 to 58 are East Asian date and
 * time formats, shown as plain dates and times.
 */
export function builtInFormatCode(id: number): string {
  if ((id >= 27 && id <= 31) || id === 36 || (id >= 50 && id <= 58)) return "m/d/yyyy";
  if (id >= 32 && id <= 35) return "h:mm:ss";
  return BUILT_IN[id] ?? "General";
}

const BUILT_IN: Readonly<Record<number, string>> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
  5: '"$"#,##0_);("$"#,##0)', 6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
  18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm",
  37: "#,##0_);(#,##0)", 38: "#,##0_);[Red](#,##0)", 39: "#,##0.00_);(#,##0.00)", 40: "#,##0.00_);[Red](#,##0.00)",
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
};

/** Format codes are attacker-chosen; one longer than Excel accepts (255) is not worth parsing. */
const MAX_CODE_LENGTH = 1024;

/** Parses a format code. A code that makes no sense formats as General rather than throwing. */
export function parseNumberFormat(code: string): NumberFormat {
  const sections = code === "" || code.length > MAX_CODE_LENGTH ? [] : splitSections(code).slice(0, 4).map(parseSection);
  if (sections.length === 0) sections.push(parseSection("General"));
  // The fourth section is for text; so is a lone last section that has `@` and no number in it.
  const last = sections[sections.length - 1]!;
  const textSection = sections.length === 4 || (last.hasText && !last.tokens.some(isNumberToken)) ? last : undefined;
  // A number in a cell formatted as text shows as General.
  const numberSections = !textSection ? sections : sections.length > 1 ? sections.slice(0, -1) : [parseSection("General")];
  return {
    isDate: numberSections[0]!.isDate,
    format: (value, date1904 = false) => formatNumberValue(value, numberSections, date1904),
    formatText: text => textSection ? { text: renderText(textSection, text), color: textSection.color } : { text },
  };
}

function isNumberToken(token: Token): boolean {
  return token.kind === "digit" || token.kind === "general" || token.kind === "date";
}

function splitSections(code: string): string[] {
  const sections: string[] = [];
  let start = 0;
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    if (char === '"') {
      const close = code.indexOf('"', index + 1);
      index = close < 0 ? code.length : close;
    } else if (char === "[") {
      const close = code.indexOf("]", index + 1);
      index = close < 0 ? code.length : close;
    } else if (char === "\\" || char === "_" || char === "*") {
      index++;
    } else if (char === ";") {
      sections.push(code.slice(start, index));
      start = index + 1;
    }
  }
  sections.push(code.slice(start));
  return sections;
}

/** The date and time letters; any of them outside a literal makes a section a date format. */
const DATE_LETTERS = /[ymdhs]/i;

function parseSection(code: string): Section {
  const tokens: Token[] = [];
  let color: string | undefined;
  let condition: Condition | undefined;
  const literal = (text: string) => {
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === "literal") tokens[tokens.length - 1] = { kind: "literal", text: previous.text + text };
    else tokens.push({ kind: "literal", text });
  };
  const bare = code.replace(/"[^"]*"?|\[[^\]]*\]?|[\\_*]./g, "");
  const isGeneral = /general/i.test(bare);
  const isDate = !isGeneral && (DATE_LETTERS.test(bare.replace(/e[+-]/gi, "")) || /\[(h+|m+|s+)\]/i.test(code));

  for (let index = 0; index < code.length; index++) {
    const char = code[index]!;
    if (char === '"') {
      const close = code.indexOf('"', index + 1);
      const end = close < 0 ? code.length : close;
      literal(code.slice(index + 1, end));
      index = end;
    } else if (char === "\\") {
      if (index + 1 < code.length) literal(code[++index]!);
    } else if (char === "_") {
      // Leaves room as wide as the next character; a space is as close as text gets.
      index++;
      literal(" ");
    } else if (char === "*") {
      // Repeats the next character to fill the column, which needs the column's width.
      index++;
    } else if (char === "[") {
      const close = code.indexOf("]", index + 1);
      const end = close < 0 ? code.length : close;
      const tag = code.slice(index + 1, end);
      index = end;
      const elapsed = /^(h+|m+|s+)$/i.exec(tag);
      const compare = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(tag);
      const indexed = /^color\s*(\d+)$/i.exec(tag);
      if (elapsed) {
        const part = `[${tag[0]!.toLowerCase()}]`;
        if (part === "[h]" || part === "[m]" || part === "[s]") tokens.push({ kind: "date", part, width: tag.length });
      } else if (compare) condition = { operator: compare[1]!, operand: Number(compare[2]) };
      else if (indexed) color = INDEXED_COLORS[Number(indexed[1]) + 7] ?? color;
      else if (NAMED_COLORS[tag.toLowerCase()]) color = NAMED_COLORS[tag.toLowerCase()];
      // `[$€-407]` is a currency symbol and a locale; `[$-409]` only a locale.
      else if (tag.startsWith("$")) literal(tag.slice(1).split("-")[0]!);
    } else if (/^general/i.test(code.slice(index, index + 7))) {
      tokens.push({ kind: "general" });
      index += 6;
    } else if (char === "@") {
      tokens.push({ kind: "text" });
    } else if (isDate) {
      index = dateToken(code, index, tokens, literal);
    } else if (char === "0" || char === "#" || char === "?") {
      tokens.push({ kind: "digit", char });
    } else if (char === ".") {
      tokens.push({ kind: "point" });
    } else if (char === ",") {
      tokens.push({ kind: "comma" });
    } else if (char === "%") {
      tokens.push({ kind: "percent" });
    } else if (char === "/") {
      tokens.push({ kind: "slash" });
    } else if ((char === "E" || char === "e") && (code[index + 1] === "+" || code[index + 1] === "-")) {
      tokens.push({ kind: "exponent", plus: code[++index] === "+" });
    } else {
      literal(char);
    }
  }
  return { tokens: isDate ? resolveMinutes(tokens) : tokens, color, condition, isDate, hasText: tokens.some(token => token.kind === "text") };
}

/** Reads one date token at `index`, returning the index of its last character. */
function dateToken(code: string, index: number, tokens: Token[], literal: (text: string) => void): number {
  const char = code[index]!;
  const lower = char.toLowerCase();
  const rest = code.slice(index, index + 5).toLowerCase();
  if (rest === "am/pm") {
    tokens.push({ kind: "date", part: "ampm", width: 5, upper: char === "A" });
    return index + 4;
  }
  if (rest.startsWith("a/p")) {
    tokens.push({ kind: "date", part: "ap", width: 3, upper: char === "A" });
    return index + 2;
  }
  if ("ymdhs".includes(lower)) {
    let end = index;
    while (code[end + 1]?.toLowerCase() === lower) end++;
    const width = end - index + 1;
    const part: DatePart =
      lower === "y" ? (width <= 2 ? "yy" : "yyyy")
      : lower === "m" ? (["m", "mm", "mmm", "mmmm", "mmmmm"] as const)[Math.min(width, 5) - 1]!
      : lower === "d" ? (["d", "dd", "ddd", "dddd"] as const)[Math.min(width, 4) - 1]!
      : lower === "h" ? (width === 1 ? "h" : "hh")
      : (width === 1 ? "s" : "ss");
    tokens.push({ kind: "date", part, width });
    return end;
  }
  const previous = tokens[tokens.length - 1];
  if (char === "." && code[index + 1] === "0" && previous?.kind === "date" && (previous.part === "s" || previous.part === "ss" || previous.part === "[s]")) {
    let end = index + 1;
    while (code[end + 1] === "0") end++;
    tokens.push({ kind: "subsecond", digits: end - index });
    return end;
  }
  literal(char);
  return index;
}

/** `m` and `mm` mean minutes right after hours or right before seconds, and months otherwise. */
function resolveMinutes(tokens: readonly Token[]): Token[] {
  const parts = tokens.flatMap((token, index) => token.kind === "date" ? [{ token, index }] : []);
  const resolved = [...tokens];
  parts.forEach(({ token, index }, position) => {
    if (token.part !== "m" && token.part !== "mm") return;
    const before = parts[position - 1]?.token.part;
    const after = parts[position + 1]?.token.part;
    if (before === "h" || before === "hh" || before === "[h]" || after === "s" || after === "ss") {
      resolved[index] = { ...token, part: token.part === "m" ? "min" : "minmin" };
    }
  });
  return resolved;
}

function matches(condition: Condition, value: number): boolean {
  switch (condition.operator) {
    case "<": return value < condition.operand;
    case "<=": return value <= condition.operand;
    case ">": return value > condition.operand;
    case ">=": return value >= condition.operand;
    case "=": return value === condition.operand;
    default: return value !== condition.operand;
  }
}

function formatNumberValue(value: number, sections: readonly Section[], date1904: boolean): FormattedValue {
  if (!Number.isFinite(value)) return { text: String(value) };
  // Without conditions: one section takes every number; two split at zero; three give zero its own.
  const defaults: Condition[] = sections.length > 2
    ? [{ operator: ">", operand: 0 }, { operator: "<", operand: 0 }]
    : [{ operator: ">=", operand: 0 }];
  let section = sections[sections.length - 1]!;
  let chosen = sections.length - 1;
  for (let index = 0; index < sections.length - 1; index++) {
    const condition = sections[index]!.condition ?? defaults[index];
    if (condition && matches(condition, value)) {
      section = sections[index]!;
      chosen = index;
      break;
    }
  }
  // A section reached because the number is negative shows it without a sign: its own literals
  // (parentheses, a minus) say so instead.
  const ownsSign = value < 0 && sections.length > 1 && chosen > 0 && !sections[0]!.condition;
  const text = section.isDate
    ? renderDate(section, value, date1904)
    : (value < 0 && !ownsSign ? "-" : "") + renderNumber(section.tokens, Math.abs(value));
  return section.color ? { text, color: section.color } : { text };
}

function renderText(section: Section, text: string): string {
  return section.tokens.map(token => token.kind === "literal" ? token.text : token.kind === "text" ? text : "").join("");
}

/**
 * `value` as decimal digits rounded half away from zero to `decimals` places. Rounds the number's
 * 15 significant digits, as Excel does, so 1.005 gives 1.01 rather than the 1.00 its binary value
 * would.
 */
function fixed(value: number, decimals: number): string {
  if (value >= 1e21) return value.toFixed(0);
  const scaled = Number(`${Number(value.toPrecision(15))}e${decimals}`);
  const rounded = Number(`${Math.round(scaled)}e-${decimals}`);
  return Number.isFinite(rounded) ? rounded.toFixed(decimals) : value.toFixed(decimals);
}

/**
 * A number the way the General format shows it: up to 11 characters of digits and decimal point,
 * and scientific notation for what would not fit.
 */
export function formatGeneral(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return Number.isFinite(value) ? "0" : String(value);
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  const exponent = Math.floor(Math.log10(magnitude));
  if (exponent < 11) {
    const text = trimZeros(fixed(magnitude, exponent < 0 ? 9 : Math.max(0, 9 - exponent)));
    // Small numbers stay in decimal form while that loses nothing, as 0.00001 does.
    const exact = exponent >= -4 || Number(text) === Number(magnitude.toPrecision(15));
    if (exact && text.replace(".", "").length <= 11 && text !== "0") return sign + text;
  }
  const [mantissa, power] = magnitude.toExponential(5).split("e") as [string, string];
  return `${sign}${trimZeros(mantissa)}E${power[0]}${power.slice(1).padStart(2, "0")}`;
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

function renderNumber(tokens: readonly Token[], magnitude: number): string {
  if (tokens.some(token => token.kind === "general")) return tokens.map(token => renderOther(token, magnitude)).join("");
  let value = magnitude;
  for (const token of tokens) if (token.kind === "percent") value *= 100;

  // Commas between digit placeholders group thousands; ones after the last placeholder each
  // divide the number by a thousand.
  let lastDigit = -1;
  tokens.forEach((token, index) => {
    if (token.kind === "digit") lastDigit = index;
  });
  const firstDigit = tokens.findIndex(token => token.kind === "digit");
  let grouping = false;
  const kept: Token[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "comma") kept.push(token);
    else if (firstDigit < 0 || index < firstDigit) kept.push({ kind: "literal", text: "," });
    else if (index < lastDigit) grouping = true;
    else if (tokens.slice(lastDigit + 1, index).every(between => between.kind === "comma")) value /= 1000;
    else kept.push({ kind: "literal", text: "," });
  });

  const exponentAt = kept.findIndex(token => token.kind === "exponent");
  if (exponentAt >= 0) return renderScientific(kept, exponentAt, value, grouping);
  const slashAt = kept.findIndex(token => token.kind === "slash");
  if (slashAt >= 0 && kept.slice(0, slashAt).some(token => token.kind === "digit")) return renderFraction(kept, slashAt, value);
  return renderDecimal(kept, value, grouping);
}

/** Fills integer and decimal placeholders with `value`'s digits, keeping literals where they sit. */
function renderDecimal(tokens: readonly Token[], value: number, grouping: boolean): string {
  const pointAt = tokens.findIndex(token => token.kind === "point");
  const integerTokens = pointAt < 0 ? tokens : tokens.slice(0, pointAt);
  const decimalTokens = pointAt < 0 ? [] : tokens.slice(pointAt + 1);
  const decimals = decimalTokens.filter(token => token.kind === "digit").length;
  const [whole = "0", fraction = ""] = fixed(value, decimals).split(".");
  return renderInteger(integerTokens, whole === "0" ? "" : whole, grouping, pointAt >= 0) +
    (pointAt < 0 ? "" : "." + renderFractionDigits(decimalTokens, fraction));
}

/**
 * Places `digits` (no leading zeros; empty for zero) into the placeholders from the right. Digits
 * the placeholders have no room for go in front of the first one.
 */
function renderInteger(tokens: readonly Token[], digits: string, grouping: boolean, beforePoint = false): string {
  const placeholders = tokens.filter(token => token.kind === "digit").length;
  if (placeholders === 0) {
    const literals = tokens.map(token => renderOther(token, 0)).join("");
    return beforePoint ? literals + digits : literals;
  }
  let out = "";
  // How many digit positions lie to the right of the one being placed.
  let position = 0;
  let remaining = digits;
  let seen = 0;
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index]!;
    if (token.kind !== "digit") {
      out = renderOther(token, 0) + out;
      continue;
    }
    seen++;
    // The leftmost placeholder takes every digit still unplaced.
    const take = seen === placeholders ? remaining : remaining.slice(-1);
    remaining = remaining.slice(0, remaining.length - take.length);
    if (take === "") {
      const filler = token.char === "0" ? "0" : token.char === "?" ? " " : "";
      out = filler + (grouping && filler === "0" && position > 0 && position % 3 === 0 ? "," : "") + out;
      position++;
      continue;
    }
    for (let at = take.length - 1; at >= 0; at--) {
      out = take[at] + (grouping && position > 0 && position % 3 === 0 ? "," : "") + out;
      position++;
    }
  }
  return out;
}

function renderFractionDigits(tokens: readonly Token[], digits: string): string {
  let out = "";
  let at = 0;
  for (const token of tokens) {
    if (token.kind !== "digit") {
      out += renderOther(token, 0);
      continue;
    }
    const digit = digits[at] ?? "0";
    // `#` and `?` drop zeros that end the number; `0` keeps them.
    const trailing = /^0*$/.test(digits.slice(at));
    at++;
    out += token.char === "0" || !trailing ? digit : token.char === "?" ? " " : "";
  }
  return out;
}

function renderOther(token: Token, value: number): string {
  switch (token.kind) {
    case "literal": return token.text;
    case "percent": return "%";
    case "general": return formatGeneral(value);
    case "slash": return "/";
    case "point": return ".";
    default: return "";
  }
}

function renderScientific(tokens: readonly Token[], exponentAt: number, value: number, grouping: boolean): string {
  const mantissaTokens = tokens.slice(0, exponentAt);
  const exponentTokens = tokens.slice(exponentAt + 1);
  const pointAt = mantissaTokens.findIndex(token => token.kind === "point");
  const integerDigits = Math.max(1, (pointAt < 0 ? mantissaTokens : mantissaTokens.slice(0, pointAt)).filter(token => token.kind === "digit").length);
  const decimals = pointAt < 0 ? 0 : mantissaTokens.slice(pointAt + 1).filter(token => token.kind === "digit").length;
  // The exponent moves in steps of the integer placeholders: `##0.0E+0` is engineering notation.
  const step = (raw: number) => Math.floor(raw / integerDigits) * integerDigits;
  let exponent = value === 0 ? 0 : step(Math.floor(Math.log10(value)));
  let mantissa = value === 0 ? 0 : value / 10 ** exponent;
  if (Number(fixed(mantissa, decimals)) >= 10 ** integerDigits) {
    exponent += integerDigits;
    mantissa = value / 10 ** exponent;
  }
  const marker = tokens[exponentAt]!;
  const sign = exponent < 0 ? "-" : marker.kind === "exponent" && marker.plus ? "+" : "";
  return renderDecimal(mantissaTokens, mantissa, grouping) + "E" + sign + renderInteger(exponentTokens, String(Math.abs(exponent)).replace(/^0$/, ""), false);
}

/** The fraction nearest `value` whose denominator is at most `maxDenominator`, by continued fractions. */
function nearestFraction(value: number, maxDenominator: number): [number, number] {
  let [previousNumerator, numerator] = [0, 1];
  let [previousDenominator, denominator] = [1, 0];
  let rest = value;
  for (let step = 0; step < 32; step++) {
    const whole = Math.floor(rest);
    const nextNumerator = whole * numerator + previousNumerator;
    const nextDenominator = whole * denominator + previousDenominator;
    if (nextDenominator > maxDenominator) break;
    [previousNumerator, numerator] = [numerator, nextNumerator];
    [previousDenominator, denominator] = [denominator, nextDenominator];
    if (Math.abs(rest - whole) < 1e-12) break;
    rest = 1 / (rest - whole);
  }
  return denominator === 0 ? [Math.round(value), 1] : [numerator, denominator];
}

function renderFraction(tokens: readonly Token[], slashAt: number, value: number): string {
  // Before the slash: an optional integer part, then the numerator's placeholders.
  let numeratorStart = slashAt;
  while (numeratorStart > 0 && tokens[numeratorStart - 1]!.kind === "digit") numeratorStart--;
  const integerTokens = tokens.slice(0, numeratorStart);
  const hasInteger = integerTokens.some(token => token.kind === "digit");
  const numeratorTokens = tokens.slice(numeratorStart, slashAt);
  let denominatorEnd = slashAt + 1;
  while (denominatorEnd < tokens.length && tokens[denominatorEnd]!.kind === "digit") denominatorEnd++;
  let denominatorTokens = tokens.slice(slashAt + 1, denominatorEnd);
  let suffix = tokens.slice(denominatorEnd);

  // `# ?/8` fixes the denominator: its digits arrive as literal text after the slash.
  let fixedDenominator: number | undefined;
  const after = tokens[slashAt + 1];
  if (denominatorTokens.length === 0 && after?.kind === "literal") {
    const digits = /^\d+/.exec(after.text)?.[0];
    if (digits) {
      fixedDenominator = Number(digits);
      denominatorTokens = [];
      suffix = [{ kind: "literal", text: after.text.slice(digits.length) }, ...tokens.slice(slashAt + 2)];
    }
  }

  const whole = hasInteger ? Math.floor(value) : 0;
  const part = value - whole;
  let numerator: number;
  let denominator: number;
  if (fixedDenominator) {
    denominator = fixedDenominator;
    numerator = Math.round(part * denominator);
  } else {
    [numerator, denominator] = nearestFraction(part, 10 ** Math.min(denominatorTokens.length, 7) - 1);
  }
  let integer = whole;
  if (hasInteger && numerator === denominator) {
    integer++;
    numerator = 0;
  }
  const tail = suffix.map(token => renderOther(token, 0)).join("");
  const integerText = hasInteger ? renderInteger(integerTokens, integer === 0 ? "" : String(integer), false) : "";
  if (hasInteger && numerator === 0) {
    // A whole number leaves the fraction's room blank rather than showing 0/1.
    const blank = [...numeratorTokens, ...denominatorTokens].map(token => token.kind === "digit" && token.char === "#" ? "" : " ").join("");
    return (integer === 0 ? renderInteger(integerTokens, "0", false) : integerText) + blank + (blank ? " " : "") + tail;
  }
  const numeratorText = renderInteger(numeratorTokens, String(numerator), false);
  const denominatorText = fixedDenominator
    ? String(denominator)
    : String(denominator).padEnd(denominatorTokens.filter(token => token.kind === "digit" && token.char !== "#").length, " ");
  return `${integerText}${numeratorText}/${denominatorText}${tail}`;
}

const DAY_SECONDS = 86_400;
const DAY_MS = 86_400_000;

interface DateParts {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  readonly day: number;
  /** 0 is Sunday. */
  readonly weekday: number;
}

/**
 * The calendar date of a whole serial day. In the 1900 system day 1 is 1 January 1900 and day 60
 * is a 29 February 1900 that never was (a Lotus 1-2-3 bug Excel keeps), so real dates before it
 * are a day nearer the epoch than those after, and weekdays before it are Excel's, not history's.
 */
function serialDate(days: number, date1904: boolean): DateParts {
  if (date1904) {
    const date = new Date(Date.UTC(1904, 0, 1) + days * DAY_MS);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
  }
  const weekday = (days + 6) % 7;
  if (days === 60) return { year: 1900, month: 2, day: 29, weekday };
  if (days === 0) return { year: 1900, month: 1, day: 0, weekday };
  const date = new Date(Date.UTC(1899, 11, days < 60 ? 31 : 30) + days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function renderDate(section: Section, serial: number, date1904: boolean): string {
  // Excel has no dates before its epoch and fills the cell with hashes instead.
  if (serial < 0 || serial >= 2_958_466) return "########";
  const subsecond = section.tokens.find(token => token.kind === "subsecond");
  const precision = 10 ** (subsecond?.kind === "subsecond" ? Math.min(subsecond.digits, 3) : 0);
  // Seconds round to what the format shows; hours and minutes then only ever truncate.
  let days = Math.floor(serial);
  let ticks = Math.round((serial - days) * DAY_SECONDS * precision);
  if (ticks >= DAY_SECONDS * precision) {
    days++;
    ticks -= DAY_SECONDS * precision;
  }
  const seconds = Math.floor(ticks / precision);
  const date = serialDate(days, date1904);
  const hours = Math.floor(seconds / 3600);
  const twelveHour = section.tokens.some(token => token.kind === "date" && (token.part === "ampm" || token.part === "ap"));
  const totalSeconds = days * DAY_SECONDS + seconds;

  let out = "";
  for (const token of section.tokens) {
    if (token.kind === "subsecond") {
      out += "." + pad(ticks % precision, Math.min(token.digits, 3)).padEnd(token.digits, "0");
      continue;
    }
    if (token.kind !== "date") {
      out += renderOther(token, serial);
      continue;
    }
    switch (token.part) {
      case "yy": out += pad(date.year % 100, 2); break;
      case "yyyy": out += pad(date.year, 4); break;
      case "m": out += date.month; break;
      case "mm": out += pad(date.month, 2); break;
      case "mmm": out += MONTHS[date.month - 1]!.slice(0, 3); break;
      case "mmmm": out += MONTHS[date.month - 1]; break;
      case "mmmmm": out += MONTHS[date.month - 1]![0]; break;
      case "d": out += date.day; break;
      case "dd": out += pad(date.day, 2); break;
      case "ddd": out += DAYS[date.weekday]!.slice(0, 3); break;
      case "dddd": out += DAYS[date.weekday]; break;
      case "h": out += twelveHour ? hours % 12 || 12 : hours; break;
      case "hh": out += pad(twelveHour ? hours % 12 || 12 : hours, 2); break;
      case "min": out += Math.floor(seconds / 60) % 60; break;
      case "minmin": out += pad(Math.floor(seconds / 60) % 60, 2); break;
      case "s": out += seconds % 60; break;
      case "ss": out += pad(seconds % 60, 2); break;
      case "ampm": out += token.upper ? (hours < 12 ? "AM" : "PM") : (hours < 12 ? "am" : "pm"); break;
      case "ap": out += token.upper ? (hours < 12 ? "A" : "P") : (hours < 12 ? "a" : "p"); break;
      case "[h]": out += pad(Math.floor(totalSeconds / 3600), token.width); break;
      case "[m]": out += pad(Math.floor(totalSeconds / 60), token.width); break;
      case "[s]": out += pad(totalSeconds, token.width); break;
    }
  }
  return out;
}
