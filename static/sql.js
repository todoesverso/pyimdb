const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const sqlEditor = window.CodeMirror ? window.CodeMirror.fromTextArea($('sql'), {
  mode: 'text/x-sqlite',
  lineNumbers: true,
  lineWrapping: true,
  matchBrackets: true,
  autoCloseBrackets: true,
  extraKeys: {
    'Ctrl-Enter': () => run(),
    'Cmd-Enter': () => run(),
  },
}) : null;

function sqlValue() {
  return sqlEditor ? sqlEditor.getValue() : $('sql').value;
}

function setSqlValue(value) {
  if (sqlEditor) sqlEditor.setValue(value);
  else $('sql').value = value;
}

function focusSql() {
  if (sqlEditor) sqlEditor.focus();
  else $('sql').focus();
}

const HISTORY_KEY = 'imdb-sql-history';
const MAX_HISTORY = 10;

function readHistory() {
  try {
    const items = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(items) ? items.filter(item => typeof item === 'string').slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

let queryHistory = readHistory();

function renderHistory() {
  const select = $('query-history');
  select.replaceChildren(el('option', queryHistory.length ? 'Choose a recent query' : 'No recent queries'));
  queryHistory.forEach((sql, index) => {
    const option = el('option', sql.split('\n')[0].slice(0, 80));
    option.value = index;
    select.appendChild(option);
  });
  $('clear-history').disabled = queryHistory.length === 0;
}

function saveHistory(sql) {
  sql = sql.trim();
  if (!sql) return;
  queryHistory = [sql, ...queryHistory.filter(item => item !== sql)].slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(queryHistory));
  } catch {
    // Keep the current session usable when storage is unavailable.
  }
  renderHistory();
}

renderHistory();
$('query-history').onchange = event => {
  const sql = queryHistory[+event.target.value];
  if (sql) {
    setSqlValue(sql);
    focusSql();
  }
};
$('clear-history').onclick = () => {
  queryHistory = [];
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // The in-memory history is still cleared.
  }
  renderHistory();
};

// Tables people should reach for first; anything else goes under "Raw tables".
const PREFERRED = ['titles', 'ratings', 'people', 'crew', 'episodes', 'akas'];
const quoteIdentifier = name => '"' + name.replaceAll('"', '""') + '"';

const schemaDisclosure = $('schema-disclosure');
const schemaBreakpoint = window.matchMedia('(max-width: 800px)');
const syncSchemaDisclosure = () => { schemaDisclosure.open = !schemaBreakpoint.matches; };
syncSchemaDisclosure();
schemaBreakpoint.addEventListener('change', syncSchemaDisclosure);

function insertAtCursor(text) {
  if (sqlEditor) {
    sqlEditor.replaceSelection(text);
    sqlEditor.focus();
    return;
  }
  const t = $('sql');
  t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end');
  t.focus();
}

// ---------- schema browser (uses /api/schema: no query budget) ----------
function tableBlock(o) {
  const d = el('details', null, 'tbl');
  const sum = el('summary');
  sum.append(el('span', o.name, 'tname'), el('span', ' ' + o.kind, 'm'));
  const sel = el('button', 'SELECT', 'mini');
  sel.title = 'Insert SELECT * FROM ' + o.name;
  sel.onclick = e => { e.preventDefault(); insertAtCursor('SELECT * FROM ' + o.name + ' LIMIT 10'); };
  sum.appendChild(sel);
  d.appendChild(sum);
  o.columns.forEach(c => {
    const row = el('button', null, 'col');
    row.type = 'button';
    row.append(el('span', c.name), el('span', ' ' + c.type, 'm'));
    row.onclick = () => insertAtCursor(quoteIdentifier(o.name) + '.' + quoteIdentifier(c.name));
    d.appendChild(row);
  });
  return d;
}

