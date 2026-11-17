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
    if document.page_count != 2:
        raise SystemExit(f"Expected two pages after #pagebreak(), got {document.page_count}")

    page_metrics = []
    for page_number, page in enumerate(document):
        pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        samples = memoryview(pixmap.samples)
        channels = pixmap.n

        non_white = 0
        red_pixels = 0
        dark_pixels = 0
        blue_pixels = 0
        for offset in range(0, len(samples), channels):
            red, green, blue = samples[offset], samples[offset + 1], samples[offset + 2]
            if red < 245 or green < 245 or blue < 245:
                non_white += 1
            if red > 180 and green < 120 and blue < 120:
                red_pixels += 1
            if red < 100 and green < 100 and blue < 100:
                dark_pixels += 1
            if blue > 150 and red < 120 and green < 180:
                blue_pixels += 1

        page_metrics.append((non_white, red_pixels, dark_pixels, blue_pixels))
        print(
            f"PDF page {page_number + 1}: {pixmap.width}x{pixmap.height}; "
            f"non-white={non_white}; red={red_pixels}; dark={dark_pixels}; blue={blue_pixels}"
        )

        if non_white < 500:
            raise SystemExit(f"PDF page {page_number + 1} rendered essentially white.")
        if dark_pixels < 100:
            raise SystemExit(f"PDF page {page_number + 1} is missing expected dark text.")

    if page_metrics[0][1] < 200:
        raise SystemExit("PDF first page is missing the expected red rectangle.")
    if page_metrics[1][3] < 100:
        raise SystemExit("PDF second page is missing the expected blue rectangle.")

    print("Two-page PDF pixel verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
