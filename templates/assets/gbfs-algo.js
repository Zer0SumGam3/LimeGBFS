/* gbfs-algo.js -- Lime GBFS Tel Aviv trip-linkage algorithms, browser + node.
 *
 * Pure functions, no DOM, no network: this is a faithful JavaScript port of the
 * Python pipeline shipped in this package (poller.py / classify_trips logic /
 * build.py / poi_correlate.py). It exists so the STATIC SITE can reconstruct
 * trips, classify them, chain identities and correlate POIs entirely client-side
 * -- identically whether it runs from a static host or from `python3 -m http.server`.
 *
 * Output objects use the SAME keys / column order as the Python path so the
 * computed JSON and CSV have identical shapes.
 *
 * Exposed as window.GBFS (browser) and module.exports (node).
 */
'use strict';

var R_EARTH = 6371000.0;
var MIN_FLOOR_M = 10.0;
var DEG_LAT_M = 111000.0;
var TIERS = [30, 50, 100];
var CLASS_ORDER = ['ride_confirmed', 'ride_probable', 'reservation_or_state_toggle',
                   'feed_flicker', 'relocation_suspect'];
var CONF = {'ride_confirmed': 0.95, 'ride_probable': 0.6, 'reservation_or_state_toggle': 0.5,
            'feed_flicker': 0.9, 'relocation_suspect': 0.55};
var CSV_COLS = ['market', 'bike_id', 'linkage', 'dropout_ts', 'reappear_ts', 'gap_s',
                'origin_lat', 'origin_lon', 'dest_lat', 'dest_lon', 'trip_len_m',
                'vehicle_type', 'range_before', 'range_after',
                'last_reported_before', 'last_reported_after', 'epoch',
                'class', 'confidence', 'precision_floor_m', 'coord_dp', 'n_missed',
                'range_delta_m', 'last_reported_changed', 'evidence'];

