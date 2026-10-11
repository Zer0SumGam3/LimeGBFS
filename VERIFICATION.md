# VERIFICATION — Tel Aviv GBFS package

Everything below was executed against this package on **2026-10-10 (UTC)** inside the
build container, using only the shipped files.

Summary: **all checks pass.** The package rebuilds from scratch with the Python
stdlib, serves correctly from `python3 -m http.server`, renders both PNGs and both
page types, and the in-browser pipeline reproduces the Python output **byte-for-byte**.
The one substantive runtime finding is the **CORS block on the live feed**, recorded
in §6.

---

## 1. Clean-room rebuild (stdlib only, from an empty site tree)

```bash
CR=/workspace/tmp/cleanroom
rm -rf "$CR"; mkdir -p "$CR"
cp -a /workspace/lime/package-tlv/. "$CR"/
cd "$CR"
rm -rf site/data site/snapshots site/assets site/index.html site/bike.html site/chains.html site/*.png
python3 -I build.py          # python3 -I = isolated: no cwd/site-packages influence
```

Observed (10.5 s wall):

```
snapshots=150 bikes=30700 trips=162 pois=4406
templates/snapshots synced (changed=159)
trips-map.png ok
flagship 8058d656 png=ok / d2230e41 png=ok / 7134e888 png=ok
BUILD done 5.33s snaps=150 bikes=30700 trips=162 confirmed=120 chains=23895/24778
```

Everything under `site/` except `site/tiles/` and `site/vendor/` was deleted first
and fully regenerated: `index.html`, `bike.html`, `chains.html`, `assets/**`,
`data/**`, `snapshots/**` + `manifest.json`, `trips-map.png`, `bike-*.png`.
Regenerated sizes: `site/data` 10.8 MB, `site/snapshots` 25.2 MB.

`python3 -I build.py` proving stdlib-only: no `numpy`, no `PIL`, no third-party
imports anywhere in `build.py` or `poller.py`.

## 2. Rebuild is deterministic

PNGs produced by the clean-room build are byte-identical to the build shipped in
`site/`:

```
9e6d3f2fa14ecdc43ca029c062c35bd9f430c7ee6659caa2728e1a6b87a71018  cleanroom/site/trips-map.png
9e6d3f2fa14ecdc43ca029c062c35bd9f430c7ee6659caa2728e1a6b87a71018  package-tlv/site/trips-map.png
a8a2a377ace61aa6eb3a47575df45c85af54079eef93bae90fd120208866bff0  cleanroom/site/bike-8058d656.png
a8a2a377ace61aa6eb3a47575df45c85af54079eef93bae90fd120208866bff0  package-tlv/site/bike-8058d656.png
```

## 3. Browser JS pipeline ≡ Python pipeline

`site/assets/gbfs-algo.js` (the module the page actually runs) was executed in node
over the **same 150 bundled snapshots** and compared with the JSON that `build.py`
wrote:

```
snapshots       150
trips js/built  162 162 IDENTICAL          <- whole array, JSON-equal
tlv.n_snaps     150  bikes 30700/30700  sessions 30862/30862
chains js/built 23895 23895   range-match 99.26% / 99.26%   sample: IDENTICAL (400)
directory js/built 162 162 IDENTICAL
tlv.stats equal YES        classes equal YES
```

Compensated/rounding semantics were reproduced deliberately so nothing drifts:
CPython `round(x, n)` (half-to-even) and CPython 3.12's Neumaier float `sum()`.
POI correlation also matched exactly (`n_pois 4406`; start/stop/combined tier
coverage equal to full float precision; `category_top`, `venues_top`,
`bike_directory`, `flagship` identical). The uniform *control* sample uses a seeded
JS PRNG instead of Python's Mersenne Twister (synthetic set — method and tiers are
identical; see README §8).

## 4. Local serve assertions — `python3 -m http.server`, document root `site/`

