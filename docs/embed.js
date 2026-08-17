/* Embeddable pin map — renders markers from
 *   ?pins=lat,lng,label|lat,lng,label,sub
 * where the optional 4th field `sub` is a caption shown in place of the
 * neighborhood (the builder sets it to the jurisdiction — "Fairfax County",
 * "Falls Church" — for pins just outside Arlington). Stateless: everything
 * arrives in the URL, geocoding already happened in the pin-drop builder, so
 * a view costs only static CDN-cached assets. */

import { classify, describe } from './classify.js';

const MAX_PINS = 20;
// Arlington County bbox and the pannable/pinnable area around it. Kept local
// (duplicating classify.js) so this high-traffic page never depends on a
// fresh classify.js — GitHub Pages caches each file independently.
const COUNTY_BBOX = [-77.1723, 38.8275, -77.0310, 38.9344];
const EMBED_BOUNDS = [
  [COUNTY_BBOX[0] - 0.08, COUNTY_BBOX[1] - 0.06],
  [COUNTY_BBOX[2] + 0.08, COUNTY_BBOX[3] + 0.06],
];
const inEmbedArea = (lng, lat) =>
  lng >= EMBED_BOUNDS[0][0] && lng <= EMBED_BOUNDS[1][0] &&
  lat >= EMBED_BOUNDS[0][1] && lat <= EMBED_BOUNDS[1][1];

const params = new URLSearchParams(location.search);
const showLabels = params.get('labels') === '1';
// ?zoom=wide|medium|close (default close). Close hugs the pins, medium backs
// off for context, wide always frames the whole county.
const zoomSetting = ['wide', 'medium'].includes(params.get('zoom'))
  ? params.get('zoom')
  : 'close';
const PIN_MAX_ZOOM = { close: 15, medium: 13 };

function parsePins() {
  const raw = params.get('pins') || '';
  const pins = [];
  for (const part of raw.split('|')) {
    const [latS, lngS, labelS = '', subS = ''] = part.split(',');
    const lat = Number(latS), lng = Number(lngS);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!inEmbedArea(lng, lat)) continue;
    const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    pins.push({ lat, lng, label: dec(labelS), sub: dec(subS) });
    if (pins.length >= MAX_PINS) break;
  }
  return pins;
}

const pins = parsePins();

const view = {};
if (zoomSetting === 'wide' || pins.length === 0) {
  // Frame the whole county (plus any pin sitting just outside it).
  const bounds = new maplibregl.LngLatBounds(
    [COUNTY_BBOX[0], COUNTY_BBOX[1]], [COUNTY_BBOX[2], COUNTY_BBOX[3]]);
  for (const p of pins) bounds.extend([p.lng, p.lat]);
  view.bounds = bounds;
  // Enough padding that a pin just outside the county isn't on the frame edge.
  view.fitBoundsOptions = { padding: pins.length ? 40 : 8 };
} else if (pins.length === 1) {
  view.center = [pins[0].lng, pins[0].lat];
  view.zoom = PIN_MAX_ZOOM[zoomSetting];
} else {
  const bounds = new maplibregl.LngLatBounds();
  for (const p of pins) bounds.extend([p.lng, p.lat]);
  view.bounds = bounds;
  // Open labels need more headroom than bare markers.
  view.fitBoundsOptions = {
    padding: showLabels ? 72 : 48,
    maxZoom: PIN_MAX_ZOOM[zoomSetting],
  };
}

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  cooperativeGestures: true, // don't hijack article scrolling
  attributionControl: { compact: true }, // embeds are small — keep it to the ⓘ
  maxBounds: EMBED_BOUNDS, // same pannable area as the main map
  ...view,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

// Neighborhood data only feeds the popups — markers don't wait for it.
const dataReady = Promise.all([
  fetch('./neighborhoods.json').then((r) => r.json()),
  fetch('./county.json').then((r) => r.json()),
]).catch(() => null);

for (const pin of pins) {
  const content = document.createElement('div');
  content.className = 'pin-popup';
  const labelEl = document.createElement('div');
  labelEl.className = 'pin-label';
  labelEl.textContent = pin.label || `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;
  content.appendChild(labelEl);

  // With ?labels=1 every popup starts open, so drop the close affordances —
  // clicking a marker still toggles its label.
  const popup = new maplibregl.Popup(
    showLabels
      ? { offset: 30, closeButton: false, closeOnClick: false, focusAfterOpen: false }
      : { offset: 30 },
  ).setDOMContent(content);
  const marker = new maplibregl.Marker({ color: '#c33' })
    .setLngLat([pin.lng, pin.lat])
    .setPopup(popup)
    .addTo(map);
  if (showLabels || pins.length === 1) marker.togglePopup();

  const addSub = (text) => {
    const el = document.createElement('div');
    el.className = 'pin-hood';
    el.textContent = text;
    content.appendChild(el);
  };

  // A caption from the URL (jurisdiction for out-of-county pins) wins;
  // otherwise compute the neighborhood once the data arrives.
  if (pin.sub) {
    addSub(pin.sub);
    continue;
  }
  dataReady.then((data) => {
    if (!data) return;
    const [hoods, county] = data;
    const d = describe(classify(hoods, county.ring, pin.lng, pin.lat));
    if (d.status === 'in_neighborhood') addSub(d.neighborhood);
  });
}
