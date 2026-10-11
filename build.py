#!/usr/bin/env python3
"""Lime GBFS Tel Aviv static-site builder -- standalone, Python standard library only.

Reads
    data/snapshots/tel_aviv/free_bike_status/*.json(.gz)   raw poller output
    data/poi/poi.geojson                                   vendored OSM venues (ODbL)
    data/poi/bbox.json, data/poi/fetch_date.txt            POI provenance
    data/tiles.json                                        vendored basemap manifest
    templates/**                                           HTML/CSS/JS templates
    site/tiles/tel_aviv/**                                 vendored OSM raster tiles
    site/vendor/**                                         vendored Leaflet

Writes
    site/data/**       TLV-only JSON payloads (same shapes as the browser pipeline)
    site/index.html, site/bike.html, site/chains.html
    site/assets/**     style.css + the client-side algorithm/UI modules
    site/trips-map.png, site/bike-<id8>.png
    site/snapshots/**  snapshot mirror + manifest.json for the browser OFFLINE mode

Every write is atomic (tmp + os.replace) and skipped when the bytes are unchanged,
so `site/` can be rsynced/git-pushed incrementally.

The same algorithms run in the browser (templates/assets/gbfs-algo.js); this file
is the headless batch equivalent and produces identical JSON/CSV shapes.

Run:
    python3 build.py
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import re
import struct
import sys
import time
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_IN = ROOT / "data"
SNAP = DATA_IN / "snapshots"
POIDIR = DATA_IN / "poi"
TEMPLATES = ROOT / "templates"
SITE = ROOT / "site"
SDATA = SITE / "data"
STILES = SITE / "tiles"

MARKET = "tel_aviv"
FEED = "free_bike_status"
JUDDER = {"reservation_or_state_toggle", "feed_flicker", "relocation_suspect"}
VISIBLE_DEFAULT = {"ride_confirmed", "ride_probable"}
R_EARTH = 6371000.0
MIN_FLOOR_M = 10.0
DEG_LAT_M = 111000.0
TIERS = (30, 50, 100)
CLASS_ORDER = ["ride_confirmed", "ride_probable", "reservation_or_state_toggle",
               "feed_flicker", "relocation_suspect"]
CONF = {"ride_confirmed": 0.95, "ride_probable": 0.6, "reservation_or_state_toggle": 0.5,
        "feed_flicker": 0.9, "relocation_suspect": 0.55}
S1, S2, S3 = "#2a78d6", "#eb6834", "#1baf7a"


def log(msg: str) -> None:
    print(f"{datetime.now(timezone.utc).isoformat()} {msg}", flush=True)


def iso(dt) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def fl(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pctl(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    a, b = math.floor(k), math.ceil(k)
    return xs[int(k)] if a == b else xs[a] + (xs[b] - xs[a]) * (k - a)


def write_bytes_if_changed(path: Path, data: bytes) -> bool:
    """Atomic write; returns True when the file actually changed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.exists() and path.read_bytes() == data:
            return False
    except OSError:
        pass
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return True


def write_json(path: Path, obj) -> int:
    txt = json.dumps(obj, separators=(",", ":"), default=str).encode()
    write_bytes_if_changed(path, txt)
    return len(txt)


def copy_if_changed(src: Path, dst: Path) -> bool:
    if not src.exists():
        return False
    return write_bytes_if_changed(dst, src.read_bytes())


# ============================================================ minimal PNG codec
_SIG = b"\x89PNG\r\n\x1a\n"
FONT = {
    "A": [14, 17, 17, 31, 17, 17, 17], "B": [30, 17, 17, 30, 17, 17, 30],
    "C": [14, 17, 16, 16, 16, 17, 14], "D": [30, 17, 17, 17, 17, 17, 30],
    "E": [31, 16, 16, 30, 16, 16, 31], "F": [31, 16, 16, 30, 16, 16, 16],
    "G": [14, 17, 16, 23, 17, 17, 14], "H": [17, 17, 17, 31, 17, 17, 17],
    "I": [14, 4, 4, 4, 4, 4, 14], "J": [7, 2, 2, 2, 2, 18, 12],
    "K": [17, 18, 20, 24, 20, 18, 17], "L": [16, 16, 16, 16, 16, 16, 31],
    "M": [17, 27, 21, 21, 17, 17, 17], "N": [17, 25, 21, 19, 17, 17, 17],
    "O": [14, 17, 17, 17, 17, 17, 14], "P": [30, 17, 17, 30, 16, 16, 16],
    "Q": [14, 17, 17, 17, 21, 18, 13], "R": [30, 17, 17, 30, 20, 18, 17],
    "S": [15, 16, 16, 14, 1, 1, 30], "T": [31, 4, 4, 4, 4, 4, 4],
    "U": [17, 17, 17, 17, 17, 17, 14], "V": [17, 17, 17, 17, 17, 10, 4],
    "W": [17, 17, 17, 21, 21, 27, 17], "X": [17, 17, 10, 4, 10, 17, 17],
    "Y": [17, 17, 10, 4, 4, 4, 4], "Z": [31, 1, 2, 4, 8, 16, 31],
    "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14],
    "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14],
    "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
    "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
    "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12],
    " ": [0, 0, 0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12],
    ":": [0, 12, 12, 0, 12, 12, 0], "-": [0, 0, 0, 31, 0, 0, 0],
    "/": [1, 2, 2, 4, 8, 8, 16], "%": [17, 2, 2, 4, 8, 8, 17],
    "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8],
    ",": [0, 0, 0, 0, 12, 12, 8], "!": [4, 4, 4, 4, 4, 0, 4],
    "+": [0, 4, 4, 31, 4, 4, 0], "=": [0, 0, 31, 0, 31, 0, 0],
    "#": [10, 31, 10, 10, 31, 10, 0], "<": [2, 4, 8, 16, 8, 4, 2],
    ">": [8, 4, 2, 1, 2, 4, 8], "*": [0, 21, 14, 31, 14, 21, 0],
    "?": [14, 17, 1, 2, 4, 0, 4], "_": [0, 0, 0, 0, 0, 0, 31],
    "~": [0, 0, 10, 21, 0, 0, 0], "@": [14, 17, 23, 21, 23, 16, 14],
    # remaining printable ASCII (so no drawn glyph ever falls through to "?")
    "\"": [10, 10, 0, 0, 0, 0, 0], "$": [4, 15, 20, 14, 5, 30, 4],
    "&": [12, 18, 20, 8, 21, 18, 13], "'": [6, 4, 8, 0, 0, 0, 0],
    ";": [0, 12, 12, 0, 12, 12, 8], "[": [14, 8, 8, 8, 8, 8, 14],
    "\\": [16, 8, 8, 4, 2, 2, 1], "]": [14, 2, 2, 2, 2, 2, 14],
    "^": [4, 10, 17, 0, 0, 0, 0], "`": [8, 4, 2, 0, 0, 0, 0],
    "{": [6, 8, 8, 16, 8, 8, 6], "|": [4, 4, 4, 4, 4, 4, 4],
    "}": [12, 2, 2, 1, 2, 2, 12],
}
OSM_ATTR = "(C) OPENSTREETMAP CONTRIBUTORS"


def hex2rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def text_w(s: str, sc: int = 1) -> int:
    return len(s) * 6 * sc - sc


