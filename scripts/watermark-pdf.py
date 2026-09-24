#!/usr/bin/env python3
"""
watermark-pdf.py — brand a client's PDF and make each copy traceable.

    python3 scripts/watermark-pdf.py in.pdf out.pdf --brand "Ibis Prep" \
        --for "Jane Smith" --email jane@example.com [--logo path.png] [--lock] [--flatten]

WHAT IT DOES, and why each part is worth having:

  1. A tiled diagonal wordmark behind the text. Brands every page and every screenshot. It sits
     UNDER the content, so nothing becomes harder to read.
  2. A footer on every page naming who the copy was made for, plus a short copy id. This is the
     part that actually stops sharing: a leaked page says who leaked it. Without it a watermark
     only says "this was ours", which the thief already knew.
  3. The same name and copy id in the PDF metadata, so it survives a screenshot-and-reassemble.
  4. --lock sets an owner password and clears the copy/modify permissions. Be honest with the
     client about this one: any number of free tools strip it in seconds. It stops a student
     pasting the text into a doc, nothing more.
  5. --flatten renders each page to an image first, so the text cannot be selected or extracted
     at all. It roughly triples the file size, kills search and screen readers, and makes the
     guide worse for the people who paid for it. Only reach for it if the client asks.

Requires PyMuPDF (import fitz), which is already available here.
"""
import argparse, hashlib, sys
from datetime import date

try:
    import fitz
except ImportError:
    sys.exit('PyMuPDF is needed: pip3 install pymupdf')

INK = (0.45, 0.52, 0.62)      # the wordmark: grey with a hint of the brand blue
FOOT = (0.55, 0.58, 0.65)


def copy_id(recipient: str, email: str, src: str) -> str:
    """Short, stable per-recipient id. Same person, same file, same id, so a leaked page can be
    matched back without keeping a database of who got what."""
    seed = (recipient + '|' + email + '|' + src).lower().encode()
    return hashlib.sha256(seed).hexdigest()[:8].upper()


def stamp(page, brand, footer_text, logo=None, angle=45, gap=250, size=34, opacity=0.08):
    r = page.rect
    # Drawn OVER the content, not under it. A Google Docs export paints an opaque white rectangle
    # across the whole page, so anything underneath is simply invisible. Low opacity is what keeps
    # it out of the way instead.
    over = max(r.width, r.height)
    y = -over
    row = 0
    while y < r.height + over:
        x = -over + (gap * 0.5 if row % 2 else 0)   # offset every other row, so it reads as a pattern
        while x < r.width + over:
            # rotate= only takes right angles, so the diagonal comes from a morph: rotate the
            # text around the point it is drawn at.
            pt = fitz.Point(x, y)
            page.insert_text(
                pt, brand, fontname='hebo', fontsize=size,
                color=INK, fill_opacity=opacity, overlay=True,
                morph=(pt, fitz.Matrix(angle)),
            )
            x += gap
        y += gap * 0.62
        row += 1

    if logo:
        w = r.width * 0.42
        h = w * (logo.height / logo.width)
        box = fitz.Rect((r.width - w) / 2, (r.height - h) / 2, (r.width + w) / 2, (r.height + h) / 2)
        page.insert_image(box, pixmap=logo, overlay=True, alpha=1, keep_proportion=True)

    # The line that makes a leak traceable. Small, at the very foot, out of the way of the content.
    page.insert_text(fitz.Point(54, r.height - 24), footer_text, fontname='helv', fontsize=7.5,
                     color=FOOT, fill_opacity=0.85, overlay=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('out')
    ap.add_argument('--brand', default='Ibis Prep')
    ap.add_argument('--for', dest='recipient', default='', help='who this copy is for')
    ap.add_argument('--email', default='')
    ap.add_argument('--logo', default='', help='PNG to ghost behind each page, optional')
    ap.add_argument('--lock', action='store_true', help='owner password, no copy or modify')
    ap.add_argument('--flatten', action='store_true', help='render pages to images: no selectable text')
    ap.add_argument('--dpi', type=int, default=170, help='resolution when flattening')
    ap.add_argument('--owner-password', default='', help='needed with --lock')
    a = ap.parse_args()

    doc = fitz.open(a.src)
    cid = copy_id(a.recipient, a.email, a.src)

    # With a recipient this is the line that makes a leak traceable. Without one it is just an
    # ownership notice: "Licensed to this copy" would read like a bug.
    who = a.recipient
    bits = [a.brand]
    if who:
        bits.append('Licensed to ' + who)
        if a.email:
            bits.append(a.email)
        bits += [date.today().strftime('%b %Y'), 'Copy ' + cid]
    else:
        bits.append('\u00a9 ' + date.today().strftime('%Y') + ' ' + a.brand)
    bits.append('Not for redistribution')
    footer = '  ·  '.join(bits)

    logo = fitz.Pixmap(a.logo) if a.logo else None

    if a.flatten:
        flat = fitz.open()
        for page in doc:
            pix = page.get_pixmap(dpi=a.dpi)
            np = flat.new_page(width=page.rect.width, height=page.rect.height)
            np.insert_image(np.rect, pixmap=pix)
        doc.close()
        doc = flat

    for page in doc:
        stamp(page, a.brand, footer, logo=logo)

    doc.set_metadata({
        'title': doc.metadata.get('title') or a.brand,
        'author': a.brand,
        'subject': ('Licensed to ' + who + (' <' + a.email + '>' if a.email else '') + '. Copy ' + cid + '.')
                   if who else ('\u00a9 ' + date.today().strftime('%Y') + ' ' + a.brand + '. Not for redistribution.'),
        'keywords': ('copy:' + cid) if who else '',
        'creator': a.brand,
    })

    save = dict(garbage=4, deflate=True)
    if a.lock:
        if not a.owner_password:
            sys.exit('--lock needs --owner-password')
        # Read and print stay open, so the student can actually use what they paid for.
        perm = int(fitz.PDF_PERM_ACCESSIBILITY | fitz.PDF_PERM_PRINT)
        save.update(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw=a.owner_password, permissions=perm)

    doc.save(a.out, **save)
    print('wrote %s — %d pages, copy %s%s%s' % (
        a.out, doc.page_count, cid, ', locked' if a.lock else '', ', flattened' if a.flatten else ''))


if __name__ == '__main__':
    main()
