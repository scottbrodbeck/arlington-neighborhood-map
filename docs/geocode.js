/* Shared browser geocoding — Arlington County GIS first, U.S. Census JSONP
 * fallback, both constrained to Arlington. Used by the main map (app.js) and
 * the pin-drop embed builder (pin-drop.js). Browser-only: the Census fallback
 * injects a <script> tag (the Census geocoder has no CORS, only JSONP). */

import { inCounty } from './classify.js';

const ARL_GEOCODER =
  'https://arlgis.arlingtonva.us/arcgis/rest/services/Geoprocessing/' +
  'Composite_AddPnt_Stnet/GeocodeServer/findAddressCandidates';
const CENSUS_GEOCODER =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

export async function geocodeArlington(query) {
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

export function geocodeCensus(query, countyRing) {
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
      if (!inCounty(countyRing, x, y)) return resolve(null);
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

// Arlington GIS first, Census fallback; null when nothing matches in-county.
export async function geocode(query, countyRing) {
  let geo = null;
  try { geo = await geocodeArlington(query); } catch { /* fall through */ }
  if (!geo) geo = await geocodeCensus(query, countyRing);
  return geo;
}