class Canvas:
    """Tiny RGB canvas backed by a bytearray (w*h*3)."""

    __slots__ = ("w", "h", "buf")

    def __init__(self, w: int, h: int, rgb=(0, 0, 0)):
        self.w, self.h = w, h
        self.buf = bytearray(bytes(rgb) * (w * h))

    def fill(self, rgb) -> None:
        self.buf[:] = bytes(rgb) * (self.w * self.h)

    def rect(self, x0, y0, x1, y1, rgb) -> None:
        w, h = self.w, self.h
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(w, int(x1)), min(h, int(y1))
        if x1 <= x0 or y1 <= y0:
            return
        row = bytes(rgb) * (x1 - x0)
        buf = self.buf
        for y in range(y0, y1):
            i = (y * w + x0) * 3
            buf[i:i + (x1 - x0) * 3] = row

    def disk(self, cx, cy, r, rgb) -> None:
        w, h = self.w, self.h
        y0, y1 = max(0, cy - r), min(h, cy + r + 1)
        x0, x1 = max(0, cx - r), min(w, cx + r + 1)
        if x1 <= x0 or y1 <= y0:
            return
        rr = r * r
        row = bytes(rgb)
        buf = self.buf
        for y in range(y0, y1):
            dy = y - cy
            span = rr - dy * dy
            if span < 0:
                continue
            half = int(math.isqrt(span))
            a, b = max(x0, cx - half), min(x1, cx + half + 1)
            for x in range(a, b):
                i = (y * w + x) * 3
                buf[i:i + 3] = row

    def line(self, x0, y0, x1, y1, rgb, thick=1) -> None:
        x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
        n = max(abs(x1 - x0), abs(y1 - y0), 1)
        w, h = self.w, self.h
        row = bytes(rgb)
        buf = self.buf
        for k in range(n + 1):
            t = k / n
            x = int(round(x0 + (x1 - x0) * t))
            y = int(round(y0 + (y1 - y0) * t))
            for dx in range(thick):
                xx = x + dx
                if 0 <= xx < w and 0 <= y < h:
                    i = (y * w + xx) * 3
                    buf[i:i + 3] = row

    def text(self, x, y, s, rgb, sc=2) -> None:
        for ch in s.upper():
            g = FONT.get(ch, FONT["?"])
            for ry in range(7):
                rowbits = g[ry]
                if not rowbits:
                    continue
                for rx in range(5):
                    if rowbits & (1 << (4 - rx)):
                        self.rect(x + rx * sc, y + ry * sc, x + rx * sc + sc, y + ry * sc + sc, rgb)
            x += 6 * sc


def _chunks(data: bytes):
    i, n = 8, len(data)
    while i + 8 <= n:
        ln = struct.unpack(">I", data[i:i + 4])[0]
        typ = data[i + 4:i + 8]
        yield typ, data[i + 8:i + 8 + ln]
        i += 12 + ln


