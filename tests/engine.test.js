/* Crisis Dispatcher — engine + scenario tests. Run: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const S = require('../src/scenarios.js');
const G = require('../src/gemini.js');

function mkUnit(id, kind, caps, lat, lng, status) {
  return { id, kind, capabilities: caps, lat, lng, status: status || 'available' };
}
function mkIncident(type, casualties, trapped, lat, lng) {
  return { type, casualties: casualties || 0, trapped: trapped || 0, lat: lat || 0, lng: lng || 0 };
}

/* --- triage --- */
test('collapse with 12 casualties and 4 trapped scores 95 (30+40+15+10)', () => {
  assert.equal(E.triageScore(mkIncident('collapse', 12, 4)), 95);
});
test('casualty points cap at 40 (20 casualties still 40)', () => {
  assert.equal(E.triageBreakdown(mkIncident('fire', 20, 0)).casualties, 40);
});
test('no trapped adds 0, trapped adds 15', () => {
  assert.equal(E.triageBreakdown(mkIncident('medical', 1, 0)).trapped, 0);
  assert.equal(E.triageBreakdown(mkIncident('medical', 1, 2)).trapped, 15);
});
test('surge bonus only at 10+ casualties', () => {
  assert.equal(E.triageBreakdown(mkIncident('fire', 9, 0)).surge, 0);
  assert.equal(E.triageBreakdown(mkIncident('fire', 10, 0)).surge, 10);
});
test('score never exceeds 100 across every type and casualty count', () => {
  Object.keys(E.TYPE_WEIGHTS).forEach((type) => {
    for (let c = 0; c <= 30; c++) {
      assert.ok(E.triageScore(mkIncident(type, c, 5)) <= 100, type + ' ' + c);
    }
  });
  // the highest reachable score with current weights is 95
  assert.equal(E.triageScore(mkIncident('collapse', 30, 5)), 95);
});
test('priority bands: 70+ P1, 45+ P2, 25+ P3, else P4', () => {
  assert.equal(E.priorityFor(70), 'P1');
  assert.equal(E.priorityFor(69), 'P2');
  assert.equal(E.priorityFor(45), 'P2');
  assert.equal(E.priorityFor(44), 'P3');
  assert.equal(E.priorityFor(25), 'P3');
  assert.equal(E.priorityFor(24), 'P4');
});
test('triage() returns score, severity and breakdown together', () => {
  const t = E.triage(mkIncident('collapse', 12, 4));
  assert.equal(t.score, 95);
  assert.equal(t.severity, 'P1');
  assert.deepEqual(t.breakdown, { type: 30, casualties: 40, trapped: 15, surge: 10 });
});
test('single-casualty medical scores 26 (18 + 8) and is P3', () => {
  const t = E.triage(mkIncident('medical', 1, 0));
  assert.equal(t.score, 26);
  assert.equal(t.severity, 'P3');
});

/* --- geography --- */
test('haversine: 1 degree of latitude is about 111 km', () => {
  const d = E.haversineKm({ lat: 17.0, lng: 78.0 }, { lat: 18.0, lng: 78.0 });
  assert.ok(Math.abs(d - 111.19) < 0.5, 'got ' + d);
});
test('haversine: same point is 0 km', () => {
  assert.equal(E.haversineKm({ lat: 17.38, lng: 78.48 }, { lat: 17.38, lng: 78.48 }), 0);
});
test('haversine: Begum Bazaar to Abids is roughly 0.8 km', () => {
  const d = E.haversineKm(S.PLACES.begumBazaar, S.PLACES.abids);
  assert.ok(d > 0.7 && d < 1.0, 'got ' + d);
});
test('ETA: 0 km is 2 min (turnout), 5.5 km is 12 min', () => {
  assert.equal(E.etaMinutes(0), 2);
  assert.equal(E.etaMinutes(5.5), 12);
});
test('ETA never drops below 1 min', () => {
  assert.ok(E.etaMinutes(0) >= 1);
});

