/**
 * The public "measuring changes" page: every change on record with its
 * evaluation, the method in plain words, and a form that evaluates any
 * road from any date, so an official can test a change themselves.
 */
import { impactText, MIN } from './impact.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ist = (iso) => (iso ? new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ') : '—');

export function renderImpactPage({ evaluations, corridors, names }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Measuring changes</title>
<style>
:root{--bg:#fff;--text:#111;--muted:#666;--line:#e3e5e8;--accent:#1a5fb4;--card:#f6f7f9}
@media (prefers-color-scheme:dark){:root{--bg:#0e1218;--text:#e6edf3;--muted:#9aa4b2;--line:#243040;--accent:#6cb6ff;--card:#151b24}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:900px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p,li{max-width:78ch}.muted{color:var(--muted)}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.sig{color:#c0392b;font-weight:600}.ok{color:#1e8449;font-weight:600}
label{display:block;font-size:13px;color:var(--muted);margin:8px 0 3px}select,input{width:100%;padding:9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}button{margin-top:12px;padding:10px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:15px;font-weight:600}
#out{margin-top:12px}
</style></head><body><main>
<h1>Measuring changes</h1>
<p class="muted"><a href="/">Chennai roads today</a> · <a href="/methodology">method and limits</a></p>
<p>When a road changes (a closed U-turn, a new signal plan, a diversion), this page measures what it did to the drive. The changed road is compared with the untouched monitored roads, before and after, at the same times of day, so citywide effects like rain, holidays and school traffic cancel out. The range comes from resampling whole days, and a placebo check runs the same test on untouched roads to show how often it would raise a false alarm. A change needs at least ${MIN.preDays} days recorded before it.</p>

<h2>Changes on record</h2>
${evaluations.length ? evaluations.map((e) => `<div class="card"><b>${esc(e.title)}</b><div class="muted">${esc(ist(e.start))}${e.end ? ` to ${esc(ist(e.end))}` : ' onwards'} IST${e.source ? ` · <a href="${esc(e.source)}">source</a>` : ''}</div><ul>${e.results.map((r) => `<li class="${r.result.status === 'significant' ? 'sig' : ''}">${esc(impactText({ ...r.result, corridor: r.result.corridor || r.corridor }, names))}</li>`).join('')}</ul></div>`).join('') : '<p class="muted">No changes recorded yet.</p>'}

<h2>Evaluate a change yourself</h2>
<div class="card">
<div class="grid">
<div><label for="c">Road and direction</label><select id="c">${corridors.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
<div><label for="s">Change started (IST)</label><input id="s" type="datetime-local"></div>
<div><label for="e">Change ended (IST, blank if still in place)</label><input id="e" type="datetime-local"></div>
<div><label for="h">Only these hours (optional, e.g. 16:00-21:00)</label><input id="h" placeholder="all day"></div>
</div>
<button id="go">Evaluate</button>
<div id="out" class="muted">The result appears here.</div>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const toIso = (v) => (v ? new Date(v + ':00+05:30').toISOString() : '');
  $('go').onclick = async () => {
    const q = new URLSearchParams({ corridor: $('c').value, start: toIso($('s').value) });
    if ($('e').value) q.set('end', toIso($('e').value));
    if ($('h').value.trim()) q.set('hours', $('h').value.trim());
    if (!q.get('start')) return ($('out').textContent = 'Choose when the change started.');
    $('out').textContent = 'Working…';
    try {
      const r = await fetch('/impact/evaluate?' + q).then((x) => x.json());
      $('out').innerHTML = r.error ? r.error : '<b>' + r.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</b>';
    } catch (e) { $('out').textContent = 'Could not evaluate: ' + e.message; }
  };
})();
</script>
</main></body></html>`;
}