def _unfilter(raw: bytes, height: int, width: int, stride: int, bpp: int) -> bytearray:
    out = bytearray(height * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        if pos >= len(raw):
            break
        ft = raw[pos]
        pos += 1
        ln = bytearray(raw[pos:pos + stride])
        pos += stride
        if len(ln) < stride:
            ln.extend(b"\x00" * (stride - len(ln)))
        if ft == 1:
            for x in range(bpp, stride):
                ln[x] = (ln[x] + ln[x - bpp]) & 0xFF
        elif ft == 2:
            for x in range(stride):
                ln[x] = (ln[x] + prev[x]) & 0xFF
        elif ft == 3:
            for x in range(stride):
                a = ln[x - bpp] if x >= bpp else 0
                ln[x] = (ln[x] + ((a + prev[x]) >> 1)) & 0xFF
        elif ft == 4:
            for x in range(stride):
                a = ln[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                ln[x] = (ln[x] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = ln
        prev = ln
    return out


def read_png(data: bytes) -> Canvas:
    """Decode a non-interlaced 8-bit PNG (color types 0/2/3/4/6, palette depth 1/8)."""
    if data[:8] != _SIG:
        raise ValueError("not a png")
    width = height = bitdepth = colortype = 0
    plte = b""
    idat = bytearray()
    for typ, body in _chunks(data):
        if typ == b"IHDR":
            width, height, bitdepth, colortype, _, _, _ = struct.unpack(">IIBBBBB", body)
        elif typ == b"PLTE":
            plte = body
        elif typ == b"IDAT":
            idat.extend(body)
        elif typ == b"IEND":
            break
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colortype]
    raw = zlib.decompress(bytes(idat))
    if bitdepth == 8:
        buf = _unfilter(raw, height, width, width * ch, ch)
    elif bitdepth == 1 and colortype == 3:
        buf = _unfilter(raw, height, width, (width + 7) // 8, 1)
    else:
        raise ValueError(f"unsupported png bitdepth={bitdepth} colortype={colortype}")
    cv = Canvas(width, height)
    out = cv.buf
    if colortype == 3:
        npal = len(plte) // 3
        k = 0
        if bitdepth == 8:
            for i in range(width * height):
                idx = buf[i]
                j = (idx if idx < npal else npal - 1) * 3
                out[k] = plte[j]
                out[k + 1] = plte[j + 1]
                out[k + 2] = plte[j + 2]
                k += 3
        else:
            stride = (width + 7) // 8
            for y in range(height):
                base = y * stride
                for x in range(width):
                    idx = (buf[base + (x >> 3)] >> (7 - (x & 7))) & 1
                    j = (idx if idx < npal else npal - 1) * 3
                    out[k] = plte[j]
                    out[k + 1] = plte[j + 1]
                    out[k + 2] = plte[j + 2]
                    k += 3
    elif colortype == 2:
        out[:] = buf
    elif colortype == 0:
        k = 0
        for i in range(width * height):
            v = buf[i]
            out[k] = out[k + 1] = out[k + 2] = v
            k += 3
    elif colortype in (4, 6):
        step = 2 if colortype == 4 else 4
        k = 0
        for i in range(0, width * height * step, step):
            out[k] = out[k + 1] = out[k + 2] = buf[i]
            k += 3
    return cv


def write_png(path: Path, cv: Canvas) -> None:
    h, w = cv.h, cv.w
    raw = bytearray()
    row = w * 3
    for y in range(h):
        raw.append(0)
        raw.extend(cv.buf[y * row:(y + 1) * row])
    comp = zlib.compress(bytes(raw), 6)

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    out = _SIG + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", comp) + chunk(b"IEND", b"")
    write_bytes_if_changed(path, out)


# ==================================================================== tiles / map
def lon2tile(lon, z):
    return int((lon + 180.0) / 360.0 * (2 ** z))


def lat2tile(lat, z):
    lat = max(min(lat, 85.05112878), -85.05112878)
    r = math.radians(lat)
    return int((1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * (2 ** z))


def tile_range(bbox, z):
    s, w, n, e = bbox
    return (lon2tile(w, z), lat2tile(n, z), lon2tile(e, z), lat2tile(s, z))


def tile_xy(lat, lon, z):
    n = 2 ** z
    fx = (lon + 180.0) / 360.0 * n
    r = math.radians(max(min(lat, 85.05112878), -85.05112878))
    fy = (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n
    return fx, fy


_TILE_META = None


def tile_meta() -> dict:
    global _TILE_META
    if _TILE_META is None:
        p = DATA_IN / "tiles.json"
        try:
            _TILE_META = json.loads(p.read_text())
        except Exception:  # noqa: BLE001
            _TILE_META = {}
    return _TILE_META


def vendored_bounds():
    t = tile_meta().get(MARKET)
    if t and t.get("bounds"):
        (bs, bw), (bn, be) = t["bounds"]
        return (bs, bw, bn, be)
    return None


def clamp_bbox(bbox):
    vb = vendored_bounds()
    if not vb:
        return bbox
    s0, w0, n0, e0 = bbox
    vs, vw, vn, ve = vb
    s1, w1, n1, e1 = max(s0, vs), max(w0, vw), min(n0, vn), min(e0, ve)
    if n1 - s1 <= 0 or e1 - w1 <= 0:
        return bbox
    return (s1, w1, n1, e1)


def stitch_tiles(bbox, z: int, max_tiles=80, min_w_tiles=1):
    x0, y0, x1, y1 = tile_range(bbox, z)
    while (x1 - x0 + 1) * (y1 - y0 + 1) > max_tiles and z > 5:
        z -= 1
        x0, y0, x1, y1 = tile_range(bbox, z)
    avail_x, avail_y = set(), set()
    zd = STILES / MARKET / str(z)
    if zd.exists():
        for xd in zd.iterdir():
            if xd.is_dir():
                try:
                    xi = int(xd.name)
                except ValueError:
                    continue
                for f in xd.glob("*.png"):
                    avail_x.add(xi)
                    avail_y.add(int(f.stem))
    if avail_x:
        x0, x1 = max(x0, min(avail_x)), min(x1, max(avail_x))
    if avail_y:
        y0, y1 = max(y0, min(avail_y)), min(y1, max(avail_y))
    if min_w_tiles > 1:
        cx = (x0 + x1) // 2
        half = (min_w_tiles - 1) // 2 + ((min_w_tiles - 1) % 2)
        nx0, nx1 = cx - half, cx + half
        if avail_x:
            nx0, nx1 = max(nx0, min(avail_x)), min(nx1, max(avail_x))
        if nx1 > nx0:
            x0, x1 = nx0, nx1
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    canvas = Canvas(nx * 256, ny * 256, (232, 229, 222))
    got = 0
    for i, x in enumerate(range(x0, x1 + 1)):
        for j, y in enumerate(range(y0, y1 + 1)):
            p = STILES / MARKET / str(z) / str(x) / f"{y}.png"
            if p.exists():
                try:
                    tile = read_png(p.read_bytes())
                except Exception:  # noqa: BLE001
                    continue
                tw = min(256, canvas.w - i * 256)
                th = min(256, canvas.h - j * 256)
                for ty in range(th):
                    src = (ty * tile.w) * 3
                    dst = ((j * 256 + ty) * canvas.w + i * 256) * 3
                    canvas.buf[dst:dst + tw * 3] = tile.buf[src:src + tw * 3]
                got += 1
    return (canvas, x0, y0, z, got, nx * ny)


def fit_scale(cv: Canvas, s: str, x: int = 16, max_sc: int = 3, pad: int = 16) -> int:
    avail = max(40, cv.w - x - pad)
    return max(1, min(max_sc, avail // (6 * max(1, len(s)))))


def render_map_png(path: Path, trips: list, st: dict, raw: dict) -> bool:
    pts = [(t["origin_lat"], t["origin_lon"], t["dest_lat"], t["dest_lon"], t["class"])
           for t in trips if t.get("class") in VISIBLE_DEFAULT
           and None not in (t.get("origin_lat"), t.get("origin_lon"),
                            t.get("dest_lat"), t.get("dest_lon"))]
    if not pts:
        return False
    lats = sorted([p[0] for p in pts] + [p[2] for p in pts])
    lons = sorted([p[1] for p in pts] + [p[3] for p in pts])
    qq = lambda xs, pc: xs[min(len(xs) - 1, max(0, int((len(xs) - 1) * pc / 100.0)))]
    bbox = (qq(lats, 1) - 0.002, qq(lons, 1) - 0.002, qq(lats, 99) + 0.002, qq(lons, 99) + 0.002)
    bbox = clamp_bbox(bbox)
    z = 13
    for cand in (15, 14, 13, 12):
        tx0, ty0, tx1, ty1 = tile_range(bbox, cand)
        if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 120:
            z = cand
            break
    canvas, x0, y0, z, got, want = stitch_tiles(bbox, z)
    if got == 0:
        canvas = Canvas(1400, 900, (26, 26, 25))
        draw_base = False
    else:
        draw_base = True
    h, w = canvas.h, canvas.w
    t1 = "TEL AVIV - GBFS VEHICLE-LEVEL TRIP LINKAGE"
    t2 = (f"{st['n']} CONFIRMED TRIPS OF {raw['n']} RAW DROPOUT PAIRS  "
          f"/  MEDIAN {st['median_displacement_m']:.0f} M (RAW {raw['median_displacement_m']:.0f} M)  "
          f"/  {st['dist_p95_m']:.0f} M P95")
    t3 = ("SAME bike_id BEFORE AND AFTER DROPOUT / CONFIRMED = BATTERY-CORROBORATED "
          "OR MULTI-INTERVAL ABSENCE WITH DISPLACEMENT")
    k1 = fit_scale(canvas, t1, max_sc=3)
    k2 = fit_scale(canvas, t2, max_sc=2)
    k3 = fit_scale(canvas, t3, max_sc=2)
    band = 10 + 8 * k1 + 8 * k2 + 8 * k3 + 10
    canvas.rect(0, 0, w, band, (17, 17, 16))
    canvas.text(16, 12, t1, (255, 255, 255), k1)
    canvas.text(16, 12 + 8 * k1 + 2, t2, (185, 184, 176), k2)
    canvas.text(16, 12 + 8 * k1 + 8 * k2 + 4, t3, (150, 149, 141), k3)

    def px(lat, lon):
        fx, fy = tile_xy(lat, lon, z)
        return int((fx - x0) * 256), int((fy - y0) * 256)

    for (ola, olo, dla, dlo, cls) in pts:
        c = (40, 50, 70) if cls == "ride_confirmed" else (150, 150, 148)
        canvas.line(*px(ola, olo), *px(dla, dlo), c, 2)
    for (ola, olo, dla, dlo, cls) in pts:
        r = 5 if cls == "ride_confirmed" else 3
        canvas.disk(*px(ola, olo), r, (30, 160, 90) if cls == "ride_confirmed" else (120, 120, 118))
        canvas.disk(*px(dla, dlo), r, (200, 60, 60) if cls == "ride_confirmed" else (120, 120, 118))
    if not draw_base:
        canvas.text(16, h // 2, "BASEMAP TILES NOT VENDORED - COORDINATE FRAME ONLY", (200, 60, 60), 2)
    ly = h - 26
    canvas.rect(0, ly - 4, w, h, (17, 17, 16))
    canvas.disk(22, ly + 6, 5, (30, 160, 90))
    canvas.text(34, ly, "START / UNLOCK", (185, 184, 176), 1)
    canvas.disk(210, ly + 6, 5, (200, 60, 60))
    canvas.text(222, ly, "STOP / LOCK", (185, 184, 176), 1)
    # right-align the OSM attribution so it can never collide with the left legend
    attr = OSM_ATTR + "  ODBL - VENDORED TILES, NO RUNTIME EGRESS"
    ax = max(300, w - text_w(attr, 1) - 14)
    canvas.text(ax, ly, attr, (150, 149, 141), 1)
    write_png(path, canvas)
    return True


def render_bike_png(path: Path, bike_id: str, trips: list, pois, row: dict) -> bool:
    mine = [t for t in trips if t["bike_id"] == bike_id or t.get("bike_id_prev") == bike_id]
    mine.sort(key=lambda t: t["dropout_ts"])
    if not mine:
        return False
    pts = [(t["origin_lat"], t["origin_lon"], t["dest_lat"], t["dest_lon"], t["class"])
           for t in mine if None not in (t.get("origin_lat"), t.get("origin_lon"),
                                         t.get("dest_lat"), t.get("dest_lon"))]
    if not pts:
        return False
    lats = [p[0] for p in pts] + [p[2] for p in pts]
    lons = [p[1] for p in pts] + [p[3] for p in pts]
    bbox = clamp_bbox((min(lats) - 0.0015, min(lons) - 0.0015, max(lats) + 0.0015, max(lons) + 0.0015))
    z = 14
    for cand in (16, 15, 14, 13):
        tx0, ty0, tx1, ty1 = tile_range(bbox, cand)
        if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 90:
            z = cand
            break
    canvas, x0, y0, z, got, want = stitch_tiles(bbox, z, max_tiles=120, min_w_tiles=6)
    if got == 0:
        canvas = Canvas(1200, 760, (26, 26, 25))
    h, w = canvas.h, canvas.w
    conf = [t for t in mine if t["class"] == "ride_confirmed"]
    td = sum((t.get("trip_len_m") or 0) for t in conf)
    t1 = "ONE BIKE'S DAY IN TEL AVIV - LABELED WITH BUSINESSES"
    t2 = f"bike_id {bike_id}"
    t3 = (f"{len(conf)} CONFIRMED TRIPS / {td/1000.0:.2f} KM / "
          f"{row.get('venues') or 0} VENUES WITHIN 50 M / "
          f"active {row.get('active_h') or 0} H / {row.get('obs') or 0} OBSERVATIONS")
    s1 = fit_scale(canvas, t1, max_sc=3)
    s2 = fit_scale(canvas, t2, max_sc=2)
    s3 = fit_scale(canvas, t3, max_sc=2)
    band = 10 + 8 * s1 + 8 * s2 + 8 * s3 + 10
    canvas.rect(0, 0, w, band, (17, 17, 16))
    canvas.text(16, 12, t1, (255, 255, 255), s1)
    canvas.text(16, 12 + 8 * s1 + 2, t2, (200, 199, 190), s2)
    canvas.text(16, 12 + 8 * s1 + 8 * s2 + 4, t3, (185, 184, 176), s3)

    def px(lat, lon):
        fx, fy = tile_xy(lat, lon, z)
        return int((fx - x0) * 256), int((fy - y0) * 256)

    for (ola, olo, dla, dlo, cls) in pts:
        canvas.line(*px(ola, olo), *px(dla, dlo),
                    (60, 70, 85) if cls == "ride_confirmed" else (140, 140, 138), 2)
    if pois:
        grid = Grid(pois)
        labelled = set()
        for t in mine:
            for key, lat, lon in (("o_ven", t.get("origin_lat"), t.get("origin_lon")),
                                  ("d_ven", t.get("dest_lat"), t.get("dest_lon"))):
                for v in (t.get(key) or [])[:1]:
                    canvas.disk(*px(v["lat"], v["lon"]), 3, (240, 200, 60))
                    k = (round(v["lat"], 5), round(v["lon"], 5))
                    txt = venue_label(v)
                    if k not in labelled and txt:
                        labelled.add(k)
                        txt = txt[:24]
                        while len(txt) > 1 and text_w(txt, 1) + 8 > w - 4:
                            txt = txt[:-1]
                        x, y = px(v["lat"], v["lon"])
                        bw = text_w(txt, 1) + 8
                        bx = min(max(2, x + 4), w - 2 - bw) if w - 2 - bw >= 2 else 2
                        by = y - 9
                        if by < 2:
                            by = y + 4
                        by = min(by, h - 12)
                        canvas.rect(bx, by, bx + bw, by + 10, (17, 17, 16))
                        canvas.text(bx + 4, by + 2, txt, (250, 225, 130), 1)
    for (ola, olo, dla, dlo, cls) in pts:
        canvas.disk(*px(ola, olo), 5, (30, 160, 90))
        canvas.disk(*px(dla, dlo), 5, (200, 60, 60))
    canvas.rect(0, h - 26, w, h, (17, 17, 16))
    items = [((30, 160, 90), 5, "START / UNLOCK (FEED DROPOUT)", (185, 184, 176)),
             ((200, 60, 60), 5, "STOP / LOCK (REAPPEARANCE)", (185, 184, 176)),
             ((240, 200, 60), 3, "NEAREST BUSINESS (OSM)", (185, 184, 176)),
             (None, 0, OSM_ATTR + " ODBL", (150, 149, 141))]
    cx = 14
    for col, r, txt, ink in items:
        need = (2 * r + 8) + text_w(txt, 1) + 14
        if cx + need > w - 8:
            break
        if col is not None:
            canvas.disk(cx + r, h - 20, r, col)
        cx += 2 * r + 8
        canvas.text(cx, h - 26, txt, ink, 1)
        cx += text_w(txt, 1) + 14
    write_png(path, canvas)
    return True


# ============================================================ trip reconstruction
def parse_ts(name: str) -> datetime:
    base = name.replace(".json.gz", "").replace(".json", "").rstrip("Z")
    if "." in base:
        base = base.split(".")[0]
    return datetime.strptime(base, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)


def hav(lat1, lon1, lat2, lon2) -> float:
    try:
        lat1, lon1, lat2, lon2 = float(lat1), float(lon1), float(lat2), float(lon2)
    except (TypeError, ValueError):
        return float("nan")
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(a))


def decimals(v) -> int:
    s = str(v)
    return 0 if "." not in s else len(s.split(".", 1)[1])


def precision_floor_m(dp_a: int, dp_b: int) -> float:
    return max(MIN_FLOOR_M, DEG_LAT_M * (10.0 ** -max(dp_a, dp_b)) * 0.5)


def _classify(disp_m, floor_m, range_delta, lr_changed, n_missed, gap_s):
    moved = disp_m is not None and disp_m == disp_m and disp_m > floor_m
    battery_ok = (range_delta is not None and range_delta > 0 and
                  disp_m is not None and range_delta <= max(5.0 * disp_m, 500.0))
    ev = (f"disp={0 if disp_m is None else round(disp_m)}m "
          f"floor={round(floor_m)}m missed={n_missed} "
          f"range_delta={range_delta} lr_changed={lr_changed}")
    if n_missed == 1 and not moved and (range_delta == 0) and not lr_changed:
        return "feed_flicker", CONF["feed_flicker"], ev + " | one-interval absence, identical pos/range/last_reported"
    if not moved and (range_delta == 0):
        return "reservation_or_state_toggle", CONF["reservation_or_state_toggle"], ev + " | same pos, zero consumption"
    if disp_m is not None and disp_m > 2000 and (range_delta is None or range_delta <= 0):
        return "relocation_suspect", CONF["relocation_suspect"], ev + " | large move, ~zero consumption"
    if moved and battery_ok:
        return "ride_confirmed", CONF["ride_confirmed"], ev + " | battery corroborated"
    if moved and n_missed >= 2:
        return "ride_confirmed", 0.8, ev + " | >=2 missed intervals + position change"
    if moved:
        return "ride_probable", CONF["ride_probable"], ev + " | above floor, no battery corroboration"
    return "reservation_or_state_toggle", CONF["reservation_or_state_toggle"], ev + " | below floor"


def load_snaps():
    """All TLV free_bike_status snapshots with >=1 vehicle (coords kept as str)."""
    files = []
    d = SNAP / MARKET / FEED
    if d.exists():
        files.extend(sorted(d.glob("*.json")))
        files.extend(sorted(d.glob("*.json.gz")))
    snaps = []
    for f in sorted(files, key=lambda p: p.name):
        try:
            raw = gzip.decompress(f.read_bytes()) if f.name.endswith(".gz") else f.read_bytes()
            data = json.loads(raw, parse_float=str)
            dd = data.get("data") or {}
            bikes = dd.get("bikes") or dd.get("vehicles") or []
            by_id = {b.get("bike_id"): b for b in bikes if b.get("bike_id")}
            if not by_id:
                continue
            snaps.append({"ts": parse_ts(f.name), "bikes": by_id, "n": len(by_id)})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"skip {f.name}: {type(e).__name__}: {e}\n")
    snaps.sort(key=lambda s: s["ts"])
    return snaps


def detect_epochs(snaps):
    if not snaps:
        return []
    epochs, start = [], 0
    for i in range(len(snaps) - 1):
        a, b = set(snaps[i]["bikes"]), set(snaps[i + 1]["bikes"])
        if len(a & b) / (len(a | b) or 1) < 0.5:
            epochs.append((start, i))
            start = i + 1
    epochs.append((start, len(snaps) - 1))
    return epochs


def trips_for_market(snaps):
    if len(snaps) < 2:
        return []
    trips = []
    for (e0, e1) in detect_epochs(snaps):
        esnaps = snaps[e0:e1 + 1]
        timeline = defaultdict(list)
        for i, s in enumerate(esnaps):
            for vid, b in s["bikes"].items():
                timeline[vid].append((i, b))
        for vid, obs in timeline.items():
            runs, cur = [], [obs[0]]
            for prev, nxt in zip(obs, obs[1:]):
                if nxt[0] == prev[0] + 1:
                    cur.append(nxt)
                else:
                    runs.append(cur)
                    cur = [nxt]
            runs.append(cur)
            for r0, r1 in zip(runs, runs[1:]):
                i0, b0 = r0[-1]
                i1, b1 = r1[0]
                if i1 <= i0 + 1:
                    continue
                t0, t1 = esnaps[i0]["ts"], esnaps[i1]["ts"]
                n_missed = i1 - i0 - 1
                d = hav(b0.get("lat"), b0.get("lon"), b1.get("lat"), b1.get("lon"))
                disp = None if d != d else round(d, 1)
                dp_a, dp_b = decimals(b0.get("lat")), decimals(b1.get("lat"))
                floor = precision_floor_m(dp_a, dp_b)
                rb, ra = fl(b0.get("current_range_meters")), fl(b1.get("current_range_meters"))
                range_delta = None if (rb is None or ra is None) else (rb - ra)
                lr0, lr1 = b0.get("last_reported"), b1.get("last_reported")
                lr_changed = (lr0 != lr1)
                gap_s = (t1 - t0).total_seconds()
                cls, conf, ev = _classify(disp, floor, range_delta, lr_changed, n_missed, gap_s)
                trips.append({
                    "market": MARKET, "bike_id": vid, "linkage": "same_id",
                    "dropout_ts": iso(t0), "reappear_ts": iso(t1), "gap_s": round(gap_s, 1),
                    "origin_lat": fl(b0.get("lat")), "origin_lon": fl(b0.get("lon")),
                    "dest_lat": fl(b1.get("lat")), "dest_lon": fl(b1.get("lon")),
                    "trip_len_m": disp, "vehicle_type": b0.get("vehicle_type") or "",
                    "range_before": None if rb is None else int(rb),
                    "range_after": None if ra is None else int(ra),
                    "last_reported_before": lr0, "last_reported_after": lr1,
                    "epoch": f"{e0}-{e1}", "class": cls, "confidence": conf,
                    "precision_floor_m": round(floor, 2), "coord_dp": f"{dp_a}/{dp_b}",
                    "n_missed": n_missed,
                    "range_delta_m": None if range_delta is None else round(range_delta, 1),
                    "last_reported_changed": int(bool(lr_changed)), "evidence": ev,
                })
    return trips


def bikes_and_chains(snaps):
    bikes: dict = {}
    open_dropouts = 0
    sessions_total = 0
    if len(snaps) < 2:
        return bikes, [], 0, 0, (0, 0, 0, [])
    epochs = detect_epochs(snaps)
    for (e0, e1) in epochs:
        esnaps = snaps[e0:e1 + 1]
        timeline = defaultdict(list)
        for i, s in enumerate(esnaps):
            for vid, b in s["bikes"].items():
                timeline[vid].append((i, b))
        for vid, obs in timeline.items():
            r = bikes.get(vid)
            if r is None:
                r = bikes[vid] = {"id": vid, "vt": (obs[0][1].get("vehicle_type") or ""),
                                  "f": None, "l": None, "n": 0, "s": 0, "t": 0, "o": False,
                                  "sess": [], "la": None, "lo": None, "nx": None, "pv": None}
            runs, cur = [], [obs[0]]
            for prev, nxt in zip(obs, obs[1:]):
                if nxt[0] == prev[0] + 1:
                    cur.append(nxt)
                else:
                    runs.append(cur)
                    cur = [nxt]
            runs.append(cur)
            for run in runs:
                r["sess"].append([int(esnaps[run[0][0]]["ts"].timestamp()),
                                  int(esnaps[run[-1][0]]["ts"].timestamp()), len(run)])
                r["s"] += 1
                sessions_total += 1
            r["n"] += len(obs)
            t_first, t_last = esnaps[obs[0][0]]["ts"], esnaps[obs[-1][0]]["ts"]
            if r["f"] is None or t_first < r["f"]:
                r["f"] = t_first
            if r["l"] is None or t_last > r["l"]:
                r["l"] = t_last
            r["la"], r["lo"] = fl(obs[-1][1].get("lat")), fl(obs[-1][1].get("lon"))
            if not r["vt"]:
                r["vt"] = obs[0][1].get("vehicle_type") or ""
            r["t"] += len(runs) - 1
            if runs[-1][-1][0] < len(esnaps) - 1:
                r["o"] = True
                open_dropouts += 1

    chains = []
    chain_total = chain_ok = range_match = 0
    ch_dists = []
    for (a0, a1), (b0i, b1i) in zip(epochs, epochs[1:]):
        A, B = snaps[a1]["bikes"], snaps[b0i]["bikes"]
        grid = defaultdict(list)
        for y in B.values():
            grid[(round(fl(y.get("lat")) or 0, 5), round(fl(y.get("lon")) or 0, 5))].append(y)
        for vid, x in A.items():
            chain_total += 1
            k = (round(fl(x.get("lat")) or 0, 5), round(fl(x.get("lon")) or 0, 5))
            cands = list(grid.get(k, []))
            if not cands:
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        cands.extend(grid.get((k[0] + dx * 1e-5, k[1] + dy * 1e-5), []))
            y = None
            for c in cands:
                if c.get("current_range_meters") == x.get("current_range_meters"):
                    y = c
                    break
            if y is None and cands:
                y = min(cands, key=lambda c: hav(x.get("lat"), x.get("lon"), c.get("lat"), c.get("lon")))
            if y is None:
                continue
            d = hav(x.get("lat"), x.get("lon"), y.get("lat"), y.get("lon"))
            if not (d == d and d < 30):
                continue
            chain_ok += 1
            ch_dists.append(d)
            if x.get("current_range_meters") == y.get("current_range_meters"):
                range_match += 1
            if bikes.get(vid) is not None and bikes[vid].get("nx") is None:
                bikes[vid]["nx"] = y.get("bike_id")
            nid = y.get("bike_id")
            if nid in bikes and bikes[nid].get("pv") is None:
                bikes[nid]["pv"] = vid
            if len(chains) < 400:
                chains.append({"old_id": vid, "new_id": nid, "dist_m": round(d, 3),
                               "lat": fl(x.get("lat")), "lon": fl(x.get("lon")),
                               "range_old": fl(x.get("current_range_meters")),
                               "range_new": fl(y.get("current_range_meters")),
                               "range_match": x.get("current_range_meters") == y.get("current_range_meters"),
                               "from_ts": iso(snaps[a1]["ts"]), "to_ts": iso(snaps[b0i]["ts"])})
    for r in bikes.values():
        r["f"] = iso(r["f"]) if r["f"] else None
        r["l"] = iso(r["l"]) if r["l"] else None
    return bikes, chains, open_dropouts, sessions_total, (chain_ok, chain_total, range_match, ch_dists)


def stats_for(trips: list) -> dict:
    dists = [t["trip_len_m"] for t in trips if t.get("trip_len_m") is not None]
    gaps = [t["gap_s"] for t in trips if t.get("gap_s") is not None]
    return {
        "n": len(trips),
        "same_id": sum(1 for t in trips if t.get("linkage") == "same_id"),
        "linkage_rate_pct": 100.0 if trips else None,
        "dist_p50_m": pctl(dists, 50), "dist_p75_m": pctl(dists, 75),
        "dist_p95_m": pctl(dists, 95), "dist_max_m": max(dists) if dists else None,
        "dist_mean_m": (sum(dists) / len(dists)) if dists else None,
        "median_displacement_m": pctl(dists, 50) or 0.0,
        "pct_gt_10m": (100.0 * sum(1 for d in dists if d > 10) / len(dists)) if dists else None,
        "pct_gt_200m": (100.0 * sum(1 for d in dists if d > 200) / len(dists)) if dists else None,
        "gap_p50_s": pctl(gaps, 50), "gap_p95_s": pctl(gaps, 95),
    }


# ============================================================================ POI
def load_pois():
    p = POIDIR / "poi.geojson"
    if not p.exists():
        return [], None
    try:
        gj = json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return [], None
    return gj.get("features", []), gj


def load_bbox():
    try:
        return tuple(json.loads((POIDIR / "bbox.json").read_text())["bbox"])
    except Exception:  # noqa: BLE001
        return (32.0, 34.75, 32.17, 34.9)


def load_fetch_date():
    try:
        return (POIDIR / "fetch_date.txt").read_text().strip()
    except Exception:  # noqa: BLE001
        return None


class Grid:
    CELL = 0.002

    def __init__(self, pois):
        self.pois = pois
        self.g = {}
        for i, p in enumerate(pois):
            self.g.setdefault(self._k(p["lat"], p["lon"]), []).append(i)

    def _k(self, lat, lon):
        return (int(math.floor(lat / self.CELL)), int(math.floor(lon / self.CELL)))

    def near(self, lat, lon, radius_m):
        ci, cj = self._k(lat, lon)
        out = []
        for di in (0, -1, 1):
            for dj in (0, -1, 1):
                for i in self.g.get((ci + di, cj + dj), []):
                    p = self.pois[i]
                    d = hav(lat, lon, p["lat"], p["lon"])
                    if d <= radius_m:
                        out.append((d, p))
        out.sort(key=lambda x: x[0])
        return out


def venue_list(grid, lat, lon, maxn=3):
    if lat is None or lon is None:
        return []
    return [{"n": p.get("name") or "", "c": p.get("category") or "", "g": p.get("group") or "",
             "d": round(d, 1), "lat": p["lat"], "lon": p["lon"]}
            for d, p in grid.near(lat, lon, TIERS[-1])[:maxn]]


def _ascii_ok(s: str) -> bool:
    """True when s is non-empty and every char is printable ASCII (fits the 5x7 font)."""
    return bool(s) and all(32 <= ord(c) < 127 for c in s)


def venue_label(v) -> str:
    """ASCII-safe label for a POI marker.

    The vendored poi.geojson carries only `name` (often Hebrew), `category`
    ("amenity=restaurant", ...) and `group`; there is no name:en / int_name /
    brand key, so we prefer an already-ASCII `name`, else the ASCII category
    value, else return "" (the caller keeps the yellow dot but omits the label).
    """
    name = (v.get("n") or "").strip()
    if _ascii_ok(name):
        return name
    cat = (v.get("c") or "").strip()
    if cat:
        val = cat.split("=", 1)[-1].replace("_", " ").strip()
        if _ascii_ok(val):
            return val
    return ""


def _tier(vl):
    if not vl:
        return None
    d = vl[0]["d"]
    for t in TIERS:
        if d <= t:
            return t
    return None


def attach_venues(trips, pois):
    if not pois:
        return
    grid = Grid(pois)
    for t in trips:
        t["o_ven"] = venue_list(grid, t.get("origin_lat"), t.get("origin_lon"))
        t["d_ven"] = venue_list(grid, t.get("dest_lat"), t.get("dest_lon"))
        t["o_tier"] = _tier(t["o_ven"])
        t["d_tier"] = _tier(t["d_ven"])


def endpoint_stats(trips, pois, bbox, n_control=20000, seed=7):
    import random as _random
    starts = [(t.get("origin_lat"), t.get("origin_lon")) for t in trips]
    stops = [(t.get("dest_lat"), t.get("dest_lon")) for t in trips]
    ends = [e for e in (starts + stops) if e[0] is not None and e[1] is not None]
    grid = Grid(pois) if pois else None

    def coverage(points):
        if not grid or not points:
            return {str(t): None for t in TIERS}, 0
        n30 = n50 = n100 = 0
        for lat, lon in points:
            cand = grid.near(lat, lon, TIERS[-1])
            if not cand:
                continue
            d = cand[0][0]
            if d <= 30:
                n30 += 1
            if d <= 50:
                n50 += 1
            if d <= 100:
                n100 += 1
        n = len(points)
        return {"30": 100.0 * n30 / n, "50": 100.0 * n50 / n, "100": 100.0 * n100 / n}, n

    out = {}
    for label, pts in (("start", starts), ("stop", stops), ("combined", ends)):
        cov, n = coverage([p for p in pts if p[0] is not None and p[1] is not None])
        out[label] = {"n": n, "pct_within": cov}
    s, w, n_, e = bbox
    rnd = _random.Random(seed)
    ctrl = [(rnd.uniform(s, n_), rnd.uniform(w, e)) for _ in range(n_control)]
    ccov, cn = coverage(ctrl)
    out["control"] = {"n": cn, "pct_within": ccov,
                      "method": "uniform random points over the same percentile-trimmed TLV bbox; "
                                "same 30/50/100 m tiers and same nearest-POI counting"}
    enf = {}
    for t in TIERS:
        o = out["combined"]["pct_within"].get(str(t))
        c = ccov.get(str(t))
        enf[str(t)] = (o / c) if (o is not None and c) else None
    out["enrichment_x"] = enf
    cat = Counter()
    for t in trips:
        for key in ("o_ven", "d_ven"):
            vl = t.get(key) or []
            if vl and vl[0]["d"] <= 30 and vl[0]["c"]:
                cat[vl[0]["c"]] += 1
    out["category_top"] = cat.most_common(15)
    venue = {}
    for t in trips:
        seen = set()
        for key in ("o_ven", "d_ven"):
            vl = t.get(key) or []
            if vl and vl[0]["d"] <= 30:
                v = vl[0]
                vid = (v["lat"], v["lon"], v["n"])
                if vid in seen:
                    continue
                seen.add(vid)
                k = f'{v["n"] or "(unnamed)"} [{v["c"]}]'
                rec = venue.setdefault(k, {"name": v["n"] or "", "category": v["c"],
                                           "group": v["g"], "lat": v["lat"], "lon": v["lon"],
                                           "endpoints": 0, "starts": 0, "stops": 0})
                rec["endpoints"] += 1
                rec["starts" if key == "o_ven" else "stops"] += 1
    out["venues_top"] = sorted(venue.values(), key=lambda r: -r["endpoints"])[:50]
    out["n_pois"] = len(pois)
    return out


def bike_directory(bikes, trips, pois):
    grid = Grid(pois) if pois else None
    by_bike = {}
    for t in trips:
        b = t["bike_id"]
        r = by_bike.setdefault(b, {"bike_id": b, "trips": 0, "confirmed": 0, "venues": set(),
                                   "first": t["dropout_ts"], "last": t["reappear_ts"], "km": 0.0})
        r["trips"] += 1
        if t["class"] == "ride_confirmed":
            r["confirmed"] += 1
        r["km"] += (t.get("trip_len_m") or 0) / 1000.0
        if t["dropout_ts"] < r["first"]:
            r["first"] = t["dropout_ts"]
        if t["reappear_ts"] > r["last"]:
            r["last"] = t["reappear_ts"]
        if grid:
            for lat, lon in ((t.get("origin_lat"), t.get("origin_lon")),
                             (t.get("dest_lat"), t.get("dest_lon"))):
                if lat is None:
                    continue
                cand = grid.near(lat, lon, 50)
                if cand:
                    p = cand[0][1]
                    r["venues"].add((p.get("name") or "", p.get("category") or ""))
    out = []
    for b, r in by_bike.items():
        bk = bikes.get(b) or {}
        sess = bk.get("sess") or []
        active_h = sum((s[1] - s[0]) for s in sess) / 3600.0
        out.append({"bike_id": b, "trips": r["trips"], "confirmed": r["confirmed"],
                    "venues": len(r["venues"]), "km": round(r["km"], 2),
                    "active_h": round(active_h, 2), "obs": bk.get("n") or 0,
                    "sessions": bk.get("s") or 0,
                    "first": bk.get("f") or r["first"], "last": bk.get("l") or r["last"],
                    "open": bool(bk.get("o"))})
    out.sort(key=lambda x: (-x["confirmed"], -x["venues"], -x["km"]))
    return out


def flagship_bikes(directory, trips, n=3):
    by_bike = defaultdict(list)
    for t in trips:
        by_bike[t["bike_id"]].append(t)
    cand = []
    for row in directory:
        b = row["bike_id"]
        conf = [t for t in by_bike.get(b, []) if t["class"] == "ride_confirmed"]
        if not conf:
            continue
        times = sorted(t["dropout_ts"] for t in conf)
        try:
            span_h = (datetime.fromisoformat(times[-1]) - datetime.fromisoformat(times[0])).total_seconds() / 3600.0
        except Exception:  # noqa: BLE001
            span_h = 0.0
        score = (len(conf) * 3.0 + row.get("venues", 0) * 1.5 + row.get("km", 0.0)
                 + span_h * 2.0 + min(row.get("sessions", 0), 5) * 0.5)
        cand.append((score, len(conf), row.get("venues", 0), b))
    cand.sort(key=lambda x: (-x[1], -x[0]))
    return [c[3] for c in cand[:n]]


# ===================================================================== assemble
def sync_templates() -> int:
    n = 0
    for src in sorted(TEMPLATES.rglob("*")):
        if src.is_file():
            dst = SITE / src.relative_to(TEMPLATES)
            if copy_if_changed(src, dst):
                n += 1
    # cache-busting: append the content hash to asset/vendor URLs so a redeploy
    # is picked up by browsers instead of serving a stale cached app.js.
    refs = ("assets/style.css", "assets/app.js", "assets/gbfs-algo.js",
            "vendor/leaflet.js", "vendor/leaflet.css")
    for page in ("index.html", "bike.html", "chains.html"):
        hp = SITE / page
        if not hp.exists():
            continue
        txt = hp.read_text()
        for ref in refs:
            ap = SITE / ref
            if not ap.exists():
                continue
            v = hashlib.sha256(ap.read_bytes()).hexdigest()[:8]
            txt = re.sub(r'((?:href|src)=")' + re.escape(ref) + r'(")',
                         lambda m, r=ref, vv=v: m.group(1) + r + "?v=" + vv + m.group(2), txt)
        if write_bytes_if_changed(hp, txt.encode()):
            n += 1
    return n


def sync_snapshots() -> int:
    """Mirror raw snapshots next to the site + write a manifest for the browser."""
    n = 0
    files = []
    d = SNAP / MARKET / FEED
    if d.exists():
        for p in sorted(d.glob("*.json")) + sorted(d.glob("*.json.gz")):
            rel = f"snapshots/{MARKET}/{FEED}/{p.name}"
            if copy_if_changed(p, SITE / rel):
                n += 1
            files.append(rel)
    manifest = {
        "market": MARKET, "feed": FEED, "count": len(files),
        "generated_utc": iso(datetime.now(timezone.utc)),
        "note": "Raw gzipped GBFS snapshots. The browser OFFLINE mode fetches these "
                "from a manifest (python3 -m http.server) or you can drag-drop your own folder.",
        "files": files,
    }
    write_json(SITE / "snapshots" / "manifest.json", manifest)
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the Tel Aviv GBFS static dossier (stdlib only)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    global log
    if args.quiet:
        log = lambda msg: None  # noqa: E731

    for d in (SDATA / "trips", SDATA / "bikes", SDATA / "chains", SDATA / "poi", SITE / "assets"):
        d.mkdir(parents=True, exist_ok=True)

    snaps = load_snaps()
    trips = trips_for_market(snaps)
    bikes, chains, open_d, sessions, chinfo = bikes_and_chains(snaps)
    chain_ok, chain_total, rmatch, chd = chinfo
    pois, _gj = load_pois()
    bbox = load_bbox()
    fetch_date = load_fetch_date()
    log(f"snapshots={len(snaps)} bikes={len(bikes)} trips={len(trips)} pois={len(pois)}")

    conf = [t for t in trips if t["class"] == "ride_confirmed"]
    prob = [t for t in trips if t["class"] == "ride_probable"]
    cs = stats_for(conf)

    poi_corr = None
    directory = []
    favs = []
    if pois and trips:
        attach_venues(trips, pois)
        poi_corr = endpoint_stats(trips, pois, bbox)
        poi_corr["fetch_date"] = fetch_date
        write_json(SDATA / "poi" / "tlv_correlation.json", poi_corr)
        directory = bike_directory(bikes, trips, pois)
        favs = flagship_bikes(directory, trips, 3)
        write_json(SDATA / "poi" / "tlv_pois.json",
                   {"market": MARKET, "total_pois": len(pois),
                    "venues": poi_corr.get("venues_top", []),
                    "category_top": poi_corr.get("category_top", []),
                    "attribution": "(C) OpenStreetMap contributors (ODbL)"})

    raw_stats = stats_for(trips)
    payload = {
        "market": MARKET, "stats": cs, "raw": raw_stats, "probable_stats": stats_for(prob),
        "classes": dict(Counter(t["class"] for t in trips)),
        "bikes": {"unique": len(bikes), "sessions": sessions},
        "chains": {"n": chain_ok, "candidates": chain_total,
                   "rate_pct": (100.0 * chain_ok / chain_total) if chain_total else None,
                   "dist_p50_m": pctl(chd, 50) if chd else None,
                   "range_match_pct": (100.0 * rmatch / chain_ok) if chain_ok else None},
        "poi": poi_corr,
        "bike_directory": {"count": len(directory), "flagship": favs},
        "window": {"start": iso(snaps[0]["ts"]) if snaps else None,
                   "end": iso(snaps[-1]["ts"]) if snaps else None,
                   "hours": ((snaps[-1]["ts"] - snaps[0]["ts"]).total_seconds() / 3600.0) if snaps else 0.0},
        "n_snapshots": len(snaps),
    }
    if snaps:
        raw_n = raw_stats["n"] or 1
        payload["before_after"] = {
            "raw_n": raw_stats["n"], "confirmed_n": cs["n"],
            "excluded_n": raw_stats["n"] - cs["n"],
            "raw_p50_m": raw_stats["dist_p50_m"], "confirmed_p50_m": cs["dist_p50_m"],
            "raw_p95_m": raw_stats["dist_p95_m"], "confirmed_p95_m": cs["dist_p95_m"],
            "raw_pct_gt_10m": raw_stats["pct_gt_10m"], "confirmed_pct_gt_10m": cs["pct_gt_10m"],
            "tightening_pct": 100.0 * (raw_stats["n"] - cs["n"]) / raw_n,
        }
    write_json(SDATA / "tlv.json", payload)
    write_json(SDATA / "trips" / f"{MARKET}.json", {"market": MARKET, "trips": trips})
    write_json(SDATA / "bikes" / f"{MARKET}.json",
               {"market": MARKET, "count": len(bikes), "bikes": bikes})
    write_json(SDATA / "chains" / f"{MARKET}.json", {
        "market": MARKET, "total": chain_ok, "candidates": chain_total,
        "dist_p50_m": pctl(chd, 50) if chd else None,
        "range_match_pct": (100.0 * rmatch / chain_ok) if chain_ok else None,
        "sample": chains})
    write_json(SDATA / f"bike_directory_{MARKET}.json",
               {"market": MARKET, "count": len(directory), "flagship": favs, "bikes": directory})

    summary = {
        "generated_utc": iso(datetime.now(timezone.utc)),
        "source": "data.lime.bike public GBFS free_bike_status",
        "headline_basis": "ride_confirmed tier only",
        "scope": "tel_aviv only",
        "window": payload["window"],
        "markets": {"total_catalog": 1, "with_data": 1 if snaps else 0,
                    "with_trips": 1 if conf else 0},
        "bikes": {"unique": len(bikes), "sessions": sessions},
        "trips": cs, "trips_raw": raw_stats,
        "class_counts": dict(Counter(t["class"] for t in trips)),
        "open_dropouts": open_d,
        "chains": {"n": chain_ok, "candidates": chain_total,
                   "rate_pct": (100.0 * chain_ok / chain_total) if chain_total else None,
                   "dist_p50_m": pctl(chd, 50) if chd else None},
        "snapshots": {"files": len(snaps)},
        "build_seconds": round(time.time() - t0, 2),
    }
    write_json(SDATA / "summary.json", summary)

    # tiles manifest (input -> site), TLV only
    tm = dict(tile_meta())
    if MARKET in tm:
        tm = {MARKET: tm[MARKET], "_meta": tm.get("_meta", {})}
    write_json(SDATA / "tiles.json", tm)
    if (POIDIR / "poi.geojson").exists():
        copy_if_changed(POIDIR / "poi.geojson", SDATA / "poi" / "poi.geojson")

    # browser CSV export (same columns as the Python classifier)
    try:
        import csv as _csv
        from io import StringIO
        cols = ["market", "bike_id", "linkage", "dropout_ts", "reappear_ts", "gap_s",
                "origin_lat", "origin_lon", "dest_lat", "dest_lon", "trip_len_m",
                "vehicle_type", "range_before", "range_after", "last_reported_before",
                "last_reported_after", "epoch", "class", "confidence", "precision_floor_m",
                "coord_dp", "n_missed", "range_delta_m", "last_reported_changed", "evidence",
                "o_tier", "d_tier"]
        buf = StringIO()
        wtr = _csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        wtr.writeheader()
        wtr.writerows(trips)
        write_bytes_if_changed(SDATA / "trips_classified.csv", buf.getvalue().encode())
    except Exception as e:  # noqa: BLE001
        log(f"CSV_FAIL {type(e).__name__}: {e}")

    changed = sync_templates()
    changed += sync_snapshots()
    log(f"templates/snapshots synced (changed={changed})")

    # headline PNG over the vendored basemap
    try:
        if trips:
            render_map_png(SITE / "trips-map.png", trips, cs, raw_stats)
            log("trips-map.png ok")
    except Exception as e:  # noqa: BLE001
        log(f"MAP_PNG_FAIL {type(e).__name__}: {e}")

    # per-bike flagship exhibits
    rows = {r["bike_id"]: r for r in directory}
    for b in favs[:3]:
        try:
            ok = render_bike_png(SITE / f"bike-{b[:8]}.png", b, trips, pois, rows.get(b, {}))
            log(f"flagship {b[:8]} png={'ok' if ok else 'skip'}")
        except Exception as e:  # noqa: BLE001
            log(f"BIKE_PNG_FAIL {b[:8]} {type(e).__name__}: {e}")

    log(f"BUILD done {summary['build_seconds']}s snaps={len(snaps)} bikes={len(bikes)} "
        f"trips={len(trips)} confirmed={len(conf)} chains={chain_ok}/{chain_total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
