/**
 * The drive logger: a phone page that records a timed drive along one of
 * the monitored roads. Pick the road and direction, tap Start at the first
 * junction, drive, and the page records GPS (screen kept awake), shows the
 * junctions as they pass, and sends the track when you arrive. The server
 * compares the drive with TomTom's and Google's predictions at departure.
 * The track is kept privately; only the comparison is published.
 */
export function renderDriveApp() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0e1218"><meta name="apple-mobile-web-app-capable" content="yes">
<title>Drive logger</title>
<style>
:root{color-scheme:dark;--bg:#0e1218;--card:#151b24;--line:#243040;--text:#e6edf3;--muted:#9aa4b2;--accent:#52d4ff;--good:#2ecc71;--bad:#e74c3c;--warn:#f1c40f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom))}
main{max-width:520px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}.small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0}
label{display:block;font-size:13px;color:var(--muted);margin:8px 0 4px}
input,select,textarea{width:100%;padding:12px;border-radius:8px;border:1px solid var(--line);background:#0b0f14;color:var(--text);font-size:16px}
button{width:100%;padding:16px;border:0;border-radius:10px;font-size:18px;font-weight:700;margin-top:12px;background:var(--accent);color:#03202b}
button.secondary{background:#243040;color:var(--text);font-size:15px;font-weight:600;padding:12px}button.danger{background:#3a1e22;color:#ffb3bb;font-size:15px;padding:12px}
button:disabled{opacity:.5}
.big{font-size:44px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-1px}
.row{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
ol{padding-left:22px;margin:6px 0}li{margin:3px 0}li.done{color:var(--good)}li.next{color:var(--accent);font-weight:700}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:right}td:first-child,th:first-child{text-align:left}
.ok{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.hide{display:none}
</style></head><body><main>
<h1>Drive logger</h1>
<p class="muted small">Timed drives check our road figures against reality. Your GPS track stays private; only the comparison is published.</p>

<section id="auth" class="card hide">
<label for="key">Map password</label><input id="key" type="password" autocomplete="current-password">
<button id="saveKey">Continue</button><p id="authMsg" class="bad small"></p>
</section>

<section id="pick" class="card hide">
<label for="road">Road and direction</label><select id="road"></select>
<p class="muted small">Junctions on this drive:</p><ol id="stops"></ol>
<p class="small">Start when you reach <b id="firstStop"></b>. Mount the phone, keep this page open and the screen on.</p>
<p id="where" class="small muted"></p>
<button id="start">Start at the first junction</button>
<button id="forget" class="secondary">Change password</button>
</section>

<section id="run" class="card hide">
<div class="row"><span class="muted">Driving</span><span id="gps" class="small muted"></span></div>
<div class="big" id="clock">0:00</div>
<div class="row small"><span>Next: <b id="next"></b></span><span id="nextDist"></span></div>
<p id="pred" class="small muted"></p>
<ol id="progress"></ol>
<label for="note">Anything unusual? (rain, an accident, a diversion)</label><textarea id="note" rows="2"></textarea>
<button id="finish">Finish drive</button>
<button id="cancel" class="danger">Cancel this drive</button>
</section>

<section id="result" class="card hide"></section>

<p class="small muted"><a href="/" style="color:var(--accent)">Chennai roads today</a> · <a href="/methodology" style="color:var(--accent)">how this is used</a></p>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id) => ['auth', 'pick', 'run', 'result'].forEach((s) => $(s).classList.toggle('hide', s !== id));
  const store = {
    get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };
  let key = store.get('gevDriveKey');
  let corridors = [];
  let drive = store.get('gevDriveActive'); // {id, corridor, startedAt, track, passed, prediction}
  let watch = null, lock = null, timer = null, lastFix = null, best = null;

  const km = (a, b) => { const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2; return 12742 * Math.asin(Math.min(1, Math.sqrt(h))); };
  const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Drive-Key': key || '', ...(opts.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || ('HTTP ' + r.status)), { status: r.status });
    return body;
  };

  async function boot() {
    if (!key) return show('auth');
    try { await api('/drives/check'); } catch (e) { if (e.status === 401) { key = null; store.del('gevDriveKey'); $('authMsg').textContent = 'That password did not work.'; return show('auth'); } }
    const c = await fetch('/corridors').then((r) => r.json());
    corridors = c.corridors.filter((x) => x.sectioned);
    if (drive) return resume();
    $('road').innerHTML = corridors.map((x) => '<option value="' + x.id + '">' + x.name + '</option>').join('');
    const last = store.get('gevDriveLastRoad'); if (last && corridors.some((x) => x.id === last)) $('road').value = last;
    renderStops(); show('pick'); locate();
  }
  function current() { return corridors.find((x) => x.id === $('road').value); }
  function renderStops() {
    const c = current(); if (!c) return;
    $('stops').innerHTML = c.stops.map((s) => '<li>' + s.name + '</li>').join('');
    $('firstStop').textContent = c.stops[0].name;
    store.set('gevDriveLastRoad', c.id);
  }
  function locate() {
    if (!navigator.geolocation) return ($('where').textContent = 'This browser cannot share its location.');
    navigator.geolocation.getCurrentPosition((p) => {
      const c = current(); if (!c) return;
      const d = km({ lat: p.coords.latitude, lon: p.coords.longitude }, c.stops[0]);
      $('where').textContent = d < 0.3 ? 'You are at ' + c.stops[0].name + '.' : 'You are ' + (d < 10 ? d.toFixed(1) : Math.round(d)) + ' km from ' + c.stops[0].name + '.';
    }, () => ($('where').textContent = 'Allow location access to log a drive.'), { enableHighAccuracy: true, timeout: 15000 });
  }

  async function start() {
    const c = current();
    $('start').disabled = true;
    try {
      const r = await api('/drives/start', { method: 'POST', body: JSON.stringify({ corridorId: c.id }) });
      drive = { id: r.id, corridor: c, startedAt: Date.now(), track: [], passed: c.stops.map(() => null), prediction: r.prediction };
      store.set('gevDriveActive', drive);
      run();
    } catch (e) { alert('Could not start: ' + e.message); } finally { $('start').disabled = false; }
  }
  function resume() {
    const ok = confirm('A drive on ' + drive.corridor.name + ' is still open. Continue it? (Cancel to discard it.)');
    if (!ok) { cancel(true); return; }
    run();
  }
  async function wake() { try { lock = await navigator.wakeLock?.request('screen'); } catch {} }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && drive) wake(); });

  function run() {
    show('run'); wake();
    const p = drive.prediction;
    $('pred').textContent = p?.tomtomMinutes ? 'At departure TomTom expected ' + Math.round(p.tomtomMinutes) + ' min' + (p.typicalMinutes ? ' (typical for this time: ' + Math.round(p.typicalMinutes) + ')' : '') + '.' : '';
    renderProgress();
    timer = setInterval(() => { $('clock').textContent = fmt((Date.now() - drive.startedAt) / 1000); }, 500);
    watch = navigator.geolocation.watchPosition(onFix, (e) => ($('gps').textContent = 'GPS: ' + e.message), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function nextIndex() { const i = drive.passed.findIndex((t) => t == null); return i < 0 ? drive.passed.length : i; }
  function renderProgress() {
    const n = nextIndex();
    $('progress').innerHTML = drive.corridor.stops.map((s, i) => '<li class="' + (drive.passed[i] ? 'done' : i === n ? 'next' : '') + '">' + s.name + (drive.passed[i] ? ' · ' + fmt((drive.passed[i] - drive.startedAt) / 1000) : '') + '</li>').join('');
    $('next').textContent = n < drive.corridor.stops.length ? drive.corridor.stops[n].name : 'arrived';
  }
  function onFix(pos) {
    const f = { t: pos.timestamp || Date.now(), lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
    $('gps').textContent = 'GPS ±' + f.acc + ' m' + (pos.coords.speed != null ? ' · ' + Math.round(pos.coords.speed * 3.6) + ' km/h' : '');
    if (f.acc > 100) return;
    if (!lastFix || f.t - lastFix.t >= 3000 || km(lastFix, f) >= 0.025) { drive.track.push(f); lastFix = f; if (drive.track.length % 10 === 0) store.set('gevDriveActive', drive); }
    // Junction passing, for the screen only: the server works it out again from the whole track.
    const n = nextIndex(); if (n >= drive.corridor.stops.length) return;
    const d = km(f, drive.corridor.stops[n]);
    $('nextDist').textContent = d < 1 ? Math.round(d * 1000) + ' m' : d.toFixed(1) + ' km';
    if (d <= 0.15 && (!best || best.i !== n || d < best.d)) best = { i: n, d, t: f.t };
    if (best && best.i === n && d > best.d + 0.12) { drive.passed[n] = best.t; best = null; renderProgress(); store.set('gevDriveActive', drive); if (n === drive.corridor.stops.length - 1) finish(); }
    // The last junction: finish when we are on it and then move away, or stay within 60 m for 20 s.
    if (n === drive.corridor.stops.length - 1 && d <= 0.06) { if (!drive.atEnd) drive.atEnd = f.t; else if (f.t - drive.atEnd > 20000) { drive.passed[n] = drive.passed[n] || f.t; finish(); } }
  }
  function stop() { if (watch != null) navigator.geolocation.clearWatch(watch); watch = null; clearInterval(timer); try { lock?.release(); } catch {} }
  async function finish() {
    if (!drive || drive.finishing) return; drive.finishing = true; stop(); $('finish').disabled = true;
    try {
      const r = await api('/drives/' + drive.id + '/finish', { method: 'POST', body: JSON.stringify({ track: drive.track, note: $('note').value }) });
      store.del('gevDriveActive'); drive = null; result(r);
    } catch (e) { drive.finishing = false; $('finish').disabled = false; store.set('gevDriveActive', drive); alert('Could not send the drive (it is saved on this phone; tap Finish again when you have signal): ' + e.message); }
  }
  async function cancel(silent) {
    if (!silent && !confirm('Discard this drive?')) return;
    stop();
    try { await api('/drives/' + drive.id + '/finish', { method: 'POST', body: JSON.stringify({ cancelled: true }) }); } catch {}
    store.del('gevDriveActive'); drive = null; boot();
  }
  function result(r) {
    const d = r.drive, a = r.analysis, legs = a.legs || [], pred = r.predictionLegs || [];
    const pct = (x) => (x == null ? '—' : (x > 0 ? '+' : '') + Math.round(x * 100) + '%');
    const tone = (b) => (b === 'within10' ? 'ok' : b === 'within20' ? 'warn' : 'bad');
    $('result').innerHTML = a.valid
      ? '<h2 style="margin:0 0 6px">' + fmt(a.actualS) + ' door to door</h2>' +
        '<p>TomTom predicted ' + (d.tomtom_pred_s ? fmt(d.tomtom_pred_s) : '—') + ' at departure: <b class="' + tone(d.tomtom_band) + '">' + pct(d.tomtom_error_pct) + '</b>' + (d.google_band ? '. Google: <b class="' + tone(d.google_band) + '">' + ({ within10: 'within 10%', within20: 'within 20%', over: 'over by more than 20%', under: 'under by more than 20%' })[d.google_band] + '</b>' : '') + '.</p>' +
        '<table><tr><th>Stretch</th><th>You</th><th>TomTom</th></tr>' + r.sections.map((s, i) => '<tr><td>' + s.from + ' → ' + s.to + '</td><td>' + (legs[i] == null ? '—' : fmt(legs[i])) + '</td><td>' + (pred[i] == null ? '—' : fmt(pred[i])) + '</td></tr>').join('') + '</table>' +
        '<p class="small muted">Thank you. This drive now counts in the ground-truth figures on the methodology page.</p>'
      : '<h2 style="margin:0 0 6px">Drive not counted</h2><p>' + (a.problems || []).join('; ') + '.</p><p class="small muted">It is kept privately but left out of the figures.</p>';
    $('result').innerHTML += '<button id="again">Log another drive</button>';
    show('result'); $('again').onclick = () => boot();
  }

  $('saveKey').onclick = () => { key = $('key').value.trim(); store.set('gevDriveKey', key); $('authMsg').textContent = ''; boot(); };
  $('forget').onclick = () => { store.del('gevDriveKey'); key = null; show('auth'); };
  $('road').onchange = () => { renderStops(); locate(); };
  $('start').onclick = start; $('finish').onclick = finish; $('cancel').onclick = () => cancel(false);
  boot().catch((e) => alert('Could not load: ' + e.message));
})();
</script></body></html>`;
}
