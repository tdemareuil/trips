'use strict';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const MODE_LABEL = { car: 'Route', transit: 'Transports', flight: 'Avion', boat: 'Bateau', bus: 'Bus', train: 'Train' };

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');

let data = null;      // { trips, images, routes }
let current = null;   // mounted view: { kind, tripId, goTo?, destroy }

// --- Helpers ---------------------------------------------------------------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Escaped text where [label](https://...) becomes a link.
const rich = s => esc(s).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const fc = features => ({ type: 'FeatureCollection', features });
const EMPTY = fc([]);

// Wikimedia only serves a fixed set of thumbnail widths (500, 960, 1280, 1920...).
const thumb = (url, w) => (url ? url.replace(/\/\d+px-/, `/${w}px-`) : null);

// Teal at the start of the trip, coral at the end.
const dayColor = (i, n) => `hsl(${Math.round(190 - 175 * (n > 1 ? i / (n - 1) : 0))}, 85%, 41%)`;

// Dates are computed in UTC so the displayed day never shifts with the viewer's timezone.
const dateFmt = opts => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', ...opts });
const LONG_DATE = dateFmt({ weekday: 'long', day: 'numeric', month: 'long' });
const SHORT_DATE = dateFmt({ weekday: 'short', day: 'numeric', month: 'short' });
const RANGE_DATE = dateFmt({ day: 'numeric', month: 'long', year: 'numeric' });
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// --- Data ------------------------------------------------------------------

async function loadData() {
  const getJson = url => fetch(url).then(r => (r.ok ? r.json() : {}));
  const [index, images, routes] = await Promise.all([
    getJson('data/trips.json'), getJson('data/images.json'), getJson('data/routes.json'),
  ]);
  const list = await Promise.all(index.map(id => getJson(`data/trips/${id}.json`)));
  data = { trips: {}, images, routes };
  list.forEach(trip => { hydrate(trip); data.trips[trip.id] = trip; });
  data.order = index;
}

// Attach photos, positions and route geometry to a trip, in place.
function hydrate(trip) {
  const img = key => (key && data.images[key]?.url ? data.images[key] : null);
  const lngLat = (coords, wiki) => {
    if (coords) return [coords[1], coords[0]];
    const a = data.images[wiki];
    return a && a.lat != null ? [a.lon, a.lat] : null;
  };
  trip.coverImg = img(trip.cover);
  const start = trip.start ? new Date(`${trip.start}T00:00:00Z`) : null;
  if (start) trip.range = RANGE_DATE.formatRange(start, addDays(start, trip.days.length - 1));
  if (trip.altStart) trip.altLabel = LONG_DATE.format(new Date(`${trip.altStart}T00:00:00Z`));
  trip.days.forEach((day, i) => {
    const qualifier = (day.weekday || '').split(' ').slice(1);
    day.dateLong = start ? capitalize(LONG_DATE.format(addDays(start, i))) : (day.weekday || '');
    day.dateShort = start ? capitalize(SHORT_DATE.format(addDays(start, i))) : (day.weekday || '');
    day.when = start ? qualifier.join(' ') : ''; // "soir" in "Mercredi soir"
    day.color = dayColor(i, trip.days.length);
    day.stops.forEach(s => { s.img = img(s.photo || s.wiki); s.pos = lngLat(s.coords, s.wiki); });
    if (day.stay) day.stay.pos = lngLat(day.stay.coords, day.stay.wiki);
    day.bg = img(day.hero) || day.stops.map(s => s.img).find(Boolean) || trip.coverImg;

    const line = data.routes[trip.id]?.[day.n]?.line;
    const prev = trip.days[i - 1]?.stay?.pos;
    day.dashed = !line;
    day.path = line || [prev, ...day.stops.map(s => s.pos), day.stay?.pos].filter(Boolean);
  });
}

// --- Map helpers -----------------------------------------------------------

const pointFeature = (pos, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: pos } });

function tripFeatures(trip) {
  const routes = [];
  const points = [];
  const seenStays = new Set();
  trip.days.forEach(day => {
    if (day.path.length > 1) {
      routes.push({ type: 'Feature', properties: { day: day.n, color: day.color, dashed: day.dashed }, geometry: { type: 'LineString', coordinates: day.path } });
    }
    day.stops.forEach(s => {
      if (s.pos) points.push(pointFeature(s.pos, { day: day.n, color: day.color, kind: 'stop', name: s.name, img: thumb(s.img?.url, 500) || '' }));
    });
    const stay = day.stay;
    if (stay?.pos && !seenStays.has(stay.name)) {
      seenStays.add(stay.name);
      points.push(pointFeature(stay.pos, { day: day.n, color: day.color, kind: 'stay', name: `Nuit : ${stay.name}`, img: '' }));
    }
  });
  return { routes: fc(routes), points: fc(points) };
}

