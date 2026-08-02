/* Embeddable pin map — renders markers from ?pins=lat,lng,label|lat,lng,label.
 * Stateless: everything arrives in the URL, geocoding already happened in the
 * pin-drop builder, so a view costs only static CDN-cached assets. */

import { classify, describe } from './classify.js';

const MAX_PINS = 20;
// Arlington County bounds with a small margin — pins outside are ignored.
const COUNTY_BBOX = [-77.1723, 38.8275, -77.0310, 38.9344];
const M = 0.02;

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
    const [latS, lngS, labelS = ''] = part.split(',');
    const lat = Number(latS), lng = Number(lngS);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lng < COUNTY_BBOX[0] - M || lng > COUNTY_BBOX[2] + M ||
        lat < COUNTY_BBOX[1] - M || lat > COUNTY_BBOX[3] + M) continue;
    let label = labelS;
    try { label = decodeURIComponent(labelS); } catch { /* keep raw */ }
    pins.push({ lat, lng, label });
    if (pins.length >= MAX_PINS) break;
  }
  return pins;
}

const pins = parsePins();

const view = {};
if (zoomSetting === 'wide' || pins.length === 0) {
  // Frame the whole county regardless of where the pins are.
  view.bounds = [
    [COUNTY_BBOX[0], COUNTY_BBOX[1]],
    [COUNTY_BBOX[2], COUNTY_BBOX[3]],
  ];
  view.fitBoundsOptions = { padding: 8 };
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
  maxBounds: [ // same pannable area as the main map
    [COUNTY_BBOX[0] - 0.08, COUNTY_BBOX[1] - 0.06],
    [COUNTY_BBOX[2] + 0.08, COUNTY_BBOX[3] + 0.06],
  ],
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

  dataReady.then((data) => {
    if (!data) return;
    const [hoods, county] = data;
    const d = describe(classify(hoods, county.ring, pin.lng, pin.lat));
    if (d.status !== 'in_neighborhood') return;
    const hoodEl = document.createElement('div');
    hoodEl.className = 'pin-hood';
    hoodEl.textContent = d.neighborhood;
    content.appendChild(hoodEl);
  });
}