/* ------------------------------------------------------------------ numbers */
function fl(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
function hav(lat1, lon1, lat2, lon2) {
  var a = fl(lat1), b = fl(lon1), c = fl(lat2), d = fl(lon2);
  if (a === null || b === null || c === null || d === null) return NaN;
  var p1 = a * Math.PI / 180.0, p2 = c * Math.PI / 180.0;
  var dp = (c - a) * Math.PI / 180.0, dl = (d - b) * Math.PI / 180.0;
  var s = Math.sin(dp / 2) * Math.sin(dp / 2) +
          Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}
function decimals(v) {
  var s = String(v);
  if (s.indexOf('.') < 0) return 0;
  return s.split('.')[1].length;
}
function round1(x) { return roundN(x, 1); }
/* Python round(x, n): correct nearest with ties-to-even on the exact double.
   Reproduce it (an exact .5 tie - e.g. 0.125 -> 0.12 - rounds to even). */
function roundN(x, n) {
  if (x === null || x === undefined || !isFinite(x)) return x;
  var m = Math.pow(10, n), neg = x < 0, s = Math.abs(x) * m;
  var f = Math.floor(s), r;
  if (s - f === 0.5) r = (f % 2 === 0) ? f : f + 1;
  else r = Math.round(s);
  r = r / m;
  return neg ? -r : r;
}
/* Python round(float) rounds half-to-even on the exact value; Math.round rounds
   half-up. Reproduce the Python result (used only in the evidence string). */
function pyRound(x) {
  var f = Math.floor(x), diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;
}
/* Python repr() of a float: 0.0, -29901.0, -1.5 ; None -> "None". */
function pyFloat(v) {
  if (v === null || v === undefined) return 'None';
  return Number.isInteger(v) ? v + '.0' : String(v);
}
/* CPython 3.12 sum() uses Neumaier compensated summation for floats; match it
   so dist_mean_m is bit-identical between the Python and browser paths. */
function fsum(arr) {
  var s = 0, c = 0;
  for (var i = 0; i < arr.length; i++) {
    var x = arr[i], t = s + x;
    if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s;
    s = t;
  }
  return s + c;
}
function round(x, n) { return roundN(x, n); }
function pctl(xs, p) {
  if (!xs || !xs.length) return null;
  var a = xs.slice().sort(function (x, y) { return x - y; });
  var k = (a.length - 1) * p / 100.0;
  var lo = Math.floor(k), hi = Math.ceil(k);
  return lo === hi ? a[hi] : a[lo] + (a[hi] - a[lo]) * (k - lo);
}
/* Python: dt.astimezone(utc).isoformat() with whole-second timestamps ->
   "2026-10-10T21:15:36+00:00". Match that shape exactly. */
function iso(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d+Z$/, '+00:00');
}
/* Filename -> UTC Date. Mirrors parse_ts(): %Y%m%dT%H%M%S, fractions ignored. */
function parseTs(name) {
  var m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(String(name));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

/* ------------------------------------------------------------------ parsing */
/* JSON.parse with a reviver that captures the RAW numeric literal for lat/lon
   (mirrors Python json.loads(..., parse_float=str)). Falls back to String(v)
   on engines without reviver-source access (rare; documented in README). */
function parseSnapText(text, ts) {
  var bikes = {};
  var doc;
  try {
    doc = JSON.parse(text, function (k, v, ctx) {
      if ((k === 'lat' || k === 'lon') && ctx && typeof ctx.source === 'string' && v !== null && v !== undefined) {
        try { Object.defineProperty(this, '__raw_' + k, {value: ctx.source, enumerable: false, configurable: true}); } catch (e) { /* noop */ }
      }
      return v;
    });
  } catch (e) { return null; }
  var d = (doc && doc.data) || {};
  var arr = d.bikes || d.vehicles || [];
  for (var i = 0; i < arr.length; i++) {
    var b = arr[i];
    if (b && b.bike_id) bikes[b.bike_id] = b;
  }
  if (!Object.keys(bikes).length) return null;   /* empty/404 = feed outage */
  return {ts: ts, bikes: bikes, n: Object.keys(bikes).length};
}

/* ------------------------------------------------------------------ classify */
function precisionFloorM(dpA, dpB) {
  var dp = Math.max(dpA, dpB);
  return Math.max(MIN_FLOOR_M, DEG_LAT_M * Math.pow(10.0, -dp) * 0.5);
}
function classify(dispM, floorM, rangeDelta, lrChanged, nMissed, gapS) {
  var moved = dispM !== null && !isNaN(dispM) && dispM > floorM;
  var batteryOk = (rangeDelta !== null && rangeDelta > 0 &&
                   dispM !== null && rangeDelta <= Math.max(5.0 * dispM, 500.0));
  var ev = 'disp=' + (dispM === null ? 0 : pyRound(dispM)) + 'm ' +
           'floor=' + pyRound(floorM) + 'm missed=' + nMissed + ' ' +
           'range_delta=' + pyFloat(rangeDelta) + ' lr_changed=' + (lrChanged ? 'True' : 'False');
  if (nMissed === 1 && !moved && rangeDelta === 0 && !lrChanged)
    return ['feed_flicker', CONF['feed_flicker'], ev + ' | one-interval absence, identical pos/range/last_reported'];
  if (!moved && rangeDelta === 0)
    return ['reservation_or_state_toggle', CONF['reservation_or_state_toggle'], ev + ' | same pos, zero consumption'];
  if (dispM !== null && dispM > 2000 && (rangeDelta === null || rangeDelta <= 0))
    return ['relocation_suspect', CONF['relocation_suspect'], ev + ' | large move, ~zero consumption'];
  if (moved && batteryOk)
    return ['ride_confirmed', CONF['ride_confirmed'], ev + ' | battery corroborated'];
  if (moved && nMissed >= 2)
    return ['ride_confirmed', 0.8, ev + ' | >=2 missed intervals + position change'];
  if (moved)
    return ['ride_probable', CONF['ride_probable'], ev + ' | above floor, no battery corroboration'];
  return ['reservation_or_state_toggle', CONF['reservation_or_state_toggle'], ev + ' | below floor'];
}

function detectEpochs(snaps) {
  if (!snaps || !snaps.length) return [];
  var epochs = [], start = 0;
  for (var i = 0; i < snaps.length - 1; i++) {
    var A = Object.keys(snaps[i].bikes), B = Object.keys(snaps[i + 1].bikes);
    var sa = {}, inter = 0;
    for (var x = 0; x < A.length; x++) sa[A[x]] = 1;
    for (var y = 0; y < B.length; y++) if (sa[B[y]]) inter++;
    var union = A.length + B.length - inter;
    if (inter / (union || 1) < 0.5) { epochs.push([start, i]); start = i + 1; }
  }
  epochs.push([start, snaps.length - 1]);
  return epochs;
}

function rawLat(b) { return b.__raw_lat !== undefined ? b.__raw_lat : b.lat; }
function rawLon(b) { return b.__raw_lon !== undefined ? b.__raw_lon : b.lon; }

function tripsForMarket(market, snaps) {
  if (!snaps || snaps.length < 2) return [];
  var trips = [];
  var epochs = detectEpochs(snaps);
  for (var e = 0; e < epochs.length; e++) {
    var e0 = epochs[e][0], e1 = epochs[e][1];
    var esnaps = snaps.slice(e0, e1 + 1);
    var timeline = {};
    for (var i = 0; i < esnaps.length; i++) {
      var ids = Object.keys(esnaps[i].bikes);
      for (var k = 0; k < ids.length; k++) {
        var vid = ids[k];
        (timeline[vid] || (timeline[vid] = [])).push([i, esnaps[i].bikes[vid]]);
      }
    }
    var vids = Object.keys(timeline);
    for (var v = 0; v < vids.length; v++) {
      var obs = timeline[vids[v]];
      var runs = [], cur = [obs[0]];
      for (var j = 1; j < obs.length; j++) {
        if (obs[j][0] === obs[j - 1][0] + 1) cur.push(obs[j]);
        else { runs.push(cur); cur = [obs[j]]; }
      }
      runs.push(cur);
      for (var r = 0; r + 1 < runs.length; r++) {
        var r0 = runs[r], r1 = runs[r + 1];
        var i0 = r0[r0.length - 1][0], b0 = r0[r0.length - 1][1];
        var i1 = r1[0][0], b1 = r1[0][1];
        if (i1 <= i0 + 1) continue;
        var t0 = esnaps[i0].ts, t1 = esnaps[i1].ts;
        var nMissed = i1 - i0 - 1;
        var d = hav(b0.lat, b0.lon, b1.lat, b1.lon);
        var disp = (d !== d) ? null : round1(d);
        var dpA = decimals(rawLat(b0)), dpB = decimals(rawLat(b1));
        var floor = precisionFloorM(dpA, dpB);
        var rb = fl(b0.current_range_meters), ra = fl(b1.current_range_meters);
        var rangeDelta = (rb === null || ra === null) ? null : (rb - ra);
        var lr0 = b0.last_reported, lr1 = b1.last_reported;
        var lrChanged = (lr0 !== lr1);
        var gapS = (t1.getTime() - t0.getTime()) / 1000.0;
        var cl = classify(disp, floor, rangeDelta, lrChanged, nMissed, gapS);
        trips.push({
          market: market, bike_id: vids[v], linkage: 'same_id',
          dropout_ts: iso(t0), reappear_ts: iso(t1),
          gap_s: round1(gapS),
          origin_lat: fl(b0.lat), origin_lon: fl(b0.lon),
          dest_lat: fl(b1.lat), dest_lon: fl(b1.lon),
          trip_len_m: disp,
          vehicle_type: b0.vehicle_type || '',
          range_before: rb === null ? null : Math.trunc(rb),
          range_after: ra === null ? null : Math.trunc(ra),
          last_reported_before: lr0, last_reported_after: lr1,
          epoch: e0 + '-' + e1,
          'class': cl[0], confidence: cl[1],
          precision_floor_m: round(floor, 2),
          coord_dp: dpA + '/' + dpB,
          n_missed: nMissed,
          range_delta_m: rangeDelta === null ? null : round1(rangeDelta),
          last_reported_changed: lrChanged ? 1 : 0,
          evidence: cl[2]
        });
      }
    }
  }
  return trips;
}

/* ------------------------------------------------- bikes (sessions) + chains */
function bikesAndChains(market, snaps) {
  var bikes = {}, openDropouts = 0, sessionsTotal = 0;
  if (!snaps || snaps.length < 2)
    return {bikes: bikes, chains: [], open_dropouts: 0, sessions: 0,
            chain_ok: 0, chain_total: 0, range_match: 0, ch_dists: []};
  var epochs = detectEpochs(snaps);
  for (var e = 0; e < epochs.length; e++) {
    var esnaps = snaps.slice(epochs[e][0], epochs[e][1] + 1);
    var timeline = {};
    for (var i = 0; i < esnaps.length; i++) {
      var ids = Object.keys(esnaps[i].bikes);
      for (var k = 0; k < ids.length; k++) {
        var vid = ids[k];
        (timeline[vid] || (timeline[vid] = [])).push([i, esnaps[i].bikes[vid]]);
      }
    }
    var vids = Object.keys(timeline);
    for (var v = 0; v < vids.length; v++) {
      var obs = timeline[vids[v]];
      var r = bikes[vids[v]];
      if (!r) {
        r = bikes[vids[v]] = {id: vids[v], vt: (obs[0][1].vehicle_type || ''),
          f: null, l: null, n: 0, s: 0, t: 0, o: false, sess: [], la: null, lo: null,
          nx: null, pv: null};
      }
      var runs = [], cur = [obs[0]];
      for (var j = 1; j < obs.length; j++) {
        if (obs[j][0] === obs[j - 1][0] + 1) cur.push(obs[j]);
        else { runs.push(cur); cur = [obs[j]]; }
      }
      runs.push(cur);
      for (var q = 0; q < runs.length; q++) {
        var run = runs[q];
        var iS = run[0][0], iE = run[run.length - 1][0];
        r.sess.push([Math.trunc(esnaps[iS].ts.getTime() / 1000),
                     Math.trunc(esnaps[iE].ts.getTime() / 1000), run.length]);
        r.s += 1; sessionsTotal += 1;
      }
      r.n += obs.length;
      var tFirst = esnaps[obs[0][0]].ts, tLast = esnaps[obs[obs.length - 1][0]].ts;
      if (r.f === null || tFirst < r.f) r.f = tFirst;
      if (r.l === null || tLast > r.l) r.l = tLast;
      r.la = fl(obs[obs.length - 1][1].lat);
      r.lo = fl(obs[obs.length - 1][1].lon);
      if (!r.vt) r.vt = obs[0][1].vehicle_type || '';
      r.t += runs.length - 1;
      if (runs[runs.length - 1][runs[runs.length - 1].length - 1][0] < esnaps.length - 1) {
        r.o = true; openDropouts += 1;
      }
    }
  }
  var chains = [], chainTotal = 0, chainOk = 0, rangeMatch = 0, chDists = [];
  /* Faithful reproduction of Python's grid: keys are round(lat,5)/round(lon,5)
     FLOATS, and neighbours are probed by adding dx*1e-5 to that float (which can
     land on a different double than round(lat+1e-5,5)). Using String(float)
     keeps the same double semantics as Python's float dict keys. */
  function r5(v) { var f = fl(v); if (!f) f = 0; return Number(f.toFixed(5)); }
  function rk(a, b) { return a + '|' + b; }
  for (var ei = 0; ei + 1 < epochs.length; ei++) {
    var a1 = epochs[ei][1], b0i = epochs[ei + 1][0];
    var A = snaps[a1].bikes, B = snaps[b0i].bikes;
    var grid = {};
    var bids = Object.keys(B);
    for (var bi = 0; bi < bids.length; bi++) {
      var y0 = B[bids[bi]];
      var gk = rk(r5(y0.lat), r5(y0.lon));
      (grid[gk] || (grid[gk] = [])).push(y0);
    }
    var aids = Object.keys(A);
    for (var ai = 0; ai < aids.length; ai++) {
      var vid = aids[ai], x = A[vid];
      chainTotal += 1;
      var ka = r5(x.lat), kb = r5(x.lon);
      var cands = (grid[rk(ka, kb)] || []).slice();
      if (!cands.length) {
        for (var dx = -1; dx <= 1; dx++)
          for (var dy = -1; dy <= 1; dy++) {
            var k2 = rk(ka + dx * 1e-5, kb + dy * 1e-5);
            if (grid[k2]) cands = cands.concat(grid[k2]);
          }
      }
      var y = null;
      for (var ci = 0; ci < cands.length; ci++)
        if (cands[ci].current_range_meters === x.current_range_meters) { y = cands[ci]; break; }
      if (y === null && cands.length) {
        y = cands[0];
        var best = hav(x.lat, x.lon, cands[0].lat, cands[0].lon);
        for (var cj = 1; cj < cands.length; cj++) {
          var dd = hav(x.lat, x.lon, cands[cj].lat, cands[cj].lon);
          if (dd < best) { best = dd; y = cands[cj]; }
        }
      }
      if (y === null) continue;
      var d = hav(x.lat, x.lon, y.lat, y.lon);
      if (!(d === d && d < 30)) continue;
      chainOk += 1; chDists.push(d);
      if (x.current_range_meters === y.current_range_meters) rangeMatch += 1;
      if (bikes[vid] && bikes[vid].nx === null) bikes[vid].nx = y.bike_id;
      var nid = y.bike_id;
      if (bikes[nid] && bikes[nid].pv === null) bikes[nid].pv = vid;
      if (chains.length < 400) {
        chains.push({old_id: vid, new_id: nid, dist_m: round(d, 3),
          lat: fl(x.lat), lon: fl(x.lon),
          range_old: fl(x.current_range_meters), range_new: fl(y.current_range_meters),
          range_match: x.current_range_meters === y.current_range_meters,
          from_ts: iso(snaps[a1].ts), to_ts: iso(snaps[b0i].ts)});
      }
    }
  }
  var keys = Object.keys(bikes);
  for (var kk = 0; kk < keys.length; kk++) {
    var rr = bikes[keys[kk]];
    rr.f = rr.f ? iso(rr.f) : null;
    rr.l = rr.l ? iso(rr.l) : null;
  }
  return {bikes: bikes, chains: chains, open_dropouts: openDropouts, sessions: sessionsTotal,
          chain_ok: chainOk, chain_total: chainTotal, range_match: rangeMatch, ch_dists: chDists};
}

/* ------------------------------------------------------------------- stats */
function statsFor(trips) {
  var dists = [], gaps = [];
  for (var i = 0; i < trips.length; i++) {
    if (trips[i].trip_len_m !== null && trips[i].trip_len_m !== undefined) dists.push(trips[i].trip_len_m);
    if (trips[i].gap_s !== null && trips[i].gap_s !== undefined) gaps.push(trips[i].gap_s);
  }
  var gt10 = dists.filter(function (d) { return d > 10; }).length;
  var gt200 = dists.filter(function (d) { return d > 200; }).length;
  return {
    n: trips.length,
    same_id: trips.filter(function (t) { return t.linkage === 'same_id'; }).length,
    linkage_rate_pct: trips.length ? 100.0 : null,
    dist_p50_m: pctl(dists, 50), dist_p75_m: pctl(dists, 75),
    dist_p95_m: pctl(dists, 95),
    dist_max_m: dists.length ? Math.max.apply(null, dists) : null,
    dist_mean_m: dists.length ? fsum(dists) / dists.length : null,
    median_displacement_m: pctl(dists, 50) || 0.0,
    pct_gt_10m: dists.length ? 100.0 * gt10 / dists.length : null,
    pct_gt_200m: dists.length ? 100.0 * gt200 / dists.length : null,
    gap_p50_s: pctl(gaps, 50), gap_p95_s: pctl(gaps, 95)
  };
}

/* --------------------------------------------------------------------- POIs */
function Grid(pois) {
  this.CELL = 0.002;
  this.pois = pois;
  this.g = {};
  for (var i = 0; i < pois.length; i++) {
    var p = pois[i];
    var k = this._k(p.lat, p.lon);
    (this.g[k] || (this.g[k] = [])).push(i);
  }
}
Grid.prototype._k = function (lat, lon) {
  return Math.floor(lat / this.CELL) + '|' + Math.floor(lon / this.CELL);
};
Grid.prototype.near = function (lat, lon, radiusM) {
  var ci = Math.floor(lat / this.CELL), cj = Math.floor(lon / this.CELL);
  var out = [];
  for (var di = -1; di <= 1; di++)
    for (var dj = -1; dj <= 1; dj++) {
      var bucket = this.g[(ci + di) + '|' + (cj + dj)];
      if (!bucket) continue;
      for (var n = 0; n < bucket.length; n++) {
        var p = this.pois[bucket[n]];
        var d = hav(lat, lon, p.lat, p.lon);
        if (d <= radiusM) out.push([d, p]);
      }
    }
  out.sort(function (a, b) { return a[0] - b[0]; });
  return out;
};
function venueList(grid, lat, lon, maxn) {
  maxn = maxn || 3;
  if (lat === null || lat === undefined || lon === null || lon === undefined) return [];
  return grid.near(lat, lon, TIERS[TIERS.length - 1]).slice(0, maxn).map(function (cand) {
    var p = cand[1];
    return {n: p.name || '', c: p.category || '', g: p.group || '',
            d: round1(cand[0]), lat: p.lat, lon: p.lon};
  });
}
function tier(vl) {
  if (!vl || !vl.length) return null;
  var d = vl[0].d;
  for (var i = 0; i < TIERS.length; i++) if (d <= TIERS[i]) return TIERS[i];
  return null;
}
function attachVenues(trips, pois) {
  if (!pois || !pois.length) return;
  var grid = new Grid(pois);
  for (var i = 0; i < trips.length; i++) {
    var t = trips[i];
    t.o_ven = venueList(grid, t.origin_lat, t.origin_lon);
    t.d_ven = venueList(grid, t.dest_lat, t.dest_lon);
    t.o_tier = tier(t.o_ven);
    t.d_tier = tier(t.d_ven);
  }
}
/* Deterministic 32-bit LCG for the uniform control (Python used random.Random;
   the control set is synthetic, so only the method/tiers must match). */
function lcg(seed) {
  var s = (seed >>> 0) || 1;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function endpointStats(trips, pois, bbox, nControl, seed) {
  nControl = nControl || 20000; seed = seed === undefined ? 7 : seed;
  var starts = [], stops = [];
  for (var i = 0; i < trips.length; i++) {
    starts.push([trips[i].origin_lat, trips[i].origin_lon]);
    stops.push([trips[i].dest_lat, trips[i].dest_lon]);
  }
  var ends = starts.concat(stops).filter(function (e) { return e[0] != null && e[1] != null; });
  var grid = (pois && pois.length) ? new Grid(pois) : null;
  function coverage(points) {
    if (!grid || !points.length) {
      var z = {}; for (var q = 0; q < TIERS.length; q++) z[String(TIERS[q])] = null;
      return [z, 0];
    }
    var n30 = 0, n50 = 0, n100 = 0;
    for (var p = 0; p < points.length; p++) {
      var cand = grid.near(points[p][0], points[p][1], TIERS[TIERS.length - 1]);
      if (!cand.length) continue;
      var d = cand[0][0];
      if (d <= 30) n30++;
      if (d <= 50) n50++;
      if (d <= 100) n100++;
    }
    var n = points.length;
    return [{'30': 100.0 * n30 / n, '50': 100.0 * n50 / n, '100': 100.0 * n100 / n}, n];
  }
  var out = {};
  var sets = [['start', starts], ['stop', stops], ['combined', ends]];
  for (var s = 0; s < sets.length; s++) {
    var pts = sets[s][1].filter(function (e) { return e[0] != null && e[1] != null; });
    var co = coverage(pts);
    out[sets[s][0]] = {n: co[1], pct_within: co[0]};
  }
  var sb = bbox[0], wb = bbox[1], nb = bbox[2], eb = bbox[3];
  var rnd = lcg(seed), ctrl = [];
  for (var c = 0; c < nControl; c++) ctrl.push([sb + rnd() * (nb - sb), wb + rnd() * (eb - wb)]);
  var cc = coverage(ctrl);
  out.control = {n: cc[1], pct_within: cc[0],
    method: 'uniform random points over the same percentile-trimmed TLV bbox; same 30/50/100 m tiers and same nearest-POI counting'};
  var enf = {};
  for (var t = 0; t < TIERS.length; t++) {
    var o = out.combined.pct_within[String(TIERS[t])];
    var ccv = cc[0][String(TIERS[t])];
    enf[String(TIERS[t])] = (o != null && ccv) ? o / ccv : null;
  }
  out.enrichment_x = enf;
  var cat = {};
  for (var tr = 0; tr < trips.length; tr++) {
    var keys = ['o_ven', 'd_ven'];
    for (var kk = 0; kk < keys.length; kk++) {
      var vl = trips[tr][keys[kk]] || [];
      if (vl.length && vl[0].d <= 30 && vl[0].c) cat[vl[0].c] = (cat[vl[0].c] || 0) + 1;
    }
  }
  out.category_top = Object.keys(cat).map(function (k) { return [k, cat[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 15);
  var venue = {};
  for (var t2 = 0; t2 < trips.length; t2++) {
    var seen = {}, ks = ['o_ven', 'd_ven'];
    for (var k2 = 0; k2 < ks.length; k2++) {
      var vl2 = trips[t2][ks[k2]] || [];
      if (vl2.length && vl2[0].d <= 30) {
        var v = vl2[0];
        var vid = v.lat + '|' + v.lon + '|' + v.n;
        if (seen[vid]) continue;
        seen[vid] = 1;
        var lab = (v.n || '(unnamed)') + ' [' + v.c + ']';
        var rec = venue[lab] || (venue[lab] = {name: v.n || '', category: v.c, group: v.g,
          lat: v.lat, lon: v.lon, endpoints: 0, starts: 0, stops: 0});
        rec.endpoints += 1;
        if (ks[k2] === 'o_ven') rec.starts += 1; else rec.stops += 1;
      }
    }
  }
  out.venues_top = Object.keys(venue).map(function (k) { return venue[k]; })
    .sort(function (a, b) { return b.endpoints - a.endpoints; }).slice(0, 50);
  out.n_pois = pois ? pois.length : 0;
  return out;
}
function bikeDirectory(bikes, trips, pois) {
  var grid = (pois && pois.length) ? new Grid(pois) : null;
  var byBike = {};
  for (var i = 0; i < trips.length; i++) {
    var t = trips[i], b = t.bike_id;
    var r = byBike[b] || (byBike[b] = {bike_id: b, trips: 0, confirmed: 0, venues: {},
      first: t.dropout_ts, last: t.reappear_ts, km: 0.0});
    r.trips += 1;
    if (t['class'] === 'ride_confirmed') r.confirmed += 1;
    r.km += (t.trip_len_m || 0) / 1000.0;
    if (t.dropout_ts < r.first) r.first = t.dropout_ts;
    if (t.reappear_ts > r.last) r.last = t.reappear_ts;
    if (grid) {
      var eps = [[t.origin_lat, t.origin_lon], [t.dest_lat, t.dest_lon]];
      for (var e = 0; e < 2; e++) {
        if (eps[e][0] == null) continue;
        var cand = grid.near(eps[e][0], eps[e][1], 50);
        if (cand.length) {
          var p = cand[0][1];
          r.venues[(p.name || '') + '\u0000' + (p.category || '')] = 1;
        }
      }
    }
  }
  var out = [];
  var bl = Object.keys(byBike);
  for (var bi = 0; bi < bl.length; bi++) {
    var row = byBike[bl[bi]], bk = bikes[row.bike_id] || {};
    var sess = bk.sess || [];
    var activeH = sess.reduce(function (a, s) { return a + (s[1] - s[0]); }, 0) / 3600.0;
    out.push({bike_id: row.bike_id, trips: row.trips, confirmed: row.confirmed,
      venues: Object.keys(row.venues).length, km: round(row.km, 2),
      active_h: round(activeH, 2), obs: bk.n || 0, sessions: bk.s || 0,
      first: bk.f || row.first, last: bk.l || row.last, open: !!bk.o});
  }
  out.sort(function (a, b) {
    return (b.confirmed - a.confirmed) || (b.venues - a.venues) || (b.km - a.km);
  });
  return out;
}
function flagshipBikes(directory, trips, n) {
  n = n || 3;
  var byBike = {};
  for (var i = 0; i < trips.length; i++) {
    (byBike[trips[i].bike_id] || (byBike[trips[i].bike_id] = [])).push(trips[i]);
  }
  var cand = [];
  for (var r = 0; r < directory.length; r++) {
    var row = directory[r];
    var ts = byBike[row.bike_id] || [];
    var conf = ts.filter(function (t) { return t['class'] === 'ride_confirmed'; });
    if (!conf.length) continue;
    var times = conf.map(function (t) { return t.dropout_ts; }).sort();
    var spanH = 0.0;
    try { spanH = (Date.parse(times[times.length - 1]) - Date.parse(times[0])) / 3600000.0; }
    catch (e) { spanH = 0.0; }
    var score = (conf.length * 3.0 + (row.venues || 0) * 1.5 + (row.km || 0.0) +
                 spanH * 2.0 + Math.min(row.sessions || 0, 5) * 0.5);
    cand.push([score, conf.length, row.venues || 0, row.bike_id]);
  }
  cand.sort(function (a, b) { return (b[1] - a[1]) || (b[0] - a[0]); });
  return cand.slice(0, n).map(function (c) { return c[3]; });
}

/* -------------------------------------------------------------------- CSV */
function toCsv(trips) {
  var cols = CSV_COLS.concat(['o_tier', 'd_tier']);
  var esc = function (v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var lines = [cols.join(',')];
  for (var i = 0; i < trips.length; i++) {
    var row = [];
    for (var c = 0; c < cols.length; c++) row.push(esc(trips[i][cols[c]]));
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

var API = {
  R_EARTH: R_EARTH, MIN_FLOOR_M: MIN_FLOOR_M, DEG_LAT_M: DEG_LAT_M, TIERS: TIERS,
  CLASS_ORDER: CLASS_ORDER, CONF: CONF, CSV_COLS: CSV_COLS,
  fl: fl, hav: hav, decimals: decimals, pctl: pctl, iso: iso, parseTs: parseTs,
  parseSnapText: parseSnapText, precisionFloorM: precisionFloorM, classify: classify,
  detectEpochs: detectEpochs, tripsForMarket: tripsForMarket, bikesAndChains: bikesAndChains,
  statsFor: statsFor, Grid: Grid, venueList: venueList, attachVenues: attachVenues,
  endpointStats: endpointStats, bikeDirectory: bikeDirectory, flagshipBikes: flagshipBikes,
  toCsv: toCsv
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.GBFS = API;
