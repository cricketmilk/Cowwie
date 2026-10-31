# make_art.py — turn a generated logo into tile art for the Sanctum.
#
#   python make_art.py "C:\Users\you\Downloads\logo.jpg" glamoire [threshold]
#
# Strips the background by flood-filling from the image borders (so interior
# colors that merely resemble the background survive), feathers the alpha,
# crops to content, caps the long edge at 640, and writes
# renderer/lounge/art/<appid>.png. Then add "art": "art/<appid>.png" to the
# app's entry in apps.config.json.
#
# Threshold is the flood tolerance (default 40). Raise it for textured
# backgrounds (paper, grain); lower it when the background color sits close
# to colors inside the art (e.g. black brushwork on near-black: try 12-16).
from PIL import Image, ImageDraw, ImageFilter
import os, sys

KEY = (255, 0, 254)  # magic color no art uses

def strip(src, dst, thresh=40):
    im = Image.open(src).convert("RGB")
    w, h = im.size
    # Background is whatever touches the edge: seed the flood every ~40px
    # along all four borders.
    for x in range(0, w, 40):
        for xy in ((x, 0), (x, h - 1)):
            if im.getpixel(xy) != KEY:
                ImageDraw.floodfill(im, xy, KEY, thresh=thresh)
    for y in range(0, h, 40):
        for xy in ((0, y), (w - 1, y)):
            if im.getpixel(xy) != KEY:
                ImageDraw.floodfill(im, xy, KEY, thresh=thresh)

    alpha = Image.new("L", (w, h), 255)
    px, ap = im.load(), alpha.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] == KEY:
                ap[x, y] = 0
    # Feather: slight erosion then blur, so the cut sits softly on any ground.
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))

    out = Image.open(src).convert("RGBA")
    out.putalpha(alpha)
    box = alpha.getbbox()
    if box:
        pad = 10
        box = (max(0, box[0] - pad), max(0, box[1] - pad),
               min(w, box[2] + pad), min(h, box[3] + pad))
        out = out.crop(box)
    out.thumbnail((640, 640), Image.LANCZOS)
    out.save(dst)
    return out.size

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__ or "usage: python make_art.py <source-image> <app-id> [threshold]")
    src, appid = sys.argv[1], sys.argv[2]
    thresh = int(sys.argv[3]) if len(sys.argv) > 3 else 40
    dst = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "renderer", "lounge", "art", appid + ".png")
    size = strip(src, dst, thresh)
    print(f"wrote {dst} {size[0]}x{size[1]} — now add \"art\": \"art/{appid}.png\" to that app's registry entry")
