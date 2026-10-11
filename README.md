# Tel Aviv GBFS per-bike trip-linkage dossier — deployable package

A self-contained, **Tel Aviv only** build of the Lime GBFS *vehicle-trip-linkage*
demonstration: a static site plus the poller and builder that produce it.

This is **the Tel Aviv example of the GBFS vehicle-trip-linkage demonstration** —
one market, fully self-contained, deployable to any static host.

Everything is Python 3 **standard library only** on the batch side, and plain
HTML/CSS/JS (no build step, no CDN, no framework) on the site side. The recipient
needs nothing installed but `python3` (and a modern browser for the in-browser mode).

---

## 1. What's in the box

| path | role |
|---|---|
| `poller.py` | Solid, crash-resilient poller for `tel_aviv` `free_bike_status`; gzips raw snapshots; one log line per cycle |
| `build.py` | Standalone stdlib-only builder: reconstructs same-id dropout→reappearance trips, classifies them, chains identities, correlates POIs, renders the map PNGs and the site |
| `refresh.sh` | One command: ensure the poller is running → rebuild → atomically swap changed files |
| `site/` | **Ready-to-deploy** static site (deploy this folder as-is) |
| `data/snapshots/tel_aviv/free_bike_status/` | Raw snapshots (poller output; a sample ships so the site already has data) |
| `data/poi/` | Vendored OSM venues + bbox for Tel Aviv (ODbL) |
| `data/tiles.json` | Vendored basemap manifest |
| `templates/` | HTML/CSS/JS used by `build.py` to (re)generate `site/` |
| `evidence/` | Raw CORS header capture + page-context result (see §4) |
| `VERIFICATION.md` | What was exercised, how, and the results |
| `MANIFEST.sha256` | SHA-256 of every file in this package |

Under `site/`:

| path | role |
|---|---|
| `index.html` | Tel Aviv dossier: runtime-mode console, headline stats, per-bike trails, interactive overlay map, classifier tiers, POI correlation, confirmed trip table |
| `bike.html?b=<bike_id>` | Per-bike labeled trail: street map, start/stop markers, nearest-business labels, timeline, sessions, raw record, CSV export |
| `chains.html` | Cross-epoch identity chains |
| `assets/gbfs-algo.js` | **The algorithms, ported to browser JS** (same output shape as the Python path) |
| `assets/app.js` | UI: overlay layers, LIVE/OFFLINE modes, IndexedDB persistence, CSV/JSON export |
| `assets/style.css` | Styling (light/dark) |
| `vendor/leaflet.{js,css}` | Vendored Leaflet (no CDN) |
| `tiles/tel_aviv/{z}/{x}/{y}.png` | Vendored OSM raster pyramid (z10–z16) |
| `data/**` | Prebuilt TLV JSON: `tlv.json`, `trips/`, `bikes/`, `chains/`, `poi/`, `bike_directory_*`, `trips_classified.csv`, `tiles.json`, `summary.json` |
| `snapshots/**` | Snapshot mirror + `manifest.json` for the browser OFFLINE mode |
| `trips-map.png` | Headline city map (confirmed trips over the vendored basemap) |
| `bike-<id8>.png` | Flagship "one bike's day, labeled with businesses" exhibits |

---

## 2. Requirements

* **python3** (3.8+) — *standard library only*. No pip installs. `poller.py` and
  `build.py` import nothing outside the stdlib.
* A modern browser (Chrome/Edge 114+, Firefox 113+, Safari 16.4+) for the
  in-browser OFFLINE mode (it uses `DecompressionStream('gzip')` and IndexedDB).
  The prebuilt site still renders in any browser that runs Leaflet; only the
  *in-browser recomputation* needs those APIs.
* No build tools, no server-side runtime, no database.

---

## 3. Run it

### 3a. Collect + build

```bash
python3 poller.py              # tel_aviv free_bike_status every 15 s (>=15 s enforced)
# ...let it collect (a few minutes is plenty)...

python3 build.py               # -> regenerates site/** from data/snapshots/**
```

Or let `refresh.sh` do both, and keep refreshing:

```bash
./refresh.sh                   # ensure poller running, rebuild once
./refresh.sh --loop 600        # keep rebuilding every 10 minutes
./refresh.sh --no-poller       # rebuild only (offline / batch)
POLL_INTERVAL=15 ./refresh.sh  # poller cadence
```

### 3b. Look at it locally

```bash
cd site
python3 -m http.server 8000
# open http://localhost:8000/
```

`python3 -m http.server` is enough: `site/snapshots/manifest.json` lets the page
auto-load the bundled snapshots and recompute everything **in the browser**
(OFFLINE mode). You can also drag-and-drop your own `snapshots/` folder onto the
page, or point a browser straight at `site/index.html` as a `file://` page (the
manifest fetch will fail under `file://`, but the prebuilt data still renders and
drag-and-drop still works).

### 3c. Deploy to any static host

Upload **the contents of `site/`** to any static host (S3+CloudFront, Netlify,
GitHub Pages, nginx, Caddy, `python3 -m http.server`, …). All paths are relative;
nothing needs a server-side runtime.

* S3: `aws s3 sync site/ s3://your-bucket/ --delete`
* nginx: `root /var/www/tlv; index index.html;`
* **Recommended**: serve `.json.gz` snapshots with `Content-Encoding: gzip`? No —
  the page decompresses them itself, so serve them as plain files (default).
* Optional cache headers: assets are content-hash versioned
  (`assets/app.js?v=<hash>`), so long `Cache-Control` on `assets/`, `vendor/`,
  `tiles/` is safe; keep `data/` and `snapshots/` short-lived.

### 3d. Keep it fresh (cron / systemd)

cron (every 10 minutes):

```cron
*/10 * * * * cd /opt/tlv && ./refresh.sh --no-poller >> data/refresh.log 2>&1
@reboot      cd /opt/tlv && ./refresh.sh --loop 600 >/dev/null 2>&1 &
```

systemd timer:

```ini
# /etc/systemd/system/tlv-refresh.service
[Service]
Type=oneshot
WorkingDirectory=/opt/tlv
ExecStart=/opt/tlv/refresh.sh --no-poller
```
```ini
# /etc/systemd/system/tlv-refresh.timer
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
```
```bash
sudo systemctl enable --now tlv-refresh.timer
```

Poller as its own unit:

```ini
# /etc/systemd/system/tlv-poller.service
[Service]
WorkingDirectory=/opt/tlv
ExecStart=/usr/bin/python3 /opt/tlv/poller.py --interval 15
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
```

---

## 4. Two runtime modes (the site has no backend)

### OFFLINE / LOCAL — the **lead mode**

Snapshots are loaded entirely client-side and every algorithm runs in the
browser:

1. **`./snapshots/`** — the page fetches `snapshots/manifest.json` and then each
   `.json`/`.json.gz`, decompressing with `DecompressionStream`. This is the
   automatic path when the site is served over HTTP(S).
2. **Drag & drop** — drop a `snapshots/` folder (or files) onto the drop zone.
   Works even from `file://`.
3. **IndexedDB** — anything loaded in a previous session is restored on the next
   visit ("load IndexedDB").

Computed in the browser, with the same output shape as the Python path:
presence/dropout→reappearance pairing, the 5-tier judder classifier
(`ride_confirmed` / `ride_probable` / `reservation_or_state_toggle` /
`feed_flicker` / `relocation_suspect`), cross-epoch identity chaining
(1e-5 grid + exact `current_range_meters`, < 30 m), and POI radius correlation
against the packaged local `poi.geojson` at the 30/50/100 m tiers.

**OFFLINE mode makes zero external network requests.**

### LIVE — implemented, but **CORS-blocked**; use it only where it works

The page can poll `https://data.lime.bike/api/partners/v2/gbfs/tel_aviv/free_bike_status`
directly and accumulate snapshots in IndexedDB across reloads.

> **CORS finding (measured — see `VERIFICATION.md`):** the feed does **not** send
> `Access-Control-Allow-Origin` for any origin (and the `OPTIONS` preflight returns
> no CORS headers). The response only carries `vary: Accept, Accept-Encoding, Origin`.
> A page-context `fetch()` is therefore **rejected** by the browser, so **LIVE mode
> cannot read the feed from a normal web page** and OFFLINE is the lead mode.
> The built-in **“test live feed (CORS)”** button re-checks this at runtime and says
> so explicitly.

When LIVE is blocked, use `poller.py` (the headless fallback): it writes snapshots
into `data/snapshots/`, `build.py` mirrors them into `site/snapshots/`, and the
browser OFFLINE mode consumes them. If you control a proxy, you can also point
`LIVE_URL` (top of `site/assets/app.js`) at a CORS-enabled mirror of the feed.

---

## 5. Interactive map overlay

Over the vendored basemap (Leaflet, no runtime tile requests):

* **layers:** `starts`, `stops`, `connectors`, `per-bike trail`, `POI businesses`
* **tiers:** `confirmed (solid)`, `probable (dotted)`, `judder (hidden by default,
  user-toggleable)`
* per-bike trail view lives in the same overlay system (`bike.html?b=<bike_id>`,
  and clicking a bike id anywhere).

## 6. Persistence & export

* **IndexedDB** keeps every snapshot the browser has seen (live or offline) so a
  session accumulates across reloads. "clear IndexedDB" wipes it.
* **Export snapshots JSON** (base64) / **import snapshots JSON** to move a
  browser-collected session between machines.
* **Export trips CSV / JSON** downloads the computed trips with the exact same
  columns as the Python classifier (`trips_classified.csv`).

---

## 7. Attribution, licence and etiquette

* Basemap raster tiles © **OpenStreetMap contributors**, data under **ODbL 1.0**
  (`https://www.openstreetmap.org/copyright`). The attribution string is burned
  into the PNGs and shown in every Leaflet view. Tiles were fetched once,
  throttled, and are served locally — the site makes **no runtime tile requests**.
* Venue data in `data/poi/poi.geojson` is © OpenStreetMap contributors (ODbL).
* **Leaflet** is vendored under its BSD-2-Clause licence (`vendor/`).
* Feed etiquette: `data.lime.bike` is a **public GBFS feed**. Keep the descriptive
  research User-Agent, poll no faster than **15 s**, and honour the feed's `ttl`.
* Output is **vehicle-level / statistical only** — no person-identifying inference.

The only external URL in the delivered site is the opt-in LIVE feed endpoint in
`assets/app.js`. Offline mode performs no external requests.

---

## 8. Divergences from the reference implementation

`build.py` and `site/assets/gbfs-algo.js` are trimmed ports of the original
multi-market pipeline. Documented differences:

1. **Tel Aviv only.** All other markets, the market selector, `markets.html` and
   `market.html` are removed. `data/summary.json` describes this single market.
2. **No numpy / no PIL.** PNG encode/decode, the bitmap font and all drawing are
   reimplemented on the Python stdlib (`struct`, `zlib`, `bytearray`).
3. **The same algorithms run twice** — Python (`build.py`) for headless batch and
   JS (`assets/gbfs-algo.js`) for the browser. They are verified to produce
   **byte-identical** trips / directory / chains JSON on the bundled snapshot set.
   Two subtle semantics were reproduced on purpose: CPython's round-half-to-even
   (`round(x, n)`) and its compensated float `sum()` (Neumaier), so means and
   rounded fields match to the last bit.
4. **The uniform control sample** in the POI correlation uses a seeded JS PRNG in
   the browser rather than Python's Mersenne Twister: the control is a synthetic
   random set, so only the method and the 30/50/100 m tiers are meaningful, and
   those are identical. Coverage percentages for real endpoints are identical.
5. **Basemap tiles for other markets** are gone; only the Tel Aviv pyramid ships.
6. `refresh.sh` replaces the original container-specific refresh loop; it no
   longer manages the (now absent) multi-market collectors.

## 9. Layout of the shipped snapshot sample

The package ships **150 contiguous Tel Aviv snapshots** (~28 minutes) so the site
works out of the box and the in-browser path can be demonstrated without polling.
Point `poller.py` at the same `data/snapshots/` directory to keep growing the
window; `build.py` mirrors whatever is there into `site/snapshots/` and refreshes
`manifest.json`.
