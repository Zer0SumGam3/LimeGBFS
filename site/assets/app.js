/* app.js -- Tel Aviv GBFS dossier UI.
 *
 * Everything here runs in the browser with no backend:
 *   - OFFLINE/LOCAL mode: load snapshots from ./snapshots/ (manifest), from a
 *     drag-dropped folder, or from IndexedDB; reconstruct + render client-side.
 *   - LIVE mode: the browser polls data.lime.bike directly (CORS permitting),
 *     accumulates snapshots in IndexedDB across reloads.
 *   - Interactive Leaflet overlay layers over the vendored basemap.
 *   - CSV / JSON export of the computed trips and of the raw snapshots.
 *
 * All algorithms live in gbfs-algo.js (window.GBFS) and mirror the Python path.
 */
(function () {
  'use strict';
  var G = window.GBFS;
  var MARKET = 'tel_aviv';
  var LIVE_URL = 'https://data.lime.bike/api/partners/v2/gbfs/tel_aviv/free_bike_status';
  var LIVE_INTERVAL = 15000;
  var MAX_DIR_MARKERS = 60;

  var S = {
    page: (document.body && document.body.dataset.page) || 'index',
    snaps: {},              /* name -> parsed snapshot */
    trips: [], bikes: {}, chains: [], chinfo: null, directory: [], payload: null,
    pois: [], venues: [],
    computed: false, live: false, liveTimer: null, map: null, tileMeta: null,
    groups: {}, markers: {}, selected: null,
    tiers: {'ride_confirmed': true, 'ride_probable': true, 'judder': false},
    layers: {starts: true, stops: true, connectors: true, trails: true, pois: false}
  };
  window.__LIME = S;

  /* ------------------------------------------------------------- tiny utils */
  function $(id) { return document.getElementById(id); }
  function qs(n) { return new URLSearchParams(location.search).get(n); }
  function fmt(n, d) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    return Number(n).toLocaleString(undefined, {minimumFractionDigits: d || 0, maximumFractionDigits: d || 0});
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c];
    });
  }
  function iso2disp(s) { return !s ? '-' : String(s).replace('T', ' ').slice(0, 19) + 'Z'; }
  function clsLabel(c) {
    return {'ride_confirmed': 'confirmed', 'ride_probable': 'probable',
      'reservation_or_state_toggle': 'reservation/toggle', 'feed_flicker': 'flicker',
      'relocation_suspect': 'relocation'}[c] || c;
  }
  function tile(v, k, n) {
    return '<div class="tile"><div class="v">' + v + '</div><div class="k">' + k + '</div>' +
           (n ? '<div class="n">' + n + '</div>' : '') + '</div>';
  }
  function setStatus(el, msg, cls) {
    if (!el) return; el.textContent = msg; el.className = 'status ' + (cls || '');
  }
  async function jget(u) {
    var r = await fetch(u, {cache: 'no-store'});
    if (!r.ok) throw new Error(u + ' ' + r.status);
    return r.json();
  }
  function tierOn(cls) {
    if (cls === 'ride_confirmed') return S.tiers.ride_confirmed;
    if (cls === 'ride_probable') return S.tiers.ride_probable;
    return S.tiers.judder;
  }
  function download(name, text, mime) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], {type: mime || 'text/plain'}));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* --------------------------------------------------------------- IndexedDB */
  var DB = 'lime-gbfs-tlv', STORE = 'snapshots';
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE, {keyPath: 'name'}); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbPut(rec) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () {});
  }
  function idbAll() {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var out = [], tx = db.transaction(STORE, 'readonly');
        tx.objectStore(STORE).openCursor().onsuccess = function (e) {
          var c = e.target.result;
          if (c) { out.push(c.value); c.continue(); } else res(out);
        };
        tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () { return []; });
  }
  function idbClear() {
    return idb().then(function (db) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
    }).catch(function () {});
  }

  /* ------------------------------------------------------------- ingestion */
  async function gunzipBytes(u8) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('this browser has no DecompressionStream; serve plain .json snapshots');
    }
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  async function ingest(name, u8, persist) {
    if (S.snaps[name]) return false;
    var ts = G.parseTs(name);
    if (!ts) return false;
    var gz = /\.gz$/.test(name), text;
    try { text = gz ? await gunzipBytes(u8) : new TextDecoder().decode(u8); }
    catch (e) { return false; }
    var snap = G.parseSnapText(text, ts);
    if (!snap) return false;
    S.snaps[name] = snap;
    if (persist !== false) idbPut({name: name, ts: ts.getTime(), gz: gz, data: u8});
    return true;
  }
  async function ingestFiles(fileList) {
    var n = 0;
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (!/\.json(\.gz)?$/.test(f.name)) continue;
      try {
        var buf = new Uint8Array(await f.arrayBuffer());
        if (await ingest(f.name, buf, true)) n++;
      } catch (e) { /* skip */ }
    }
    return n;
  }
  async function loadFromManifest(statusEl) {
    var man = await jget('snapshots/manifest.json');
    var files = man.files || [];
    var n = 0;
    for (var i = 0; i < files.length; i++) {
      try {
        var r = await fetch(files[i], {cache: 'no-store'});
        if (!r.ok) continue;
        var u8 = new Uint8Array(await r.arrayBuffer());
        if (await ingest(files[i].split('/').pop(), u8, true)) n++;
      } catch (e) { /* skip */ }
      if (statusEl && (i % 20 === 0)) setStatus(statusEl, 'loading snapshots ' + i + '/' + files.length + ' ...');
    }
    return n;
  }
  async function loadFromIdb() {
    var rows = await idbAll(), n = 0;
    for (var i = 0; i < rows.length; i++) {
      var u8 = new Uint8Array(rows[i].data);
      if (await ingest(rows[i].name, u8, false)) n++;
    }
    return n;
  }

  /* ---------------------------------------------------------------- compute */
  function buildPayload(snapList) {
    var trips = S.trips, conf = trips.filter(function (t) { return t['class'] === 'ride_confirmed'; });
    var prob = trips.filter(function (t) { return t['class'] === 'ride_probable'; });
    var cs = G.statsFor(conf), raw = G.statsFor(trips);
    var classes = {};
    trips.forEach(function (t) { classes[t['class']] = (classes[t['class']] || 0) + 1; });
    var ch = S.chinfo || {chain_ok: 0, chain_total: 0, range_match: 0, ch_dists: []};
    var poi = null;
    if (S.pois.length) poi = G.endpointStats(trips, S.pois, bboxOrDefault());
    var rawN = raw.n || 1;
    return {
      market: MARKET, stats: cs, raw: raw, probable_stats: G.statsFor(prob), classes: classes,
      bikes: {unique: Object.keys(S.bikes).length, sessions: ch.sessions || 0},
      chains: {n: ch.chain_ok, candidates: ch.chain_total,
        rate_pct: ch.chain_total ? 100.0 * ch.chain_ok / ch.chain_total : null,
        dist_p50_m: G.pctl(ch.ch_dists, 50), range_match_pct: ch.chain_ok ? 100.0 * ch.range_match / ch.chain_ok : null},
      poi: poi, bike_directory: {count: S.directory.length, flagship: []},
      window: {start: snapList.length ? G.iso(snapList[0].ts) : null,
        end: snapList.length ? G.iso(snapList[snapList.length - 1].ts) : null,
        hours: snapList.length ? (snapList[snapList.length - 1].ts - snapList[0].ts) / 3600000 : 0},
      n_snapshots: snapList.length,
      before_after: {raw_n: raw.n, confirmed_n: cs.n, excluded_n: raw.n - cs.n,
        raw_p50_m: raw.dist_p50_m, confirmed_p50_m: cs.dist_p50_m,
        raw_p95_m: raw.dist_p95_m, confirmed_p95_m: cs.dist_p95_m,
        raw_pct_gt_10m: raw.pct_gt_10m, confirmed_pct_gt_10m: cs.pct_gt_10m,
        tightening_pct: 100.0 * (raw.n - cs.n) / rawN}
    };
  }
  function bboxOrDefault() {
    var t = S.tileMeta && S.tileMeta[MARKET];
    if (t && t.bounds) return [t.bounds[0][0], t.bounds[0][1], t.bounds[1][0], t.bounds[1][1]];
    return [32.0, 34.75, 32.17, 34.9];
  }
  function recompute() {
    var list = Object.keys(S.snaps).map(function (k) { return S.snaps[k]; }).sort(function (a, b) { return a.ts - b.ts; });
    if (list.length < 2) return false;
    S.trips = G.tripsForMarket(MARKET, list);
    if (S.pois.length) G.attachVenues(S.trips, S.pois);
    var bc = G.bikesAndChains(MARKET, list);
    S.bikes = bc.bikes; S.chains = bc.chains; S.chinfo = bc;
    S.directory = S.pois.length ? G.bikeDirectory(S.bikes, S.trips, S.pois) : [];
    S.payload = buildPayload(list);
    S.computed = true;
    S.nSnaps = list.length;
    renderAll();
    return true;
  }
  function loadPrebuilt() {
    return jget('data/tlv.json').then(function (p) {
      S.payload = p;
      return Promise.all([
        jget('data/trips/' + MARKET + '.json').catch(function () { return {trips: []}; }),
        jget('data/bikes/' + MARKET + '.json').catch(function () { return {bikes: {}}; }),
        jget('data/chains/' + MARKET + '.json').catch(function () { return {sample: []}; }),
        jget('data/bike_directory_' + MARKET + '.json').catch(function () { return {bikes: []}; })
      ]);
    }).then(function (res) {
      S.trips = res[0].trips || [];
      S.bikes = res[1].bikes || {};
      S.chains = res[2].sample || [];
      S.directory = res[3].bikes || [];
      return jget('data/poi/poi.geojson').catch(function () { return null; });
    }).then(function (gj) {
      if (gj && gj.features) S.pois = gj.features;
      return jget('data/tiles.json').catch(function () { return {}; });
    }).then(function (tm) { S.tileMeta = tm; S.computed = false; renderAll(); return true; })
      .catch(function (e) { renderEmpty(e); return false; });
  }

  /* ------------------------------------------------------------------ map */
  function makeMap(id) {
    var el = $(id);
    if (!el || !window.L) return null;
    /* idempotent: Leaflet throws if a container is initialised twice */
    if (el.__limeMap) return el.__limeMap;
    var m = L.map(el, {worldCopyJump: false, attributionControl: true});
    el.__limeMap = m;
    var t = S.tileMeta && S.tileMeta[MARKET];
    if (t && t.mode === 'pyramid') {
      var b = [[t.bounds[0][0], t.bounds[0][1]], [t.bounds[1][0], t.bounds[1][1]]];
      L.tileLayer(t.url, {minZoom: t.zmin, maxZoom: t.zmax, bounds: b, noWrap: true,
        attribution: '&copy; OpenStreetMap contributors'}).addTo(m);
      m.setMaxBounds(b); m.setMinZoom(t.zmin); m.fitBounds(b);
    } else {
      L.control.attribution({prefix: false}).addAttribution('no vendored basemap');
    }
    return m;
  }
  function styleFor(cls) {
    if (cls === 'ride_confirmed') return {color: '#6f7f96', weight: 1.8, dash: null, r: 4, fill: 0.9};
    if (cls === 'ride_probable') return {color: '#b08a6a', weight: 1.4, dash: '4,4', r: 3, fill: 0.45};
    return {color: '#9b9a93', weight: 1.0, dash: '2,4', r: 2, fill: 0.5};
  }
  function visibleTrips(limit, src) {
    src = src || S.trips;
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var t = src[i];
      if (limit && out.length >= limit) break;
      if (!tierOn(t['class'])) continue;
      if (t.origin_lat == null || t.dest_lat == null) continue;
      out.push(t);
    }
    return out;
  }
  function renderMap() {
    if (!S.map) return;
    ['starts', 'stops', 'connectors', 'pois', 'trails'].forEach(function (k) {
      if (S.groups[k]) { S.map.removeLayer(S.groups[k]); S.groups[k] = null; }
    });
    var trips = visibleTrips(6000, S.restrict);
    var starts = L.layerGroup(), stops = L.layerGroup(), conn = L.layerGroup();
    var bnds = [];
    trips.forEach(function (t) {
      var st = styleFor(t['class']);
      if (S.layers.connectors) {
        var o = {color: st.color, weight: st.weight, opacity: 0.85};
        if (st.dash) o.dashArray = st.dash;
        L.polyline([[t.origin_lat, t.origin_lon], [t.dest_lat, t.dest_lon]], o).bindPopup(popupFor(t)).addTo(conn);
      }
      if (S.layers.starts)
        L.circleMarker([t.origin_lat, t.origin_lon], {radius: st.r, color: '#fff', weight: 1,
          fillColor: '#2a78d6', fillOpacity: st.fill}).bindPopup(popupFor(t)).addTo(starts);
      if (S.layers.stops)
        L.circleMarker([t.dest_lat, t.dest_lon], {radius: st.r, color: '#fff', weight: 1,
          fillColor: '#eb6834', fillOpacity: st.fill}).bindPopup(popupFor(t)).addTo(stops);
      bnds.push([t.origin_lat, t.origin_lon], [t.dest_lat, t.dest_lon]);
    });
    S.groups.starts = starts; S.groups.stops = stops; S.groups.connectors = conn;
    starts.addTo(S.map); stops.addTo(S.map); conn.addTo(S.map);
    if (S.layers.pois && S.venues.length) {
      var pg = L.layerGroup();
      S.venues.slice(0, MAX_DIR_MARKERS).forEach(function (v) {
        L.circleMarker([v.lat, v.lon], {radius: 5, color: '#fff', weight: 1,
          fillColor: '#eda100', fillOpacity: 0.9})
          .bindTooltip((v.name || '(unnamed)') + ' - ' + fmt(v.endpoints) + ' endpoints', {direction: 'top'})
          .addTo(pg);
      });
      S.groups.pois = pg; pg.addTo(S.map);
    }
    if (S.selected && S.layers.trails) {
      var tg = L.layerGroup();
      var mine = S.trips.filter(function (t) { return t.bike_id === S.selected; });
      mine.forEach(function (t) {
        L.polyline([[t.origin_lat, t.origin_lon], [t.dest_lat, t.dest_lon]],
          {color: '#111', weight: 4, opacity: 0.9}).addTo(tg);
        L.polyline([[t.origin_lat, t.origin_lon], [t.dest_lat, t.dest_lon]],
          {color: t['class'] === 'ride_confirmed' ? '#2a78d6' : '#eb6834', weight: 2.5, opacity: 1})
          .bindPopup(popupFor(t)).addTo(tg);
      });
      S.groups.trails = tg; tg.addTo(S.map);
    }
    if (bnds.length) S.map.fitBounds(bnds, {padding: [24, 24], maxZoom: 16});
  }
  function venueTxt(vl) {
    if (!vl || !vl.length) return 'no mapped venue within 100 m';
    return vl.map(function (v) {
      return esc(v.n || '(unnamed)') + ' <span style="color:#8a8983">' + esc(v.c) + ' ' + fmt(v.d, 0) + ' m</span>';
    }).join('<br>');
  }
  function popupFor(t) {
    return '<b>' + esc(t.bike_id) + '</b><br>' + esc(clsLabel(t['class'])) + ' (' + fmt(t.confidence, 2) + ')<br>' +
      'dropout ' + iso2disp(t.dropout_ts) + '<br>reappear ' + iso2disp(t.reappear_ts) + '<br>' +
      'gap ' + fmt(t.gap_s) + ' s &middot; ' + fmt(t.trip_len_m, 1) + ' m &middot; floor ' + fmt(t.precision_floor_m, 1) + ' m<br>' +
      'range ' + fmt(t.range_before) + '&rarr;' + fmt(t.range_after) + '<br>' +
      '<b style="color:#2a78d6">start venue</b><br>' + venueTxt(t.o_ven) + '<br>' +
      '<b style="color:#eb6834">stop venue</b><br>' + venueTxt(t.d_ven);
  }

  /* --------------------------------------------------------------- rendering */
  function renderAll() {
    renderTiles();
    renderDirectory();
    renderFlagship();
    renderClassTable();
    renderPoi();
    renderTrips();
    if (S.map === null) S.map = makeMap('map');
    renderMap();
    renderSourceStatus();
  }
  function renderFlagship() {
    var el = $('flagship'); if (!el) return;
    var fs = (S.payload && S.payload.bike_directory && S.payload.bike_directory.flagship) || [];
    if (!fs.length) { el.textContent = 'flagship renders pending'; return; }
    var byId = {};
    (S.directory || []).forEach(function (b) { if (b && b.bike_id) byId[b.bike_id] = b; });
    el.innerHTML = fs.map(function (id) {
      var b = byId[id] || {};
      var short = String(id).slice(0, 8);
      var png = 'bike-' + short + '.png';
      var cap = esc(short) + ' &middot; ' + fmt(b.confirmed) + ' confirmed trips &middot; ' +
        fmt(b.km, 2) + ' km &middot; ' + fmt(b.venues) + ' venues &le;50&nbsp;m';
      return '<figure class="flagship">' +
        '<a href="' + png + '"><img loading="lazy" src="' + png + '" ' +
          'alt="Labeled confirmed trail for bike ' + esc(short) + '"></a>' +
        '<figcaption>' + cap + ' &middot; ' +
        '<a href="bike.html?m=' + MARKET + '&b=' + encodeURIComponent(id) + '">open trail &rarr;</a>' +
        '</figcaption></figure>';
    }).join('');
  }
  function renderSourceStatus() {
    var el = $('srcstatus');
    if (!el) return;
    if (S.computed) {
      setStatus(el, 'computed in-browser from ' + S.nSnaps + ' snapshot(s)' +
        (S.live ? ' (live accumulation active)' : ''), 'ok');
    } else if (S.payload) {
      setStatus(el, 'showing the prebuilt dataset (n_snapshots=' + (S.payload.n_snapshots || 0) + ')', '');
    }
  }
  function renderTiles() {
    var el = $('tiles'); if (!el || !S.payload) return;
    var p = S.payload, st = p.stats || {}, raw = p.raw || {}, ba = p.before_after || {};
    el.innerHTML =
      tile(fmt(st.n), 'confirmed trips', fmt(raw.n) + ' raw pairs') +
      tile(fmt(ba.tightening_pct, 1) + '%', 'judder removed', fmt((raw.n || 0) - (st.n || 0)) + ' pairs excluded') +
      tile(fmt(st.median_displacement_m, 0) + ' m', 'median displacement', 'raw ' + fmt(raw.median_displacement_m, 0) + ' m') +
      tile(fmt(st.dist_p95_m, 0) + ' m', 'p95 displacement') +
      tile(fmt((p.bikes || {}).unique), 'unique bikes') +
      tile(fmt((p.bikes || {}).sessions), 'bike sessions') +
      tile(fmt((p.window || {}).hours, 2) + ' h', 'observation window') +
      tile(fmt((p.chains || {}).n), 'cross-epoch id links', 'p50 ' + fmt((p.chains || {}).dist_p50_m, 1) + ' m');
  }
  function renderDirectory() {
    var tb = $('dir'); if (!tb) return;
    var d = S.directory || [];
    if ($('dircount')) $('dircount').textContent = fmt(d.length) + ' bikes with reconstructed trips';
    tb.innerHTML = d.slice(0, 40).map(function (b, i) {
      return '<tr><td class="num">' + (i + 1) + '</td>' +
        '<td><a href="bike.html?m=' + MARKET + '&b=' + encodeURIComponent(b.bike_id) + '">' + esc(b.bike_id) + '</a></td>' +
        '<td class="num">' + fmt(b.confirmed) + '</td><td class="num">' + fmt(b.venues) + '</td>' +
        '<td class="num">' + fmt(b.km, 2) + '</td><td class="num">' + fmt(b.active_h, 2) + '</td>' +
        '<td class="num">' + fmt(b.obs) + '</td><td>' + iso2disp(b.first) + '</td><td>' + iso2disp(b.last) + '</td>' +
        '<td><a href="bike.html?m=' + MARKET + '&b=' + encodeURIComponent(b.bike_id) + '">trail &rarr;</a></td></tr>';
    }).join('');
    if ($('dirnote')) $('dirnote').textContent = d.length ? ('showing top ' + Math.min(40, d.length) + ' of ' + d.length + ' ranked bikes') : 'no reconstructed trips yet';
  }
  function renderClassTable() {
    var tb = $('ba'); if (!tb || !S.payload) return;
    var p = S.payload, cc = p.classes || {}, st = p.stats, pr = p.probable_stats;
    var tiers = [['ride_confirmed', 'confirmed', st], ['ride_probable', 'probable', pr],
      ['reservation_or_state_toggle', 'reservation/toggle', null], ['feed_flicker', 'flicker', null],
      ['relocation_suspect', 'relocation', null]];
    var meaning = {'ride_confirmed': 'displaced, battery-corroborated or multi-interval',
      'ride_probable': 'displaced, no battery corroboration',
      'reservation_or_state_toggle': 'same position, zero consumption (hold / unlock-relock)',
      'feed_flicker': 'one-interval absence, identical pos+range+last_reported',
      'relocation_suspect': 'large move, ~zero consumption (ops redeploy)'};
    tb.innerHTML = tiers.map(function (t) {
      var s = t[2];
      return '<tr><td>' + t[1] + '</td><td class="num">' + fmt(cc[t[0]] || 0) + '</td>' +
        '<td class="num">' + (s ? fmt(s.dist_p50_m, 0) : '-') + '</td>' +
        '<td class="num">' + (s ? fmt(s.dist_p95_m, 0) : '-') + '</td>' +
        '<td class="num">' + (s ? fmt(s.pct_gt_10m, 1) : '-') + '</td>' +
        '<td style="white-space:normal;color:var(--text-secondary)">' + meaning[t[0]] + '</td></tr>';
    }).join('');
    var bars = $('classbars');
    if (bars) {
      var rows = Object.keys(cc).map(function (k) { return {k: k, v: cc[k]}; });
      var max = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([1]));
      bars.innerHTML = rows.map(function (r) {
        var jud = ['reservation_or_state_toggle', 'feed_flicker', 'relocation_suspect'].indexOf(r.k) >= 0;
        return '<div class="barrow"><div class="lbl">' + esc(clsLabel(r.k)) +
          (jud ? ' <span style="color:var(--text-muted)">(judder)</span>' : '') + '</div>' +
          '<div><div class="bar' + (jud ? ' j' : '') + '" style="width:' +
          Math.max(2, Math.round(r.v / max * 100)) + '%"></div></div><div class="val">' + fmt(r.v) + '</div></div>';
      }).join('');
    }
  }
  function renderPoi() {
    var el = $('poitiles'); if (!el || !S.payload || !S.payload.poi) return;
    var c = S.payload.poi, e = c.enrichment_x || {};
    el.innerHTML = tile(fmt(c.n_pois), 'OSM venues indexed') +
      tile(fmt(e['30'], 1) + 'x', 'enrichment &le;30 m', 'vs uniform control') +
      tile(fmt(e['50'], 1) + 'x', 'enrichment &le;50 m') +
      tile(fmt(e['100'], 1) + 'x', 'enrichment &le;100 m');
    var rows = [['start', c.start], ['stop', c.stop], ['combined', c.combined], ['control (uniform)', c.control]];
    if ($('poirows')) $('poirows').innerHTML = rows.map(function (r) {
      return '<tr><td>' + r[0] + '</td><td class="num">' + fmt(r[1].n) + '</td>' +
        '<td class="num">' + fmt(r[1].pct_within['30'], 1) + '%</td>' +
        '<td class="num">' + fmt(r[1].pct_within['50'], 1) + '%</td>' +
        '<td class="num">' + fmt(r[1].pct_within['100'], 1) + '%</td></tr>';
    }).join('');
    if ($('poinote')) $('poinote').textContent = 'Control: ' + (c.control || {}).method +
      ' OSM data (c) OpenStreetMap contributors (ODbL); fetched ' + (c.fetch_date || 'n/a') + '.';
    if ($('vrows')) $('vrows').innerHTML = (c.venues_top || []).slice(0, 50).map(function (v) {
      return '<tr><td>' + esc(v.name || '(unnamed)') + '</td><td>' + esc(v.category) + '</td>' +
        '<td class="num">' + fmt(v.endpoints) + '</td><td class="num">' + fmt(v.starts) + '</td>' +
        '<td class="num">' + fmt(v.stops) + '</td></tr>';
    }).join('');
  }
  function renderTrips() {
    var tb = $('trows'); if (!tb) return;
    var conf = S.trips.filter(function (t) { return t['class'] === 'ride_confirmed'; });
    if ($('tcnt')) $('tcnt').textContent = fmt(conf.length) + ' confirmed of ' + fmt(S.trips.length) + ' pairs';
    if ($('cnt')) $('cnt').textContent = fmt(S.trips.length) + ' pairs';
    tb.innerHTML = conf.slice(0, 300).map(function (t) {
      var sv = (t.o_ven && t.o_ven[0]) ? esc(t.o_ven[0].n || '') + ' <span style="color:#8a8983">' + fmt(t.o_ven[0].d, 0) + ' m</span>' : '-';
      var dv = (t.d_ven && t.d_ven[0]) ? esc(t.d_ven[0].n || '') + ' <span style="color:#8a8983">' + fmt(t.d_ven[0].d, 0) + ' m</span>' : '-';
      return '<tr><td><a href="bike.html?m=' + MARKET + '&b=' + encodeURIComponent(t.bike_id) + '">' +
        esc(String(t.bike_id).slice(0, 8)) + '&hellip;</a></td><td>' + esc(clsLabel(t['class'])) + '</td>' +
        '<td class="num">' + fmt(t.confidence, 2) + '</td><td>' + iso2disp(t.dropout_ts) + '</td>' +
        '<td>' + iso2disp(t.reappear_ts) + '</td><td class="num">' + fmt(t.gap_s) + '</td>' +
        '<td class="num">' + fmt(t.trip_len_m, 1) + '</td><td>' + sv + '</td><td>' + dv + '</td></tr>';
    }).join('');
  }
  function renderEmpty(err) {
    var el = $('tiles');
    if (el) el.innerHTML = '<div class="tile"><div class="v">no data</div><div class="k">' +
      esc(err ? err.message : 'run the poller or load snapshots') + '</div></div>';
  }

  /* ------------------------------------------------------------- controls */
  function bindControls() {
    var modeBtns = document.querySelectorAll('[data-mode]');
    Array.prototype.forEach.call(modeBtns, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(modeBtns, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        setMode(b.dataset.mode);
      });
    });
    if ($('btnManifest')) $('btnManifest').addEventListener('click', async function () {
      var st = $('srcstatus'); setStatus(st, 'loading ./snapshots/ ...', 'warn');
      try {
        var n = await loadFromManifest(st);
        setStatus(st, n + ' snapshot(s) loaded from ./snapshots/', n ? 'ok' : 'warn');
        if (n) recompute(); else renderSourceStatus();
      } catch (e) { setStatus(st, 'manifest unavailable: ' + e.message, 'err'); }
    });
    if ($('btnIdb')) $('btnIdb').addEventListener('click', async function () {
      var st = $('srcstatus'); setStatus(st, 'reading IndexedDB ...', 'warn');
      var n = await loadFromIdb();
      setStatus(st, n + ' snapshot(s) from IndexedDB', n ? 'ok' : '');
      if (n) recompute();
    });
    if ($('btnClear')) $('btnClear').addEventListener('click', async function () {
      await idbClear(); S.snaps = {};
      setStatus($('srcstatus'), 'IndexedDB cleared', '');
    });
    var dir = $('dirInput');
    if (dir) dir.addEventListener('change', async function () {
      var st = $('srcstatus'); setStatus(st, 'reading ' + dir.files.length + ' file(s) ...', 'warn');
      var n = await ingestFiles(dir.files);
      setStatus(st, n + ' new snapshot(s) ingested', n ? 'ok' : 'warn');
      if (n) recompute();
    });
    var drop = $('drop');
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
      });
      drop.addEventListener('drop', async function (e) {
        var st = $('srcstatus');
        var items = e.dataTransfer.items, files = [];
        if (items && items.length && items[0].webkitGetAsEntry) {
          for (var i = 0; i < items.length; i++) {
            var entry = items[i].webkitGetAsEntry();
            if (entry) await walkEntry(entry, files);
          }
        } else { files = Array.prototype.slice.call(e.dataTransfer.files); }
        setStatus(st, 'reading ' + files.length + ' file(s) ...', 'warn');
        var n = await ingestFiles(files);
        setStatus(st, n + ' new snapshot(s) ingested', n ? 'ok' : 'warn');
        if (n) recompute();
      });
      drop.addEventListener('click', function () { if (dir) dir.click(); });
    }
    if ($('btnLive')) $('btnLive').addEventListener('click', function () {
      if (S.live) { stopLive(); } else { startLive(); }
    });
    if ($('btnProbe')) $('btnProbe').addEventListener('click', probeCors);
    if ($('btnCsv')) $('btnCsv').addEventListener('click', exportCsv);
    if ($('btnJson')) $('btnJson').addEventListener('click', exportTripsJson);
    if ($('btnSnapExport')) $('btnSnapExport').addEventListener('click', exportSnapshots);
    if ($('snapImport')) $('snapImport').addEventListener('change', importSnapshots);
    ['starts', 'stops', 'connectors', 'trails', 'pois'].forEach(function (k) {
      var cb = $('lay_' + k);
      if (cb) cb.addEventListener('change', function () { S.layers[k] = cb.checked; renderMap(); });
    });
    ['ride_confirmed', 'ride_probable', 'judder'].forEach(function (k) {
      var cb = $('tier_' + k);
      if (cb) cb.addEventListener('change', function () { S.tiers[k] = cb.checked; renderMap(); renderTrips(); });
    });
    if ($('bgo')) $('bgo').addEventListener('click', function () {
      var q = ($('bsearch').value || '').trim().toLowerCase();
      var res = $('bres');
      if (!q) { res.textContent = 'enter a bike_id'; return; }
      var keys = Object.keys(S.bikes);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === q || keys[i].indexOf(q) === 0) {
          location.href = 'bike.html?m=' + MARKET + '&b=' + encodeURIComponent(keys[i]); return;
        }
      }
      res.textContent = 'no match for "' + q + '"';
    });
  }
  async function walkEntry(entry, out) {
    if (entry.isFile) {
      await new Promise(function (res) {
        entry.file(function (f) { if (/\.json(\.gz)?$/.test(f.name)) out.push(f); res(); }, res);
      });
    } else if (entry.isDirectory) {
      var rd = entry.createReader(), all = [];
      await new Promise(function (res) {
        (function read() {
          rd.readEntries(function (es) {
            if (!es.length) { res(); return; }
            all = all.concat(Array.prototype.slice.call(es)); read();
          }, res);
        })();
      });
      for (var i = 0; i < all.length; i++) await walkEntry(all[i], out);
    }
  }
  function setMode(mode) {
    var st = $('srcstatus');
    if (mode === 'live') {
      setStatus(st, 'LIVE selected. Click "start live" to poll the public feed (CORS permitting).', 'warn');
    } else {
      stopLive();
      setStatus(st, 'OFFLINE/LOCAL selected. Load ./snapshots/ or drop a folder.', '');
    }
  }
  function startLive() {
    if (S.live) return;
    S.live = true;
    if ($('btnLive')) $('btnLive').textContent = 'stop live';
    pollLive();
    S.liveTimer = setInterval(pollLive, LIVE_INTERVAL);
  }
  function stopLive() {
    S.live = false;
    if (S.liveTimer) { clearInterval(S.liveTimer); S.liveTimer = null; }
    if ($('btnLive')) $('btnLive').textContent = 'start live';
  }
  async function pollLive() {
    var st = $('srcstatus');
    try {
      var r = await fetch(LIVE_URL, {cache: 'no-store', mode: 'cors'});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var text = await r.text();
      var d = Date.now();
      var name = new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '') + 'Z.json';
      await ingest(name, new TextEncoder().encode(text), true);
      setStatus(st, 'live poll ok at ' + new Date().toISOString().slice(11, 19) + 'Z (' + Object.keys(S.snaps).length + ' snapshots)', 'ok');
      recompute();
    } catch (e) {
      setStatus(st, 'live poll failed: ' + e.message +
        ' -- if this says "Failed to fetch"/TypeError, the feed blocks browser CORS; use OFFLINE mode (see README).', 'err');
    }
  }
  async function probeCors() {
    var st = $('srcstatus');
    setStatus(st, 'probing ' + LIVE_URL + ' ...', 'warn');
    try {
      var r = await fetch(LIVE_URL, {cache: 'no-store', mode: 'cors'});
      var t = await r.text();
      setStatus(st, 'CORS OK: HTTP ' + r.status + ', ' + t.length + ' bytes. LIVE mode works from this browser.', 'ok');
    } catch (e) {
      setStatus(st, 'CORS/network BLOCKED: ' + e.message + ' -- the feed does not allow this page origin. Use OFFLINE mode.', 'err');
    }
  }
  function exportCsv() {
    download('tel_aviv_trips.csv', G.toCsv(S.trips), 'text/csv');
  }
  function exportTripsJson() {
    download('tel_aviv_trips.json', JSON.stringify({market: MARKET, n: S.trips.length, trips: S.trips}), 'application/json');
  }
  async function exportSnapshots() {
    var rows = await idbAll();
    var out = {market: MARKET, format: 'lime-gbfs-snapshots/1', count: rows.length, snapshots: []};
    for (var i = 0; i < rows.length; i++) {
      var b = new Uint8Array(rows[i].data), bin = '';
      for (var j = 0; j < b.length; j += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(j, j + 0x8000));
      out.snapshots.push({name: rows[i].name, gz: rows[i].gz, b64: btoa(bin)});
    }
    download('tel_aviv_snapshots.json', JSON.stringify(out), 'application/json');
  }
  function importSnapshots(e) {
    var f = e.target.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = async function () {
      var doc = JSON.parse(rd.result), n = 0;
      for (var i = 0; i < doc.snapshots.length; i++) {
        var s = doc.snapshots[i], bin = atob(s.b64), u8 = new Uint8Array(bin.length);
        for (var j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
        if (await ingest(s.name, u8, true)) n++;
      }
      setStatus($('srcstatus'), n + ' snapshot(s) imported', n ? 'ok' : 'warn');
      if (n) recompute();
    };
    rd.readAsText(f);
  }

  /* --------------------------------------------------------------- bike page */
  async function initBikePage() {
    var m = MARKET;
    var b = qs('b');
    if ($('mk')) $('mk').href = 'index.html';
    if (!b) { if ($('title')) $('title').textContent = 'missing ?b='; return; }
    if (!S.payload) { await loadPrebuilt(); }
    var r = S.bikes[b] || null;
    if ($('title')) $('title').textContent = b;
    if ($('sub')) $('sub').innerHTML = 'market ' + esc(m) + ' &mdash; every bike_id ever observed renders this labeled trail' + (r ? '' : ' <b>(not found)</b>');
    if (!r) return;
    var mine = S.trips.filter(function (x) { return x.bike_id === b || x.bike_id_prev === b; })
      .sort(function (x, y) { return x.dropout_ts < y.dropout_ts ? -1 : 1; });
    var conf = mine.filter(function (x) { return x['class'] === 'ride_confirmed'; });
    var vt = 0;
    mine.forEach(function (x) {
      (x.o_ven || []).forEach(function (v) { if (v.d <= 50) vt++; });
      (x.d_ven || []).forEach(function (v) { if (v.d <= 50) vt++; });
    });
    if ($('tiles')) $('tiles').innerHTML = tile(fmt(r.n), 'observations') + tile(fmt(r.s), 'sessions') +
      tile(fmt(conf.length), 'confirmed trips') + tile(fmt(mine.length), 'all pairs') +
      tile(fmt(vt), 'endpoints near venue (&le;50 m)') +
      tile(iso2disp(r.f).slice(0, 10), 'first seen') + tile(iso2disp(r.l).slice(0, 10), 'last seen') +
      tile(r.o ? 'open' : 'closed', 'dropout state');
    if ($('srows')) $('srows').innerHTML = (r.sess || []).map(function (s, i) {
      var st = new Date(s[0] * 1000).toISOString(), en = new Date(s[1] * 1000).toISOString();
      return '<tr><td class="num">' + (i + 1) + '</td><td>' + iso2disp(st) + '</td><td>' + iso2disp(en) + '</td>' +
        '<td class="num">' + fmt(s[2]) + '</td><td class="num">' + fmt(s[1] - s[0]) + '</td></tr>';
    }).join('');
    var ev = [];
    if (r.f) ev.push({ts: r.f, type: 'first seen in feed', lat: null, lon: null, ven: null, trip: null});
    mine.forEach(function (x) {
      ev.push({ts: x.dropout_ts, type: 'start / unlock (feed dropout)', lat: x.origin_lat, lon: x.origin_lon, ven: x.o_ven || [], trip: null, cls: x['class']});
      ev.push({ts: x.reappear_ts, type: 'stop / lock (reappearance)', lat: x.dest_lat, lon: x.dest_lon, ven: x.d_ven || [], trip: x, cls: x['class']});
    });
    if (r.l) ev.push({ts: r.l, type: 'last seen in feed', lat: r.la, lon: r.lo, ven: null, trip: null});
    ev.sort(function (a, b2) { return a.ts < b2.ts ? -1 : (a.ts > b2.ts ? 1 : 0); });
    if ($('tl')) $('tl').innerHTML = ev.map(function (e) {
      var vs = (e.ven && e.ven.length) ? e.ven.map(function (v) {
        return esc(v.n || '(unnamed)') + ' <span style="color:#8a8983">[' + esc(v.c) + '] ' + fmt(v.d, 0) + ' m</span>';
      }).join('<br>') : (e.ven === null ? '-' : '<span style="color:#8a8983">no mapped venue within 100 m</span>');
      var tr = '-';
      if (e.trip) tr = (e.trip['class'] === 'ride_confirmed' ? 'confirmed' : 'probable') + ' &middot; ' + fmt(e.trip.gap_s) + ' s &middot; ' +
        fmt(e.trip.trip_len_m, 1) + ' m &middot; floor ' + fmt(e.trip.precision_floor_m, 1) + ' m';
      else if (e.cls) tr = clsLabel(e.cls);
      return '<tr><td>' + iso2disp(e.ts) + '</td><td>' + esc(e.type) + '</td>' +
        '<td>' + (e.lat != null ? fmt(e.lat, 5) + ', ' + fmt(e.lon, 5) : '-') + '</td>' +
        '<td style="white-space:normal">' + vs + '</td><td style="white-space:normal">' + tr + '</td></tr>';
    }).join('');
    if ($('tlnote')) $('tlnote').textContent = ev.length + ' events (' + mine.length + ' dropout/reappearance pairs).';
    if ($('trows')) $('trows').innerHTML = mine.map(function (x) {
      var sv = (x.o_ven && x.o_ven[0]) ? esc(x.o_ven[0].n || '') + ' <span style="color:#8a8983">' + fmt(x.o_ven[0].d, 0) + ' m</span>' : '-';
      var dv = (x.d_ven && x.d_ven[0]) ? esc(x.d_ven[0].n || '') + ' <span style="color:#8a8983">' + fmt(x.d_ven[0].d, 0) + ' m</span>' : '-';
      return '<tr><td>' + esc(clsLabel(x['class'])) + '</td><td class="num">' + fmt(x.confidence, 2) + '</td>' +
        '<td>' + iso2disp(x.dropout_ts) + '</td><td>' + iso2disp(x.reappear_ts) + '</td>' +
        '<td class="num">' + fmt(x.gap_s) + '</td><td class="num">' + fmt(x.trip_len_m, 1) + '</td>' +
        '<td>' + sv + '</td><td>' + dv + '</td></tr>';
    }).join('');
    if ($('kv')) $('kv').innerHTML =
      '<div>bike_id</div><div><code>' + esc(r.id) + '</code></div>' +
      '<div>market</div><div>' + esc(m) + '</div><div>vehicle_type</div><div>' + esc(r.vt || '-') + '</div>' +
      '<div>first seen</div><div>' + iso2disp(r.f) + '</div><div>last seen</div><div>' + iso2disp(r.l) + '</div>' +
      '<div>observations</div><div>' + fmt(r.n) + '</div><div>sessions</div><div>' + fmt(r.s) + '</div>' +
      '<div>open dropout</div><div>' + (r.o ? 'yes' : 'no') + '</div>' +
      '<div>last lat/lon</div><div>' + (r.la != null ? r.la + ', ' + r.lo : '-') + '</div>' +
      '<div>next id after rotation</div><div>' + (r.nx ? esc(r.nx) : '-') + '</div>' +
      '<div>previous id (rotation)</div><div>' + (r.pv ? esc(r.pv) : '-') + '</div>';
    S.selected = b;
    S.tripsForBike = mine;
    S.restrict = mine;          /* bike page: overlay shows only this bike's trips */
    if (!S.map) S.map = makeMap('map');
    if (mine.length) renderMap();
    else if ($('map')) $('map').innerHTML = '<div style="padding:18px;color:var(--text-secondary)">no reconstructed trip for this bike in the window.</div>';
    if ($('btnCsv')) $('btnCsv').addEventListener('click', function () {
      download('bike_' + b.slice(0, 8) + '_trips.csv', G.toCsv(mine), 'text/csv');
    });
  }

  /* ------------------------------------------------------------- chains page */
  async function initChainsPage() {
    if (!S.tileMeta) S.tileMeta = await jget('data/tiles.json').catch(function () { return {}; });
    var c = await jget('data/chains/' + MARKET + '.json').catch(function () { return null; });
    if ($('tiles') && c) $('tiles').innerHTML = tile(fmt(c.total), 'cross-epoch links') +
      tile(fmt(c.candidates), 'candidates') + tile(fmt(c.range_match_pct, 2) + '%', 'range-match rate') +
      tile(fmt(c.dist_p50_m, 2) + ' m', 'p50 spatial error');
    if ($('rows') && c) $('rows').innerHTML = (c.sample || []).slice(0, 200).map(function (x) {
      return '<tr><td>' + esc(x.old_id) + '</td><td>' + esc(x.new_id) + '</td><td class="num">' + fmt(x.dist_m, 2) + '</td>' +
        '<td class="num">' + fmt(x.range_old) + '</td><td class="num">' + fmt(x.range_new) + '</td>' +
        '<td>' + (x.range_match ? 'yes' : 'no') + '</td><td>' + iso2disp(x.from_ts) + '</td><td>' + iso2disp(x.to_ts) + '</td></tr>';
    }).join('');
    if ($('note') && c) $('note').textContent = 'showing ' + Math.min(200, (c.sample || []).length) + ' of ' + c.total + ' TLV chains.';
  }

  /* ------------------------------------------------------------------ boot */
  async function boot() {
    if (!G) { renderEmpty(new Error('gbfs-algo.js failed to load')); return; }
    S.tileMeta = await jget('data/tiles.json').catch(function () { return {}; });
    if (S.page === 'bike') { bindControls(); await initBikePage(); return; }
    if (S.page === 'chains') { bindControls(); await initChainsPage(); return; }
    // index page
    bindControls();
    S.restrict = null;
    await loadPrebuilt();
    if (!S.map) S.map = makeMap('map');
    renderAll();
    /* Restore last session from IndexedDB (instant), then top up from the bundled
       ./snapshots/ folder, and recompute ONCE at the end so partial data is never
       presented as final. */
    var idbn = await loadFromIdb();
    var n = 0;
    try {
      var m = await jget('snapshots/manifest.json');
      if ($('manifestinfo')) $('manifestinfo').textContent = (m.count || 0) + ' snapshots bundled in ./snapshots/';
      if ((m.count || 0) > 0) {
        setStatus($('srcstatus'), 'loading ./snapshots/ ...', 'warn');
        n = await loadFromManifest($('srcstatus'));
      }
    } catch (e) {
      if ($('manifestinfo')) $('manifestinfo').textContent = 'no ./snapshots/manifest.json (run build.py)';
    }
    if (idbn + n > 0) recompute(); else renderSourceStatus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