function renderSchema(objects) {
  const main = objects.filter(o => PREFERRED.includes(o.name));
  const raw = objects.filter(o => !PREFERRED.includes(o.name));
  const box = $('schema');
  box.replaceChildren(...main.map(tableBlock));
  if (raw.length) {
    const g = el('details', null, 'rawgroup');
    g.appendChild(el('summary', 'Raw tables (' + raw.length + ')'));
    raw.forEach(o => g.appendChild(tableBlock(o)));
    box.appendChild(g);
  }
}

$('schema-filter').oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#schema details.tbl').forEach(d => {
    const hit = !q || d.textContent.toLowerCase().includes(q);
    d.style.display = hit ? '' : 'none';
    d.open = !!q && hit;
  });
  document.querySelectorAll('#schema details.rawgroup').forEach(g => { if (q) g.open = true; });
};

fetch('/api/schema').then(r => r.json()).then(d => renderSchema(d.objects))
  .catch(() => { $('schema').textContent = 'Could not load schema.'; });

// ---------- examples ----------
let examples = [];
let pendingHint = null;  // optional {type, x, y:[...]} from the selected example
function loadExample(i) {
  const e = examples[i];
  if (!e) return;
  pendingHint = e.chart || null;
  setSqlValue(e.sql);
  $('example-desc').textContent = e.description || '';
}
fetch('/static/examples.json').then(r => r.json()).then(list => {
  examples = list;
  list.forEach((e, i) => { const o = el('option', e.title); o.value = i; $('examples').appendChild(o); });
  loadExample(0);
});
$('examples').onchange = e => loadExample(+e.target.value);  // loads only; never runs it

// ---------- results: table + chart ----------
const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
                 '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
const sliceColor = i => i < PALETTE.length ? PALETTE[i] : 'hsl(' + ((i * 47) % 360) + ' 65% 55%)';
const compact = new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1});
const whiteBg = {  // so the downloaded PNG isn't transparent
  id: 'whiteBg',
  beforeDraw(c) {
    const ctx = c.canvas.getContext('2d');
    ctx.save(); ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.restore();
  },
};

let last = null;                       // {columns, rows, numeric[]}
let chart = null;
const prefs = {type: null, x: null, y: []};   // remembered by column name between runs

const isNumericCol = (rows, i) => {
  let seen = false;
  for (const r of rows) {
    if (r[i] === null) continue;
    if (typeof r[i] !== 'number') return false;
    seen = true;
  }
  return seen;
};

function hideResult() {
  last = null;
  $('res').replaceChildren();
  $('tabs').hidden = true;
  $('chart-panel').hidden = true;
  if (chart) { chart.destroy(); chart = null; }
}

function showTab(name) {
  const chartTab = name === 'chart';
  $('tab-table').classList.toggle('active', !chartTab);
  $('tab-chart').classList.toggle('active', chartTab);
  $('res').hidden = chartTab;
  $('chart-panel').hidden = !chartTab;
  if (chartTab) renderChart();   // render only when visible so sizing is right
}
$('tab-table').onclick = () => showTab('table');
$('tab-chart').onclick = () => showTab('chart');

function showResult(d) {
  const t = document.createElement('table'), h = t.createTHead().insertRow();
  d.columns.forEach(c => { const th = document.createElement('th'); th.textContent = c; h.appendChild(th); });
  const b = t.createTBody();
  d.rows.forEach(row => {
    const tr = b.insertRow();
    row.forEach(v => { tr.insertCell().textContent = v === null ? 'NULL' : v; });
  });
  $('res').replaceChildren(t);

  last = {columns: d.columns, rows: d.rows, numeric: d.columns.map((_, i) => isNumericCol(d.rows, i))};
  const plottable = d.rows.length > 0 && last.numeric.some(Boolean);
  const wasChart = $('tab-chart').classList.contains('active');
  $('tabs').hidden = !plottable;
  if (plottable) { configureChart(); showTab(wasChart ? 'chart' : 'table'); }
  else { showTab('table'); $('chart-panel').hidden = true; }
}

