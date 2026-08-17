/* Shared browser geocoding — Arlington County GIS first, U.S. Census JSONP
 * fallback, both constrained to the embed area (Arlington plus a few miles
 * around it; see EMBED_BOUNDS in classify.js). Used by the main map (app.js)
 * and the pin-drop embed builder (pin-drop.js). Browser-only: the Census
 * calls inject <script> tags (the Census geocoder has no CORS, only JSONP). */

// Versioned import: these exports are newer than some cached classify.js
// copies, and GitHub Pages caches each file independently for 10 minutes.
import { inEmbedArea, jurisdictionName } from './classify.js?v=3';

const ARL_GEOCODER =
  'https://arlgis.arlingtonva.us/arcgis/rest/services/Geoprocessing/' +
  'Composite_AddPnt_Stnet/GeocodeServer/findAddressCandidates';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder';

export async function geocodeArlington(query) {
  const url = `${ARL_GEOCODER}?${new URLSearchParams({
    SingleLine: query,
    outSR: '4326',
    outFields: 'Loc_name,Addr_type',
    maxLocations: '5',
    f: 'json',
  })}`;
  const data = await (await fetch(url)).json();
  // A bare StreetName hit is the street's centroid, not the address — it's
  // what the locator returns for out-of-county numbers on in-county streets.
  const ok = (data.candidates || []).filter((c) =>
    c.score >= 80 && c.attributes?.Addr_type !== 'StreetName');
  if (!ok.length) return null;
  ok.sort((a, b) =>
    (b.score - a.score) ||
    ((b.attributes?.Addr_type === 'PointAddress') - (a.attributes?.Addr_type === 'PointAddress')));
  const c = ok[0];
  return { lng: c.location.x, lat: c.location.y, matched: c.address,
           source: 'Arlington County GIS' };
}

// JSONP request to a Census geocoder endpoint; resolves null on error/timeout.
function censusJsonp(path, params) {
  return new Promise((resolve) => {
    const cb = `_censusCb${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); resolve(null); }, 8000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); resolve(null); };
    script.src = `${CENSUS}/${path}?${new URLSearchParams({
      ...params, benchmark: 'Public_AR_Current', format: 'jsonp', callback: cb,
    })}`;
    document.head.appendChild(script);
  });
}

// Query variants to try, most specific first: bare addresses get Arlington
// assumed, then just Virginia so nearby out-of-county addresses still resolve.
function censusVariants(query) {
  if (/\bva\b|virginia|\bdc\b|d\.c\./i.test(query)) return [query];
  if (query.includes(',')) return [query, `${query}, VA`];
  return [`${query}, Arlington, VA`, `${query}, VA`];
}

export async function geocodeCensus(query) {
  for (const q of censusVariants(query)) {
    const data = await censusJsonp('locations/onelineaddress', { address: q });
    const m = data?.result?.addressMatches?.[0];
    if (!m) continue;
    const { x, y } = m.coordinates;
    if (!inEmbedArea(x, y)) continue;
    return { lng: x, lat: y, matched: m.matchedAddress,
             source: 'U.S. Census geocoder (fallback)' };
  }
  return null;
}

// Arlington GIS first, Census fallback; null when nothing matches nearby.
// Callers decide what to do with in-area but out-of-county results.
export async function geocode(query) {
  let geo = null;
  try { geo = await geocodeArlington(query); } catch { /* fall through */ }
  if (geo && !inEmbedArea(geo.lng, geo.lat)) geo = null;
  if (!geo) geo = await geocodeCensus(query);
  return geo;
}

// Which county / independent city / D.C. a point is in, in ARLnow phrasing
// ("Fairfax County", "Falls Church", "Alexandria", "Washington, D.C.").
export async function lookupJurisdiction(lng, lat) {
  const data = await censusJsonp('geographies/coordinates', {
    x: lng, y: lat, vintage: 'Current_Current', layers: 'Counties',
  });
  return jurisdictionName(data?.result?.geographies?.Counties?.[0]?.NAME);
}
