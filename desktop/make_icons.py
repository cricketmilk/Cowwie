#!/usr/bin/env python3
"""
Generate the Roost icon set.

Draws the mark fresh at every size rather than downscaling one master. A
512px design scaled to 16px turns into grey mush — strokes fall below one
pixel and the rings close up. So stroke weights, gaps, and the corner radius
are all expressed as ratios of the canvas and re-rendered per size, and the
smallest sizes drop detail deliberately.

The mark: the Ifreglen sigil — an open eye held in a downward triad, on a
void tile. Phosphor iris, candle pupil, the same signal colours the toolbar
uses (candle amber means recording). The triad drops out below 24px on
purpose: at taskbar size a triangle plus an eye is mush, and a single lit
eye is about the most legible occult thing 16x16 can hold.

    python make_icons.py

Writes build/icon.ico (Windows), build/icon.png (Linux, 512), build/icon.icns
(macOS, if png2icns is available), plus build/icons/*.png.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent / "build"
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512]

BG = (8, 9, 15, 255)          # --bg      #08090F  void
RING = (127, 214, 168, 255)   # --ready   #7FD6A8  phosphor
PUPIL = (217, 161, 91, 255)   # --signal  #D9A15B  candle
RULE = (35, 42, 61, 255)      # --rule    #232A3D
TRIAD = (121, 128, 143, 255)  # --dim     #79808F


def draw_icon(size: int) -> Image.Image:
    # Supersample, then downsample once at the end. Anti-aliasing circles by
    # hand is worse than letting the resampler do it on a 4x buffer.
    ss = 4 if size >= 32 else 8
    S = size * ss
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded tile. Radius shrinks proportionally at small sizes so the
    # silhouette stays square-ish and readable rather than turning into a blob.
    radius = int(S * (0.20 if size >= 32 else 0.16))
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=BG)

    # Hairline inner edge, for definition against dark taskbars. Below 32px
    # there aren't enough pixels for it to read as anything but noise.
    if size >= 32:
        inset = max(1, int(S * 0.012))
        d.rounded_rectangle(
            [inset, inset, S - 1 - inset, S - 1 - inset],
            radius=int(radius * 0.88),
            outline=RULE,
            width=max(1, int(S * 0.008)),
        )

    # The triad. Hairline, dropped below 24px where it would only smear.
    cx = S / 2
    if size >= 24:
        top_y = S * 0.16
        base_y = S * 0.80
        half = S * 0.36
        w = max(1, int(S * 0.030))
        d.line([(cx, top_y), (cx + half, base_y)], fill=TRIAD, width=w)
        d.line([(cx + half, base_y), (cx - half, base_y)], fill=TRIAD, width=w)
        d.line([(cx - half, base_y), (cx, top_y)], fill=TRIAD, width=w)

    # The eye, held low in the triad (or centred when the triad is dropped).
    cy = S * (0.615 if size >= 24 else 0.50)
    eye_rx = S * (0.215 if size >= 24 else 0.30)
    eye_ry = eye_rx * 0.62
    stroke = S * (0.045 if size >= 24 else 0.075)
    pupil_r = eye_ry * (0.52 if size >= 24 else 0.58)

    d.ellipse(
        [cx - eye_rx, cy - eye_ry, cx + eye_rx, cy + eye_ry],
        outline=RING,
        width=max(1, int(stroke)),
    )
    d.ellipse(
        [cx - pupil_r, cy - pupil_r, cx + pupil_r, cy + pupil_r],
        fill=PUPIL,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    icons_dir = OUT / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)

    images = {}
    for s in SIZES:
        img = draw_icon(s)
        images[s] = img
        img.save(icons_dir / f"{s}x{s}.png")
    print(f"  {len(SIZES)} PNGs -> {icons_dir}")

    # Windows .ico. Multi-resolution so Explorer, the taskbar and the title
    # bar each pick the size they want instead of rescaling one bitmap.
    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    images[256].save(
        OUT / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=[images[s] for s in ico_sizes if s != 256],
    )
    print(f"  icon.ico  ({len(ico_sizes)} resolutions)")

    # Linux / Electron window icon.
    images[512].save(OUT / "icon.png")
    print("  icon.png  (512)")

    # macOS. Optional — skip quietly if the tool isn't installed.
    try:
        pngs = [str(icons_dir / f"{s}x{s}.png") for s in (16, 32, 128, 256, 512)]
        subprocess.run(
            ["png2icns", str(OUT / "icon.icns"), *pngs],
            check=True, capture_output=True,
        )
        print("  icon.icns")
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("  icon.icns skipped (png2icns not installed — macOS only)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
