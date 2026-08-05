"""One-off: turn the supplied TVM logo (opaque black plate) into a transparent-background
wordmark plus PWA icons. Run with the backend venv after dropping a new logo in."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "brand"
ICONS = Path(__file__).resolve().parents[2] / "frontend" / "public" / "icons"

LOW, HIGH = 22, 52  # luminance ramp used to fade the black plate out


def knockout_black(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            lum = max(r, g, b)
            if lum <= LOW:
                px[x, y] = (r, g, b, 0)
            elif lum < HIGH:
                px[x, y] = (r, g, b, int(a * (lum - LOW) / (HIGH - LOW)))
    return img


def main(src_path: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)

    src = Image.open(src_path)
    knocked = knockout_black(src)
    lockup = knocked.crop(knocked.getbbox())
    lockup.save(OUT / "tvm-logo.png")
    print(f"wordmark  {lockup.size}")

    # the "TVM" mark alone lives in the top-left ~40% of the lockup
    mark = lockup.crop((0, 0, lockup.width, int(lockup.height * 0.42)))
    mark = mark.crop(mark.getbbox())
    mark.save(OUT / "tvm-mark.png")
    print(f"mark      {mark.size}")

    for size in (192, 512):
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 255))
        radius = int(size * 0.18)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
        canvas.putalpha(mask)

        target_w = int(size * 0.72)
        scaled = mark.resize(
            (target_w, max(1, round(mark.height * target_w / mark.width))), Image.LANCZOS
        )
        canvas.alpha_composite(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2))
        canvas.save(ICONS / f"icon-{size}.png")
        print(f"icon      {size}")

    # maskable needs the safe zone: same art, smaller, on a full-bleed black square
    for size in (512,):
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 255))
        target_w = int(size * 0.54)
        scaled = mark.resize(
            (target_w, max(1, round(mark.height * target_w / mark.width))), Image.LANCZOS
        )
        canvas.alpha_composite(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2))
        canvas.save(ICONS / f"icon-maskable-{size}.png")
        print(f"maskable  {size}")


if __name__ == "__main__":
    main(sys.argv[1])
