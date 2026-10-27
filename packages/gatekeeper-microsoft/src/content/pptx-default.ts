// The design a deck gets when it is written without a template: a 16:9 package with one master,
// the four layouts the writer uses, a theme, and a notes master. The look is deliberately quiet so
// it reads as a company deck, not a demo: a dark title slide, white content slides with a short
// accent rule under the title, Aptos (Microsoft 365's default face), and a muted palette whose
// accent colors stay legible on both backgrounds.

import { escapeAttribute } from "./ooxml";
import { XML_DECLARATION } from "./ooxml";
import { CONTENT_TYPE, OpcPackage, REL } from "./pptx-package";

/** The DrawingML, relationships and PresentationML namespace declarations a slide part's root carries. */
export const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** 16:9 at PowerPoint's default size, in EMU. */
export const SLIDE_WIDTH = 12192000;
export const SLIDE_HEIGHT = 6858000;

/** Body text sizes by list level, in hundredths of a point, as the master's body style sets them. */
export const BODY_SIZES = [2400, 2000, 1800, 1600, 1600, 1600, 1600, 1600, 1600] as const;
/** Left margin of each body level, in EMU; bullets hang 0.25in into it. */
export const BODY_MARGINS = [285750, 742950, 1200150, 1657350, 2114550, 2571750, 3028950, 3486150, 3943350] as const;
/** The hanging indent of a bulleted paragraph, in EMU. */
export const BULLET_INDENT = -285750;
const BULLETS = ["•", "–", "•", "–", "•", "–", "•", "–", "•"];

const TITLE_BOX = { x: 838200, y: 365125, cx: 10515600, cy: 1325563 };
const BODY_BOX = { x: 838200, y: 1825625, cx: 10515600, cy: 4351338 };
const FOOTER_Y = 6356350;

function xfrm(box: { x: number; y: number; cx: number; cy: number }): string {
  return `<a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>`;
}

