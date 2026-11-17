#!/usr/bin/env python3
"""Rasterize the exported PDF and verify that visible shape and text pixels exist."""

import sys
from pathlib import Path

import fitz


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: verify-offline-pdf.py <pdf-path>")

    pdf_path = Path(sys.argv[1])
    if not pdf_path.is_file():
        raise SystemExit(f"PDF does not exist: {pdf_path}")

    document = fitz.open(pdf_path)
    if document.page_count != 1:
        raise SystemExit(f"Expected one page, got {document.page_count}")

    page = document[0]
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    samples = memoryview(pixmap.samples)
    channels = pixmap.n

    non_white = 0
    red_pixels = 0
    dark_pixels = 0
    for offset in range(0, len(samples), channels):
        red, green, blue = samples[offset], samples[offset + 1], samples[offset + 2]
        if red < 245 or green < 245 or blue < 245:
            non_white += 1
        if red > 180 and green < 120 and blue < 120:
            red_pixels += 1
        if red < 100 and green < 100 and blue < 100:
            dark_pixels += 1

    print(
        f"PDF raster: {pixmap.width}x{pixmap.height}; "
        f"non-white={non_white}; red={red_pixels}; dark={dark_pixels}"
    )

    if non_white < 500:
        raise SystemExit("PDF rendered essentially white: too few non-white pixels.")
    if red_pixels < 200:
        raise SystemExit("PDF is missing the expected red rectangle.")
    if dark_pixels < 100:
        raise SystemExit("PDF is missing the expected dark text.")

    print("PDF pixel verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
