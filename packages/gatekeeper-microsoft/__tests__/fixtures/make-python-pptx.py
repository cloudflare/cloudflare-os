# Makes the PowerPoint fixtures from python-pptx's default template, which PowerPoint itself
# authored: `python-pptx-deck.pptx` (a deck with everything an in-place edit must keep) and
# `python-pptx-template.potx` (the same design saved as a template, with slides of its own that a
# deck made from it must not inherit). Run from the package directory:
#   python3 -m venv /tmp/m365venv-p && /tmp/m365venv-p/bin/pip install python-pptx
#   /tmp/m365venv-p/bin/python __tests__/fixtures/make-python-pptx.py

import io
import struct
import zipfile
import zlib
from copy import deepcopy

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt

HERE = "__tests__/fixtures"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"


def png(width, height, rgb):
    """A solid-color PNG, so the fixture needs no image files."""
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def split_runs(paragraph, pieces):
    """One paragraph whose text is split across runs with different formatting, as PowerPoint leaves it after editing."""
    for text, bold in pieces:
        run = paragraph.add_run()
        run.text = text
        run.font.bold = bold


def deck():
    prs = Presentation()
    title = prs.slides.add_slide(prs.slide_layouts[0])
    title.shapes.title.text = "Northwind Quarterly Review"
    title.placeholders[1].text = "Finance team, Q3"
    # A transition on the title slide.
    transition = etree.SubElement(title._element, f"{{{P}}}transition", spd="med")
    etree.SubElement(transition, f"{{{P}}}fade")

    bullets = prs.slides.add_slide(prs.slide_layouts[1])
    bullets.shapes.title.text = "Highlights"
    body = bullets.placeholders[1].text_frame
    split_runs(body.paragraphs[0], [("Quar", True), ("terly rev", False), ("enue grew 12%", False)])
    second = body.add_paragraph()
    second.text = "Churn fell in every region"
    nested = body.add_paragraph()
    nested.text = "EMEA churn fell the most"
    nested.level = 1
    repeat = body.add_paragraph()
    repeat.text = "Revenue targets met"
    bullets.notes_slide.notes_text_frame.text = "Mention the revenue restatement."

    table_slide = prs.slides.add_slide(prs.slide_layouts[5])
    table_slide.shapes.title.text = "Regional revenue"
    table = table_slide.shapes.add_table(3, 2, Inches(1), Inches(2), Inches(6), Inches(1.5)).table
    for row, values in enumerate([("Region", "Revenue"), ("EMEA", "$1.2M"), ("Americas", "$2.4M")]):
        for column, value in enumerate(values):
            table.cell(row, column).text = value
    # An entrance animation on the table slide.
    timing = etree.fromstring(
        f'<p:timing xmlns:p="{P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/></p:par></p:tnLst></p:timing>')
    table_slide._element.append(timing)

    picture = prs.slides.add_slide(prs.slide_layouts[5])
    picture.shapes.title.text = "Our new office"
    picture.shapes.add_picture(io.BytesIO(png(8, 6, (37, 99, 235))), Inches(1), Inches(2), Inches(4), Inches(3))

    chart = prs.slides.add_slide(prs.slide_layouts[5])
    chart.shapes.title.text = "Revenue trend"
    data = CategoryChartData()
    data.categories = ["Q1", "Q2", "Q3"]
    data.add_series("Revenue", (1.0, 1.3, 1.5))
    chart.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(2), Inches(6), Inches(4), data)
    prs.save(f"{HERE}/python-pptx-deck.pptx")


def template():
    prs = Presentation()
    first = prs.slides.add_slide(prs.slide_layouts[0])
    first.shapes.title.text = "Template sample slide"
    first.notes_slide.notes_text_frame.text = "Template speaker notes"
    second = prs.slides.add_slide(prs.slide_layouts[6])
    second.shapes.add_picture(io.BytesIO(png(4, 4, (220, 38, 38))), Inches(1), Inches(1))
    buffer = io.BytesIO()
    prs.save(buffer)
    # Saved as a template: only the main part's content type differs.
    source = zipfile.ZipFile(buffer)
    with zipfile.ZipFile(f"{HERE}/python-pptx-template.potx", "w", zipfile.ZIP_DEFLATED) as out:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(b"presentationml.presentation.main+xml", b"presentationml.template.main+xml")
            out.writestr(deepcopy(item), data)


deck()
template()
