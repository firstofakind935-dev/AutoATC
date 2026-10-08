// /developers page behavior: fill in this server's URL in the snippets,
// snippet tabs, the live explorer, and the starter-radar download.

const BASE = location.origin;

for (const el of document.querySelectorAll('.base')) el.textContent = BASE;

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const s of document.querySelectorAll('.snippet')) s.hidden = s.dataset.snippet !== tab.dataset.snippet;
  });
}

const explorerOutput = document.querySelector('#explorer-output code');
const explorerMeta = document.getElementById('explorer-meta');
document.getElementById('explorer-run').addEventListener('click', async () => {
  const path = document.getElementById('explorer-endpoint').value;
  explorerMeta.textContent = 'Loading…';
  const started = performance.now();
  try {
    const res = await fetch(path);
    const body = await res.json();
    const ms = Math.round(performance.now() - started);
    const count = Array.isArray(body.aircraft) ? `, ${body.aircraft.length} aircraft`
      : Array.isArray(body.airports) ? `, ${body.airports.length} airports` : '';
    explorerMeta.textContent = `HTTP ${res.status} in ${ms} ms${count}`;
    explorerOutput.textContent = JSON.stringify(body, null, 2);
  } catch (err) {
    explorerMeta.textContent = '';
    explorerOutput.textContent = `Request failed: ${err.message}`;
  }
});

// The served starter radar uses a placeholder API base so it works from
// any origin it's hosted on; bake this server's origin into the download
// so the saved file still works when opened straight from disk (file://).
document.getElementById('download-starter').addEventListener('click', async () => {
  const html = await fetch('starter-radar.html').then((r) => r.text());
  const blob = new Blob([html.replace('__AUTOATC_API_BASE__', BASE)], { type: 'text/html' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'starter-radar.html';
  link.click();
  URL.revokeObjectURL(link.href);
});
