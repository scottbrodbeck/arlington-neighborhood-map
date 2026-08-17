/* Shared neighborhood classification — the single source of truth for the
 * border algorithm. Pure: no DOM, no network. Imported by both the website
 * (docs/app.js) and the MCP server (mcp-server/src/index.js) so their answers
 * can never drift. */
'use strict';

// A point within this distance (meters) of another neighborhood is reported
// as "on the border of". Tuned against real geocoder output: address points
// are building centroids, typically 30-70 m from a boundary street's
// centerline (1015 N Quincy St sits 66 m from the Ballston divider), while
// a typical Arlington block is 150-250 m deep.
export const BORDER_M = 80;
export const EDGE_M = 1; // treat as "inside" when this close to an edge

// Meters in a local flat projection around (lng0, lat0) — fine at sub-km scale.
export function toMeters(lng, lat, lng0, lat0) {
  return [
    (lng - lng0) * 111320 * Math.cos((lat0 * Math.PI) / 180),
    (lat - lat0) * 111320,
  ];
}

// Even-odd ray casting over one ring ([[lng,lat], ...]).
export function ringContains(ring, lng, lat) {
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
export function featureContains(feature, lng, lat) {
  let inside = false;
  for (const poly of feature.geometry.coordinates) {
    for (const ring of poly) {
      if (ringContains(ring, lng, lat)) inside = !inside;
    }
  }
  return inside;
}

// Min distance (meters) from point to any boundary segment of the feature.
export function featureDistance(feature, lng, lat) {
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

export function inCounty(countyRing, lng, lat) {
  return countyRing ? ringContains(countyRing, lng, lat) : true;
}

// Arlington County bounding box [w, s, e, n], and the somewhat larger area the
// maps will pan/show. Pins may sit anywhere in EMBED_BOUNDS, so spots just
// over the line (Bailey's Crossroads, Falls Church, Old Town, downtown D.C.)
// still work — they just get a jurisdiction instead of a neighborhood.
export const COUNTY_BBOX = [-77.1723, 38.8275, -77.0310, 38.9344];
export const EMBED_BOUNDS = [
  [COUNTY_BBOX[0] - 0.08, COUNTY_BBOX[1] - 0.06],
  [COUNTY_BBOX[2] + 0.08, COUNTY_BBOX[3] + 0.06],
];

export function inEmbedArea(lng, lat) {
  return lng >= EMBED_BOUNDS[0][0] && lng <= EMBED_BOUNDS[1][0] &&
         lat >= EMBED_BOUNDS[0][1] && lat <= EMBED_BOUNDS[1][1];
}

// Census county / county-equivalent NAME -> how ARLnow writes the jurisdiction.
// "Fairfax County" stays as is; Virginia independent cities drop the "city"
// suffix ("Alexandria city" -> "Alexandria"), except the City of Fairfax,
// which needs disambiguating from the county.
export function jurisdictionName(censusName) {
  if (!censusName) return null;
  if (censusName === 'District of Columbia') return 'Washington, D.C.';
  const m = censusName.match(/^(.+) city$/i);
  if (m) return m[1] === 'Fairfax' ? 'City of Fairfax' : m[1];
  return censusName;
}

// -> { kind: 'inside'|'unassigned'|'outside', primary, partners: [{name,d}], nearest }
export function classify(hoods, countyRing, lng, lat) {
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
      containing.push(dists.shift().name); // numerically on an edge
    } else {
      if (!inCounty(countyRing, lng, lat) || !dists[0]) return { kind: 'outside' };
      return { kind: 'unassigned', nearest: dists[0] };
    }
  }

  const partners = containing.slice(1).map((name) => ({ name, d: 0 }))
    .concat(dists.filter((x) => x.d <= BORDER_M))
    .slice(0, 2);
  return { kind: 'inside', primary: containing[0], partners };
}

// "2000 block of N Quincy St" -> "2050 N Quincy St" (mid-block). Returns the
// query unchanged when it isn't block-style.
export function parseBlock(query) {
  const m = query.match(/^(?:the\s+)?(\d{2,5})\s+block\s+of\s+(.+)$/i);
  return m ? `${+m[1] + 50} ${m[2]}` : query;
}

export function fmtDistance(m) {
  const feet = m * 3.28084;
  return feet < 1000 ? `${Math.round(feet / 10) * 10} feet` : `${(m / 1609.34).toFixed(1)} miles`;
}

// Turn a classify() result into presentation-neutral semantics that both the
// website and the MCP server format their own way. The "On the border of …"
// phrasing lives here so both say it identically.
export function describe(res) {
  if (res.kind === 'outside') return { status: 'outside_arlington' };
  if (res.kind === 'unassigned') {
    return {
      status: 'unassigned',
      nearest: res.nearest.name,
      distanceText: fmtDistance(res.nearest.d),
    };
  }
  const onBorder = res.partners.map((p) => p.name);
  let borderPhrase = null;
  if (onBorder.length) {
    const names = [res.primary, ...onBorder];
    const list = names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    borderPhrase = `On the border of the ${list} neighborhoods.`;
  }
  return { status: 'in_neighborhood', neighborhood: res.primary, onBorder, borderPhrase };
}
