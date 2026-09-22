"""Erzeugt die Testbilder (braucht Pillow):
    barcode.mjpeg  EAN-13 als Bild für die simulierte Kamera von Chromium
    foto.jpg       Foto mit 2400 x 1800 Pixeln (größer als die 1600 Pixel, auf die offline.js verkleinert)

    python tests/fixtures/make-fixtures.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

CODE = "4006381333931"
L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"]
G = ["".join("1" if b == "0" else "0" for b in reversed(c)) for c in L]
R = ["".join("1" if b == "0" else "0" for b in c) for c in L]
PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]

digits = [int(c) for c in CODE]
bits = "101"
for i, d in enumerate(digits[1:7]):
    bits += (L if PARITY[digits[0]][i] == "L" else G)[d]
bits += "01010"
for d in digits[7:]:
    bits += R[d]
bits += "101"

module, quiet = 5, 12
width, height = 640, 480
img = Image.new("RGB", (width, height), "white")
draw = ImageDraw.Draw(img)
left = (width - (len(bits) + 2 * quiet) * module) // 2 + quiet * module
for i, b in enumerate(bits):
    if b == "1":
        draw.rectangle([left + i * module, 120, left + (i + 1) * module - 1, 360], fill="black")

out = Path(__file__).with_name("barcode.mjpeg")
img.save(out, "JPEG", quality=95)
print(out, CODE)

foto = Image.new("RGB", (2400, 1800))
pixels = foto.load()
for x in range(0, 2400, 4):
    for y in range(0, 1800, 4):
        color = (x * 255 // 2400, y * 255 // 1800, 128)
        for dx in range(4):
            for dy in range(4):
                pixels[x + dx, y + dy] = color
ImageDraw.Draw(foto).rectangle([900, 700, 1500, 1100], outline="white", width=20)
out = Path(__file__).with_name("foto.jpg")
foto.save(out, "JPEG", quality=90)
print(out)