function addTripLayers(map, trip) {
  const { routes, points } = tripFeatures(trip);
  const layout = { 'line-cap': 'round', 'line-join': 'round' };
  // A cream veil over the basemap (below its labels) tones down its greens and blues
  // while routes and points, added after, keep their colours.
  const firstLabel = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  map.addLayer({ id: 'veil', type: 'background', paint: { 'background-color': '#f5f2ea', 'background-opacity': 0.4 } }, firstLabel);
  map.addSource('routes', { type: 'geojson', data: routes });
  map.addSource('points', { type: 'geojson', data: points });
  map.addSource('active', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', filter: ['==', ['get', 'dashed'], false], layout, paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.4 } });
  map.addLayer({ id: 'routes-dashed', type: 'line', source: 'routes', filter: ['==', ['get', 'dashed'], true], layout, paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.4, 'line-dasharray': [1, 2] } });
  map.addLayer({ id: 'active-glow', type: 'line', source: 'active', layout, paint: { 'line-color': ['get', 'color'], 'line-width': 14, 'line-blur': 10, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'active', type: 'line', source: 'active', layout, paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 } });
  map.addLayer({
    id: 'points', type: 'circle', source: 'points',
    paint: {
      'circle-radius': ['case', ['==', ['get', 'kind'], 'stay'], 6, 4.5],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
      'circle-opacity': 0.8,
      'circle-stroke-opacity': 0.8,
    },
  });
  map.on('mouseenter', 'points', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'points', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'points', e => {
    const f = e.features[0];
    new maplibregl.Popup({ offset: 12, closeButton: false, maxWidth: '240px' })
      .setLngLat(f.geometry.coordinates).setHTML(popupHTML(trip, f.properties)).addTo(map);
  });
}

function createMap(container, trip) {
  const map = new maplibregl.Map({ container, style: STYLE_URL, center: [-119.5, 36.5], zoom: 5, attributionControl: false });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  const ready = new Promise(resolve => map.on('load', () => {
    addTripLayers(map, trip);
    resolve();
  }));
  return { map, ready };
}

function popupHTML(trip, p) {
  const day = trip.days[p.day - 1];
  return `<div class="pop">
    ${p.img ? `<img src="${esc(p.img)}" alt="" onerror="this.remove()">` : ''}
    <div class="pop-body"><strong>${esc(p.name)}</strong><span>Jour ${day.n}${day.dateLong ? ` · ${esc(day.dateLong)}` : ''}</span><a href="#/${trip.id}/${day.n}">Voir le jour →</a></div>
  </div>`;
}

const boundsOf = positions => positions.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds());
const tripPositions = trip => trip.days.flatMap(d => d.path);

function setLayerOpacity(map, { routes, points }) {
  ['routes', 'routes-dashed'].forEach(id => map.setPaintProperty(id, 'line-opacity', routes));
  map.setPaintProperty('points', 'circle-opacity', points);
  map.setPaintProperty('points', 'circle-stroke-opacity', points);
}

// Reveal the first fraction f (0..1) of a path, interpolating the last segment.
function pathUpTo(path, f) {
  const x = f * (path.length - 1);
  const k = Math.floor(x);
  const out = path.slice(0, k + 1);
  if (k < path.length - 1) {
    const [a, b] = [path[k], path[k + 1]];
    const r = x - k;
    out.push([a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r]);
  }
  return out;
}

function drawRoute(map, day, anim) {
  cancelAnimationFrame(anim.raf);
  const src = map.getSource('active');
  map.setPaintProperty('active', 'line-dasharray', day.dashed ? [1, 2] : [1, 0]);
  if (day.path.length < 2) { src.setData(EMPTY); return; }
  const feature = coords => fc([{ type: 'Feature', properties: { color: day.color }, geometry: { type: 'LineString', coordinates: coords } }]);
  const t0 = performance.now();
  const duration = day.dashed ? 900 : 1800;
  const step = now => {
    const t = clamp((now - t0) / duration, 0, 1); // rAF timestamps can precede t0
    src.setData(feature(pathUpTo(day.path, 1 - Math.pow(1 - t, 3))));
    if (t < 1) anim.raf = requestAnimationFrame(step);
  };
  anim.raf = requestAnimationFrame(step);
}

