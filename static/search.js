const out = document.getElementById('out');
const input = document.getElementById('q');
const form = document.getElementById('search-form');
const status = document.getElementById('search-status');
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const fmt = r => [r.type, r.premiered, r.rating != null ? '★ ' + r.rating + ' (' + (r.votes || 0).toLocaleString() + ')' : ''].filter(Boolean).join(' · ');
const get = async url => {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};

let timer, sequence = 0, query = '';

function setStatus(message) {
  status.textContent = message;
}

function routeUrl(view, id = null) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (view === 'title') params.set('title', id);
  if (view === 'person') params.set('person', id);
  const search = params.toString();
  return search ? `/?${search}` : '/';
}

function setRoute(view, id = null, fromView = null, replace = false) {
  const state = {view, id, query, fromView};
  history[replace ? 'replaceState' : 'pushState'](state, '', routeUrl(view, id));
}

function list(rows, titleOf, metaOf, onSelect) {
  const ul = el('ul');
  ul.className = 'result-list';
  rows.forEach(r => {
    const li = el('li');
    const button = el('button', null, 'result-link');
    button.type = 'button';
    button.append(el('span', titleOf(r), 'result-title'), el('span', metaOf(r), 'result-meta m'));
    button.onclick = () => onSelect(r);
    li.appendChild(button);
    ul.appendChild(li);
  });
  return ul;
}

function titleList(rows, onSelect) {
  return list(rows, r => r.primary_title || r.name, r => [fmt(r), r.category].filter(Boolean).join(' · '), onSelect);
}

function focusResults(direction) {
  const buttons = [...out.querySelectorAll('.result-link')];
  if (buttons.length) buttons[direction < 0 ? buttons.length - 1 : 0].focus();
}

function showEmpty(message) {
  out.replaceChildren(el('p', message, 'empty-state'));
}

async function searchTitles(value, requestSequence = ++sequence) {
  clearTimeout(timer);
  if (requestSequence !== sequence) return;
  if (!value) {
    out.replaceChildren();
    setStatus('');
    return;
  }
  out.replaceChildren();
  setStatus('Searching...');
  try {
    const rows = await get('/api/search?q=' + encodeURIComponent(value));
    if (requestSequence !== sequence) return;
    if (!rows.length) {
      setStatus('No titles found. Try another search.');
      return;
    }
    setStatus(`${rows.length} ${rows.length === 1 ? 'title' : 'titles'} found.`);
    out.replaceChildren(titleList(rows, r => showTitle(r.title_id, 'search')));
  } catch {
    if (requestSequence !== sequence) return;
    setStatus('Search failed. Check your connection and try again.');
    const retry = el('button', 'Retry search');
    retry.type = 'button';
    retry.onclick = () => searchTitles(value);
    out.appendChild(retry);
  }
}

function updateSearch(value, immediate = false) {
  query = value.trim();
  input.value = value;
  setRoute('search', null, null, true);
  clearTimeout(timer);
  const requestSequence = ++sequence;
  if (!query) {
    searchTitles('', requestSequence);
    return;
  }
  setStatus('Searching...');
  timer = setTimeout(() => searchTitles(query, requestSequence), immediate ? 0 : 250);
}

input.addEventListener('input', () => updateSearch(input.value));
input.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusResults(1);
  }
});
form.addEventListener('submit', event => {
  event.preventDefault();
  updateSearch(input.value, true);
});

out.addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
  const buttons = [...out.querySelectorAll('.result-link')];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    input.focus();
  } else if (event.key === 'ArrowDown' && index < buttons.length - 1) {
    event.preventDefault();
    buttons[index + 1].focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (index > 0) buttons[index - 1].focus();
    else input.focus();
  }
});

function backButton(label, expectedView) {
  const button = el('button', '← ' + label, 'back-button');
  button.type = 'button';
  button.onclick = () => {
    if (history.state?.fromView === expectedView) {
      history.back();
      return;
    }
    setRoute('search', null, null, true);
    searchTitles(query);
    input.focus();
  };
  return button;
}

async function showTitle(id, fromView = null) {
  const requestSequence = ++sequence;
  clearTimeout(timer);
  if (fromView) setRoute('title', id, fromView);
  out.replaceChildren();
  setStatus('Loading title...');
  try {
    const data = await get('/api/title/' + encodeURIComponent(id));
    if (requestSequence !== sequence) return;
    const title = data.title;
    const heading = el('h2', title.primary_title);
    const details = el('p', [fmt(title), title.genres].filter(Boolean).join(' · '), 'detail-meta m');
    const cast = list(data.cast, person => person.name,
      person => [person.category, person.characters].filter(Boolean).join(' · '),
      person => showPerson(person.person_id, 'title'));
    out.replaceChildren(backButton('Back to results', 'search'), heading, details, cast);
    setStatus(`${data.cast.length} cast and crew members shown.`);
  } catch {
    if (requestSequence !== sequence) return;
    setStatus('Could not load this title. It may no longer be available.');
    out.replaceChildren(backButton('Back to results', 'search'));
  }
}

async function showPerson(id, fromView = null) {
  const requestSequence = ++sequence;
  clearTimeout(timer);
  if (fromView) setRoute('person', id, fromView);
  out.replaceChildren();
  setStatus('Loading person...');
  try {
    const data = await get('/api/person/' + encodeURIComponent(id));
    if (requestSequence !== sequence) return;
    const heading = el('h2', data.person.name);
    const titles = titleList(data.titles, title => showTitle(title.title_id, 'person'));
    out.replaceChildren(backButton('Back to title', 'title'), heading, titles);
    setStatus(`${data.titles.length} titles shown.`);
  } catch {
    if (requestSequence !== sequence) return;
    setStatus('Could not load this person. They may no longer be available.');
    out.replaceChildren(backButton('Back to results', 'search'));
  }
}

function restoreRoute() {
  clearTimeout(timer);
  const params = new URLSearchParams(location.search);
  query = params.get('q') || '';
  input.value = query;
  sequence++;
  const titleId = params.get('title');
  const personId = params.get('person');
  if (titleId) showTitle(titleId);
  else if (personId) showPerson(personId);
  else searchTitles(query);
}

window.addEventListener('popstate', restoreRoute);

const initialParams = new URLSearchParams(location.search);
query = initialParams.get('q') || '';
input.value = query;
history.replaceState({
  view: initialParams.has('title') ? 'title' : initialParams.has('person') ? 'person' : 'search',
  id: initialParams.get('title') || initialParams.get('person'),
  query,
  fromView: null,
}, '', location.pathname + location.search);
restoreRoute();