/* --- matching --- */
test('matcher picks the nearest capable unit', () => {
  const inc = mkIncident('medical', 1, 0, 17.39, 78.48);
  const units = [
    mkUnit('A-1', 'ALS ambulance', ['ALS'], 17.40, 78.48),
    mkUnit('A-2', 'ALS ambulance', ['ALS'], 17.39, 78.481)
  ];
  const m = E.matchUnit(inc, units);
  assert.equal(m.unit.id, 'A-2');
  assert.ok(m.etaMin >= 2);
});
test('matcher skips the nearest unit when it lacks capability, and says why', () => {
  // BLS unit is closest to the collapse, but collapse needs rescue/ALS.
  const inc = mkIncident('collapse', 5, 0, 17.39, 78.48);
  const units = [
    mkUnit('B-1', 'BLS ambulance', ['BLS'], 17.3901, 78.4801),
    mkUnit('R-1', 'Rescue unit', ['rescue', 'ALS'], 17.42, 78.48)
  ];
  const m = E.matchUnit(inc, units);
  assert.equal(m.unit.id, 'R-1');
  assert.equal(m.rejected.length, 1);
  assert.match(m.rejected[0].reason, /B-1/);
  assert.match(m.rejected[0].reason, /no rescue\/ALS capability/);
});
test('fire incident only matches fire units', () => {
  const inc = mkIncident('fire', 2, 0, 17.39, 78.48);
  const units = [
    mkUnit('A-1', 'ALS ambulance', ['ALS'], 17.3901, 78.4801),
    mkUnit('F-1', 'Fire engine', ['fire'], 17.42, 78.48)
  ];
  assert.equal(E.matchUnit(inc, units).unit.id, 'F-1');
});
test('crime incident only matches police', () => {
  const inc = mkIncident('crime', 1, 0, 17.39, 78.48);
  const units = [mkUnit('A-1', 'ALS ambulance', ['ALS'], 17.39, 78.48), mkUnit('P-1', 'Police patrol', ['police'], 17.42, 78.48)];
  assert.equal(E.matchUnit(inc, units).unit.id, 'P-1');
});
test('matcher returns null when no unit can handle the incident', () => {
  const inc = mkIncident('fire', 1, 0, 17.39, 78.48);
  const units = [mkUnit('A-1', 'ALS ambulance', ['ALS'], 17.39, 78.48)];
  assert.equal(E.matchUnit(inc, units), null);
});
test('matcher returns null when every unit is busy', () => {
  const inc = mkIncident('medical', 1, 0, 17.39, 78.48);
  const units = [mkUnit('A-1', 'ALS ambulance', ['ALS'], 17.39, 78.48, 'dispatched')];
  assert.equal(E.matchUnit(inc, units), null);
});
test('matcher tie-breaks on unit id when ETAs are equal', () => {
  const inc = mkIncident('medical', 1, 0, 17.39, 78.48);
  const units = [
    mkUnit('A-2', 'ALS ambulance', ['ALS'], 17.39, 78.48),
    mkUnit('A-1', 'ALS ambulance', ['ALS'], 17.39, 78.48)
  ];
  assert.equal(E.matchUnit(inc, units).unit.id, 'A-1');
});
test('unitCanHandle: ALS covers medical, BLS does not cover collapse', () => {
  assert.equal(E.unitCanHandle(mkUnit('A-1', 'ALS', ['ALS'], 0, 0), mkIncident('medical', 1, 0)), true);
  assert.equal(E.unitCanHandle(mkUnit('B-1', 'BLS', ['BLS'], 0, 0), mkIncident('collapse', 1, 0)), false);
});

/* --- prioritise --- */
test('queue sorts by score desc, then by reported time asc', () => {
  const a = { triageScore: 40, reportedAt: 5 };
  const b = { triageScore: 90, reportedAt: 9 };
  const c = { triageScore: 40, reportedAt: 2 };
  assert.deepEqual(E.sortQueue([a, b, c]), [b, c, a]);
});
test('a P1 never waits behind a P4 in the queue', () => {
  const p4 = { triageScore: 18, reportedAt: 0 };
  const p1 = { triageScore: 95, reportedAt: 30 };
  assert.equal(E.sortQueue([p4, p1])[0], p1);
});

