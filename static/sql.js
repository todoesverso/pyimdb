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

function historyLabel(sql, index) {
  const title = sql.match(/^\s*--\s*(.+?)(?:\r?\n|$)/)?.[1]?.trim();
  const clean = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  const truncate = (text, limit) => text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  const sources = [...clean.matchAll(/\b(?:FROM|JOIN)\s+("(?:[^"]|"")*"|[\w.]+)/gi)]
    .map(match => match[1].replaceAll('"', ''))
    .filter((name, i, names) => names.indexOf(name) === i)
    .slice(0, 3);
  const parts = [
    title ? truncate(title, 36) : '',
    sources.length ? sources.join('+') : '',
  ].filter(Boolean);
  return `${index + 1}. ${parts.join(' · ') || 'SQL query'}`;
}

let queryHistory = readHistory();

function renderHistory() {
  const select = $('query-history');
  select.replaceChildren(el('option', queryHistory.length ? 'Choose a recent query' : 'No recent queries'));
  queryHistory.forEach((sql, index) => {
    const option = el('option', historyLabel(sql, index));
    option.value = index;
    option.title = sql;
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
  $('chart').hidden = false;
  $('chart-fallback').hidden = true;
  $('chart-fallback').replaceChildren();
  $('chart-download').textContent = 'Download PNG';
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
  const cols = last.columns, rows = last.rows, num = last.numeric;
  const type = $('chart-type').value, xi = +$('chart-x').value, yis = selectedYs();
  if (!yis.length) return msg('Tick at least one numeric column for Y.');
  if (type === 'scatter' && !num[xi]) return msg('Scatter needs a numeric X column.');
  if (typeof Chart === 'undefined') return renderFallbackChart(type, xi, yis);

  $('chart').hidden = false;
  $('chart-fallback').hidden = true;
  $('chart-download').textContent = 'Download PNG';

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

const SVG_NS = 'http://www.w3.org/2000/svg';
const FALLBACK_ROWS = 40;

function svgElement(name, attributes = {}, text = null) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  if (text !== null) node.textContent = text;
  return node;
}

function svgText(svg, x, y, text, attributes = {}) {
  const node = svgElement('text', {x, y, fill: '#53625c', 'font-size': 12, ...attributes}, text);
  svg.appendChild(node);
  return node;
}

function makeSvg(width, height, label) {
  return svgElement('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': label,
    xmlns: SVG_NS,
  });
}

function numericDomain(values) {
  let min = Math.min(0, ...values), max = Math.max(0, ...values);
  if (min === max) max = min + 1;
  return {min, max};
}

function fallbackGrid(svg, box, domain, orientation = 'vertical') {
  for (let i = 0; i <= 4; i++) {
    const value = domain.max - (domain.max - domain.min) * i / 4;
    if (orientation === 'vertical') {
      const y = box.top + box.height * i / 4;
      svg.appendChild(svgElement('line', {x1: box.left, x2: box.left + box.width, y1: y, y2: y, stroke: '#d8e0db'}));
      svgText(svg, box.left - 10, y + 4, compact.format(value), {'text-anchor': 'end'});
    } else {
      const x = box.left + box.width * i / 4;
      svg.appendChild(svgElement('line', {x1: x, x2: x, y1: box.top, y2: box.top + box.height, stroke: '#d8e0db'}));
      svgText(svg, x, box.top + box.height + 20, compact.format(value), {'text-anchor': 'middle'});
    }
  }
}

function renderFallbackChart(type, xi, yis) {
  const host = $('chart-fallback');
  const canvas = $('chart');
  canvas.hidden = true;
  host.hidden = false;
  host.replaceChildren();
  $('chart-download').textContent = 'Download SVG';

  const cols = last.columns;
  const rows = last.rows.slice(0, FALLBACK_ROWS);
  const series = yis.slice(0, 4);
  const labels = rows.map(row => row[xi] == null ? 'NULL' : String(row[xi]));
  const values = rows.flatMap(row => series.map(index => row[index]).filter(Number.isFinite));
  if (!values.length) {
    $('chart-msg').textContent = 'No numeric values are available to plot.';
    return;
  }

  const notices = ['Chart.js unavailable; showing a lightweight SVG chart.'];
  if (last.rows.length > FALLBACK_ROWS) notices.push(`Showing the first ${FALLBACK_ROWS} of ${last.rows.length} rows.`);
  if (yis.length > series.length) notices.push('Showing the first four Y series.');
  if ((type === 'pie' || type === 'doughnut') && yis.length > 1) notices.push('Pie charts use the first Y series.');
  $('chart-msg').textContent = notices.join(' ');

  if (type === 'pie' || type === 'doughnut') {
    const yi = series[0];
    let slices = rows.map((row, index) => ({label: labels[index], value: row[yi]}))
      .filter(item => Number.isFinite(item.value) && item.value > 0);
    if (!slices.length) {
      $('chart-msg').textContent += ' Pie charts need at least one positive value.';
      return;
    }
    if (slices.length > 16) {
      const other = slices.slice(15).reduce((sum, item) => sum + item.value, 0);
      slices = [...slices.slice(0, 15), {label: 'Other', value: other}];
      $('chart-msg').textContent += ' Smaller slices are grouped as Other.';
    }
    const width = 960, height = Math.max(420, 50 + slices.length * 25);
    const cx = 250, cy = height / 2, radius = Math.min(178, height / 2 - 20);
    const innerRadius = type === 'doughnut' ? radius * .56 : 0;
    const total = slices.reduce((sum, item) => sum + item.value, 0);
    const svg = makeSvg(width, height, `${type} chart of ${cols[yi]} by ${cols[xi]}`);
    let angle = -Math.PI / 2;
    slices.forEach((slice, index) => {
      const start = angle;
      angle += Math.PI * 2 * slice.value / total;
      const end = angle;
      const color = sliceColor(index);
      const point = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      if (slices.length === 1) {
        svg.appendChild(svgElement('circle', {cx, cy, r: radius, fill: color}));
      } else {
        const [x1, y1] = point(start, radius), [x2, y2] = point(end, radius);
        const large = end - start > Math.PI ? 1 : 0;
        let path;
        if (innerRadius) {
          const [ix2, iy2] = point(end, innerRadius), [ix1, iy1] = point(start, innerRadius);
          path = `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${innerRadius} ${innerRadius} 0 ${large} 0 ${ix1} ${iy1} Z`;
        } else {
          path = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`;
        }
        const slicePath = svgElement('path', {d: path, fill: color, stroke: '#fff', 'stroke-width': 2});
        slicePath.appendChild(svgElement('title', {}, `${slice.label}: ${slice.value}`));
        svg.appendChild(slicePath);
      }
      const y = 38 + index * 25;
      svg.appendChild(svgElement('rect', {x: 500, y: y - 12, width: 13, height: 13, rx: 2, fill: color}));
      const legend = svgText(svg, 522, y, `${slice.label.slice(0, 34)}  ${compact.format(slice.value)}`);
      legend.appendChild(svgElement('title', {}, `${slice.label}: ${slice.value}`));
    });
    if (innerRadius) svg.appendChild(svgElement('circle', {cx, cy, r: innerRadius, fill: '#fff'}));
    host.appendChild(svg);
    return;
  }

  if (type === 'bar' || type === 'hbar') {
    const horizontal = type === 'hbar';
    const width = 1000;
    const height = horizontal ? Math.max(340, 45 + rows.length * 27) : 450;
    const box = horizontal
      ? {left: 190, top: 22, width: width - 225, height: height - 62}
      : {left: 72, top: 24, width: width - 96, height: height - 140};
    const domain = numericDomain(values);
    const svg = makeSvg(width, height, `${type} chart of ${series.map(i => cols[i]).join(', ')}`);
    const grid = svgElement('g');
    fallbackGrid(grid, box, domain, horizontal ? 'horizontal' : 'vertical');
    svg.appendChild(grid);
    const scale = value => horizontal
      ? box.left + (value - domain.min) / (domain.max - domain.min) * box.width
      : box.top + (domain.max - value) / (domain.max - domain.min) * box.height;
    const zero = scale(0);
    rows.forEach((row, rowIndex) => {
      if (horizontal) {
        const slot = box.height / rows.length;
        const barHeight = Math.max(2, slot * .72 / series.length);
        series.forEach((yi, seriesIndex) => {
          const value = row[yi];
          if (!Number.isFinite(value)) return;
          const y = box.top + rowIndex * slot + (slot - barHeight * series.length) / 2 + seriesIndex * barHeight;
          const end = scale(value), start = Math.min(zero, end);
          const rect = svgElement('rect', {x: start, y, width: Math.max(1, Math.abs(end - zero)), height: barHeight - 2, fill: sliceColor(seriesIndex), rx: 2});
          rect.appendChild(svgElement('title', {}, `${labels[rowIndex]} · ${cols[yi]}: ${value}`));
          svg.appendChild(rect);
        });
        svgText(svg, box.left - 10, box.top + rowIndex * box.height / rows.length + box.height / rows.length * .68, labels[rowIndex].slice(0, 24), {'text-anchor': 'end'});
      } else {
        const slot = box.width / rows.length;
        const groupWidth = slot * .76;
        const barWidth = groupWidth / series.length;
        series.forEach((yi, seriesIndex) => {
          const value = row[yi];
          if (!Number.isFinite(value)) return;
          const x = box.left + rowIndex * slot + (slot - groupWidth) / 2 + seriesIndex * barWidth;
          const end = scale(value), top = Math.min(zero, end);
          const rect = svgElement('rect', {x, y: top, width: Math.max(1, barWidth - 2), height: Math.max(1, Math.abs(end - zero)), fill: sliceColor(seriesIndex), rx: 2});
          rect.appendChild(svgElement('title', {}, `${labels[rowIndex]} · ${cols[yi]}: ${value}`));
          svg.appendChild(rect);
        });
        const label = svgText(svg, box.left + rowIndex * slot + slot * .5, height - 14, labels[rowIndex].slice(0, 20), {
          'text-anchor': 'end', transform: `rotate(-38 ${box.left + rowIndex * slot + slot * .5} ${height - 14})`,
        });
        label.appendChild(svgElement('title', {}, labels[rowIndex]));
      }
    });
    if (series.length > 1) series.forEach((yi, index) => {
      const x = horizontal ? 195 + index * 170 : 75 + index * 170;
      const y = horizontal ? height - 14 : 15;
      svg.appendChild(svgElement('rect', {x, y: y - 10, width: 10, height: 10, fill: sliceColor(index)}));
      svgText(svg, x + 15, y, cols[yi].slice(0, 22));
    });
    host.appendChild(svg);
    return;
  }

  if (type === 'line' || type === 'scatter') {
    const width = 1000, height = 440;
    const box = {left: 76, top: 24, width: width - 110, height: height - 105};
    const xValues = type === 'scatter' ? rows.map(row => row[xi]).filter(Number.isFinite) : [];
    let xMin = Math.min(...xValues), xMax = Math.max(...xValues);
    if (type === 'scatter' && xMin === xMax) { xMin -= 1; xMax += 1; }
    const yDomain = numericDomain(values);
    const svg = makeSvg(width, height, `${type} chart of ${series.map(i => cols[i]).join(', ')}`);
    const grid = svgElement('g');
    fallbackGrid(grid, box, yDomain);
    if (type === 'scatter') {
      for (let i = 0; i <= 4; i++) {
        const value = xMin + (xMax - xMin) * i / 4;
        const x = box.left + box.width * i / 4;
        grid.appendChild(svgElement('line', {x1: x, x2: x, y1: box.top, y2: box.top + box.height, stroke: '#e8eeea'}));
        svgText(grid, x, box.top + box.height + 20, compact.format(value), {'text-anchor': 'middle'});
      }
    }
    svg.appendChild(grid);
    const mapY = value => box.top + (yDomain.max - value) / (yDomain.max - yDomain.min) * box.height;
    series.forEach((yi, seriesIndex) => {
      const color = sliceColor(seriesIndex);
      if (type === 'scatter') {
        rows.forEach((row, index) => {
          if (!Number.isFinite(row[xi]) || !Number.isFinite(row[yi])) return;
          const x = box.left + (row[xi] - xMin) / (xMax - xMin) * box.width;
          const circle = svgElement('circle', {cx: x, cy: mapY(row[yi]), r: 4, fill: color, opacity: .82});
          circle.appendChild(svgElement('title', {}, `${String(row[0])} · ${cols[xi]}: ${row[xi]} · ${cols[yi]}: ${row[yi]}`));
          svg.appendChild(circle);
        });
      } else {
        const points = rows.map((row, index) => ({
          x: box.left + (rows.length === 1 ? .5 : index / (rows.length - 1)) * box.width,
          y: Number.isFinite(row[yi]) ? mapY(row[yi]) : null,
          value: row[yi],
          label: labels[index],
        }));
        let path = '', active = false;
        points.forEach(point => {
          if (point.y === null) { active = false; return; }
          path += `${active ? 'L' : 'M'} ${point.x} ${point.y} `;
          active = true;
        });
        svg.appendChild(svgElement('path', {d: path, fill: 'none', stroke: color, 'stroke-width': 2.5}));
        points.forEach(point => {
          if (point.y === null) return;
          const circle = svgElement('circle', {cx: point.x, cy: point.y, r: 3.5, fill: color});
          circle.appendChild(svgElement('title', {}, `${point.label} · ${cols[yi]}: ${point.value}`));
          svg.appendChild(circle);
        });
        const stride = Math.max(1, Math.ceil(rows.length / 12));
        points.forEach((point, index) => {
          if (index % stride && index !== points.length - 1) return;
          svgText(svg, point.x, height - 14, point.label.slice(0, 18), {'text-anchor': 'end', transform: `rotate(-35 ${point.x} ${height - 14})`});
        });
      }
    });
    const yAxisLabel = series.map(index => cols[index]).join(', ');
    svgText(svg, 18, box.top + box.height / 2, yAxisLabel, {
      'text-anchor': 'middle', transform: `rotate(-90 18 ${box.top + box.height / 2})`,
    });
    svgText(svg, width / 2, height - 2, cols[xi], {'text-anchor': 'middle'});
    if (series.length > 1) series.forEach((yi, index) => {
      const x = 82 + index * 175;
      svg.appendChild(svgElement('line', {x1: x, x2: x + 18, y1: 15, y2: 15, stroke: sliceColor(index), 'stroke-width': 3}));
      svgText(svg, x + 24, 19, cols[yi].slice(0, 20));
    });
    host.appendChild(svg);
    return;
  }
  $('chart-msg').textContent = 'This chart type is unavailable in the SVG fallback.';
}

$('chart-download').onclick = () => {
  if (chart) {
    const a = document.createElement('a');
    a.href = $('chart').toDataURL('image/png');
    a.download = 'imdb-chart.png';
    a.click();
    return;
  }
  const svg = $('chart-fallback').querySelector('svg');
  if (!svg) return;
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], {type: 'image/svg+xml;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'imdb-chart.svg';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function loadChartLibrary() {
  if (window.Chart) return;
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js';
  script.async = true;
  script.onload = () => {
    $('chart-download').textContent = 'Download PNG';
    if (last && $('tab-chart').classList.contains('active')) renderChart();
  };
  script.onerror = () => {
    if (last && $('tab-chart').classList.contains('active')) renderChart();
  };
  document.head.appendChild(script);
}
loadChartLibrary();

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
