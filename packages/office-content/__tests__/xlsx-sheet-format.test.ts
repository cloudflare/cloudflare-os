import { describe, expect, it } from "vitest";
import { builtInFormatCode, formatGeneral, parseNumberFormat } from "../src/xlsx-sheet-format";

const show = (code: string, value: number, date1904 = false) => parseNumberFormat(code).format(value, date1904).text;

describe("formatGeneral", () => {
  it.each([
    [0, "0"],
    [42, "42"],
    [-7.5, "-7.5"],
    [0.1 + 0.2, "0.3"],
    [1234.5678912345, "1234.567891"],
    [12345678901, "12345678901"],
    [123456789012, "1.23457E+11"],
    [1e20, "1E+20"],
    [0.000123456789, "0.000123457"],
    [0.0000123456789, "1.23457E-05"],
    [0.00001, "0.00001"],
    [1e-10, "1E-10"],
    [-1e-10, "-1E-10"],
    [1 / 3, "0.333333333"],
    [99999999999.9, "1E+11"],
  ])("shows %d as %s", (value, expected) => {
    expect(formatGeneral(value)).toBe(expected);
  });
});

describe("parseNumberFormat", () => {
  it.each<[string, number, string]>([
    // Digit placeholders and rounding.
    ["0", 1234.5, "1235"],
    ["0.00", 1.005, "1.01"],
    ["0.00", 2, "2.00"],
    ["0.0", -0.04, "-0.0"],
    ["#.##", 1.5, "1.5"],
    ["#.##", 12, "12."],
    ["#.00", 0.5, ".50"],
    ["000", 7, "007"],
    ["0.0#", 2.71628, "2.72"],
    ["?.??", 1.5, "1.5 "],
    // Thousands separators and scaling.
    ["#,##0", 1234567, "1,234,567"],
    ["#,##0", 999, "999"],
    ["#,##0", 0, "0"],
    ["#,##0.00", 1234.5, "1,234.50"],
    ["#,##0.00", -1234.5, "-1,234.50"],
    ["0,000", 5, "0,005"],
    ["#,##0,", 1234567, "1,235"],
    ["0.0,,", 12345678, "12.3"],
    ['#,##0,"K"', 1500000, "1,500K"],
    // Currency, literals, escapes, padding and fill.
    ["$#,##0.00", 1200, "$1,200.00"],
    ["$#,##0.00", -1200, "-$1,200.00"],
    ['0.0" days"', 1.5, "1.5 days"],
    ["0\\ \\k\\g", 12, "12 kg"],
    ["[$€-407]#,##0.00", 1234.5, "€1,234.50"],
    ["#,##0.00 [$kr-41D]", 12, "12.00 kr"],
    ["[$-409]0.0", 2, "2.0"],
    ["#,##0_);(#,##0)", 1234, "1,234 "],
    ["#,##0_);(#,##0)", -1234, "(1,234)"],
    ['_($* #,##0.00_);_($* \\(#,##0.00\\);_($* "-"??_);_(@_)', 1200, " $1,200.00 "],
    ['_($* #,##0.00_);_($* \\(#,##0.00\\);_($* "-"??_);_(@_)', -1200, " $(1,200.00)"],
    ['_($* #,##0.00_);_($* \\(#,##0.00\\);_($* "-"??_);_(@_)', 0, " $-   "],
    ["000-00-0000", 123456789, "123-45-6789"],
    ["(###) ###-####", 5551234567, "(555) 123-4567"],
    // Percent.
    ["0%", 0.125, "13%"],
    ["0.0%", 0.125, "12.5%"],
    ["0.00%", -0.5, "-50.00%"],
    // Sections.
    ["0.00;[Red]-0.00", -3, "-3.00"],
    ['0;-0;"zero"', 0, "zero"],
    ['0;-0;"zero"', -2, "-2"],
    ['"up";"down"', -1, "down"],
    ['[>=100]"high";[<10]"low";0', 150, "high"],
    ['[>=100]"high";[<10]"low";0', 5, "low"],
    ['[>=100]"high";[<10]"low";0', 50, "50"],
    ['[<1000]0;0.0,"k"', 2500, "2.5k"],
    // General inside a code.
    ['General" units"', 2.5, "2.5 units"],
    ["General", 1234567.891, "1234567.891"],
    ["@", 12, "12"],
    // Scientific.
    ["0.00E+00", 12345, "1.23E+04"],
    ["0.00E+00", 0.00012345, "1.23E-04"],
    ["0.00E+00", 0, "0.00E+00"],
    ["0.0E-0", 12345, "1.2E4"],
    ["##0.0E+0", 12345, "12.3E+3"],
    ["##0.0E+0", 1234567, "1.2E+6"],
    ["0.00E+00", 9.999e5, "1.00E+06"],
    // Fractions.
    ["# ?/?", 5.25, "5 1/4"],
    ["# ?/?", 0.5, " 1/2"],
    ["# ??/??", 1.3125, "1  5/16"],
    ["# ?/?", 3, "3    "],
    ["# ?/8", 2.375, "2 3/8"],
    ["?/?", 1.5, "3/2"],
    ["# ?/?", 2.999, "3    "],
  ])("formats %s of %d as %j", (code, value, expected) => {
    expect(show(code, value)).toBe(expected);
  });

  it("returns the colour a section names", () => {
    const format = parseNumberFormat("#,##0.00;[Red]-#,##0.00;[Blue]0;[Color10]@");
    expect(format.format(1.5)).toEqual({ text: "1.50" });
    expect(format.format(-1.5)).toEqual({ text: "-1.50", color: "#FF0000" });
    expect(format.format(0)).toEqual({ text: "0", color: "#0000FF" });
    expect(format.formatText("n/a")).toEqual({ text: "n/a", color: "#008000" });
  });

  it("puts text through the text section, and leaves it alone without one", () => {
    expect(parseNumberFormat('0;-0;0;"<"@">"').formatText("x")).toEqual({ text: "<x>", color: undefined });
    expect(parseNumberFormat('"ID: "@').formatText("x").text).toBe("ID: x");
    expect(parseNumberFormat("0.00").formatText("x")).toEqual({ text: "x" });
  });

  // 45000.75 is 15 March 2023 (a Wednesday), 18:00:00.
  it.each<[string, number, string]>([
    ["yyyy-mm-dd", 45000, "2023-03-15"],
    ["m/d/yy", 45000, "3/15/23"],
    ["d-mmm-yy", 45000, "15-Mar-23"],
    ["dddd, mmmm d, yyyy", 45000, "Wednesday, March 15, 2023"],
    ["ddd dd mmm", 45000, "Wed 15 Mar"],
    ["mmmmm", 45000, "M"],
    ["[$-409]mmm\\ d", 45000, "Mar 15"],
    ["yyyy\\-mm\\-dd hh:mm", 45000.75, "2023-03-15 18:00"],
    ["h:mm AM/PM", 45000.75, "6:00 PM"],
    ["h:mm:ss am/pm", 0.5, "12:00:00 pm"],
    ["hh:mm A/P", 0.25, "06:00 A"],
    ["h:mm", 0.125, "3:00"],
    // m is minutes after hours or before seconds, and months otherwise.
    ["mm:ss", 0.5 + 754 / 86400, "12:34"],
    ["h \"h\" m \"m\"", 0.26, "6 h 14 m"],
    ["m", 45000, "3"],
    ["mm/dd hh:mm", 45000.75, "03/15 18:00"],
    // Elapsed time counts past a day.
    ["[h]:mm:ss", 1.5, "36:00:00"],
    ["[mm]:ss", 0.1, "144:00"],
    ["[s]", 0.001, "86"],
    ["ss.00", 0.5 + 1.25 / 86400, "01.25"],
    ["mmss.0", 0.5 + 61.5 / 86400, "0101.5"],
    // Seconds round, hours and minutes do not.
    ["hh:mm", 0.999988, "23:59"],
    ["hh:mm:ss", 0.9999999, "00:00:00"],
    // The 1900 date system and its 29 February that never was.
    ["yyyy-mm-dd", 1, "1900-01-01"],
    ["yyyy-mm-dd", 59, "1900-02-28"],
    ["yyyy-mm-dd", 60, "1900-02-29"],
    ["yyyy-mm-dd", 61, "1900-03-01"],
    ["dddd", 1, "Sunday"],
    ["dddd", 61, "Thursday"],
    ["yyyy-mm-dd", -1, "########"],
  ])("formats %s of %d as %j", (code, value, expected) => {
    expect(show(code, value)).toBe(expected);
  });

  it("counts from 1904 when asked", () => {
    expect(show("yyyy-mm-dd dddd", 1, true)).toBe("1904-01-02 Saturday");
    expect(show("yyyy-mm-dd", 43538, true)).toBe("2023-03-15");
  });

  it("tells date formats from number formats", () => {
    expect(parseNumberFormat("yyyy-mm-dd").isDate).toBe(true);
    expect(parseNumberFormat("[h]:mm").isDate).toBe(true);
    expect(parseNumberFormat('0.0" days"').isDate).toBe(false);
    expect(parseNumberFormat("[Red]0.00E+00").isDate).toBe(false);
    expect(parseNumberFormat("General").isDate).toBe(false);
  });

  it("formats as General rather than failing on a code it cannot read", () => {
    expect(show("", 1.5)).toBe("1.5");
    expect(show('"unclosed', 2)).toBe("unclosed");
    expect(show("0".repeat(5000), 2)).toBe("2");
    expect(show("0.00", Number.POSITIVE_INFINITY)).toBe("Infinity");
  });
});