/* --- rationale --- */
test('rule rationale names unit, kind, ETA, type and casualties', () => {
  const inc = { code: 'INC-101', type: 'collapse', casualties: 12, trapped: 4 };
  const text = E.ruleRationale(inc, { unit: { id: 'R-1', kind: 'Rescue unit' }, etaMin: 4 });
  assert.match(text, /R-1 dispatched to INC-101/);
  assert.match(text, /nearest Rescue unit/);
  assert.match(text, /4 min ETA/);
  assert.match(text, /12 casualties, 4 trapped/);
});
test('rule rationale uses singular "casualty" for one person', () => {
  const text = E.ruleRationale(
    { code: 'INC-102', type: 'medical', casualties: 1, trapped: 0 },
    { unit: { id: 'A-1', kind: 'ALS ambulance' }, etaMin: 3 });
  assert.match(text, /1 casualty\./);
});
test('no-unit rationale names the incident and the hold', () => {
  const text = E.noUnitRationale({ code: 'INC-103', type: 'fire' });
  assert.match(text, /INC-103/);
  assert.match(text, /held in queue/);
});

/* --- scenarios / roster --- */
test('roster has 11 units covering every capability', () => {
  const units = S.roster();
  assert.equal(units.length, 11);
  const caps = new Set(units.flatMap((u) => u.capabilities));
  ['ALS', 'BLS', 'fire', 'police', 'rescue'].forEach((c) => assert.ok(caps.has(c), 'missing ' + c));
  units.forEach((u) => assert.equal(u.status, 'available'));
});
test('headline scenario starts with a 12-casualty collapse at t=0', () => {
  const sc = S.SCENARIOS.find((s) => s.id === 'collapse');
  assert.equal(sc.events[0].t, 0);
  assert.equal(sc.events[0].type, 'collapse');
  assert.equal(sc.events[0].casualties, 12);
  assert.equal(sc.events[0].trapped, 4);
  assert.equal(sc.events.length, 5);
});
test('scenario events are in time order and reference known places', () => {
  S.SCENARIOS.forEach((sc) => {
    let prev = -1;
    sc.events.forEach((ev) => {
      assert.ok(ev.t >= prev, sc.id + ' events out of order');
      prev = ev.t;
      assert.ok(S.PLACES[ev.place], sc.id + ' unknown place ' + ev.place);
      assert.ok(E.TYPE_WEIGHTS[ev.type] !== undefined, sc.id + ' unknown type ' + ev.type);
    });
  });
});
test('every scenario event can be matched by at least one roster unit', () => {
  const units = S.roster();
  S.SCENARIOS.forEach((sc) => {
    sc.events.forEach((ev) => {
      const inc = { type: ev.type, casualties: ev.casualties, trapped: ev.trapped, lat: S.PLACES[ev.place].lat, lng: S.PLACES[ev.place].lng };
      assert.ok(E.matchUnit(inc, units), sc.id + ' ' + ev.type + ' has no capable unit');
    });
  });
});
test('headline scenario is fully dispatchable in order with the real roster', () => {
  const units = S.roster().map((u) => ({ ...u }));
  const sc = S.SCENARIOS.find((s) => s.id === 'collapse');
  sc.events.forEach((ev) => {
    const inc = { type: ev.type, casualties: ev.casualties, trapped: ev.trapped, lat: S.PLACES[ev.place].lat, lng: S.PLACES[ev.place].lng };
    const m = E.matchUnit(inc, units);
    assert.ok(m, 'no unit for ' + ev.type + ' at t=' + ev.t);
    m.unit.status = 'dispatched'; // unit is busy for the rest of the flood
  });
});

/* --- gemini layer (static contract only — no key, no network) --- */
test('gemini layer names the verified model and endpoint', () => {
  assert.equal(G.MODEL, 'gemini-2.5-flash');
  assert.equal(G.ENDPOINT, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
});
test('gemini timeout is 8 seconds', () => {
  assert.equal(G.TIMEOUT_MS, 8000);
});
