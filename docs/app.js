/* ARLnow Arlington Neighborhood Lookup — browser app.
 * The border algorithm lives in ./classify.js (shared with the MCP server);
 * the geocoders live in ./geocode.js (shared with the pin-drop builder).
 * This file owns the map and the DOM. */

import { classify, inCounty, parseBlock, describe } from './classify.js';
import { geocode } from './geocode.js';

// Arlington County bounds — used only to constrain the map's pannable area.
const COUNTY_BBOX = [-77.1723, 38.8275, -77.0310, 38.9344];

let hoods = null;          // FeatureCollection of neighborhood polygons
let countyRing = null;     // simplified Arlington County outline
let marker = null;
let hoverId = null;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-77.105, 38.882],
  zoom: 12,
  maxBounds: [
    [COUNTY_BBOX[0] - 0.08, COUNTY_BBOX[1] - 0.06],
    [COUNTY_BBOX[2] + 0.08, COUNTY_BBOX[3] + 0.06],
  ],
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

// Load the lookup data immediately — search must work even if the basemap
// is still streaming tiles (map 'load' waits for full style+tile idle).
const dataReady = Promise.all([
  fetch('./neighborhoods.json').then((r) => r.json()),
  fetch('./labels.json').then((r) => r.json()),
  fetch('./county.json').then((r) => r.json()),
]).then(([h, l, c]) => {
  hoods = h;
  countyRing = c.ring;
  return { hoods: h, labels: l };
});

map.on('load', async () => {
  const { labels } = await dataReady;

  map.addSource('hoods', { type: 'geojson', data: hoods, generateId: true });
  map.addSource('hood-labels', { type: 'geojson', data: labels });

  // OSM suburb names (e.g. "Nauck") can contradict ARLnow canon — hide them.
  for (const id of ['label_other', 'label_village']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  }

  const firstSymbol = map.getLayer('waterway_line_label')
    ? 'waterway_line_label'
    : map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  map.addLayer({
    id: 'hoods-fill',
    type: 'fill',
    source: 'hoods',
    paint: {
      'fill-color': ['match', ['get', 'color'],
        1, '#aec7e8', 2, '#ffbb78', 3, '#98df8a', 4, '#f7b6d2', 5, '#c5b0d5',
        '#dddddd'],
      'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.55, 0.35],
    },
  }, firstSymbol);

  map.addLayer({
    id: 'hoods-line',
    type: 'line',
    source: 'hoods',
    paint: {
      'line-color': '#5b5b6e',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 2],
    },
  }, firstSymbol);

  map.addLayer({
    id: 'hoods-label',
    type: 'symbol',
    source: 'hood-labels',
    minzoom: 10.5,
    layout: {
      'text-field': ['get', 'name'],
      'text-transform': 'uppercase',
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 9, 13, 13, 16, 17],
      'text-font': ['Noto Sans Bold'],
      'text-max-width': 7,
    },
    paint: {
      'text-color': '#3a3a55',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.5,
    },
  });

  map.on('mousemove', 'hoods-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const id = e.features[0]?.id;
    if (id === hoverId) return;
    if (hoverId !== null) map.setFeatureState({ source: 'hoods', id: hoverId }, { hover: false });
    hoverId = id;
    map.setFeatureState({ source: 'hoods', id }, { hover: true });
  });
  map.on('mouseleave', 'hoods-fill', () => {
    map.getCanvas().style.cursor = '';
    if (hoverId !== null) map.setFeatureState({ source: 'hoods', id: hoverId }, { hover: false });
    hoverId = null;
  });

  map.on('click', (e) => {
    placeMarker(e.lngLat.lng, e.lngLat.lat);
    renderResult('Clicked point', classify(hoods, countyRing, e.lngLat.lng, e.lngLat.lat), null);
  });
});

// ---------------------------------------------------------------------- UI

const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const resultEl = document.getElementById('result');
const hintEl = document.getElementById('hint');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw) return;
  await dataReady;

  const query = parseBlock(raw); // "2000 block of N Quincy St" -> "2050 N Quincy St"

  showMessage('Searching…');
  const geo = await geocode(query);
  // The main map is Arlington-only: nearby out-of-county hits are treated
  // as not found, exactly as before.
  if (!geo || !inCounty(countyRing, geo.lng, geo.lat)) {
    showMessage("Couldn't find that address in Arlington. Try a street address " +
      "like “3100 Columbia Pike” or “2000 block of N Quincy St”.", true);
    return;
  }

  placeMarker(geo.lng, geo.lat);
  map.flyTo({ center: [geo.lng, geo.lat], zoom: 15.5 });
  renderResult(raw, classify(hoods, countyRing, geo.lng, geo.lat), geo);
});

function placeMarker(lng, lat) {
  if (!marker) marker = new maplibregl.Marker({ color: '#c33' });
  marker.setLngLat([lng, lat]).addTo(map);
}

function showMessage(text, isError = false) {
  hintEl.hidden = true;
  resultEl.hidden = false;
  resultEl.innerHTML = `<div class="${isError ? 'error' : ''}"></div>`;
  resultEl.firstChild.textContent = text;
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderResult(label, res, geo) {
  hintEl.hidden = true;
  resultEl.hidden = false;

  const d = describe(res);
  let html = '';
  if (d.status === 'outside_arlington') {
    html = `<div class="headline">That point is outside Arlington County.</div>`;
  } else if (d.status === 'unassigned') {
    html = `<div class="headline"><b>${esc(label)}</b> isn't in any neighborhood —
      the Pentagon, Arlington National Cemetery, Reagan National Airport, parkway land
      and some parks are unassigned. The nearest neighborhood is
      <b>${esc(d.nearest)}</b>, about ${esc(d.distanceText)} away.</div>`;
  } else {
    html = `<div class="headline"><b>${esc(label)}</b> is in <b>${esc(d.neighborhood)}</b>.</div>`;
    if (d.borderPhrase) {
      html += `<div class="border-note">${esc(d.borderPhrase)}</div>`;
    }
  }
  if (geo) {
    html += `<div class="source">Matched: ${esc(geo.matched)} · via ${esc(geo.source)}</div>`;
  }
  resultEl.innerHTML = html;
}