// pick X / Y / type: example hint > what the user chose last time > sensible defaults
function configureChart() {
  const cols = last.columns, num = last.numeric;
  const idx = name => cols.indexOf(name);
  let x = -1, ys = [], type = null;

  const hint = pendingHint; pendingHint = null;
  const wanted = hint || prefs;
  if (wanted.x && idx(wanted.x) >= 0 && (wanted.y || []).length
      && wanted.y.every(n => idx(n) >= 0 && num[idx(n)])) {
    x = idx(wanted.x); ys = wanted.y.map(idx); type = wanted.type;
  }
  if (x < 0) {
    x = num.findIndex(n => !n); if (x < 0) x = 0;                 // first text column, else first
    const rest = cols.map((_, i) => i).filter(i => num[i] && i !== x);
    ys = rest.slice(0, 1);
    type = num[x] ? 'line' : 'hbar';                              // years -> line, names -> ranking
  }

  const xs = $('chart-x'); xs.replaceChildren();
  cols.forEach((c, i) => { const o = el('option', c); o.value = i; xs.appendChild(o); });
  xs.value = x;
  $('chart-type').value = type || 'bar';

  buildYBoxes(x, ys);
}

// Y checkboxes: every numeric column except the one used for X
function buildYBoxes(x, checked) {
  const box = $('chart-y');
  box.replaceChildren(el('span', 'Y:', 'm'), document.createTextNode(' '));
  last.columns.forEach((c, i) => {
    if (!last.numeric[i] || i === x) return;
    const lab = el('label'), cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = i; cb.checked = checked.includes(i);
    cb.onchange = onChartChange;
    lab.append(cb, document.createTextNode(' ' + c));
    box.appendChild(lab);
  });
}

const selectedYs = () => [...document.querySelectorAll('#chart-y input:checked')].map(e => +e.value);

function onChartChange() {
  prefs.type = $('chart-type').value;
  prefs.x = last.columns[+$('chart-x').value];
  prefs.y = selectedYs().map(i => last.columns[i]);
  renderChart();
}
$('chart-type').onchange = onChartChange;
$('chart-x').onchange = () => {
  const x = +$('chart-x').value;
  let keep = selectedYs().filter(i => i !== x);
  if (!keep.length) { const f = last.numeric.findIndex((n, i) => n && i !== x); if (f >= 0) keep = [f]; }
  buildYBoxes(x, keep);
  onChartChange();
};

