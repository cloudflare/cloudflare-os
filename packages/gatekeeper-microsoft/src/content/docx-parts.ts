// The parts a new Word document carries besides its body and styles: the Office theme (whose
// palette and Aptos fonts the styles refer to), settings, the font table, and the core and
// extended document properties. Each is the minimal form Word itself accepts without repair.

import { escapeText } from "./ooxml";
import { isoSeconds, XML_DECLARATION } from "./ooxml";

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

const COLORS: ReadonlyArray<readonly [string, string]> = [
  ["accent1", "156082"], ["accent2", "E97132"], ["accent3", "196B24"],
  ["accent4", "0F9ED5"], ["accent5", "A02B93"], ["accent6", "4EA72E"],
  ["hlink", "467886"], ["folHlink", "96607D"],
];

const SOLID_PH = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';

function gradient(stops: ReadonlyArray<readonly [number, string]>): string {
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops.map(([position, mods]) =>
    `<a:gs pos="${position}"><a:schemeClr val="phClr">${mods}</a:schemeClr></a:gs>`).join("")}</a:gsLst>` +
    '<a:lin ang="5400000" scaled="0"/></a:gradFill>';
}

function line(width: number): string {
  return `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${SOLID_PH}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
}

/** The Office theme (2023): its color scheme, Aptos fonts, and the format scheme Word requires. */
export const THEME_XML = `${XML_DECLARATION}<a:theme xmlns:a="${A_NS}" name="Office Theme">` +
  '<a:themeElements><a:clrScheme name="Office">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="0E2841"/></a:dk2><a:lt2><a:srgbClr val="E8E8E8"/></a:lt2>' +
  COLORS.map(([name, value]) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`).join("") +
  '</a:clrScheme><a:fontScheme name="Office">' +
  '<a:majorFont><a:latin typeface="Aptos Display" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Aptos" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>' + SOLID_PH +
  gradient([[0, '<a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/>'], [50000, '<a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/>'], [100000, '<a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/>']]) +
  gradient([[0, '<a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/>'], [50000, '<a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/>'], [100000, '<a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/>']]) +
  `</a:fillStyleLst><a:lnStyleLst>${line(12700)}${line(19050)}${line(25400)}</a:lnStyleLst>` +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0">' +
  '<a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>' +
  `<a:bgFillStyleLst>${SOLID_PH}<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>` +
  gradient([[0, '<a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/>'], [50000, '<a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/>'], [100000, '<a:shade val="63000"/><a:satMod val="120000"/>']]) +
  '</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

/** Settings in Word 2013+ compatibility mode, so nothing renders in a legacy layout. */
export const SETTINGS_XML = `${XML_DECLARATION}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>' +
  '<w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
  '<w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
  '<w:compatSetting w:name="doNotFlipMirrorIndents" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat>' +
  '<w:themeFontLang w:val="en-US"/>' +
  '<w:clrSchemeMapping w:bg1="light1" w:t1="dark1" w:bg2="light2" w:t2="dark2" w:accent1="accent1" w:accent2="accent2" ' +
  'w:accent3="accent3" w:accent4="accent4" w:accent5="accent5" w:accent6="accent6" w:hyperlink="hyperlink" w:followedHyperlink="followedHyperlink"/>' +
  '<w:decimalSymbol w:val="."/><w:listSeparator w:val=","/></w:settings>';

const FONTS: ReadonlyArray<readonly [string, string, string, string]> = [
  // name, panose, family, pitch
  ["Aptos", "020B0004020202020204", "swiss", "variable"],
  ["Aptos Display", "020B0004020202020204", "swiss", "variable"],
  ["Consolas", "020B0609020204030204", "modern", "fixed"],
  ["Times New Roman", "02020603050405020304", "roman", "variable"],
];

/** The fonts the styles use, so Word can substitute sensibly where one isn't installed. */
export const FONT_TABLE_XML = `${XML_DECLARATION}<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  FONTS.map(([name, panose, family, pitch]) =>
    `<w:font w:name="${name}"><w:panose1 w:val="${panose}"/><w:charset w:val="00"/><w:family w:val="${family}"/><w:pitch w:val="${pitch}"/></w:font>`).join("") +
  "</w:fonts>";

/** The core properties: the title shown in SharePoint and the file's Info pane, author and dates. */
export function coreXml(properties: { title?: string; author?: string; created: Date; modified: Date }): string {
  const element = (name: string, value: string | undefined): string => value ? `<${name}>${escapeText(value)}</${name}>` : "";
  return `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    element("dc:title", properties.title) + element("dc:creator", properties.author) + element("cp:lastModifiedBy", properties.author) +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${isoSeconds(properties.created)}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${isoSeconds(properties.modified)}</dcterms:modified></cp:coreProperties>`;
}

/** The extended properties. Word recomputes page and word counts itself, so none are claimed. */
export const APP_XML = `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>Normal.dotm</Template>' +
  "<Application>Gadgets</Application><DocSecurity>0</DocSecurity></Properties>";