describe("builtInFormatCode", () => {
  it.each<[number, number, string]>([
    [0, 1234.5, "1234.5"],
    [1, 1234.5, "1235"],
    [2, 1234.5, "1234.50"],
    [3, 1234.5, "1,235"],
    [4, 1234.5, "1,234.50"],
    [9, 0.256, "26%"],
    [10, 0.256, "25.60%"],
    [11, 1234.5, "1.23E+03"],
    [12, 1234.5, "1234 1/2"],
    [14, 45000, "3/15/2023"],
    [15, 45000, "15-Mar-23"],
    [16, 45000, "15-Mar"],
    [17, 45000, "Mar-23"],
    [18, 0.75, "6:00 PM"],
    [20, 0.75, "18:00"],
    [21, 0.75, "18:00:00"],
    [22, 45000.75, "3/15/2023 18:00"],
    [37, -1234.5, "(1,235)"],
    [39, -1234.5, "(1,234.50)"],
    [44, 1234.5, " $1,234.50 "],
    [45, 0.75 + 65 / 86400, "01:05"],
    [46, 1.75, "42:00:00"],
    [48, 1234.5, "1.2E+3"],
    [49, 1234.5, "1234.5"],
    [164, 1234.5, "1234.5"],
  ])("id %d shows %d as %j", (id, value, expected) => {
    expect(show(builtInFormatCode(id), value)).toBe(expected);
  });

  it("colours negatives red for ids 38 and 40", () => {
    expect(parseNumberFormat(builtInFormatCode(40)).format(-2)).toEqual({ text: "(2.00)", color: "#FF0000" });
  });
});
