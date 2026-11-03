"""The notebook carried inside its own PDF, as a standard PDF file attachment.

PDF has file attachments built in (the paperclip in Adobe Reader; e-invoices carry their
data this way). An exported PDF opens and prints like any other everywhere; this notebook,
importing it, finds the attachment and opens the exact document (equations, graphs with
sound) instead of reading the printed page. Nothing new is invented: a standard PDF with
a standard attachment, holding our own .mathnb file.
"""
import io
import json

import pypdfium2 as pdfium

NAME = 'notebook.mathnb'


def attach(pdf_bytes, notebook_text):
    """The PDF with the notebook attached (replacing an earlier attachment of that name)."""
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        for i in reversed(range(pdf.count_attachments())):
            if pdf.get_attachment(i).get_name() == NAME:
                pdf.del_attachment(i)
        att = pdf.new_attachment(NAME)
        att.set_data(notebook_text.encode('utf-8'))
        out = io.BytesIO()
        pdf.save(out)
        return out.getvalue()
    finally:
        pdf.close()


def read(pdf_bytes):
    """The attached notebook (as text), or None. Only a valid Math Notebook file counts."""
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        for i in range(pdf.count_attachments()):
            att = pdf.get_attachment(i)
            if att.get_name() != NAME:
                continue
            text = bytes(att.get_data()).decode('utf-8')
            try:
                if json.loads(text).get('format') == 'math-notebook':
                    return text
            except ValueError:
                return None
        return None
    finally:
        pdf.close()
