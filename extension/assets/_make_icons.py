"""Generates placeholder PNG icons for the extension. Run once.

Produces a flat-colored rounded square with a white pin glyph.
Uses only the stdlib (struct + zlib) to avoid extra deps.
"""
from __future__ import annotations
import os
import struct
import zlib
from pathlib import Path

# Brand color.
BG = (14, 134, 106)   # deep green
FG = (255, 255, 255)  # white glyph
BG_SHADE = (10, 100, 80)


def png(width: int, height: int, pixels: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = b""
    stride = width * 4
    for y in range(height):
        raw += b"\x00" + pixels[y * stride : (y + 1) * stride]
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def make_icon(size: int) -> bytes:
    # Rounded-square background with a small white pin glyph.
    radius = max(2, size // 6)
    buf = bytearray(size * size * 4)

    def put(x: int, y: int, rgba):
        if 0 <= x < size and 0 <= y < size:
            i = (y * size + x) * 4
            buf[i : i + 4] = bytes(rgba)

    # Background rounded square.
    for y in range(size):
        for x in range(size):
            inside = True
            # corner tests
            corners = [
                (radius, radius),
                (size - 1 - radius, radius),
                (radius, size - 1 - radius),
                (size - 1 - radius, size - 1 - radius),
            ]
            for cx, cy in corners:
                dx = x - cx
                dy = y - cy
                if ((x < cx and y < cy) or (x > cx and y < cy) or
                        (x < cx and y > cy) or (x > cx and y > cy)):
                    if dx * dx + dy * dy > radius * radius:
                        inside = False
                        break
            if inside:
                put(x, y, (*BG, 255))

    # Pin teardrop: circle + triangle tail.
    cx = size / 2
    cy = size * 0.42
    r = size * 0.22
    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            if dx * dx + dy * dy <= r * r:
                put(x, y, (*FG, 255))

    # Triangle tail of the pin.
    tip_y = size * 0.82
    for y in range(int(cy), int(tip_y) + 1):
        t = (y - cy) / (tip_y - cy) if tip_y != cy else 0
        half = r * (1 - t) * 0.9
        for x in range(int(cx - half), int(cx + half) + 1):
            put(x, y, (*FG, 255))

    # Hole in the pin head.
    r2 = r * 0.35
    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            if dx * dx + dy * dy <= r2 * r2:
                put(x, y, (*BG_SHADE, 255))

    return png(size, size, bytes(buf))


def main() -> None:
    here = Path(__file__).parent
    for size in (16, 32, 48, 128):
        out = here / f"icon-{size}.png"
        out.write_bytes(make_icon(size))
        print(f"wrote {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
