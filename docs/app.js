/* ARLnow Arlington Neighborhood Lookup */
'use strict';

// A point within this distance (meters) of another neighborhood is reported
// as "on the border of". Tuned against real geocoder output: address points
// are building centroids, typically 30-70 m from a boundary street's
// centerline (1015 N Quincy St sits 66 m from the Ballston divider), while
// a typical Arlington block is 150-250 m deep.
const BORDER_M = 80;
const EDGE_M = 1;          // treat as "inside" when this close to an edge

// Actual Arlington County bounds (includes DCA, the Pentagon, the cemetery —
// county land that has no neighborhood polygon).
const COUNTY_BBOX = [-77.1723, 38.8275, -77.0310, 38.9344];
const ARL_GEOCODER =
  'https://arlgis.arlingtonva.us/arcgis/rest/services/Geoprocessing/' +
  'Composite_AddPnt_Stnet/GeocodeServer/findAddressCandidates';
const CENSUS_GEOCODER =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

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
    renderResult('Clicked point', classify(e.lngLat.lng, e.lngLat.lat), null);
  });
});

// ---------------------------------------------------------------- geometry

// Meters in a local flat projection around (lng0, lat0) — fine at sub-km scale.
function toMeters(lng, lat, lng0, lat0) {
  return [
    (lng - lng0) * 111320 * Math.cos((lat0 * Math.PI) / 180),
    (lat - lat0) * 111320,
  ];
}

// Even-odd ray casting over one ring ([[lng,lat], ...]).
function ringContains(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Even-odd across all rings of a MultiPolygon handles holes automatically.
function featureContains(feature, lng, lat) {
  let inside = false;
  for (const poly of feature.geometry.coordinates) {
    for (const ring of poly) {
      if (ringContains(ring, lng, lat)) inside = !inside;
    }
  }
  return inside;
}

// Min distance (meters) from point to any boundary segment of the feature.
function featureDistance(feature, lng, lat) {
  let best = Infinity;
  for (const poly of feature.geometry.coordinates) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const [ax, ay] = toMeters(ring[i - 1][0], ring[i - 1][1], lng, lat);
        const [bx, by] = toMeters(ring[i][0], ring[i][1], lng, lat);
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const px = ax + t * dx, py = ay + t * dy;
        best = Math.min(best, Math.hypot(px, py));
      }
    }
  }
  return best;
}

function inCounty(lng, lat) {
  return countyRing ? ringContains(countyRing, lng, lat) : true;
}

// -> { kind: 'inside'|'unassigned'|'outside', primary, partners: [{name,d}], nearest }
function classify(lng, lat) {
  const containing = [];
  const dists = [];
  for (const f of hoods.features) {
    const inside = featureContains(f, lng, lat);
    if (inside) containing.push(f.properties.name);
    else dists.push({ name: f.properties.name, d: featureDistance(f, lng, lat) });
  }
  dists.sort((a, b) => a.d - b.d);

  if (containing.length === 0) {
    if (dists[0] && dists[0].d <= EDGE_M) {
      containing.push(dists.shift().name);   // numerically on an edge
    } else {
      if (!inCounty(lng, lat) || !dists[0]) return { kind: 'outside' };
      return { kind: 'unassigned', nearest: dists[0] };
    }
  }

  const partners = containing.slice(1).map((name) => ({ name, d: 0 }))
    .concat(dists.filter((x) => x.d <= BORDER_M))
    .slice(0, 2);
  return { kind: 'inside', primary: containing[0], partners };
}

// --------------------------------------------------------------- geocoding

async function geocodeArlington(query) {
  const url = `${ARL_GEOCODER}?${new URLSearchParams({
    SingleLine: query,
    outSR: '4326',
    outFields: 'Loc_name,Addr_type',
    maxLocations: '5',
    f: 'json',
  })}`;
  const data = await (await fetch(url)).json();
  const ok = (data.candidates || []).filter((c) => c.score >= 80);
  if (!ok.length) return null;
  ok.sort((a, b) =>
    (b.score - a.score) ||
    ((b.attributes?.Addr_type === 'PointAddress') - (a.attributes?.Addr_type === 'PointAddress')));
  const c = ok[0];
  return { lng: c.location.x, lat: c.location.y, matched: c.address,
           source: 'Arlington County GIS' };
}

function geocodeCensus(query) {
  if (!/,|\bva\b|virginia/i.test(query)) query += ', Arlington, VA';
  return new Promise((resolve) => {
    const cb = `_censusCb${Date.now()}`;
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); resolve(null); }, 8000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }
    window[cb] = (data) => {
      cleanup();
      const m = data?.result?.addressMatches?.[0];
      if (!m) return resolve(null);
      const { x, y } = m.coordinates;
      if (!inCounty(x, y)) return resolve(null);
      resolve({ lng: x, lat: y, matched: m.matchedAddress,
                source: 'U.S. Census geocoder (fallback)' });
    };
    script.onerror = () => { cleanup(); resolve(null); };
    script.src = `${CENSUS_GEOCODER}?${new URLSearchParams({
      address: query,
      benchmark: 'Public_AR_Current',
      format: 'jsonp',
      callback: cb,
    })}`;
    document.head.appendChild(script);
  });
}

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

  // "2000 block of N Quincy St" -> geocode mid-block as 2050 N Quincy St
  const blockMatch = raw.match(/^(?:the\s+)?(\d{2,5})\s+block\s+of\s+(.+)$/i);
  const query = blockMatch ? `${+blockMatch[1] + 50} ${blockMatch[2]}` : raw;

  showMessage('Searching…');
  let geo = null;
  try { geo = await geocodeArlington(query); } catch { /* fall through */ }
  if (!geo) geo = await geocodeCensus(query);
  if (!geo) {
    showMessage("Couldn't find that address in Arlington. Try a street address " +
      "like “3100 Columbia Pike” or “2000 block of N Quincy St”.", true);
    return;
  }

  placeMarker(geo.lng, geo.lat);
  map.flyTo({ center: [geo.lng, geo.lat], zoom: 15.5 });
  renderResult(raw, classify(geo.lng, geo.lat), geo);
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

function fmtDistance(m) {
  const feet = m * 3.28084;
  return feet < 1000 ? `${Math.round(feet / 10) * 10} feet` : `${(m / 1609.34).toFixed(1)} miles`;
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderResult(label, res, geo) {
  hintEl.hidden = true;
  resultEl.hidden = false;

  let html = '';
  if (res.kind === 'outside') {
    html = `<div class="headline">That point is outside Arlington County.</div>`;
  } else if (res.kind === 'unassigned') {
    html = `<div class="headline"><b>${esc(label)}</b> isn't in any neighborhood —
      the Pentagon, Arlington National Cemetery, Reagan National Airport, parkway land
      and some parks are unassigned. The nearest neighborhood is
      <b>${esc(res.nearest.name)}</b>, about ${fmtDistance(res.nearest.d)} away.</div>`;
  } else {
    html = `<div class="headline"><b>${esc(label)}</b> is in <b>${esc(res.primary)}</b>.</div>`;
    if (res.partners.length) {
      const names = [res.primary, ...res.partners.map((p) => p.name)];
      const list = names.length === 2
        ? `${esc(names[0])} and ${esc(names[1])}`
        : `${names.slice(0, -1).map(esc).join(', ')} and ${esc(names[names.length - 1])}`;
      html += `<div class="border-note">On the border of the ${list} neighborhoods.</div>`;
    }
  }
  if (geo) {
    html += `<div class="source">Matched: ${esc(geo.matched)} · via ${esc(geo.source)}</div>`;
  }
  resultEl.innerHTML = html;
}
