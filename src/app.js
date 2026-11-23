/* Crisis Dispatcher — board application.
 * Scenario engine + deterministic pipeline + Leaflet map.
 * No network needed except OSM tiles (optional) and Gemini (optional). */
(function () {
  'use strict';

  var E = window.CrisisEngine;
  var S = window.CrisisScenarios;
  var G = window.CrisisGemini;

  var TRAVEL_PER_ETA_MIN = 6; // sim-seconds of marker travel per ETA minute (time-compressed for training)
  var DWELL_SEC = 30;         // on-scene dwell before returning

  var state = null;
  var map = null;
  var incidentMarkers = {};
  var unitMarkers = {};
  var placeMarkers = [];
  var timer = null;
  var lastTick = 0;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- state ---------------- */
  function freshState(scenarioId) {
    var sc = S.SCENARIOS.find(function (s) { return s.id === scenarioId; }) || S.SCENARIOS[0];
    return {
      scenario: sc,
      units: S.roster(),
      incidents: [],
      dispatches: [],
      log: [],
      simTime: 0,
      running: false,
      speed: 1,
      nextCode: 101,
      nextInject: 1,
      firedEvents: 0,
      selectedId: null,
      tilesFailed: false
    };
  }

  function fmtClock(sec) {
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------- map ---------------- */
  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([17.3850, 78.4867], 13);
    var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    tiles.on('tileerror', function () {
      if (!state.tilesFailed) { state.tilesFailed = true; $('map-note').hidden = false; }
    });
    tiles.addTo(map);
    drawStreetGrid();
    drawPlaceLabels();
  }

  // Fictional street grid + lake + parks, so the board reads even
  // when OSM tiles cannot load (venue Wi-Fi / offline demo).
  function drawStreetGrid() {
    var road = { color: '#5b6b82', weight: 2, opacity: 0.85 };
    var arterial = { color: '#7c8aa0', weight: 3, opacity: 0.9 };
    var lats = [17.3200, 17.3330, 17.3460, 17.3590, 17.3720, 17.3850, 17.3980, 17.4110, 17.4240, 17.4370, 17.4500, 17.4630];
    var lngs = [78.4200, 78.4330, 78.4460, 78.4590, 78.4720, 78.4850, 78.4980, 78.5110, 78.5240, 78.5370];
    lats.forEach(function (la) { L.polyline([[la, 78.4150], [la, 78.5420]], road).addTo(map); });
    lngs.forEach(function (lo) { L.polyline([[17.3150, lo], [17.4680, lo]], road).addTo(map); });
    // arterials: Tank Bund Rd, MG Rd, Bank St
    L.polyline([[17.4156, 78.4400], [17.4156, 78.5300]], arterial).addTo(map);
    L.polyline([[17.3850, 78.4300], [17.3850, 78.5350]], arterial).addTo(map);
    L.polyline([[17.4399, 78.4500], [17.4300, 78.5350]], arterial).addTo(map);
    // Hussain Sagar lake
    L.polygon([
      [17.4280, 78.4680], [17.4280, 78.4800], [17.4200, 78.4840],
      [17.4140, 78.4780], [17.4180, 78.4680]
    ], { color: '#3b82f6', weight: 1, fillColor: '#1e3a5f', fillOpacity: 0.9 }).addTo(map);
    // parks
    L.polygon([[17.3980, 78.4880], [17.3980, 78.4940], [17.3920, 78.4940], [17.3920, 78.4880]],
      { color: '#166534', weight: 1, fillColor: '#14532d', fillOpacity: 0.8 }).addTo(map);
    L.polygon([[17.3720, 78.4620], [17.3720, 78.4680], [17.3660, 78.4680], [17.3660, 78.4620]],
      { color: '#166534', weight: 1, fillColor: '#14532d', fillOpacity: 0.8 }).addTo(map);
  }

  function drawPlaceLabels() {
    Object.keys(S.PLACES).forEach(function (key) {
      var p = S.PLACES[key];
      var icon = L.divIcon({ className: '', html: '<span class="place-lbl">' + esc(p.label) + '</span>', iconSize: null });
      placeMarkers.push(L.marker([p.lat, p.lng], { icon: icon, interactive: false, keyboard: false }).addTo(map));
    });
  }

  function incidentIcon(inc, selected) {
    var cls = 'mk sev-' + inc.severity + (selected ? ' selected' : '');
    return L.divIcon({ className: '', html: '<div class="' + cls + '">' + inc.code.replace('INC-', '') + '</div>', iconSize: [28, 28], iconAnchor: [14, 14] });
  }

  function unitIcon(u) {
    var cls = 'uk' + (u.status === 'available' ? '' : ' busy');
    return L.divIcon({ className: '', html: '<div class="' + cls + '">' + esc(u.id) + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
  }

  function syncMarkers() {
    state.incidents.forEach(function (inc) {
      var m = incidentMarkers[inc.id];
      if (!m) {
        m = L.marker([inc.lat, inc.lng], { icon: incidentIcon(inc, state.selectedId === inc.id) })
          .addTo(map).on('click', function () { selectIncident(inc.id); });
        incidentMarkers[inc.id] = m;
      } else {
        m.setIcon(incidentIcon(inc, state.selectedId === inc.id));
      }
    });
    state.units.forEach(function (u) {
      var m = unitMarkers[u.id];
      if (!m) {
        m = L.marker([u.lat, u.lng], { icon: unitIcon(u) }).addTo(map);
        m.bindTooltip(u.id + ' — ' + u.kind, { direction: 'top' });
        unitMarkers[u.id] = m;
      } else {
        m.setLatLng([u.lat, u.lng]);
        m.setIcon(unitIcon(u));
      }
    });
  }

  function clearMarkers() {
    Object.keys(incidentMarkers).forEach(function (k) { map.removeLayer(incidentMarkers[k]); });
    Object.keys(unitMarkers).forEach(function (k) { map.removeLayer(unitMarkers[k]); });
    incidentMarkers = {}; unitMarkers = {};
  }

  /* ---------------- pipeline ---------------- */
  function ingestIncident(data) {
    var place = S.PLACES[data.place];
    var inc = {
      id: 'inc-' + state.nextCode,
      code: 'INC-' + state.nextCode,
      type: data.type, casualties: data.casualties, trapped: data.trapped || 0,
      lat: place.lat, lng: place.lng, place: place.label,
      note: data.note || '', source: data.source || 'scenario',
      reportedAt: state.simTime, status: 'triaged'
    };
    state.nextCode += 1;
    var t = E.triage(inc);
    inc.triageScore = t.score; inc.severity = t.severity; inc.breakdown = t.breakdown;
    inc.typeLabel = E.TYPE_LABELS[inc.type] || inc.type;
    state.incidents.push(inc);
    dispatchFor(inc);
    renderAll();
    return inc;
  }

  function dispatchFor(inc) {
    var match = E.matchUnit(inc, state.units);
    if (!match) {
      addLog(E.noUnitRationale(inc), 'rule');
      return null;
    }
    var u = match.unit;
    u.status = 'dispatched';
    u.assignedIncidentId = inc.id;
    u.etaMin = match.etaMin;
    u.fromLat = u.lat; u.fromLng = u.lng;
    u.toLat = inc.lat; u.toLng = inc.lng;
    u.moveStart = state.simTime;
    u.moveDuration = Math.max(4, match.etaMin * TRAVEL_PER_ETA_MIN);
    u.phase = 'to-scene';
    inc.status = 'assigned';
    var rationale = E.ruleRationale(inc, match);
    var dispatch = {
      id: 'dsp-' + inc.id, incidentId: inc.id, unitId: u.id,
      decidedAt: state.simTime, etaMin: match.etaMin,
      rationale: rationale, source: 'rule',
      alternatives: match.rejected.map(function (r) { return r.reason; })
    };
    state.dispatches.push(dispatch);
    var entry = addLog(rationale, 'rule');
    // Optional Gemini rewrite — same facts, plainer words. Any failure
    // leaves the rule text in place; nothing is ever faked.
    var key = G.getKey();
    if (key) {
      G.rewriteRationale(inc, match, key).then(function (text) {
        dispatch.rationale = text; dispatch.source = 'gemini';
        entry.text = text; entry.source = 'gemini';
        renderLog();
      }).catch(function () { /* rule text stands */ });
    }
    return dispatch;
  }

  // When a unit frees up, retry the highest-priority unassigned incident.
  function retryQueued() {
    var waiting = E.sortQueue(state.incidents.filter(function (i) { return i.status === 'triaged'; }));
    waiting.forEach(function (inc) { dispatchFor(inc); });
  }

  function addLog(text, source) {
    var entry = { t: state.simTime, text: text, source: source };
    state.log.unshift(entry);
    return entry;
  }

  /* ---------------- sim tick ---------------- */
  function tick() {
    if (!state.running) return;
    var now = Date.now();
    var dt = Math.min(1, (now - lastTick) / 1000) * state.speed;
    lastTick = now;
    state.simTime += dt;

    // fire due scenario events
    var sc = state.scenario;
    while (state.firedEvents < sc.events.length && sc.events[state.firedEvents].t <= state.simTime) {
      var ev = sc.events[state.firedEvents];
      state.firedEvents += 1;
      ingestIncident({ type: ev.type, casualties: ev.casualties, trapped: ev.trapped, place: ev.place, note: ev.note, source: 'scenario' });
    }

    // move units
    var freed = false;
    state.units.forEach(function (u) {
      if (u.status === 'dispatched' || u.status === 'returning') {
        var p = (state.simTime - u.moveStart) / u.moveDuration;
        if (p >= 1) {
          p = 1;
          if (u.status === 'dispatched') {
            u.status = 'on-scene';
            u.dwellUntil = state.simTime + DWELL_SEC;
            var inc = state.incidents.find(function (i) { return i.id === u.assignedIncidentId; });
            if (inc) inc.status = 'on-scene';
          } else {
            u.status = 'available';
            u.assignedIncidentId = null; u.etaMin = null;
            freed = true;
          }
        }
        u.lat = u.fromLat + (u.toLat - u.fromLat) * p;
        u.lng = u.fromLng + (u.toLng - u.fromLng) * p;
      } else if (u.status === 'on-scene' && state.simTime >= u.dwellUntil) {
        var inc2 = state.incidents.find(function (i) { return i.id === u.assignedIncidentId; });
        if (inc2) inc2.status = 'resolved';
        u.status = 'returning';
        u.fromLat = u.lat; u.fromLng = u.lng;
        u.toLat = u.baseLat; u.toLng = u.baseLng;
        u.moveStart = state.simTime;
        u.moveDuration = Math.max(4, (u.etaMin || 4) * TRAVEL_PER_ETA_MIN);
        u.phase = 'returning';
      }
    });
    if (freed) retryQueued();

    renderAll();
  }

  function startLoop() {
    if (timer) clearInterval(timer);
    lastTick = Date.now();
    timer = setInterval(tick, 250);
  }

  /* ---------------- rendering ---------------- */
  function renderAll() {
    $('clock').textContent = fmtClock(state.simTime);
    renderStats();
    renderQueue();
    renderUnits();
    renderLog();
    renderDetail();
    syncMarkers();
  }

  function renderStats() {
    $('stat-incidents').textContent = state.incidents.length;
    $('stat-p1').textContent = state.incidents.filter(function (i) { return i.severity === 'P1' && i.status === 'triaged'; }).length;
    $('stat-available').textContent = state.units.filter(function (u) { return u.status === 'available'; }).length;
    $('stat-dispatched').textContent = state.dispatches.length;
    var etas = state.dispatches.map(function (d) { return d.etaMin; });
    $('stat-eta').textContent = etas.length ? (etas.reduce(function (a, b) { return a + b; }, 0) / etas.length).toFixed(1) : '—';
    $('queue-count').textContent = state.incidents.length;
    $('units-count').textContent = state.units.length;
  }

  function statusLabel(s) {
    return { triaged: 'Awaiting unit', assigned: 'Unit assigned', 'on-scene': 'Unit on scene', resolved: 'Resolved' }[s] || s;
  }

  function renderQueue() {
    var q = $('queue');
    if (!state.incidents.length) {
      q.innerHTML = '<div class="empty">No incidents yet. Press <b>Start scenario</b> to run the script, or inject one yourself.</div>';
      return;
    }
    q.innerHTML = E.sortQueue(state.incidents).map(function (inc) {
      var sel = state.selectedId === inc.id ? ' selected' : '';
      return '<button class="incident sev-' + inc.severity + sel + '" data-id="' + inc.id + '">' +
        '<span class="row1"><span class="code">' + inc.code + '</span>' +
        '<span class="sev-tag">' + inc.severity + '</span>' +
        '<span class="score">score <b>' + inc.triageScore + '</b></span></span>' +
        '<span class="type">' + esc(inc.typeLabel) + '</span><br>' +
        '<span class="meta">' + esc(inc.place) + ' · ' + inc.casualties + ' casualt' + (inc.casualties === 1 ? 'y' : 'ies') +
        (inc.trapped ? ' · ' + inc.trapped + ' trapped' : '') + ' · ' + fmtClock(inc.reportedAt) + '</span><br>' +
        '<span class="status">' + statusLabel(inc.status) + '</span>' +
        '</button>';
    }).join('');
    q.querySelectorAll('.incident').forEach(function (el) {
      el.addEventListener('click', function () { selectIncident(el.getAttribute('data-id')); });
    });
  }

  function renderUnits() {
    $('units').innerHTML = state.units.map(function (u) {
      var assign = '';
      if (u.assignedIncidentId) {
        var inc = state.incidents.find(function (i) { return i.id === u.assignedIncidentId; });
        assign = inc ? esc(inc.code) + ' · ETA ' + u.etaMin + ' min' : '';
      } else if (u.status === 'returning') assign = 'Returning to base';
      else if (u.status === 'available') assign = 'At base — ready';
      return '<div class="unit-row"><span class="uid">' + esc(u.id) + '</span>' +
        '<span class="ukind"><span class="k">' + esc(u.kind) + '</span><br><span class="a">' + assign + '</span></span>' +
        '<span class="chip ' + u.status + '">' + u.status.replace('-', ' ') + '</span></div>';
    }).join('');
  }

  function renderLog() {
    var log = $('log');
    if (!state.log.length) {
      log.innerHTML = '<div class="empty">Nothing dispatched yet. Start the scenario and the log fills itself.</div>';
      return;
    }
    log.innerHTML = state.log.map(function (e) {
      var tag = e.source === 'gemini'
        ? '<span class="src-tag gemini">Gemini rationale</span>'
        : (e.source === 'rule' ? '<span class="src-tag">Rule-based rationale</span>' : '');
      return '<div class="log-entry"><span class="t">' + fmtClock(e.t) + '</span>' + esc(e.text) + tag + '</div>';
    }).join('');
  }

  function renderDetail() {
    var d = $('detail');
    var inc = state.incidents.find(function (i) { return i.id === state.selectedId; });
    if (!inc) { d.hidden = true; d.innerHTML = ''; return; }
    var disp = state.dispatches.find(function (x) { return x.incidentId === inc.id; });
    var b = inc.breakdown;
    var alts = disp && disp.alternatives.length
      ? disp.alternatives.map(function (a) { return '<p class="alt">' + esc(a) + '.</p>'; }).join('')
      : '<p class="alt">No nearer unit was passed over.</p>';
    d.hidden = false;
    d.className = 'detail sev-' + inc.severity;
    d.innerHTML =
      '<button class="close" id="detail-close" aria-label="Close details">×</button>' +
      '<h3>' + inc.code + ' — ' + esc(inc.typeLabel) + '</h3>' +
      '<div class="sub">' + esc(inc.place) + ' · reported ' + fmtClock(inc.reportedAt) +
      (inc.source === 'injected' ? ' · injected live' : ' · from scenario script') + '</div>' +
      '<div class="score-rows">' +
      '<div class="score-row"><span>Type weight (' + esc(inc.type) + ')</span><span>' + b.type + '</span></div>' +
      '<div class="score-row"><span>Casualties (' + inc.casualties + ' × 8, capped 40)</span><span>' + b.casualties + '</span></div>' +
      '<div class="score-row"><span>Trapped</span><span>' + b.trapped + '</span></div>' +
      '<div class="score-row"><span>Mass-casualty surge (≥10)</span><span>' + b.surge + '</span></div>' +
      '<div class="score-row total"><span>Triage score — ' + inc.severity + '</span><span>' + inc.triageScore + '</span></div>' +
      '</div>' +
      (disp
        ? '<p class="note"><b>' + esc(disp.unitId) + '</b> assigned · ETA ' + disp.etaMin + ' min · ' +
          esc(disp.rationale) + '</p>'
        : '<p class="note"><b>No unit assigned yet</b> — ' + esc(E.noUnitRationale(inc)) + '</p>') +
      alts +
      (inc.note ? '<p class="note">' + esc(inc.note) + '</p>' : '');
    $('detail-close').addEventListener('click', function () { state.selectedId = null; renderAll(); });
  }

  function selectIncident(id) {
    state.selectedId = id;
    renderAll();
    var inc = state.incidents.find(function (i) { return i.id === id; });
    if (inc && map) map.panTo([inc.lat, inc.lng]);
  }

  /* ---------------- controls ---------------- */
  function reset(scenarioId) {
    state = freshState(scenarioId || (state ? state.scenario.id : 'collapse'));
    clearMarkers();
    state.running = false;
    $('btn-start').textContent = 'Start scenario';
    addLog('Scenario ready — ' + state.scenario.name + '. Press Start.', 'info');
    renderAll();
  }

  function updateGeminiStatus() {
    var on = !!G.getKey();
    $('footer-gemini').textContent = on
      ? 'Gemini rationale: on (' + G.MODEL + ') — rule-based text still stands if a call fails.'
      : 'Gemini rationale: not configured — rule-based rationale in use.';
    $('rationale-status').textContent = on ? 'Gemini rationale on' : 'rule-based rationale';
  }

  function initControls() {
    var sel = $('scenario');
    sel.innerHTML = S.SCENARIOS.map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
    }).join('');
    sel.addEventListener('change', function () { reset(sel.value); });

    $('speed').addEventListener('change', function (e) { state.speed = Number(e.target.value); });

    $('btn-start').addEventListener('click', function () {
      state.running = !state.running;
      $('btn-start').textContent = state.running ? 'Pause' : 'Resume';
      if (state.running && state.simTime === 0 && state.firedEvents === 0 && !state.incidents.length) {
        addLog('Scenario started — ' + state.scenario.name + '.', 'info');
      }
      renderAll();
    });

    $('btn-reset').addEventListener('click', function () { reset(); });

    var injPlace = $('inj-place');
    injPlace.innerHTML = S.INJECT_PLACES.map(function (k) {
      return '<option value="' + k + '">' + esc(S.PLACES[k].label) + '</option>';
    }).join('');
    $('btn-inject').addEventListener('click', function () { $('dlg-inject').showModal(); });
    $('inject-form').addEventListener('submit', function (e) {
      if (e.submitter && e.submitter.value === 'ok') {
        ingestIncident({
          type: $('inj-type').value,
          casualties: Math.max(0, Math.min(20, Number($('inj-cas').value) || 0)),
          trapped: $('inj-trapped').checked ? 1 : 0,
          place: injPlace.value,
          note: 'Injected live by the operator.',
          source: 'injected'
        });
      }
    });

    $('btn-settings').addEventListener('click', function () {
      $('gemini-key').value = G.getKey() || '';
      $('settings-status').textContent = '';
      $('settings-status').className = 'dlg-status';
      $('dlg-settings').showModal();
    });
    $('btn-settings-close').addEventListener('click', function () { $('dlg-settings').close(); });
    $('btn-key-save').addEventListener('click', function () {
      var k = $('gemini-key').value.trim();
      if (!k) { $('settings-status').textContent = 'Paste a key first, or clear the saved one.'; $('settings-status').className = 'dlg-status err'; return; }
      G.setKey(k);
      $('settings-status').textContent = 'Key saved in this browser only.';
      $('settings-status').className = 'dlg-status ok';
      updateGeminiStatus();
    });
    $('btn-key-clear').addEventListener('click', function () {
      G.clearKey(); $('gemini-key').value = '';
      $('settings-status').textContent = 'Key cleared. Rule-based rationale in use.';
      $('settings-status').className = 'dlg-status';
      updateGeminiStatus();
    });
    $('btn-key-test').addEventListener('click', function () {
      var k = $('gemini-key').value.trim() || G.getKey();
      if (!k) { $('settings-status').textContent = 'No key to test.'; $('settings-status').className = 'dlg-status err'; return; }
      $('settings-status').textContent = 'Testing — one short call to Google…';
      $('settings-status').className = 'dlg-status';
      G.testKey(k).then(function (t) {
        $('settings-status').textContent = 'Key works — Gemini replied: ' + t.trim().slice(0, 40);
        $('settings-status').className = 'dlg-status ok';
      }).catch(function (err) {
        $('settings-status').textContent = 'Key test failed: ' + err.message + '. Rule-based rationale still works.';
        $('settings-status').className = 'dlg-status err';
      });
    });
  }

  /* ---------------- screenshot mode ---------------- */
  function fastForward(uptoT) {
    var sc = state.scenario;
    while (state.firedEvents < sc.events.length && sc.events[state.firedEvents].t <= uptoT) {
      var ev = sc.events[state.firedEvents];
      state.firedEvents += 1;
      state.simTime = ev.t;
      ingestIncident({ type: ev.type, casualties: ev.casualties, trapped: ev.trapped, place: ev.place, note: ev.note, source: 'scenario' });
    }
    state.simTime = uptoT;
    // move dispatched units halfway to their incidents
    state.units.forEach(function (u) {
      if (u.status === 'dispatched') {
        var p = 0.5;
        u.lat = u.fromLat + (u.toLat - u.fromLat) * p;
        u.lng = u.fromLng + (u.toLng - u.fromLng) * p;
      }
    });
    state.running = false;
    $('btn-start').textContent = 'Start scenario';
    renderAll();
  }

  /* ---------------- boot ---------------- */
  function boot() {
    state = freshState('collapse');
    initMap();
    initControls();
    updateGeminiStatus();
    addLog('Scenario ready — Market building collapse. Press Start.', 'info');
    renderAll();
    startLoop();
    var params = new URLSearchParams(location.search);
    if (params.get('shot') === '1') fastForward(40);
    // Demo/screenshot helpers: open the top incident's detail card,
    // or the inject dialog, on load. Same real code paths as clicking.
    if (params.get('detail') === '1' && state.incidents.length) {
      state.selectedId = E.sortQueue(state.incidents)[0].id;
      renderAll();
    }
    if (params.get('inject') === '1') $('dlg-inject').showModal();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