function renderChart() {
  if (chart) { chart.destroy(); chart = null; }
  const msg = t => { $('chart-msg').textContent = t || ''; };
  msg('');
  if (!last) return;
  if (typeof Chart === 'undefined') return msg('Chart.js failed to load.');

  const cols = last.columns, rows = last.rows, num = last.numeric;
  const type = $('chart-type').value, xi = +$('chart-x').value, yis = selectedYs();
  if (!yis.length) return msg('Tick at least one numeric column for Y.');
  if (type === 'scatter' && !num[xi]) return msg('Scatter needs a numeric X column.');

  const labels = rows.map(r => r[xi] === null ? 'NULL' : String(r[xi]));
  const horizontal = type === 'hbar';
  const circular = type === 'pie' || type === 'doughnut';
  if (circular && yis.length > 1) msg('Pie/doughnut charts use only the first Y column.');
  if (!circular && type !== 'scatter' && rows.length > 100) msg(rows.length + ' rows plotted; consider adding LIMIT.');

  $('chart').parentElement.style.height =
    (horizontal ? Math.max(320, rows.length * 26 + 90) : circular ? 440 : 400) + 'px';

  const axisTitle = text => ({display: true, text});
  const valueTicks = {callback: v => compact.format(v)};
  let config;
  if (circular) {
    const yi = yis[0];
    config = {type, data: {labels, datasets: [{
      label: cols[yi], data: rows.map(r => r[yi]),
      backgroundColor: rows.map((_, i) => sliceColor(i)),
    }]}, options: {plugins: {legend: {display: rows.length <= 20, position: 'right'}}}};
  } else if (type === 'scatter') {
    const hover = rows.map(r => String(r[0]));        // first column names each point
    config = {type, data: {datasets: yis.map((yi, k) => ({
      label: cols[yi], data: rows.map(r => ({x: r[xi], y: r[yi]})),
      backgroundColor: PALETTE[k % PALETTE.length], pointRadius: 4,
    }))}, options: {
      scales: {x: {title: axisTitle(cols[xi]), ticks: valueTicks},
               y: {title: yis.length === 1 ? axisTitle(cols[yis[0]]) : {}, ticks: valueTicks}},
      plugins: {tooltip: {callbacks: {label: c =>
        hover[c.dataIndex] + ': (' + c.parsed.x + ', ' + c.parsed.y + ')'}}},
    }};
  } else {
    const valueAxis = {ticks: valueTicks, beginAtZero: type !== 'line'};
    const catAxis = {title: axisTitle(cols[xi])};
    // Series whose scale is >20x different from the first one go on a right-hand axis
    const maxOf = yi => Math.max(1e-9, ...rows.map(r => Math.abs(r[yi] || 0)));
    const base = maxOf(yis[0]);
    const right = yis.map(yi => !horizontal && yis.length > 1 && (maxOf(yi) / base > 20 || base / maxOf(yi) > 20));
    const scales = horizontal ? {x: valueAxis, y: catAxis} : {x: catAxis, y: valueAxis};
    if (right.some(Boolean)) {
      scales.y = Object.assign({}, valueAxis, {title: axisTitle(cols[yis[0]])});
      scales.y2 = Object.assign({}, valueAxis, {position: 'right', grid: {drawOnChartArea: false},
        title: axisTitle(yis.filter((_, k) => right[k]).map(i => cols[i]).join(', '))});
    }
    config = {type: horizontal ? 'bar' : type, data: {labels, datasets: yis.map((yi, k) => ({
      label: cols[yi] + (right[k] ? ' (right axis)' : ''), data: rows.map(r => r[yi]),
      backgroundColor: PALETTE[k % PALETTE.length], borderColor: PALETTE[k % PALETTE.length],
      tension: 0.2, yAxisID: right[k] ? 'y2' : 'y',
    }))}, options: {
      indexAxis: horizontal ? 'y' : 'x',
      scales,
      plugins: {legend: {display: yis.length > 1}},
    }};
  }
  config.options = Object.assign({responsive: true, maintainAspectRatio: false, animation: false}, config.options);
  config.plugins = [whiteBg];
  chart = new Chart($('chart'), config);
}

$('chart-png').onclick = () => {
  if (!chart) return;
  const a = document.createElement('a');
  a.href = $('chart').toDataURL('image/png');
  a.download = 'imdb-chart.png';
  a.click();
};

// ---------- run ----------
async function run() {
  $('run').disabled = true;
  $('err').textContent = '';
  $('status').textContent = 'running...';
  saveHistory(sqlValue());
  try {
    const r = await fetch('/api/query', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sql: sqlValue()}),
    });
    let d;
    try { d = await r.json(); }
    catch { d = {error: r.status === 429 ? 'Too many requests. Slow down.' : 'Server error (' + r.status + ')'}; }

    if (d.error) {
      $('err').textContent = d.error;
      hideResult();
    } else {
      showResult(d);
    }

    if (d.ms !== undefined) {
      $('status').textContent =
        (d.rows ? d.rows.length + ' rows' + (d.truncated ? ' (truncated)' : '') + ' · ' : '') +
        d.ms + ' ms · budget ' + d.budget_left + '/' + d.budget_max + ' s';
    } else {
      $('status').textContent = '';
    }
  } finally {
    $('run').disabled = false;
  }
}

$('run').onclick = run;
$('sql').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });
