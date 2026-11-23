/* Crisis Dispatcher — deterministic decision engine.
 * Triage -> prioritise -> dispatch -> explain.
 * Pure functions, no network, no randomness. Works in the browser
 * (window.CrisisEngine) and in Node (module.exports) for tests. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CrisisEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TYPE_WEIGHTS = {
    collapse: 30, fire: 25, hazmat: 22,
    'road-traffic': 20, medical: 18, crime: 12
  };

  // Capability each incident type needs from a unit.
  var REQUIRED_CAPABILITY = {
    collapse: ['rescue', 'ALS'],
    fire: ['fire'],
    hazmat: ['fire', 'ALS'],
    'road-traffic': ['ALS', 'BLS'],
    medical: ['ALS', 'BLS'],
    crime: ['police']
  };

  var TYPE_LABELS = {
    collapse: 'Building collapse', fire: 'Fire', hazmat: 'Hazmat leak',
    'road-traffic': 'Road traffic collision', medical: 'Medical emergency',
    crime: 'Public safety'
  };

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /* --- Triage ---------------------------------------------------- */
  function triageBreakdown(incident) {
    var type = TYPE_WEIGHTS[incident.type] || 10;
    var casualties = Math.min((incident.casualties || 0) * 8, 40);
    var trapped = incident.trapped ? 15 : 0;
    var surge = (incident.casualties || 0) >= 10 ? 10 : 0;
    return { type: type, casualties: casualties, trapped: trapped, surge: surge };
  }

  function triageScore(incident) {
    var b = triageBreakdown(incident);
    return clamp(b.type + b.casualties + b.trapped + b.surge, 0, 100);
  }

  function priorityFor(score) {
    if (score >= 70) return 'P1';
    if (score >= 45) return 'P2';
    if (score >= 25) return 'P3';
    return 'P4';
  }

  function triage(incident) {
    var score = triageScore(incident);
    return {
      score: score,
      severity: priorityFor(score),
      breakdown: triageBreakdown(incident)
    };
  }

  /* --- Geography ------------------------------------------------- */
  function haversineKm(a, b) {
    var R = 6371;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // City driving speed ~33 km/h => 0.55 km per minute, plus 2 min turnout.
  function etaMinutes(distanceKm) {
    return Math.max(1, Math.round(2 + distanceKm / 0.55));
  }

  /* --- Dispatch (matching) --------------------------------------- */
  function requiredCapabilities(type) {
    return (REQUIRED_CAPABILITY[type] || ['ALS', 'BLS']).slice();
  }

  function unitCanHandle(unit, incident) {
    var need = requiredCapabilities(incident.type);
    return unit.capabilities.some(function (c) { return need.indexOf(c) !== -1; });
  }

  // Returns { unit, etaMin, distanceKm, rejected: [{unit, etaMin, reason}] }
  // or null when no available unit can handle the incident.
  // rejected = units that were nearer but lacked the capability, plus
  // the nearest available units that lost on distance — the explanation
  // for "why the nearest unit was NOT chosen".
  function matchUnit(incident, units) {
    var available = units.filter(function (u) { return u.status === 'available'; });
    if (!available.length) return null;

    function withEta(u) {
      var d = haversineKm({ lat: u.lat, lng: u.lng }, { lat: incident.lat, lng: incident.lng });
      return { unit: u, distanceKm: d, etaMin: etaMinutes(d) };
    }

    var capable = available.filter(function (u) { return unitCanHandle(u, incident); })
      .map(withEta)
      .sort(function (a, b) { return a.etaMin - b.etaMin || (a.unit.id < b.unit.id ? -1 : 1); });
    if (!capable.length) return null;

    var chosen = capable[0];
    var rejected = [];
    // Nearer units that could not handle it (the interesting explanation).
    available.filter(function (u) { return !unitCanHandle(u, incident); })
      .map(withEta)
      .filter(function (r) { return r.etaMin < chosen.etaMin; })
      .sort(function (a, b) { return a.etaMin - b.etaMin; })
      .forEach(function (r) {
        rejected.push({
          unit: r.unit, etaMin: r.etaMin,
          reason: r.unit.id + ' is ' + r.etaMin + ' min away but has no ' +
            requiredCapabilities(incident.type).join('/') + ' capability'
        });
      });
    // Next-best capable units, for the record.
    capable.slice(1, 3).forEach(function (r) {
      rejected.push({
        unit: r.unit, etaMin: r.etaMin,
        reason: r.unit.id + ' is ' + r.etaMin + ' min away — kept in reserve'
      });
    });

    return { unit: chosen.unit, etaMin: chosen.etaMin, distanceKm: chosen.distanceKm, rejected: rejected };
  }

  /* --- Prioritise ------------------------------------------------ */
  function sortQueue(incidents) {
    return incidents.slice().sort(function (a, b) {
      return (b.triageScore - a.triageScore) || (a.reportedAt - b.reportedAt);
    });
  }

  /* --- Explain (rule-based rationale — always available) --------- */
  function ruleRationale(incident, match) {
    var label = TYPE_LABELS[incident.type] || incident.type;
    var bits = incident.casualties + ' casualt' + (incident.casualties === 1 ? 'y' : 'ies');
    if (incident.trapped) bits += ', ' + incident.trapped + ' trapped';
    return match.unit.id + ' dispatched to ' + incident.code + ': nearest ' +
      match.unit.kind + ' unit, ' + match.etaMin + ' min ETA, ' + label.toLowerCase() +
      ', ' + bits + '.';
  }

  function noUnitRationale(incident) {
    return 'No available unit can handle ' + incident.code +
      ' (' + (TYPE_LABELS[incident.type] || incident.type).toLowerCase() +
      ') — held in queue until a unit frees up.';
  }

  return {
    TYPE_WEIGHTS: TYPE_WEIGHTS,
    TYPE_LABELS: TYPE_LABELS,
    REQUIRED_CAPABILITY: REQUIRED_CAPABILITY,
    triageBreakdown: triageBreakdown,
    triageScore: triageScore,
    priorityFor: priorityFor,
    triage: triage,
    haversineKm: haversineKm,
    etaMinutes: etaMinutes,
    requiredCapabilities: requiredCapabilities,
    unitCanHandle: unitCanHandle,
    matchUnit: matchUnit,
    sortQueue: sortQueue,
    ruleRationale: ruleRationale,
    noUnitRationale: noUnitRationale
  };
});
