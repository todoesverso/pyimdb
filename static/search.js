const out = document.getElementById('out');
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const fmt = r => [r.type, r.premiered, r.rating ? '★ ' + r.rating + ' (' + (r.votes || 0).toLocaleString() + ')' : ''].filter(Boolean).join(' · ');
const get = async u => (await fetch(u)).json();

function list(rows, onclick) {
  const ul = el('ul');
  rows.forEach(r => {
    const li = el('li', r.primary_title || r.name);
    li.appendChild(el('span', ' ' + fmt(r), 'm'));
    li.onclick = () => onclick(r);
    ul.appendChild(li);
  });
  return ul;
}

let timer, searchSequence = 0;
document.getElementById('q').oninput = e => {
  clearTimeout(timer);
  const sequence = ++searchSequence;
  timer = setTimeout(async () => {
    const rows = await get('/api/search?q=' + encodeURIComponent(e.target.value));
    if (sequence !== searchSequence) return;
    out.replaceChildren(list(rows, r => showTitle(r.title_id)));
  }, 250);
};

async function showTitle(id) {
  const sequence = ++searchSequence;
  clearTimeout(timer);
  const d = await get('/api/title/' + id), t = d.title;
  if (sequence !== searchSequence) return;
  out.replaceChildren(el('h2', t.primary_title), el('div', fmt(t) + (t.genres ? ' · ' + t.genres : ''), 'm'));
  const ul = el('ul');
  d.cast.forEach(c => {
    const li = el('li', c.name);
    li.appendChild(el('span', ' ' + c.category + (c.characters ? ' · ' + c.characters : ''), 'm'));
    li.onclick = () => showPerson(c.person_id);
    ul.appendChild(li);
  });
  out.appendChild(ul);
}

async function showPerson(id) {
  const sequence = ++searchSequence;
  clearTimeout(timer);
  const d = await get('/api/person/' + id);
  if (sequence !== searchSequence) return;
  out.replaceChildren(el('h2', d.person.name));
  out.appendChild(list(d.titles, r => showTitle(r.title_id)));
}