/** The properties of a shape tree's root group, which every slide, layout and notes page opens with. */
export const GROUP_PROPERTIES = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function placeholder(id: number, name: string, ph: string, box: { x: number; y: number; cx: number; cy: number } | undefined,
                     body = "<a:bodyPr/>", paragraphs = '<a:p><a:endParaRPr lang="en-US"/></a:p>', lstStyle = "<a:lstStyle/>"): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeAttribute(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${box ? xfrm(box) : ""}</p:spPr><p:txBody>${body}${lstStyle}${paragraphs}</p:txBody></p:sp>`;
}

/** A short accent rule under the title: a plain rectangle in the theme's first accent. */
function accentRule(id: number, y: number): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Accent Rule"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr>` +
    `<p:spPr>${xfrm({ x: 838200, y, cx: 914400, cy: 50800 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>' +
    '<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>';
}

/** A slide number field. */
export const FIELD_SLIDE_NUMBER = '<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld>';

function furniture(firstId: number): string {
  return placeholder(firstId, "Date Placeholder", '<p:ph type="dt" sz="half" idx="10"/>', { x: 838200, y: FOOTER_Y, cx: 2743200, cy: 365125 }) +
    placeholder(firstId + 1, "Footer Placeholder", '<p:ph type="ftr" sz="quarter" idx="11"/>', { x: 4038600, y: FOOTER_Y, cx: 4114800, cy: 365125 }) +
    placeholder(firstId + 2, "Slide Number Placeholder", '<p:ph type="sldNum" sz="quarter" idx="12"/>', { x: 8610600, y: FOOTER_Y, cx: 2743200, cy: 365125 },
      "<a:bodyPr/>", `<a:p>${FIELD_SLIDE_NUMBER}<a:endParaRPr lang="en-US"/></a:p>`);
}

function level(index: number, size: number, bullet: string | undefined, extra = ""): string {
  const margin = BODY_MARGINS[index]!;
  const bulletXml = bullet === undefined ? "<a:buNone/>" : `<a:buFont typeface="Arial" panose="020B0604020202020204"/><a:buChar char="${bullet}"/>`;
  return `<a:lvl${index + 1}pPr marL="${bullet === undefined ? 0 : margin}" indent="${bullet === undefined ? 0 : BULLET_INDENT}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">` +
    `<a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="${index === 0 ? 1000 : 500}"/></a:spcBef>${bulletXml}` +
    `<a:defRPr sz="${size}" kern="1200"${extra}><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${index + 1}pPr>`;
}

function otherLevels(): string {
  return Array.from({ length: 9 }, (_, index) =>
    `<a:lvl${index + 1}pPr marL="${index * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">` +
    `<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${index + 1}pPr>`).join("");
}

function slideMasterXml(): string {
  const title = placeholder(2, "Title Placeholder", '<p:ph type="title"/>', TITLE_BOX,
    '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="b"><a:normAutofit/></a:bodyPr>',
    '<a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>');
  const body = placeholder(3, "Text Placeholder", '<p:ph type="body" idx="1"/>', BODY_BOX,
    '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr>',
    ["Click to edit Master text styles", "Second level", "Third level", "Fourth level", "Fifth level"].map((text, index) =>
      `<a:p>${index ? `<a:pPr lvl="${index}"/>` : ""}<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`).join(""));
  return `${XML_DECLARATION}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
    `<p:spTree>${GROUP_PROPERTIES}${title}${body}${furniture(4)}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst>' + LAYOUTS.map((_, at) => at + 1).map(index => `<p:sldLayoutId id="${2147483648 + index}" r:id="rId${index}"/>`).join("") + "</p:sldLayoutIdLst>" +
    "<p:txStyles>" +
    '<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc>' +
    '<a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="3600" b="1" kern="1200"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill>' +
    '<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
    `<p:bodyStyle>${BODY_SIZES.map((size, index) => level(index, size, BULLETS[index])).join("")}</p:bodyStyle>` +
    `<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${otherLevels()}</p:otherStyle>` +
    "</p:txStyles></p:sldMaster>";
}

/** The layouts, in master order, named as PowerPoint names its own so `<!-- layout: ... -->` finds them. */
const LAYOUTS = [
  { type: "title", name: "Title Slide" },
  { type: "obj", name: "Title and Content" },
  { type: "secHead", name: "Section Header" },
  { type: "twoObj", name: "Two Content" },
  { type: "twoTxTwoObj", name: "Comparison" },
  { type: "titleOnly", name: "Title Only" },
  { type: "blank", name: "Blank" },
  { type: "picTx", name: "Picture with Caption" },
] as const;

type LayoutType = (typeof LAYOUTS)[number]["type"];

const DARK_BACKGROUND = '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>';
const PROMPT = (text: string) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`;
const LIGHT_TEXT = '<a:solidFill><a:schemeClr val="bg1"/></a:solidFill>';
const MUTED_LIGHT_TEXT = '<a:solidFill><a:schemeClr val="bg1"><a:lumMod val="85000"/></a:schemeClr></a:solidFill>';
const COLUMN_WIDTH = 5181600;
const RIGHT_COLUMN = 6172200;

function title(id: number): string {
  return placeholder(id, "Title 1", '<p:ph type="title"/>', undefined);
}

/** A caption or column header: unbulleted text in a fixed size. */
function captionStyle(size: number, bold: boolean, color = ""): string {
  return `<a:lstStyle><a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="${size}"${bold ? ' b="1"' : ""}>${color}</a:defRPr></a:lvl1pPr></a:lstStyle>`;
}

function slideLayoutXml(type: LayoutType, name: string): string {
  let tree: string;
  let background = "";
  switch (type) {
    case "title":
      // A dark title slide: the theme's second dark color, with light text and the accent rule.
      background = DARK_BACKGROUND;
      tree = placeholder(2, "Title 1", '<p:ph type="ctrTitle"/>', { x: 838200, y: 1600200, cx: 10515600, cy: 2286000 },
        '<a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr>', PROMPT("Click to edit Master title style"),
        `<a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="5400" b="1">${LIGHT_TEXT}</a:defRPr></a:lvl1pPr></a:lstStyle>`) +
        accentRule(3, 4038600) +
        placeholder(4, "Subtitle 2", '<p:ph type="subTitle" idx="1"/>', { x: 838200, y: 4267200, cx: 10515600, cy: 1295400 },
          "<a:bodyPr><a:normAutofit/></a:bodyPr>", PROMPT("Click to edit Master subtitle style"), captionStyle(2400, false, MUTED_LIGHT_TEXT)) +
        furniture(5);
      break;
    case "obj":
      tree = title(2) + accentRule(3, 1714500) + placeholder(4, "Content Placeholder 2", '<p:ph idx="1"/>', undefined) + furniture(5);
      break;
    case "secHead":
      // A section divider, dark like the title slide.
      background = DARK_BACKGROUND;
      tree = placeholder(2, "Title 1", '<p:ph type="title"/>', { x: 838200, y: 1709738, cx: 10515600, cy: 2852737 },
        '<a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr>', PROMPT("Click to edit Master title style"),
        `<a:lstStyle><a:lvl1pPr><a:defRPr sz="4800" b="1">${LIGHT_TEXT}</a:defRPr></a:lvl1pPr></a:lstStyle>`) +
        accentRule(3, 4663440) +
        placeholder(4, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', { x: 838200, y: 4846320, cx: 10515600, cy: 1243330 },
          "<a:bodyPr><a:normAutofit/></a:bodyPr>", PROMPT("Click to edit Master text styles"), captionStyle(2000, false, MUTED_LIGHT_TEXT)) +
        furniture(5);
      break;
    case "twoObj":
      tree = title(2) + accentRule(3, 1714500) +
        placeholder(4, "Content Placeholder 2", '<p:ph sz="half" idx="1"/>', { x: 838200, y: 1825625, cx: COLUMN_WIDTH, cy: 4351338 }) +
        placeholder(5, "Content Placeholder 3", '<p:ph sz="half" idx="2"/>', { x: RIGHT_COLUMN, y: 1825625, cx: COLUMN_WIDTH, cy: 4351338 }) +
        furniture(6);
      break;
    case "twoTxTwoObj": {
      const header = (id: number, idx: number, x: number) => placeholder(id, `Text Placeholder ${id - 1}`, `<p:ph type="body" idx="${idx}"/>`,
        { x, y: 1828800, cx: COLUMN_WIDTH, cy: 640080 }, '<a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr>', PROMPT("Click to edit Master text styles"),
        captionStyle(2000, true, '<a:solidFill><a:schemeClr val="tx2"/></a:solidFill>'));
      const column = (id: number, idx: number, x: number) => placeholder(id, `Content Placeholder ${id - 1}`, `<p:ph sz="quarter" idx="${idx}"/>`,
        { x, y: 2560320, cx: COLUMN_WIDTH, cy: 3616643 });
      tree = title(2) + accentRule(3, 1714500) + header(4, 1, 838200) + column(5, 2, 838200) + header(6, 3, RIGHT_COLUMN) + column(7, 4, RIGHT_COLUMN) + furniture(8);
      break;
    }
    case "titleOnly":
      tree = title(2) + accentRule(3, 1714500) + furniture(4);
      break;
    case "picTx":
      tree = placeholder(2, "Title 1", '<p:ph type="title"/>', { x: 838200, y: 457200, cx: 3932237, cy: 1600200 },
        '<a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr>', PROMPT("Click to edit Master title style"),
        '<a:lstStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></a:lstStyle>') +
        accentRule(3, 2148840) +
        placeholder(4, "Picture Placeholder 2", '<p:ph type="pic" idx="1"/>', { x: 5183188, y: 987425, cx: 6172200, cy: 4873625 },
          "<a:bodyPr/>", PROMPT("Click icon to add picture"), captionStyle(2800, false)) +
        placeholder(5, "Text Placeholder 3", '<p:ph type="body" sz="half" idx="2"/>', { x: 838200, y: 2331720, cx: 3932237, cy: 3537268 },
          "<a:bodyPr><a:normAutofit/></a:bodyPr>", PROMPT("Click to edit Master text styles"), captionStyle(2000, false)) +
        furniture(6);
      break;
    case "blank":
      tree = furniture(2);
      break;
  }
  return `${XML_DECLARATION}<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${name}">${background}<p:spTree>${GROUP_PROPERTIES}${tree}</p:spTree></p:cSld>` +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";
}

const PALETTE = {
  dk2: "1F2A44", lt2: "EEF1F6",
  accent1: "2F6FDE", accent2: "0E9384", accent3: "E0A21B", accent4: "C2417B", accent5: "6E56CF", accent6: "3F9142",
  hlink: "2F6FDE", folHlink: "6E56CF",
};

function solidFill(transforms = ""): string {
  return `<a:solidFill><a:schemeClr val="phClr">${transforms}</a:schemeClr></a:solidFill>`;
}

function line(width: number): string {
  return `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
}

/** A theme: the palette, Aptos for headings and body, and plain fill, line and effect styles. */
function themeXml(name = "Gadgets"): string {
  const colors = Object.entries(PALETTE).map(([slot, value]) => `<a:${slot}><a:srgbClr val="${value}"/></a:${slot}>`);
  const order = ["dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  const byName = new Map(Object.keys(PALETTE).map((slot, index) => [slot, colors[index]!]));
  return `${XML_DECLARATION}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${escapeAttribute(name)}"><a:themeElements>` +
    `<a:clrScheme name="${escapeAttribute(name)}"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    `${order.map(slot => byName.get(slot)).join("")}</a:clrScheme>` +
    `<a:fontScheme name="${escapeAttribute(name)}"><a:majorFont><a:latin typeface="Aptos Display" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    '<a:minorFont><a:latin typeface="Aptos" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    `<a:fmtScheme name="${escapeAttribute(name)}">` +
    `<a:fillStyleLst>${solidFill()}${solidFill('<a:tint val="50000"/>')}${solidFill('<a:shade val="80000"/>')}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>" +
    '<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${solidFill()}${solidFill('<a:tint val="95000"/>')}${solidFill('<a:shade val="90000"/>')}</a:bgFillStyleLst>` +
    "</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>";
}

/** The notes page: the slide's image above the notes, as PowerPoint lays it out by default. */
function notesMasterXml(): string {
  const box = (x: number, y: number, cx: number, cy: number) => ({ x, y, cx, cy });
  const tree = placeholder(2, "Header Placeholder", '<p:ph type="hdr" sz="quarter"/>', box(0, 0, 2971800, 458788)) +
    placeholder(3, "Date Placeholder", '<p:ph type="dt" idx="1"/>', box(3884613, 0, 2971800, 458788)) +
    `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Image Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(box(685800, 1143000, 5486400, 3086100))}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    '<a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>' +
    placeholder(5, "Notes Placeholder", '<p:ph type="body" sz="quarter" idx="3"/>', box(685800, 4400550, 5486400, 3600450)) +
    placeholder(6, "Footer Placeholder", '<p:ph type="ftr" sz="quarter" idx="4"/>', box(0, 8685213, 2971800, 458787)) +
    placeholder(7, "Slide Number Placeholder", '<p:ph type="sldNum" sz="quarter" idx="5"/>', box(3884613, 8685213, 2971800, 458787),
      "<a:bodyPr/>", `<a:p>${FIELD_SLIDE_NUMBER}<a:endParaRPr lang="en-US"/></a:p>`);
  return `${XML_DECLARATION}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
    `<p:spTree>${GROUP_PROPERTIES}${tree}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    `<p:notesStyle>${Array.from({ length: 9 }, (_, index) =>
      `<a:lvl${index + 1}pPr marL="${index * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">` +
      `<a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${index + 1}pPr>`).join("")}</p:notesStyle>` +
    "</p:notesMaster>";
}

/** A notes master with its own theme, added to a package that has none. Returns its part name. */
export function addNotesMaster(pkg: OpcPackage): string {
  const theme = pkg.freeName("ppt/theme/theme", ".xml");
  pkg.set(theme, themeXml("Notes"), CONTENT_TYPE.theme);
  const master = pkg.freeName("ppt/notesMasters/notesMaster", ".xml");
  pkg.set(master, notesMasterXml(), CONTENT_TYPE.notesMaster);
  pkg.relate(master, REL.theme, theme);
  return master;
}

/**
 * A new package holding the default design and no slides: presentation.xml with an empty slide
 * list, its master, layouts, theme and properties parts.
 */
export function defaultPackage(): OpcPackage {
  const pkg = OpcPackage.empty();
  const presentation = "ppt/presentation.xml";
  pkg.set(presentation, `${XML_DECLARATION}<p:presentation ${NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst/>' +
    `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    `<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${otherLevels()}</p:defaultTextStyle></p:presentation>`, CONTENT_TYPE.presentation);
  pkg.setRelationships("", [{ id: "rId1", type: REL.officeDocument, target: presentation }]);

  const master = "ppt/slideMasters/slideMaster1.xml";
  pkg.set(master, slideMasterXml(), CONTENT_TYPE.slideMaster);
  pkg.relate(presentation, REL.slideMaster, master);
  LAYOUTS.forEach((layout, index) => {
    const name = `ppt/slideLayouts/slideLayout${index + 1}.xml`;
    pkg.set(name, slideLayoutXml(layout.type, layout.name), CONTENT_TYPE.slideLayout);
    pkg.relate(master, REL.slideLayout, name);
    pkg.relate(name, REL.slideMaster, master);
  });
  const theme = "ppt/theme/theme1.xml";
  pkg.set(theme, themeXml(), CONTENT_TYPE.theme);
  pkg.relate(master, REL.theme, theme);

  pkg.set("ppt/presProps.xml", `${XML_DECLARATION}<p:presentationPr ${NS}/>`, CONTENT_TYPE.presProps);
  pkg.set("ppt/viewProps.xml", `${XML_DECLARATION}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`, CONTENT_TYPE.viewProps);
  // Medium Style 2 – Accent 1, PowerPoint's default table style, which it knows by this ID.
  pkg.set("ppt/tableStyles.xml", `${XML_DECLARATION}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="${DEFAULT_TABLE_STYLE}"/>`, CONTENT_TYPE.tableStyles);
  pkg.relate(presentation, REL.presProps, "ppt/presProps.xml");
  pkg.relate(presentation, REL.viewProps, "ppt/viewProps.xml");
  pkg.relate(presentation, REL.theme, theme);
  pkg.relate(presentation, REL.tableStyles, "ppt/tableStyles.xml");
  return pkg;
}

/** Medium Style 2 – Accent 1, PowerPoint's default table style. */
export const DEFAULT_TABLE_STYLE = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";
