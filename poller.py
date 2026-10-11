#!/usr/bin/env python3
"""Lime GBFS Tel Aviv poller -- standalone, Python standard library only.

Polls ONE market (tel_aviv) on the public GBFS v2.2 ``free_bike_status`` feed and
writes gzipped raw snapshots so they can be replayed offline by ``build.py``
(headless batch) or by the browser (client-side mode).

    data/snapshots/tel_aviv/free_bike_status/<UTC-timestamp>.json.gz

Design notes
------------
* stdlib only (urllib/gzip/json) -- the recipient needs nothing but python3.
* polite research User-Agent, >=15 s interval enforced (public feed etiquette).
* crash-resilient: every cycle is wrapped; the loop never dies on a network error.
* one log line per cycle on stderr and in ``data/poller.log``.
* Writes atomically (tmp file + os.replace) so the builder never reads a partial file.

The poller never deletes or rewrites existing snapshots; re-running it just adds
new ones, so a long-running session accumulates across restarts.

Run:
    python3 poller.py                  # 15 s cadence, tel_aviv
    python3 poller.py --interval 20    # slower
    python3 poller.py --once           # single snapshot (smoke test)
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MARKET = "tel_aviv"
FEED = "free_bike_status"
BASE = "https://data.lime.bike/api/partners/v2/gbfs"
# Public GBFS v2.2 feed. The bare name is the canonical endpoint; ``.json`` also works.
DEFAULT_URL = f"{BASE}/{MARKET}/{FEED}"
UA = ("WildHunt-GBFS-Research/1.0 (security research; polite poller; "
      "contact via Bugcrowd Lime program)")
MIN_INTERVAL = 15.0

ROOT = Path(os.environ.get("LIME_ROOT") or Path(__file__).resolve().parent)
OUT = ROOT / "data" / "snapshots" / MARKET / FEED
LOG = ROOT / "data" / "poller.log"
INDEX = ROOT / "data" / "snapshot-index.tsv"
PIDFILE = ROOT / "data" / "poller.pid"

_STOP = False


def _on_signal(signum, _frame):  # graceful stop
    global _STOP
    _STOP = True
    log(f"SIGNAL {signum} -- stopping after current cycle")


def _sleep(seconds: float) -> None:
    """Interruptible sleep: a SIGTERM/SIGINT takes effect within ~0.25 s."""
    deadline = time.time() + seconds
    while not _STOP:
        remaining = deadline - time.time()
        if remaining <= 0:
            return
        time.sleep(min(0.25, remaining))


def log(msg: str) -> None:
    line = f"{datetime.now(timezone.utc).isoformat()} {msg}"
    sys.stderr.write(line + "\n")
    sys.stderr.flush()
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def fetch(url: str, timeout: float = 30.0):
    """Return (status, body, latency_s). Never raises."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:  # noqa: BLE001
            body = b""
        return e.code, body, time.time() - t0
    except Exception as e:  # noqa: BLE001  (DNS, TLS, timeout, reset ...)
        log(f"FETCH_ERR {url} {type(e).__name__}: {e}")
        return 0, b"", time.time() - t0


def parse_bikes(body: bytes):
    """Return (n_bikes, last_updated, version) or (None, None, None)."""
    try:
        data = json.loads(body)
    except Exception:  # noqa: BLE001
        return None, None, None
    d = data.get("data") or {}
    bikes = d.get("bikes") or d.get("vehicles") or []
    return len(bikes), str(data.get("last_updated", "")), str(data.get("version", ""))


def snapshot_path(ts: datetime) -> Path:
    stamp = ts.strftime("%Y%m%dT%H%M%S.%f")[:-3] + "Z"
    return OUT / f"{stamp}.json.gz"


def write_snapshot(body: bytes, path: Path) -> None:
    """Atomic gzip write (repo-friendly: fixed mtime=0)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with gzip.GzipFile(filename="", mode="wb", fileobj=open(tmp, "wb"), mtime=0) as g:
        g.write(body)
    os.replace(tmp, path)


def index_row(ts: datetime, status: int, nbytes: int, n_bikes, last_updated, version, rel, lat) -> None:
    new = not INDEX.exists()
    try:
        with INDEX.open("a") as f:
            if new:
                f.write("ts_utc\tmarket\tfeed\thttp\tbytes\tn_bikes\tlast_updated\tversion\tpath\tlatency_s\n")
            f.write(f"{ts.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3]}Z\t{MARKET}\t{FEED}\t{status}\t{nbytes}\t"
                    f"{n_bikes}\t{last_updated}\t{version}\t{rel}\t{lat:.3f}\n")
    except OSError:
        pass


def cycle(url: str, timeout: float) -> int:
    """One poll. Returns the HTTP status."""
    ts = datetime.now(timezone.utc)
    status, body, lat = fetch(url, timeout)
    rel = ""
    n_bikes = last_updated = version = None
    if status == 200 and body:
        path = snapshot_path(ts)
        try:
            write_snapshot(body, path)
            rel = str(path.relative_to(ROOT))
        except OSError as e:
            log(f"WRITE_ERR {path} {type(e).__name__}: {e}")
        n_bikes, last_updated, version = parse_bikes(body)
        log(f"CYCLE {ts.strftime('%H:%M:%S')}Z http={status} bytes={len(body)} "
            f"bikes={n_bikes} latency={lat:.3f}s -> {path.name}")
    else:
        log(f"CYCLE {ts.strftime('%H:%M:%S')}Z http={status} bytes={len(body)} "
            f"latency={lat:.3f}s (not written)")
    index_row(ts, status, len(body), n_bikes, last_updated, version, rel, lat)
    return status


def main() -> int:
    ap = argparse.ArgumentParser(description="Lime GBFS Tel Aviv free_bike_status poller (stdlib only)")
    ap.add_argument("--interval", type=float,
                    default=float(os.environ.get("GBFS_INTERVAL", "15")),
                    help="seconds between cycles (default 15, minimum enforced 15)")
    ap.add_argument("--url", default=os.environ.get("GBFS_FEED_URL", DEFAULT_URL),
                    help="feed URL (default: public tel_aviv free_bike_status)")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--once", action="store_true", help="poll once then exit (smoke test)")
    args = ap.parse_args()

    interval = max(MIN_INTERVAL, args.interval)
    if interval != args.interval:
        log(f"interval {args.interval}s raised to the polite minimum {MIN_INTERVAL}s")

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    OUT.mkdir(parents=True, exist_ok=True)
    try:
        PIDFILE.parent.mkdir(parents=True, exist_ok=True)
        PIDFILE.write_text(str(os.getpid()))
    except OSError:
        pass
    log(f"START pid={os.getpid()} market={MARKET} feed={FEED} interval={interval}s out={OUT} url={args.url}")

    if args.once:
        cycle(args.url, args.timeout)
        return 0

    cycles = 0
    while not _STOP:
        t0 = time.time()
        try:
            cycle(args.url, args.timeout)
        except Exception as e:  # noqa: BLE001  crash-resilient: never die on a cycle
            log(f"CYCLE_ERR {type(e).__name__}: {e}")
        cycles += 1
        elapsed = time.time() - t0
        if _STOP:
            break
        _sleep(max(1.0, interval - elapsed))
    log(f"STOP pid={os.getpid()} cycles={cycles}")
    try:
        if PIDFILE.exists() and PIDFILE.read_text().strip() == str(os.getpid()):
            PIDFILE.unlink()
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