function pinMarker(label, color, { stay = false, delay = 0 } = {}) {
  const el = document.createElement('div');
  el.className = 'pin-wrap';
  el.innerHTML = `<div class="pin${stay ? ' stay' : ''}" style="--c:${color};animation-delay:${delay}ms"><span>${label}</span></div>`;
  return el;
}

// --- Access code -----------------------------------------------------------
// A light gate, not security: the code is checked in the browser against a SHA-256
// hash stored in the trip (`lock`), and the trip data stays readable in the repo.

const UNLOCK_KEY = 'trips-unlocked';
const unlocked = new Set();
try { JSON.parse(sessionStorage.getItem(UNLOCK_KEY) || '[]').forEach(id => unlocked.add(id)); } catch { /* no storage: ask again on reload */ }

const isLocked = trip => Boolean(trip.lock) && !unlocked.has(trip.id);

function markUnlocked(id) {
  unlocked.add(id);
  try { sessionStorage.setItem(UNLOCK_KEY, JSON.stringify([...unlocked])); } catch { /* ignore */ }
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Router ----------------------------------------------------------------

function renderTopbar(trip) {
  const crumb = trip ? `<a class="crumb" href="#/${trip.id}/0">${esc(trip.title)}</a>` : '';
  topbar.innerHTML = `<a class="brand" href="#/">Trips</a>${crumb}`;
}

function route() {
  const [id, arg, sub] = location.hash.replace(/^#\/?/, '').split('/');
  const trip = data.trips[id];
  if (!trip) return show('home');
  if (isLocked(trip)) return show('lock', trip);
  if (arg === 'guide' && trip.guides?.some(g => g.id === sub)) return show('guide', trip, sub);
  show('story', trip, clamp(parseInt(arg, 10) || 0, 0, trip.days.length));
}

function show(kind, trip, slide) { // `slide` is the day for a story, the guide id for a guide
  if (current && kind === 'story' && current.kind === 'story' && current.tripId === trip.id) {
    current.goTo(slide);
    return;
  }
  if (current) current.destroy();
  app.innerHTML = '';
  window.scrollTo(0, 0);
  renderTopbar(trip);
  document.title = trip ? `${trip.title} · Trips` : 'Trips';
  if (kind === 'home') current = mountHome();
  else if (kind === 'lock') current = mountLock(trip);
  else if (kind === 'guide') current = mountGuide(trip, slide);
  else current = mountStory(trip, slide);
}

// --- Home ------------------------------------------------------------------

const LOCK_ICON = '<svg class="lock-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 3.5a2 2 0 1 1 4 0V6H6V4.5Z"/></svg>';

function mountHome() {
  const card = id => {
    const t = data.trips[id];
    const bg = t.coverImg ? `style="--img:url('${thumb(t.coverImg.url, 1280)}')"` : '';
    return `<a class="trip-card" href="#/${t.id}" ${bg}>
      <span class="meta">${isLocked(t) ? LOCK_ICON : ''}${t.days.length} jours</span>
      <h2>${esc(t.title)}</h2>
      <p>${esc(t.subtitle)}</p>
      ${t.range ? `<span class="when">${esc(t.range)}</span>` : ''}
    </a>`;
  };
  const trips = data.order.map(id => data.trips[id]);
  const open = trips.filter(t => !t.done);
  const group = (title, list) => list.length
    ? `<h3 class="home-sub">${title}</h3><div class="cards">${list.map(t => card(t.id)).join('')}</div>` : '';
  const seasons = [...new Set(open.filter(t => t.season).map(t => t.season))];
  const planned = open.filter(t => !t.season);
  const done = trips.filter(t => t.done);
  app.innerHTML = `<section class="home">
    <p class="eyebrow">Prochains voyages</p>
    <h1 class="title big">Où va-t-on ensuite ?</h1>
    <p class="lead">Itinéraires jour par jour, cartes et photos.</p>
    ${planned.length ? `<div class="cards">${planned.map(t => card(t.id)).join('')}</div>` : ''}
    ${seasons.map(se => {
      const list = open.filter(t => t.season === se);
      return `<h2 class="home-section">${esc(se)}</h2>`
        + group('Voyages longs', list.filter(t => t.kind !== 'short'))
        + group('Voyages courts', list.filter(t => t.kind === 'short'));
    }).join('')}
    ${done.length ? `<h2 class="home-section">Voyages réalisés</h2><div class="cards">${done.map(t => card(t.id)).join('')}</div>` : ''}
  </section>`;
  return { kind: 'home', destroy() {} };
}

// --- Lock screen -----------------------------------------------------------

function mountLock(trip) {
  const bg = trip.coverImg ? `style="--img:url('${thumb(trip.coverImg.url, 1920)}')"` : '';
  app.innerHTML = `<section class="lock" ${bg}>
    <form class="lock-card" autocomplete="off">
      <p class="eyebrow">Voyage protégé</p>
      <h1 class="title">${esc(trip.title)}</h1>
      <label class="lead" for="code">Entrez le code pour voir l'itinéraire.</label>
      <input id="code" type="password" autocomplete="off">
      <p class="lock-error" role="alert"></p>
      <button class="cta" type="submit">Déverrouiller <span>→</span></button>
      <a class="lock-back" href="#/">← Retour</a>
    </form>
  </section>`;
  const form = app.querySelector('form');
  const input = app.querySelector('input');
  const error = app.querySelector('.lock-error');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (await sha256(input.value.trim()) === trip.lock) {
      markUnlocked(trip.id);
      route();
      return;
    }
    error.textContent = 'Code incorrect.';
    form.classList.remove('shake');
    void form.offsetWidth; // restart the shake animation
    form.classList.add('shake');
    input.select();
  });
  input.focus();
  return { kind: 'lock', destroy() {} };
}

