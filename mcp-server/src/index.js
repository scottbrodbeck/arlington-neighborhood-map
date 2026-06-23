/* ARLnow Arlington Neighborhood Lookup — remote MCP server (Cloudflare Worker).
 *
 * Exposes the same neighborhood classification as map.arlnow.com to Claude as a
 * connector. Reuses the website's exact border algorithm (docs/classify.mjs)
 * and polygon data so answers can never drift from the public map.
 *
 * SCOPE GUARD — Arlington County, Virginia only. There is no national geocoder
 * in this server (only Arlington County GIS, which returns nothing for
 * out-of-county addresses), every path is gated by classify()/inCounty, and any
 * out-of-scope result is a flat "Address not in Arlington." with NO coordinates
 * or matched address — so it cannot be repurposed as a general geocoder.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { classify, parseBlock, describe } from '../../docs/classify.js';
import neighborhoods from '../../docs/neighborhoods.json';
import countyData from '../../docs/county.json';

const countyRing = countyData.ring;

const ARL_GEOCODER =
  'https://arlgis.arlingtonva.us/arcgis/rest/services/Geoprocessing/' +
  'Composite_AddPnt_Stnet/GeocodeServer/findAddressCandidates';

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
  const ok = (data.candidates || []).filter((c) => c.score >= 80);
  if (!ok.length) return null;
  ok.sort((a, b) =>
    (b.score - a.score) ||
    ((b.attributes?.Addr_type === 'PointAddress') - (a.attributes?.Addr_type === 'PointAddress')));
  const c = ok[0];
  return { lng: c.location.x, lat: c.location.y, matched: c.address };
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
        'out-of-county input. Use list_neighborhoods for canonical spellings.',
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
