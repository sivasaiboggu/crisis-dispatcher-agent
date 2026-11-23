/* Crisis Dispatcher — scenario scripts + unit roster.
 * Fictional incident points on a real Hyderabad geography.
 * Deterministic: events are a fixed timeline, no randomness. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CrisisScenarios = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // City centre: Hyderabad 17.3850, 78.4867. Places are real area names;
  // incident points are fictional, for training only.
  var PLACES = {
    begumBazaar: { lat: 17.3858, lng: 78.4745, label: 'Begum Bazaar, Market Rd' },
    tankBund: { lat: 17.4156, lng: 78.4750, label: 'Tank Bund Rd, near Secretariat' },
    abids: { lat: 17.3930, lng: 78.4740, label: 'Abids Circle' },
    secunderabad: { lat: 17.4399, lng: 78.4983, label: 'Secunderabad, MG Rd' },
    koti: { lat: 17.3850, lng: 78.4867, label: 'Koti, Bank St' },
    charminar: { lat: 17.3616, lng: 78.4747, label: 'Charminar, Laad Bazaar' },
    banjara: { lat: 17.4126, lng: 78.4431, label: 'Banjara Hills, Rd No. 12' },
    malakpet: { lat: 17.3726, lng: 78.4996, label: 'Malakpet, Dilsukhnagar Rd' }
  };

  function unit(id, kind, capabilities, base) {
    return {
      id: id, kind: kind, capabilities: capabilities,
      baseLat: base.lat, baseLng: base.lng, lat: base.lat, lng: base.lng,
      status: 'available', assignedIncidentId: null, etaMin: null,
      // movement animation state (app-side)
      fromLat: base.lat, fromLng: base.lng, toLat: base.lat, toLng: base.lng,
      moveStart: 0, moveDuration: 0, dwellUntil: 0
    };
  }

  function roster() {
    return [
      unit('A-1', 'ALS ambulance', ['ALS'], { lat: 17.3950, lng: 78.4820 }),
      unit('A-2', 'ALS ambulance', ['ALS'], { lat: 17.4050, lng: 78.4700 }),
      unit('A-3', 'ALS ambulance', ['ALS'], { lat: 17.3750, lng: 78.4900 }),
      unit('A-4', 'ALS ambulance', ['ALS'], { lat: 17.4250, lng: 78.4800 }),
      unit('B-1', 'BLS ambulance', ['BLS'], { lat: 17.3900, lng: 78.4600 }),
      unit('B-2', 'BLS ambulance', ['BLS'], { lat: 17.3650, lng: 78.4800 }),
      unit('F-1', 'Fire engine', ['fire'], { lat: 17.4000, lng: 78.4750 }),
      unit('F-2', 'Fire engine', ['fire'], { lat: 17.3800, lng: 78.4950 }),
      unit('P-1', 'Police patrol', ['police'], { lat: 17.3880, lng: 78.4780 }),
      unit('P-2', 'Police patrol', ['police'], { lat: 17.4150, lng: 78.4900 }),
      unit('R-1', 'Rescue unit', ['rescue', 'ALS'], { lat: 17.3920, lng: 78.4720 })
    ];
  }

  var SCENARIOS = [
    {
      id: 'collapse',
      name: 'Market building collapse',
      blurb: '12-casualty collapse plus 3 concurrent incidents. The headline demo, about 90 seconds.',
      durationSec: 120,
      events: [
        { t: 0, type: 'collapse', casualties: 12, trapped: 4, place: 'begumBazaar', note: 'Three-storey market building, partial collapse reported by shopkeepers.' },
        { t: 8, type: 'road-traffic', casualties: 2, trapped: 0, place: 'abids', note: 'Two-car collision, one driver trapped in vehicle.' },
        { t: 18, type: 'fire', casualties: 3, trapped: 0, place: 'koti', note: 'Shop fire, smoke reported from first floor.' },
        { t: 30, type: 'medical', casualties: 1, trapped: 0, place: 'charminar', note: 'Chest pain, 62-year-old, bystander on phone.' },
        { t: 45, type: 'road-traffic', casualties: 1, trapped: 0, place: 'malakpet', note: 'Scooter vs bus, rider conscious.' }
      ]
    },
    {
      id: 'monsoon',
      name: 'Monsoon evening',
      blurb: 'Six staggered incidents across the city over two minutes.',
      durationSec: 150,
      events: [
        { t: 0, type: 'road-traffic', casualties: 3, trapped: 1, place: 'secunderabad', note: 'Bus and auto collision in heavy rain.' },
        { t: 15, type: 'fire', casualties: 2, trapped: 0, place: 'banjara', note: 'Electrical fire, apartment block.' },
        { t: 35, type: 'medical', casualties: 1, trapped: 0, place: 'tankBund', note: 'Breathing difficulty, elderly caller.' },
        { t: 55, type: 'hazmat', casualties: 2, trapped: 0, place: 'malakpet', note: 'Chemical smell from a godown, two workers dizzy.' },
        { t: 75, type: 'crime', casualties: 1, trapped: 0, place: 'koti', note: 'Assault reported, victim waiting at the junction.' },
        { t: 100, type: 'road-traffic', casualties: 4, trapped: 0, place: 'abids', note: 'Four-vehicle pile-up, rain-slick road.' }
      ]
    },
    {
      id: 'quiet',
      name: 'Quiet night',
      blurb: 'Two minor incidents. For showing the board at its calmest.',
      durationSec: 90,
      events: [
        { t: 0, type: 'medical', casualties: 1, trapped: 0, place: 'banjara', note: 'Fall at home, ankle injury.' },
        { t: 20, type: 'road-traffic', casualties: 1, trapped: 0, place: 'tankBund', note: 'Minor collision, no injuries reported beyond one person.' }
      ]
    }
  ];

  // Inject pool: what-if incidents the user can add mid-demo.
  var INJECT_PLACES = ['tankBund', 'abids', 'koti', 'banjara'];

  return { PLACES: PLACES, roster: roster, SCENARIOS: SCENARIOS, INJECT_PLACES: INJECT_PLACES };
});