```
/                                           200  7844B
/index.html                                 200  7844B
/bike.html?b=8058d656-...-07e961722a5e      200  3367B
/chains.html                                200  1455B
/trips-map.png                              200  3347538B
/bike-8058d656.png                          200  1355088B
/data/tlv.json                              200  10421B
/data/trips/tel_aviv.json                   200  188346B
/data/bikes/tel_aviv.json                   200  10148493B
/data/chains/tel_aviv.json                  200  110344B
/data/bike_directory_tel_aviv.json          200  35335B
/data/poi/poi.geojson                       200  690560B
/data/tiles.json                            200  568B
/assets/app.js                              200  40488B
/assets/gbfs-algo.js                        200  26915B
/assets/style.css                           200  5757B
/vendor/leaflet.js                          200  147552B
/vendor/leaflet.css                         200  14806B
/snapshots/manifest.json                    200  9969B
/tiles/tel_aviv/10/611/415.png              200  42980B
```

`index.html` resolves only relative references:
`assets/style.css?v=…`, `assets/app.js?v=…`, `assets/gbfs-algo.js?v=…`,
`vendor/leaflet.css?v=…`, `vendor/leaflet.js?v=…`, `chains.html`, `index.html`,
`trips-map.png` (content-hash query strings are added by `build.py` so redeploys
are not served from browser cache).

Both PNGs were visually inspected after the rebuild and render correctly:
`trips-map.png` = confirmed trips over the vendored Tel Aviv basemap with burned-in
OSM attribution; `bike-8058d656.png` = one bike's labeled trail.

## 5. External-reference audit

* No `/workspace`, `file:///`, `127.0.0.1` or `localhost` string appears in any
  `site/` HTML/JS/CSS/JSON/CSV file. **All site paths are relative.**
* External URL strings in `site/`:

  | string | where | runtime request? |
  |---|---|---|
  | `data.lime.bike/api/partners/v2/gbfs/tel_aviv/free_bike_status` | `assets/app.js` (`LIVE_URL`) | only in **LIVE** mode (opt-in button); never in OFFLINE |
  | `leafletjs.com`, `w3.org/2000/svg`, `bugzilla.mozilla.org/…`, `bugs.chromium.org/…` | vendored `vendor/leaflet.js` / attribution markup | **no** — namespace/attribution/comment strings, not fetched |
  | `© OpenStreetMap contributors` baked into PNGs and attribution labels | PNGs + Leaflet attribution | no |

* `fetch()` call sites in our code: 3 take **relative** URLs
  (`jget(u)` for `data/**` and `snapshots/manifest.json`; `files[i]` from the
  manifest), 2 take `LIVE_URL` (`pollLive`, `probeCors`). **OFFLINE mode performs
  zero external network requests**; the site makes zero runtime tile requests.

## 6. CORS finding (live feed) — measured, page context

Order of testing: response headers first, then a real browser page context.

**(a) Response headers** (device network), `GET` with `Origin: https://example.com`:

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
vary: Accept, Accept-Encoding, Origin
x-frame-options: SAMEORIGIN
Cache-Control: no-cache, no-store
... (no Access-Control-* header at all)
```

`OPTIONS` preflight (`Origin` + `Access-Control-Request-Method: GET`) → `200`,
`Content-Length: 0`, and again **no `Access-Control-Allow-Origin`** and no
`Access-Control-Allow-Methods`. Repeated with `Origin: https://evil.example` and
`Origin: null`: same — no ACAO for any origin.
Raw capture: `evidence/CORS-headers-raw.txt`.

**(b) Page context (real browser)** — a page served at `http://127.0.0.1:8898/`
ran `fetch(LIVE_URL, {cache:'no-store', mode:'cors'})`; observed:

```
CORS BLOCKED
TypeError: Failed to fetch
```

`evidence/CORS-page-context.txt`.

**Conclusion:** the feed sends no `Access-Control-Allow-Origin`, so a page-context
read is rejected by the browser and **LIVE mode cannot read the feed from a web
page**. Per the brief this is documented in the README and **OFFLINE/LOCAL is the
lead mode**; the local `poller.py` (which is not subject to browser CORS) is the
live-data path, and the site's “test live feed (CORS)” button re-checks the
condition at runtime.

