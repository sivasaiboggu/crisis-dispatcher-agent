/* Crisis Dispatcher — optional Gemini rationale layer.
 * One call per dispatch, facts supplied by the engine, never invented
 * by the model. Falls back to the rule-based rationale on any failure.
 * Key lives in localStorage only; it is sent only to Google's API. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CrisisGemini = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODEL = 'gemini-2.5-flash';
  var ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
  var KEY_STORAGE = 'cda.geminiKey';
  var TIMEOUT_MS = 8000;

  function getKey() {
    try { return (localStorage.getItem(KEY_STORAGE) || '').trim() || null; }
    catch (e) { return null; }
  }
  function setKey(k) {
    try { localStorage.setItem(KEY_STORAGE, (k || '').trim()); } catch (e) { /* private mode */ }
  }
  function clearKey() {
    try { localStorage.removeItem(KEY_STORAGE); } catch (e) { /* ignore */ }
  }

  // Rewrite the engine's facts in plain language. The prompt carries the
  // exact numbers; the model only rewords them.
  function rewriteRationale(incident, match, apiKey) {
    var label = incident.typeLabel || incident.type;
    var prompt = 'Rewrite this dispatch decision as one plain sentence, under 30 words, ' +
      'using exactly these facts and no others. Do not add numbers or details.\n' +
      'Unit: ' + match.unit.id + ' (' + match.unit.kind + '). Incident: ' + incident.code +
      ', ' + label + ', ' + incident.casualties + ' casualties' +
      (incident.trapped ? ', ' + incident.trapped + ' trapped' : '') +
      '. ETA: ' + match.etaMin + ' minutes. Reason: nearest unit with the required capability.';
    return callGemini(prompt, apiKey).then(function (text) {
      var clean = (text || '').trim().replace(/^["']|["']$/g, '').split('\n')[0].trim();
      if (!clean || clean.length < 10 || clean.length > 240) throw new Error('unusable rationale');
      return clean;
    });
  }

  function callGemini(prompt, apiKey) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 120, temperature: 0.3 }
      }),
      signal: ctrl.signal
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('Gemini HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var text = data && data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
      if (!text) throw new Error('empty Gemini response');
      return text;
    }).catch(function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function testKey(apiKey) {
    return callGemini('Reply with exactly the word OK and nothing else.', apiKey);
  }

  return {
    MODEL: MODEL, ENDPOINT: ENDPOINT, TIMEOUT_MS: TIMEOUT_MS,
    getKey: getKey, setKey: setKey, clearKey: clearKey,
    rewriteRationale: rewriteRationale, testKey: testKey
  };
});
