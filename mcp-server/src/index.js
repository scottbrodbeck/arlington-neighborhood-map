/* ARLnow Arlington Neighborhood Lookup — remote MCP server (Cloudflare Worker).
 *
 * Exposes the same neighborhood classification as map.arlnow.com to Claude as a
 * connector. Reuses the website's exact border algorithm (docs/classify.mjs)
 * and polygon data so answers can never drift from the public map.
 *
 * SCOPE GUARD — Arlington County, Virginia and its immediate surroundings only.
 * The lookup tools are strictly Arlington: only the Arlington County GIS
 * geocoder, every path gated by classify()/inCounty, and out-of-scope results
 * are a flat "Address not in Arlington." with NO coordinates or matched address.
 * generate_pin_embed additionally falls back to the U.S. Census geocoder, but
 * discards anything outside EMBED_BOUNDS (Arlington plus a few miles — the
 * area the embed map can show), so neither path works as a general geocoder.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import {
  classify, parseBlock, describe, inEmbedArea, jurisdictionName,
} from '../../docs/classify.js';
import neighborhoods from '../../docs/neighborhoods.json';
import countyData from '../../docs/county.json';

const countyRing = countyData.ring;

const ARL_GEOCODER =
  'https://arlgis.arlingtonva.us/arcgis/rest/services/Geoprocessing/' +
  'Composite_AddPnt_Stnet/GeocodeServer/findAddressCandidates';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder';

// Arlington County's own geocoder — authoritative, and it returns no candidates
// for anything outside the county, which is the server's first scope guard.
async function geocodeArlington(query) {
  const url = `${ARL_GEOCODER}?${new URLSearchParams({
    SingleLine: query,
    outSR: '4326',
    outFields: 'Loc_name,Addr_type',
    maxLocations: '5',
    f: 'json',
  })}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  // A bare StreetName hit is the street's centroid, not the address — it's
  // what the locator returns for out-of-county numbers on in-county streets.
  const ok = (data.candidates || []).filter((c) =>
    c.score >= 80 && c.attributes?.Addr_type !== 'StreetName');
  if (!ok.length) return null;
  ok.sort((a, b) =>
    (b.score - a.score) ||
    ((b.attributes?.Addr_type === 'PointAddress') - (a.attributes?.Addr_type === 'PointAddress')));
  const c = ok[0];
  return { lng: c.location.x, lat: c.location.y, matched: c.address };
}

async function censusJson(path, params) {
  try {
    const res = await fetch(`${CENSUS}/${path}?${new URLSearchParams({
      ...params, benchmark: 'Public_AR_Current', format: 'json',
    })}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Census fallback for the embed tool: tries the query with Arlington assumed,
// then just Virginia, and keeps only hits inside the embed area.
async function geocodeCensusNearby(query) {
  let variants;
  if (/\bva\b|virginia|\bdc\b|d\.c\./i.test(query)) variants = [query];
  else if (query.includes(',')) variants = [query, `${query}, VA`];
  else variants = [`${query}, Arlington, VA`, `${query}, VA`];
  for (const q of variants) {
    const data = await censusJson('locations/onelineaddress', { address: q });
    const m = data?.result?.addressMatches?.[0];
    if (!m) continue;
    const { x, y } = m.coordinates;
    if (!inEmbedArea(x, y)) continue;
    return { lng: x, lat: y, matched: m.matchedAddress };
  }
  return null;
}

// County / independent city / D.C. for a point, in ARLnow phrasing.
async function lookupJurisdiction(lng, lat) {
  const data = await censusJson('geographies/coordinates', {
    x: lng, y: lat, vintage: 'Current_Current', layers: 'Counties',
  });
  return jurisdictionName(data?.result?.geographies?.Counties?.[0]?.NAME);
}

const EMBED_BASE = 'https://map.arlnow.com/embed.html';
const MAX_PINS = 20; // embed.js ignores pins past this

// "2100 CLARENDON BLVD, ARLINGTON, VIRGINIA" -> "2100 Clarendon Blvd"
// (same default-label rule as the pin-drop builder page).
function defaultLabel(matched) {
  const street = matched.split(',')[0].trim();
  return street.replace(/\S+/g, (w) =>
    /^\d/.test(w) || /^(?:N|S|E|W|NE|NW|SE|SW)$/i.test(w)
      ? w.toUpperCase()
      : w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// MCP result envelopes: a human sentence + a JSON line of structured fields.
function result(sentence, structured) {
  return {
    content: [
      { type: 'text', text: sentence },
      { type: 'text', text: JSON.stringify(structured) },
    ],
  };
}

function refusal(sentence = 'Address not in Arlington.') {
  return result(sentence, { status: 'not_in_arlington' });
}

// Build a success/unassigned envelope for an in-Arlington point. `info` may
// carry { matched, lat, lng, geocoder }; only defined fields are echoed.
function inArlington(label, res, info = {}) {
  const d = describe(res);
  if (d.status === 'outside_arlington') return refusal(); // belt-and-suspenders

  const geo = {};
  if (info.matched != null) geo.matchedAddress = info.matched;
  if (info.lat != null) geo.lat = info.lat;
  if (info.lng != null) geo.lng = info.lng;
  if (info.geocoder != null) geo.geocoder = info.geocoder;

  if (d.status === 'unassigned') {
    const sentence = `${label} isn't in a mapped neighborhood — the Pentagon, ` +
      `Arlington National Cemetery, Reagan National Airport, parkway land and ` +
      `some parks are unassigned. The nearest neighborhood is ${d.nearest}, ` +
      `about ${d.distanceText} away.`;
    return result(sentence, {
      status: 'unassigned', neighborhood: null, onBorder: [],
      nearest: d.nearest, distanceText: d.distanceText, ...geo,
    });
  }

  let sentence = `${label} is in ${d.neighborhood}.`;
  if (d.borderPhrase) sentence += ` ${d.borderPhrase}`;
  if (info.matched != null && info.geocoder != null) {
    sentence += ` (Matched ${info.matched} via ${info.geocoder}.)`;
  }
  return result(sentence, {
    status: 'in_neighborhood', neighborhood: d.neighborhood,
    onBorder: d.onBorder, borderPhrase: d.borderPhrase, ...geo,
  });
}

export class NeighborhoodMCP extends McpAgent {
  server = new McpServer(
    { name: 'arlnow-neighborhoods', version: '1.0.0' },
    {
      instructions:
        'Look up which ARLnow Arlington, Virginia neighborhood an address, ' +
        'block, or coordinate falls in, including any neighborhood it borders. ' +
        'Arlington County only — this server will not geocode or locate ' +
        'anything outside Arlington, and returns no coordinates for ' +
        'out-of-county input. Use list_neighborhoods for canonical spellings. ' +
        'generate_pin_embed turns a list of Arlington addresses into a ' +
        'ready-to-paste responsive <iframe> pin map for ARLnow articles.',
    },
  );

  async init() {
    this.server.registerTool(
      'lookup_neighborhood',
      {
        description:
          'Given an Arlington, Virginia street address or block (e.g. ' +
          '"3100 Columbia Pike" or "2000 block of N Quincy St"), return the ' +
          "ARLnow neighborhood it's in plus any neighborhood it borders " +
          '(writers phrase locations as "on the border of X and Y"). ' +
          'Arlington County only: returns "Address not in Arlington." for ' +
          'anything outside the county and never returns coordinates for ' +
          'non-Arlington locations.',
        inputSchema: {
          query: z.string().describe('An Arlington VA street address, or "NNNN block of STREET".'),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ query }) => {
        const geo = await geocodeArlington(parseBlock(query));
        if (!geo) return refusal();
        return inArlington(query, classify(neighborhoods, countyRing, geo.lng, geo.lat), {
          matched: geo.matched, lat: geo.lat, lng: geo.lng, geocoder: 'Arlington County GIS',
        });
      },
    );

    this.server.registerTool(
      'lookup_by_coordinates',
      {
        description:
          'Given a latitude/longitude in Arlington, Virginia (WGS84), return the ' +
          'ARLnow neighborhood and any bordering neighborhood. Returns ' +
          '"Those coordinates are not in Arlington." for points outside Arlington County.',
        inputSchema: {
          lat: z.number().describe('Latitude (WGS84), e.g. 38.8816'),
          lng: z.number().describe('Longitude (WGS84), e.g. -77.1117'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ lat, lng }) => {
        const res = classify(neighborhoods, countyRing, lng, lat);
        if (res.kind === 'outside') return refusal('Those coordinates are not in Arlington.');
        return inArlington(`(${lat.toFixed(5)}, ${lng.toFixed(5)})`, res, { lat, lng });
      },
    );

    this.server.registerTool(
      'generate_pin_embed',
      {
        description:
          'Generate a ready-to-paste, responsive <iframe> embed of a map with ' +
          'pins at one or more addresses, blocks, or intersections in or just ' +
          'around Arlington, Virginia — the same stateless embeds the ' +
          'map.arlnow.com/pin-drop.html builder makes. Pins are geocoded once ' +
          'here and baked into the embed URL; nothing is stored. Pins inside ' +
          'Arlington are captioned with their ARLnow neighborhood; pins just ' +
          'over the county line (Bailey\'s Crossroads, Falls Church, Alexandria, ' +
          'D.C.) are captioned with the jurisdiction instead. Anything farther ' +
          'away is skipped and reported in `failed` with no coordinates. ' +
          `Maximum ${MAX_PINS} pins.`,
        inputSchema: {
          pins: z.array(z.object({
            address: z.string().describe(
              'A street address ("3100 Columbia Pike"), block ("2000 block of N Quincy St"), ' +
              'or intersection ("Columbia Pike & Carlin Springs Rd") in or near Arlington VA. ' +
              'Add a city for out-of-county addresses ("5800 Columbia Pike, Falls Church").'),
            label: z.string().optional().describe(
              'Optional pin label shown on the map; defaults to the matched street address (or the block phrase as given).'),
          })).min(1).max(MAX_PINS)
            .describe(`Pins to place, in display order (1-${MAX_PINS}).`),
          show_labels: z.boolean().optional().default(true).describe(
            'true (default): every pin label is open on load. false: labels appear only when a pin is clicked.'),
          zoom: z.enum(['close', 'medium', 'wide']).optional().default('close').describe(
            'close (default): frame the pins tightly. medium: pins with more surrounding context. wide: always frame the whole county.'),
          height: z.number().int().min(200).max(900).optional().default(420).describe(
            'Embed height in px (200-900, default 420). Width is responsive (100%, max 650px).'),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ pins, show_labels, zoom, height }) => {
        const placed = [];
        const failed = [];
        const results = await Promise.all(pins.map(async (pin) => {
          const q = parseBlock(pin.address);
          let geo = await geocodeArlington(q);
          if (geo && !inEmbedArea(geo.lng, geo.lat)) geo = null;
          if (!geo) geo = await geocodeCensusNearby(q);
          if (!geo) return { pin, geo: null };
          const d = describe(classify(neighborhoods, countyRing, geo.lng, geo.lat));
          const jurisdiction = d.status === 'outside_arlington'
            ? (await lookupJurisdiction(geo.lng, geo.lat)) || 'Outside Arlington'
            : 'Arlington';
          return { pin, geo, d, jurisdiction };
        }));
        for (const { pin, geo, d, jurisdiction } of results) {
          if (!geo) {
            failed.push(pin.address);
            continue;
          }
          placed.push({
            lat: +geo.lat.toFixed(5),
            lng: +geo.lng.toFixed(5),
            label: pin.label?.trim() ||
              (/block\s+of/i.test(pin.address) ? pin.address : defaultLabel(geo.matched)),
            neighborhood: d.status === 'in_neighborhood' ? d.neighborhood : null,
            jurisdiction,
          });
        }

        if (!placed.length) {
          return refusal('None of those addresses could be found in or near Arlington.');
        }

        // lat,lng[,label[,sub]] — sub (the jurisdiction) only for out-of-county
        // pins; the embed shows it where the neighborhood would go.
        const pinsParam = placed.map((p) => {
          const sub = p.jurisdiction !== 'Arlington' ? p.jurisdiction : '';
          let s = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
          if (p.label || sub) s += `,${encodeURIComponent(p.label)}`;
          if (sub) s += `,${encodeURIComponent(sub)}`;
          return s;
        }).join('|');
        const embedUrl = `${EMBED_BASE}?pins=${pinsParam}` +
          (show_labels ? '&labels=1' : '') +
          (zoom !== 'close' ? `&zoom=${zoom}` : '');
        const embedCode =
          `<iframe src="${embedUrl}"\n` +
          `  style="width:100%;max-width:650px;height:${height}px;border:0;display:block"\n` +
          `  loading="lazy" title="Map of Arlington locations"></iframe>`;

        let sentence = `Embed with ${placed.length} pin${placed.length === 1 ? '' : 's'} ` +
          `(${placed.map((p) => p.label).join('; ')}):\n\n${embedCode}`;
        if (failed.length) {
          sentence += `\n\nNot found in or near Arlington (skipped): ${failed.join('; ')}`;
        }
        return result(sentence, { embedUrl, embedCode, pins: placed, failed });
      },
    );

    this.server.registerTool(
      'list_neighborhoods',
      {
        description:
          'List all ARLnow Arlington neighborhood names in their canonical ' +
          'spellings (e.g. "Green Valley", "Hall\'s Hill / High View Park").',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        const names = neighborhoods.features.map((f) => f.properties.name).sort();
        return result(names.join('\n'), { count: names.length, neighborhoods: names });
      },
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (url.pathname === '/mcp') {
      if (env.RATE_LIMITER) {
        const ip = request.headers.get('cf-connecting-ip') || 'anon';
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) return new Response('Rate limit exceeded', { status: 429 });
      }
      return NeighborhoodMCP.serve('/mcp').fetch(request, env, ctx);
    }
    return new Response('Not found', { status: 404 });
  },
};