// --- Guides ----------------------------------------------------------------
// Comparisons and studies attached to a trip: a heading, text, a list or a table.

function blockHTML(b) {
  if (b.type === 'heading') return `<h2 class="g-heading">${esc(b.text)}</h2>`;
  if (b.type === 'text') return `<p class="g-text">${rich(b.text)}</p>`;
  if (b.type === 'list') {
    const tag = b.ordered ? 'ol' : 'ul';
    return `<${tag} class="g-list">${b.items.map(i => `<li>${rich(i)}</li>`).join('')}</${tag}>`;
  }
  if (b.type === 'table') {
    const head = b.columns.map(c => `<th>${esc(c)}</th>`).join('');
    const rows = b.rows.map(r => `<tr>${r.map((c, i) => `<td data-label="${esc(b.columns[i])}">${rich(c)}</td>`).join('')}</tr>`).join('');
    return `<div class="g-table-wrap"><table class="g-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  return '';
}

function mountGuide(trip, gid) {
  const guide = trip.guides.find(g => g.id === gid);
  const chips = trip.guides.map(g => `<a class="chip${g.id === gid ? ' on' : ''}" href="#/${trip.id}/guide/${g.id}">${esc(g.title)}</a>`).join('');
  document.title = `${guide.title} · ${trip.title} · Trips`;
  app.innerHTML = `<article class="guide">
    <a class="guide-back" href="#/${trip.id}/0">← ${esc(trip.title)}</a>
    <p class="eyebrow">Guide &amp; comparatif</p>
    <h1 class="title">${esc(guide.title)}</h1>
    <p class="lead">${esc(guide.summary)}</p>
    ${trip.guides.length > 1 ? `<nav class="chips">${chips}</nav>` : ''}
    ${guide.blocks.map(blockHTML).join('')}
  </article>`;
  return { kind: 'guide', destroy() {} };
}

// --- Story -----------------------------------------------------------------

function mountStory(trip, start) {
  const days = trip.days;
  const N = days.length;
  const credit = '<p class="credits">Photos : Wikipédia / Wikimedia Commons, sous licences libres. Le © de chaque photo renvoie à son auteur.</p>';

  const dots = ['Aperçu', ...days.map(d => `Jour ${d.n}${d.dateLong ? ` · ${d.dateLong}` : ''}`)].map((label, i) => `
    <a class="dot" href="#/${trip.id}/${i}" data-i="${i}" data-label="${esc(label)}" style="left:${(i / N) * 100}%;--c:${i ? days[i - 1].color : '#1b2130'}" aria-label="${esc(label)}">${i || '◎'}</a>`).join('');

  app.innerHTML = `<section class="story">
    <div class="bg"><div class="bg-layer"></div><div class="bg-layer"></div></div>
    <div class="stage">
      <article class="card" aria-live="polite"></article>
      <div class="map-panel"><div class="map"></div><button class="map-reset" type="button">Vue du jour</button></div>
    </div>
    <button class="nav nav-prev" type="button" aria-label="Jour précédent">‹</button>
    <button class="nav nav-next" type="button" aria-label="Jour suivant">›</button>
    <nav class="rail">
      <button class="rail-btn" data-d="-1" type="button" aria-label="Jour précédent">‹</button>
      <div class="track"><div class="track-fill"></div>${dots}</div>
      <button class="rail-btn" data-d="1" type="button" aria-label="Jour suivant">›</button>
    </nav>
  </section>`;

  const $ = sel => app.querySelector(sel);
  const card = $('.card');
  const stage = $('.stage');
  const layers = [...app.querySelectorAll('.bg-layer')];
  const { map, ready } = createMap($('.map'), trip);
  const anim = { raf: 0 };
  let idx = -1;
  let front = 0;
  let bgToken = 0;
  let markers = [];
  let stopPins = []; // marker of each stop by index (a stop without a position has none)

  const go = delta => {
    let j = idx + delta;
    if (j > N) j = 0; // right of the last day: back to the overview
    j = clamp(j, 0, N);
    if (j !== idx) location.hash = `#/${trip.id}/${j}`;
  };

  // --- Background photo, cross-faded
  function setBg(img) {
    const url = img ? thumb(img.url, 1920) : null;
    const token = ++bgToken;
    const swap = () => {
      if (token !== bgToken) return;
      const next = layers[1 - front];
      next.style.backgroundImage = url ? `url("${url}")` : '';
      next.classList.add('on');
      layers[front].classList.remove('on');
      front = 1 - front;
    };
    if (!url) { swap(); return; }
    const im = new Image();
    im.onload = swap;
    im.onerror = swap;
    im.src = url;
  }

  // --- Card
  function introHTML() {
    const stats = [
      [N, 'jours'],
      [days.filter(d => d.stay).length, 'nuits'],
    ].map(([n, label]) => `<div><dt>${n}</dt><dd>${label}</dd></div>`).join('');
    const list = days.map(d => `
      <li><a href="#/${trip.id}/${d.n}" style="--c:${d.color}"><span class="swatch"></span><b>${d.n}</b><span>${esc(d.title)}</span>${d.dateShort ? `<time>${esc(d.dateShort)}</time>` : ''}</a></li>`).join('');
    const guides = trip.guides?.length ? `
      <h2 class="section">Guides &amp; comparatifs</h2>
      <ul class="guides">${trip.guides.map(g => `
        <li><a href="#/${trip.id}/guide/${g.id}"><b>${esc(g.title)}</b><span>${esc(g.summary)}</span></a></li>`).join('')}
      </ul>` : '';
    return `
      <p class="eyebrow">${esc(trip.travelers.join(' & '))}${trip.done ? ' · Voyage réalisé' : ''}</p>
      <h1 class="title big">${esc(trip.title)}</h1>
      ${trip.range ? `<p class="dates">${esc(trip.range)}</p>` : ''}
      ${trip.altLabel ? `<p class="alt-dates">Option : départ le ${esc(trip.altLabel)}</p>` : ''}
      <p class="lead">${esc(trip.subtitle)}</p>
      <dl class="stats">${stats}</dl>
      <a class="cta" href="#/${trip.id}/1">Commencer le voyage <span>→</span></a>
      <h2 class="section">Vue d'ensemble</h2>
      <ol class="overview">${list}</ol>
      ${guides}
      ${credit}`;
  }

  function dayHTML(day) {
    const parts = day.parts ? `<ul class="parts">${day.parts.map(p => `<li><b>${esc(p.label)}</b><span>${rich(p.text)}</span></li>`).join('')}</ul>` : '';
    const stops = day.stops.map((s, k) => {
      const article = data.images[s.wiki];
      const text = s.culture || article?.extract;
      return `
      <div class="stop" data-k="${k}" tabindex="0" role="button" aria-pressed="false" aria-label="${esc(s.name)}">
        <div class="flip">
          <div class="face front${s.img ? '' : ' nophoto'}" style="--c:${day.color}">
            ${s.img ? `<img src="${thumb(s.img.url, 500)}" alt="${esc(s.name)}" loading="lazy" onload="this.classList.add('loaded')" onerror="this.remove()">` : ''}
            <span class="num" style="--c:${day.color}">${k + 1}</span>
            <span class="name">${esc(s.name)}</span>
            <span class="hint" aria-hidden="true">↻</span>
            ${s.img ? `<a class="credit" href="${esc(s.img.page)}" target="_blank" rel="noopener" title="${esc(`Photo : ${s.img.artist || 'Wikimedia Commons'} · ${s.img.license}`)}">©</a>` : ''}
          </div>
          <div class="face back" style="--c:${day.color}">
            <h3>${esc(s.name)}</h3>
            <p>${esc(text || 'Pas encore de notes sur ce lieu.')}</p>
            ${article?.article ? `<a href="${esc(article.article)}" target="_blank" rel="noopener">Wikipédia →</a>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
    const stay = day.stay
      ? `<div class="stay"><span class="glyph">☾</span><div><small>${rich(day.stay.note || 'Nuit à')}</small><b>${esc(day.stay.name)}</b>${day.stay.price ? `<em class="price">${esc(day.stay.price)}</em>` : ''}${day.stay.options?.length ? `<ul class="options">${day.stay.options.map(o => `<li>${rich(o)}</li>`).join('')}</ul>` : ''}</div></div>`
      : day.end ? `<div class="stay"><span class="glyph">✈</span><div><small>Fin du voyage</small><b>${esc(day.end)}</b></div></div>` : '';
    const transport = (day.transport || []).map(t => `<li><span class="mode">${MODE_LABEL[t.mode] || ''}</span>${rich(t.text)}</li>`).join('');
    return `
      <p class="eyebrow" style="--c:${day.color}"><span class="swatch"></span>Jour ${day.n}</p>
      ${day.dateLong ? `<p class="date" style="--c:${day.color}">${esc(day.dateLong)}${day.when ? ` <small>${esc(day.when)}</small>` : ''}</p>` : ''}
      <h1 class="title">${esc(day.title)}</h1>
      <p class="lead">${esc(day.summary)}</p>
      ${parts}
      ${day.stops.length ? `<h2 class="section">Lieux</h2><div class="stops">${stops}</div>` : ''}
      ${stay}
      ${transport ? `<ul class="transport">${transport}</ul>` : ''}
      ${day.food?.length ? `<h2 class="section">Où manger et boire</h2><ul class="food">${day.food.map(f => `<li>${rich(f)}</li>`).join('')}</ul>` : ''}
      ${day.ideas?.length ? `<h2 class="section">Idées, variantes et alternatives</h2><ul class="ideas">${day.ideas.map(i => `<li>${typeof i === 'string' ? rich(i) : `<b>${esc(i.label)}</b> ${rich(i.text)}`}</li>`).join('')}</ul>` : ''}
      ${day.notes?.length ? `<ul class="notes">${day.notes.map(n => `<li>${rich(n)}</li>`).join('')}</ul>` : ''}
      ${credit}`;
  }

  function renderCard(i, dir) {
    card.innerHTML = i === 0 ? introHTML() : dayHTML(days[i - 1]);
    card.dataset.dir = dir;
    [...card.children].forEach((c, n) => c.style.setProperty('--n', n));
    card.scrollTop = 0;
    stage.scrollTop = 0;
    card.classList.remove('enter');
    void card.offsetWidth; // restart the CSS entrance animation
    card.classList.add('enter');
  }

  // --- Rail
  function updateRail(i) {
    $('.track-fill').style.width = `${(i / N) * 100}%`;
    app.querySelectorAll('.dot').forEach(d => {
      const n = +d.dataset.i;
      d.classList.toggle('on', n === i);
      d.classList.toggle('past', n < i);
      d.toggleAttribute('aria-current', n === i);
    });
    $('.nav-prev').disabled = i === 0;
    const last = i === N;
    app.querySelectorAll('.nav-next, .rail-btn[data-d="1"]').forEach(b => {
      b.textContent = last ? '↺' : '›';
      b.setAttribute('aria-label', last ? "Retour à l'aperçu" : 'Jour suivant');
    });
    app.querySelector('.rail-btn[data-d="-1"]').disabled = i === 0;
  }

  // --- Map
  function fitDay(day) {
    const positions = [...day.path, ...day.stops.map(s => s.pos), day.stay?.pos].filter(Boolean);
    map.fitBounds(boundsOf(positions), { padding: 70, maxZoom: 12, pitch: 30, bearing: 0, duration: 1800 });
  }

  async function updateMap(i) {
    await ready;
    if (i !== idx) return;
    markers.forEach(m => m.remove());
    markers = [];
    stopPins = [];
    $('.map-reset').classList.toggle('show', i > 0);
    if (i === 0) {
      cancelAnimationFrame(anim.raf);
      map.getSource('active').setData(EMPTY);
      setLayerOpacity(map, { routes: 0.75, points: 0.9 });
      map.fitBounds(boundsOf(tripPositions(trip)), { padding: 50, pitch: 0, bearing: 0, duration: 2000 });
      return;
    }
    const day = days[i - 1];
    setLayerOpacity(map, { routes: 0.15, points: ['case', ['==', ['get', 'day'], day.n], 0, 0.5] });
    day.stops.forEach((s, k) => {
      if (!s.pos) return;
      const marker = new maplibregl.Marker({ element: pinMarker(k + 1, day.color, { delay: 300 + k * 130 }) }).setLngLat(s.pos).addTo(map);
      markers.push(marker);
      stopPins[k] = marker;
    });
    if (day.stay?.pos) {
      markers.push(new maplibregl.Marker({ element: pinMarker('☾', day.color, { stay: true, delay: 300 + day.stops.length * 130 }) }).setLngLat(day.stay.pos).addTo(map));
    }
    drawRoute(map, day, anim);
    fitDay(day);
  }

  function focusStop(k) {
    const pos = days[idx - 1]?.stops[k]?.pos;
    if (pos) map.flyTo({ center: pos, zoom: 12.5, pitch: 45, duration: 1400 });
  }

  function hotStop(k, on) {
    const pin = stopPins[k]?.getElement().querySelector('.pin');
    if (pin) pin.classList.toggle('hot', on);
  }

  // --- Navigation
  function goTo(i) {
    i = clamp(i, 0, N);
    if (i === idx) return;
    const dir = i > idx || (idx === N && i === 0) ? 'next' : 'prev';
    idx = i;
    setBg(i === 0 ? trip.coverImg : days[i - 1].bg);
    renderCard(i, dir);
    updateRail(i);
    updateMap(i);
  }

  const onKey = e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Home') go(-idx);
    else if (e.key === 'End') go(N - idx);
  };
  document.addEventListener('keydown', onKey);

  $('.nav-prev').addEventListener('click', () => go(-1));
  $('.nav-next').addEventListener('click', () => go(1));
  app.querySelectorAll('.rail-btn').forEach(b => b.addEventListener('click', () => go(+b.dataset.d)));
  $('.map-reset').addEventListener('click', () => idx > 0 && fitDay(days[idx - 1]));

  // A tile flips to its cultural note; flipping it also flies the map to the place.
  function toggleStop(stop) {
    const flipped = stop.classList.toggle('flipped');
    stop.setAttribute('aria-pressed', flipped);
    if (flipped) focusStop(+stop.dataset.k);
  }
  card.addEventListener('click', e => {
    const stop = e.target.closest('.stop');
    if (stop && !e.target.closest('a')) toggleStop(stop);
  });
  card.addEventListener('keydown', e => {
    const stop = e.target.closest('.stop');
    if (stop && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleStop(stop); }
  });
  card.addEventListener('mouseover', e => { const s = e.target.closest('.stop'); if (s) hotStop(+s.dataset.k, true); });
  card.addEventListener('mouseout', e => { const s = e.target.closest('.stop'); if (s) hotStop(+s.dataset.k, false); });

  // Swipe left/right on the text side to change day (the map keeps its own gestures).
  let touch = null;
  stage.addEventListener('touchstart', e => {
    touch = e.target.closest('.map-panel') ? null : [e.touches[0].clientX, e.touches[0].clientY];
  }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch[0];
    const dy = e.changedTouches[0].clientY - touch[1];
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  });

  goTo(start);
  return {
    kind: 'story',
    tripId: trip.id,
    goTo,
    destroy() {
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(anim.raf);
      map.remove();
    },
  };
}

// --- Boot ------------------------------------------------------------------

loadData().then(() => {
  window.addEventListener('hashchange', route);
  route();
}).catch(err => {
  app.innerHTML = `<p class="lead" style="padding:120px 24px">Impossible de charger les voyages : ${esc(err.message)}</p>`;
});
