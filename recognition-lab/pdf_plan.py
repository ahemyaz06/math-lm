"""Cheap PDF page-count/range preflight. No OCR or model imports."""
MAX_DOCUMENT_PAGES = 2000
DEFAULT_BATCH_PAGES = 100


def inspect_pdf(path, first_page=1, last_page=None, batch_pages=DEFAULT_BATCH_PAGES):
    for value, name in ((first_page, 'First page'), (batch_pages, 'Batch size')):
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(f'{name} must be a whole number.')
    if not 1 <= batch_pages <= 100:
        raise ValueError('Batch size must be between 1 and 100 pages.')
    if last_page is not None and (not isinstance(last_page, int) or isinstance(last_page, bool)):
        raise ValueError('Last page must be a whole number.')
    import pypdfium2
    try:
        pdf = pypdfium2.PdfDocument(str(path))
    except Exception as exc:
        if 'password' in str(exc).lower():
            raise ValueError('This PDF is password-protected. Open it in a PDF reader, save an unprotected copy, and upload that.') from exc
        raise ValueError('Could not open this PDF. It may be damaged, incomplete (for example a partly downloaded file), or unsupported.') from exc
    try:
        total = len(pdf)
        if not 1 <= total <= MAX_DOCUMENT_PAGES:
            raise ValueError(f'Choose a PDF with between 1 and {MAX_DOCUMENT_PAGES:,} pages.')
        last = total if last_page is None else last_page
        if not 1 <= first_page <= last <= total:
            raise ValueError(f'Page range must fall between 1 and {total}.')
        batches = []
        for start in range(first_page, last+1, batch_pages):
            end = min(last, start+batch_pages-1)
            batches.append({'index': len(batches)+1, 'first_page': start,
                            'last_page': end, 'pages_total': end-start+1})
        return {'document_pages': total, 'first_page': first_page, 'last_page': last,
                'pages_total': last-first_page+1, 'batch_pages': batch_pages, 'batches': batches}
    finally:
        pdf.close()
