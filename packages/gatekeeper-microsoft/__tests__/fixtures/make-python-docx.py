# Makes the Word fixtures from python-docx's default template, which Word itself authored (its
# styles, numbering, theme and settings are Word's own): `python-docx-report.docx` (a report with
# what an in-place edit must keep, and what a rewrite would lose) and `python-docx-template.dotx`
# (a corporate look saved as a template, with placeholder text a new document must not inherit).
# Run from the package directory:
#   python3 -m venv /tmp/m365venv && /tmp/m365venv/bin/pip install python-docx
#   /tmp/m365venv/bin/python __tests__/fixtures/make-python-docx.py __tests__/fixtures
import io, struct, sys, zlib, zipfile
from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_BREAK
from docx.shared import Inches, Pt, RGBColor

out = sys.argv[1]

def png(width, height, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

# A report as a person writes one: runs split mid-word by formatting, list styles, a styled table,
# a header and footer, a picture and a comment.
doc = Document()
doc.core_properties.author = "Dana Reviewer"
doc.core_properties.title = "Project Falcon Status"
section = doc.sections[0]
section.header.paragraphs[0].text = "Contoso Ltd. — Internal"
section.footer.paragraphs[0].text = "Project Falcon status report"
doc.add_heading("Project Falcon Status", 0)
doc.add_heading("Summary", 1)
p = doc.add_paragraph("The launch is ")
p.add_run("on track").bold = True
p.add_run(" for the ")
p.add_run("third").italic = True
p.add_run(" quarter, pending the vendor’s security review.")
p = doc.add_paragraph()
for piece in ["Budget", " remains ", "within", " the approved envelope."]:
    p.add_run(piece)
doc.add_heading("Milestones", 1)
for item in ["Design sign-off", "Pilot with two teams", "General availability"]:
    doc.add_paragraph(item, style="List Number")
doc.add_heading("Risks", 2)
for item in ["Vendor review slips", "Hiring for the support rota"]:
    doc.add_paragraph(item, style="List Bullet")
doc.add_paragraph("Owners\tDue", style="Normal")
table = doc.add_table(rows=1, cols=3)
table.style = "Light Grid Accent 1"
for cell, text in zip(table.rows[0].cells, ["Workstream", "Owner", "Status"]):
    cell.text = text
for row in [["Security", "Priya", "In review"], ["Support", "Marcus", "Hiring"]]:
    cells = table.add_row().cells
    for cell, text in zip(cells, row):
        cell.text = text
doc.add_paragraph("Figure 1 shows the rollout plan.")
image = io.BytesIO(png(48, 24, (21, 96, 130)))
doc.add_picture(image, width=Inches(2))
p = doc.add_paragraph("Questions go to the steering group before Friday.")
doc.add_comment(p.runs, text="Which Friday?", author="Sam Lee", initials="SL")
p = doc.add_paragraph("Colors: ")
r = p.add_run("red text")
r.font.color.rgb = RGBColor(0xC0, 0x00, 0x00)
doc.add_paragraph("Closing remarks.")
doc.save(f"{out}/python-docx-report.docx")

# A corporate template: its own fonts, heading color, margins, header and footer. Saved by
# python-docx as a .docx, then marked as a template (.dotx), as Word saves one.
template = Document()
styles = template.styles
styles["Normal"].font.name = "Georgia"
styles["Normal"].font.size = Pt(10.5)
styles["Heading 1"].font.color.rgb = RGBColor(0x8B, 0x00, 0x00)
styles["Heading 1"].font.name = "Georgia"
section = template.sections[0]
section.left_margin = section.right_margin = Inches(1.25)
section.header.paragraphs[0].text = "ACME Corporation — Confidential"
section.footer.paragraphs[0].text = "ACME template footer"
template.add_paragraph("Template placeholder body text that a new document replaces.")
buffer = io.BytesIO()
template.save(buffer)
source = zipfile.ZipFile(io.BytesIO(buffer.getvalue()))
with zipfile.ZipFile(f"{out}/python-docx-template.dotx", "w", zipfile.ZIP_DEFLATED) as target:
    for info in source.infolist():
        data = source.read(info.filename)
        if info.filename == "[Content_Types].xml":
            data = data.replace(b"wordprocessingml.document.main+xml", b"wordprocessingml.template.main+xml")
        target.writestr(info, data)