*(Environment note: the build container had no outbound DNS at verification time,
so header capture and the browser test were done over the shared Android device's
network — which reaches the feed normally.)*

## 7. Both runtime modes exercised locally (real browser)

Everything below was exercised in a real mobile browser (Chrome) against
`python3 -m http.server` serving `site/` over `adb reverse`.

**OFFLINE/LOCAL (lead mode)** — `index.html` auto-loaded `snapshots/manifest.json`,
fetched and gunzipped all 150 snapshots client-side, ran the algorithms, and
displayed:

```
computed in-browser from 150 snapshot(s)
120 CONFIRMED TRIPS · 162 raw pairs · 25.9% judder removed · 808 m median (raw 565 m)
1,766 m P95 · 23,895 cross-epoch id links
```

Those are exactly the Python-built values in `site/data/tlv.json`.

**Overlay layer + tiers** — `Tel Aviv trip map [162 pairs]` with the toggle row
`layers: starts | stops | connectors | per-bike trail | POI businesses` and
`tiers: confirmed (solid) | probable (dotted) | judder (hidden)`. Confirmed:
toggling **judder** on added the dashed judder connectors live; starts render blue,
stops orange, over the vendored basemap (Leaflet attribution visible).

**Per-bike trail view** — `bike.html?m=tel_aviv&b=8058d656-…`: 25 observations,
2 sessions, 1 confirmed trip, a map zoomed to that single trip (blue start → orange
stop over the local tiles), the chronological timeline, sessions table, per-bike
trip table, raw record (`vehicle_type scooter`, next-id-after-rotation link) and CSV
export. *(A bug found here — the bike map initially rendered all trips because the
map container was initialised twice — was fixed; `makeMap()` is now idempotent and
the bike page restricts the overlay to that bike's trips.)*

**LIVE** — the mode toggle and “start live” are present; the “test live feed (CORS)”
button reports the block described in §6.

**IndexedDB persistence** — the write path runs on every ingest and the restore
path is proven: on a mid-load page the tile row showed `72 confirmed / 101 raw
pairs`, a **partial** figure that can only come from `loadFromIdb()` reading a
previously written store, before the `./snapshots/` load completed and recomputed
to `120 / 162`. “load IndexedDB” / “clear IndexedDB” buttons are wired to the
`idbAll()` / `idbClear()` paths. **Export**: “export trips CSV” produces the
classifier columns
(`market,bike_id,linkage,dropout_ts,reappear_ts,gap_s,…,evidence,o_tier,d_tier`),
“export trips JSON” and “export snapshots JSON” (base64) / “import snapshots JSON”
are present.

## 7b. `poller.py` — run end-to-end against a local stand-in feed

The build container has no outbound DNS, so the poller was pointed at a local
`python3 -m http.server` serving **one real TLV snapshot** as the feed payload.

```bash
LIME_ROOT=… python3 -I poller.py --once --url http://127.0.0.1:8902/free_bike_status --interval 5
```

```
interval 5.0s raised to the polite minimum 15.0s          <- >=15 s enforced
START pid=… market=tel_aviv feed=free_bike_status interval=15.0s out=…/data/snapshots/tel_aviv/free_bike_status
CYCLE 23:25:58Z http=200 bytes=1101907 bikes=4886 latency=0.019s -> 20261010T232558.090Z.json.gz
```

Artifacts produced: `data/snapshots/tel_aviv/free_bike_status/<stamp>.json.gz`
(gunzips to valid GBFS `version 2.2`, 4886 bikes), `data/poller.log`,
`data/snapshot-index.tsv` (one row per cycle), `data/poller.pid`.

* **one log line per cycle** — confirmed.
* **crash-resilient loop** — against an unreachable feed (`Connection refused`) the
  loop logged `FETCH_ERR … URLError` then `CYCLE … http=0 (not written)` and kept
  going through further cycles instead of dying.
* **graceful stop** — `SIGTERM` → `SIGNAL 15 -- stopping after current cycle`,
  then `STOP pid=… cycles=1`, process gone in **0.24 s** and the pidfile removed.
  *(Found and fixed during verification: the original `time.sleep()` restarted
  across the signal, so shutdown took up to a full interval; the sleep is now
  interruptible.)*

## 7c. `refresh.sh`

```bash
./refresh.sh --no-poller      # rc=0, "build ok" in data/refresh.log
GBFS_FEED_URL=http://127.0.0.1:8902/free_bike_status ./refresh.sh
                              # rc=0: starts the poller, then rebuilds
```

Verified: the poller is started with `nohup setsid`, its pidfile appears,
`data/refresh.log` records `build start` / `build ok`, and a second run
`--no-poller` does not touch it. *(Fixed during verification: `refresh.sh` had
redirected the poller's stdout/stderr into `data/poller.log`, which poller.py also
writes itself — every line was duplicated. The redirection now goes to
`data/poller.stderr.log`.)* `refresh.sh`, `poller.py` and `build.py` ship mode 755.

## 7d. Zip integrity and end-to-end from the extracted archive

```
zip: 1567 entries, 88,143,909 bytes
python zipfile extract -> package-tlv/
sha256sum -c MANIFEST.sha256 -> 1566 OK, 0 failed
```

The extracted tree was then rebuilt from scratch (`rm -rf site/{data,snapshots,assets} site/*.html site/*.png`,
`python3 -I build.py`) and re-checked: `snapshots 150`, `trips js/built 162 162
IDENTICAL`, `directory … IDENTICAL`, `chains 23895/23895`, and
`/`, `/index.html`, `/bike.html?b=…`, `/chains.html`, `/trips-map.png`,
`/data/tlv.json` all HTTP 200.

## 8. Not verified / caveats

* **`poller.py` was not run against the *live* feed** (no outbound DNS in the build
  container). It was fully exercised against a local stand-in serving a real
  snapshot (§7b), including interval clamping, gzip write, logging, crash
  resilience and signal handling. The feed itself was reached from the device
  (HTTP 200, GBFS `version: 2.2`, 5008 bikes). A one-shot confirmation from a
  networked host is `python3 poller.py --once`.
* **LIVE mode cannot work from a web page** — that is a measured property of the
  feed (no `Access-Control-Allow-Origin`), not a defect of this package.
* The synthetic **uniform control** sample in the POI correlation differs between
  the Python and JS paths (different PRNG); real-endpoint coverage is identical.
* In-browser recomputation requires `DecompressionStream('gzip')` + IndexedDB
  (modern browsers). Older browsers still render the prebuilt data.
* `site/snapshots/` ships a **150-snapshot sample** (~28 min); the numbers in
  `site/data/**` are computed from exactly that sample, so the prebuilt and the
  in-browser results agree by construction.
* Device-side scrolling/tap verification was done by screenshot; there is no
  headless browser in this container, so DOM assertions are the HTTP/serve checks
  in §4 plus the node parity run in §3.

---

## 9. Polish pass (2026-10-11)

Operator review of the shipped renders found three defects in the PNG output and
three polish items in the site. All were fixed in place; **the data is unchanged**
(no snapshot/algorithm change).

### PNG render fixes (`build.py`)

1. **Pixel-font gaps.** `FONT` had no glyph for `'` (apostrophe), so
   `ONE BIKE'S DAY …` rendered `ONE BIKE?S DAY`; `&` and other printable ASCII
   were also missing. Added the 13 missing printable-ASCII glyphs
   (`" $ & ' ; [ \ ] ^ \` { | }`); the font now covers **all 95 printable ASCII**
   code points (`Canvas.text` upper-cases its input first). Verified by replaying
   both renders with `Canvas.text` instrumented: 33 text calls / 23 distinct
   strings, **0 characters fall through to `FONT["?"]`**, 0 non-ASCII characters
   reach `canvas.text` (`tmp/results/package-polish-20261010/drawn_strings.json`).
2. **`render_map_png` bottom-bar collision.** The OSM attribution was drawn at a
   fixed `x=220`, on top of the `STOP / LOCK` legend at `x=222`. It is now
   right-aligned at `w - text_w(attr,1) - 14`; START/STOP stay on the left. At the
   shipped 2048-px width the attribution starts at x≈1609, clear of the legend
   (which ends x≈281). The bike render's bottom legend cursor was audited for the
   same class of bug: its running `cx` + measured-`need` packing fits all four
   items in ≈800 px and the narrowest flagship is 1536 px, so it fits with margin
   (no text shortened).
3. **Hebrew venue labels rendered as `?????`.** `data/poi/poi.geojson` features
   carry only `id, name, category, group, lat, lon` — there is **no**
   `name:en`/`int_name`/`brand` key — and Tel Aviv `name`s are frequently Hebrew
   (2119 / 4406 are non-ASCII). `render_bike_png` now routes every label through
   `venue_label()`: prefer an already-ASCII `name` (e.g. `Molly Bloom's`,
   `Victory`), else the ASCII `category` value (`restaurant`, `cafe`, `atm`,
   `lawyer` …), else omit the label but keep the yellow dot. The label background
   rect is clamped to the image so text never overflows its box or the edge. The
   three flagship PNGs now label only with ASCII; label ink bounding boxes all lie
   inside the image.

### Site polish (`templates/`)

4. **Favicon.** Inline SVG data-URI (blue start dot + orange stop dot) added to
   the `<head>` of all three templates. No external request; the `xmlns` string
   `http://www.w3.org/2000/svg` is an SVG namespace identifier, not a fetch (same
   class as the vendored Leaflet namespace/comment strings).
5. **Mobile tables.** `@media (max-width:820px){ section table{display:block;
   width:100%;overflow-x:auto;…} }` — wide nowrap tables scroll on narrow screens.
   The rule lives only inside the media query, so desktop rendering is unchanged.
6. **Flagship thumbnails.** `renderFlagship` now emits one `<figure>` per flagship
   with a lazy-loaded `<img loading="lazy">` (max-width 560 px, token border/radius)
   linking to the full-size PNG, captioned with the short bike id + confirmed trips
   + km + venues (joined from `bike_directory` `bikes[]`), and keeps the “open
   trail” link.
7. **Copy.** Added a one-sentence explainer to the flagship section.

### Verification of this pass

* **Data drift:** every `site/data/**` JSON is byte-identical to the pre-pass
  build **except** `summary.json`, which differs only in
  `generated_utc`/`build_seconds` (inherent). Numbers unchanged: **120 confirmed /
  162 raw / 100.0 % linkage**, 30700 bikes, 23895/24778 chains, class counts
  120/1/40/1. Rebuild log:
  `snapshots=150 bikes=30700 trips=162 confirmed=120 chains=23895/24778`.
* **No egress:** external http(s) strings in `site/` are only the OSM attribution
  text/URL (PNGs / Leaflet attribution), the favicon SVG namespace, and `LIVE_URL`
  (`data.lime.bike`, opt-in LIVE mode only); no `/workspace`, `file:///`,
  `127.0.0.1` or `localhost` string appears in any site text file.
* **Serve:** `python3 -m http.server` on a scratch port → HTTP 200 for `/`,
  `/index.html`, `/bike.html?b=…`, `/chains.html`, `/trips-map.png`, the three
  `/bike-*.png`, all `data/**` JSON + `poi.geojson`, `assets/*` and
  `snapshots/manifest.json`.
* **JS syntax:** `node --check` clean on `assets/app.js` and `assets/gbfs-algo.js`.
* `MANIFEST.sha256` regenerated (1566 files).

The operator reviews the regenerated PNGs; no label renders a garbage glyph run
after this pass.
