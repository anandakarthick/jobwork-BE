"""
Complete text of a PDF for training into Claude — nothing missed.

For every page:
  1. the text layer (PyMuPDF, reading order), and
  2. OCR of what the text layer cannot give: a page with no / almost no text is
     rendered and OCR'd whole; on every page, embedded images large enough to
     carry text are OCR'd too (tables and labels printed as pictures).
OCR runs locally with RapidOCR (ONNX) — no API, no external binary, no cost.

Usage:  py -3 pdf_text.py <input.pdf> <output.txt>
Output: UTF-8 text, pages headed "[page N]" (the format the app already uses),
        OCR'd parts headed "[ocr]" / "[image text]". A JSON summary is printed to
        stdout: {"pages": N, "ocrPages": N, "ocrImages": N, "chars": N}.
"""
import hashlib
import io
import json
import re
import sys

import fitz  # PyMuPDF

MIN_TEXT_CHARS = 40        # a page with fewer characters is treated as an image page
MIN_IMAGE_SIDE = 160       # smaller embedded images are icons / logos — skipped
RENDER_ZOOM = 2.0          # 144 dpi render for whole-page OCR

_ocr = None


def ocr_engine():
    """RapidOCR, created on first use (model load takes a moment)."""
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    return _ocr


def ocr_image_bytes(data: bytes) -> str:
    """OCR an image (PNG/JPEG bytes) → lines of text, top-to-bottom."""
    import numpy as np
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return ""
    if img.width < MIN_IMAGE_SIDE or img.height < MIN_IMAGE_SIDE:
        return ""
    result, _ = ocr_engine()(np.array(img))
    if not result:
        return ""
    # result: [ [box, text, score], ... ] — sort by the box's top-left (y, then x).
    rows = sorted(result, key=lambda r: (round(r[0][0][1] / 12), r[0][0][0]))
    lines, current, current_y = [], [], None
    for box, text, _score in rows:
        y = round(box[0][1] / 12)
        if current_y is None or y == current_y:
            current.append(text)
        else:
            lines.append(" | ".join(current))
            current = [text]
        current_y = y
    if current:
        lines.append(" | ".join(current))
    return "\n".join(t for t in lines if t.strip())


def page_text(page) -> str:
    """Text layer in reading order; tables keep their cells on one line.
    PyMuPDF pads columns with long runs of spaces when sorting — collapse them
    (they more than double the size while carrying nothing)."""
    text = page.get_text("text", sort=True)
    lines = [re.sub(r"[ \t]{2,}", " ", ln).strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln).strip()


# OCR results are cached next to the PDF, keyed by the image bytes' hash, so a
# re-train of an unchanged file does not redo minutes of OCR.
_cache_path = None
_cache = {}


def cache_open(src: str) -> None:
    global _cache_path, _cache
    _cache_path = src + ".ocr-cache.json"
    try:
        with open(_cache_path, "r", encoding="utf-8") as f:
            _cache = json.load(f)
    except Exception:
        _cache = {}


def cache_save() -> None:
    if _cache_path:
        try:
            with open(_cache_path, "w", encoding="utf-8") as f:
                json.dump(_cache, f)
        except Exception:
            pass


def ocr_cached(data: bytes) -> str:
    key = hashlib.sha1(data).hexdigest()
    if key in _cache:
        return _cache[key]
    text = ocr_image_bytes(data)
    _cache[key] = text
    return text


def is_noise_line(line: str) -> bool:
    """OCR junk: CJK guesses, runs of the same glyph, single glyphs, no letters/digits."""
    s = line.replace(" | ", " ").strip()
    if len(s) < 3:
        return True
    if any("　" <= ch <= "鿿" for ch in s):  # CJK — never in these catalogues
        return True
    alnum = sum(ch.isalnum() for ch in s)
    if alnum < 3 or alnum / len(s) < 0.5:
        return True
    # "oooooooooo" / "0000000000" style runs (terminal strips, LED rows).
    for ch in "0oO-_.|":
        if s.count(ch) >= 10 and s.count(ch) / len(s) > 0.6:
            return True
    return False


def clean_ocr(text: str, page_layer: str) -> str:
    """Keep OCR lines that carry real content and are not already in the text layer."""
    layer = page_layer.replace(" ", "").lower()
    kept = []
    for line in text.splitlines():
        if is_noise_line(line):
            continue
        if line.replace(" ", "").lower() in layer:  # duplicate of the text layer
            continue
        kept.append(line.strip())
    return "\n".join(kept)


CODE_LIKE = re.compile(r"^[A-Z]{2,4}\d[A-Z0-9]{3,}$")  # DZ4F0250DXH1AOOOO, CM93008OOOOX1, EPLR240A


def worth_keeping(text: str, strict: bool = False) -> bool:
    """Train an OCR block only if it carries real content.
    Whole-page OCR (strict=False): a code-like token or three real words.
    Embedded images (strict=True): product photos mostly yield printed-label
    fragments ("040 / 022.5", "53NO63NO"), so require a catalogue-style code
    (letters+digits in the brand's pattern) or at least four real words."""
    tokens = [w.strip(",;:()") for w in text.replace("|", " ").split()]
    words = [w for w in tokens if sum(c.isalpha() for c in w) >= 4 and sum(c.isalpha() for c in w) / max(1, len(w)) >= 0.8]
    if strict:
        codes = [w for w in tokens if CODE_LIKE.match(w)]
        return bool(codes) or len(words) >= 4
    codes = [w for w in tokens if len(w) >= 5 and any(c.isalpha() for c in w) and any(c.isdigit() for c in w)]
    return bool(codes) or len(words) >= 3


def main(src: str, dst: str) -> None:
    doc = fitz.open(src)
    cache_open(src)
    out = []
    ocr_pages = 0
    ocr_images = 0
    for index, page in enumerate(doc, start=1):
        text = page_text(page)
        parts = [f"[page {index}]"]
        if text:
            parts.append(text)

        if len(text.replace(" ", "")) < MIN_TEXT_CHARS:
            # Picture-only page (scan, graphic table): OCR the rendered page.
            pix = page.get_pixmap(matrix=fitz.Matrix(RENDER_ZOOM, RENDER_ZOOM), alpha=False)
            ocr = clean_ocr(ocr_cached(pix.tobytes("png")), text)
            if ocr and worth_keeping(ocr):
                parts.append("[ocr]\n" + ocr)
                ocr_pages += 1
        else:
            # Text page: still OCR the embedded images (tables / labels as pictures).
            seen = set()
            for img in page.get_images(full=True):
                xref = img[0]
                if xref in seen:
                    continue
                seen.add(xref)
                try:
                    info = doc.extract_image(xref)
                except Exception:
                    continue
                if not info or info.get("width", 0) < MIN_IMAGE_SIDE or info.get("height", 0) < MIN_IMAGE_SIDE:
                    continue
                # Product photos yield noise ("oooo", stray glyphs) — keep only real
                # content that the text layer does not already have.
                ocr = clean_ocr(ocr_cached(info["image"]), text)
                if ocr and worth_keeping(ocr, strict=True):
                    parts.append("[image text]\n" + ocr)
                    ocr_images += 1
        out.append("\n".join(parts))

    cache_save()
    full = "\n\n".join(out).strip() + "\n"
    with open(dst, "w", encoding="utf-8") as f:
        f.write(full)
    print(json.dumps({"pages": len(doc), "ocrPages": ocr_pages, "ocrImages": ocr_images, "chars": len(full)}))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: pdf_text.py <input.pdf> <output.txt>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
