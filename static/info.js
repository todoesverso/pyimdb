fetch('/api/info').then(r => r.json()).then(d => {
  const f = document.getElementById('info');
  if (!f || !d.updated) return;
  f.textContent = 'Database updated: ' + d.updated.slice(0, 10);
  // hover: exact UTC timestamps
  f.title = 'Built ' + d.updated + (d.source_updated ? '\nIMDb data published ' + d.source_updated : '');
}).catch(() => {});
