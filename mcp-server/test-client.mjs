/* Local MCP test client — drives the full streamable-HTTP handshake and runs
 * the verification checklist. Usage: node test-client.mjs [baseUrl] */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] || 'http://127.0.0.1:8788/mcp';
const client = new Client({ name: 'arlnow-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(base)));

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '), '\n');

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  const label = args.query ?? JSON.stringify(args);
  console.log(`■ ${name}(${label})`);
  console.log('  ', texts[0]);
  if (texts[1]) console.log('   JSON:', texts[1]);
  console.log();
  return texts;
}

await call('lookup_neighborhood', { query: '1015 N Quincy St' });
await call('lookup_neighborhood', { query: '3100 Columbia Pike' });
await call('lookup_neighborhood', { query: '2000 block of N Quincy St' });
await call('lookup_neighborhood', { query: '5115 26th St N' });
await call('lookup_neighborhood', { query: '4040 Wilson Blvd' });
await call('lookup_by_coordinates', { lat: 38.8719, lng: -77.0563 }); // Pentagon
// Scope guard — must refuse with NO coordinates
await call('lookup_neighborhood', { query: '1600 Pennsylvania Ave NW, Washington DC' });
await call('lookup_neighborhood', { query: '350 5th Ave, New York' });
await call('lookup_by_coordinates', { lat: 38.8895, lng: -77.0353 }); // DC coords
const ln = await call('list_neighborhoods', {});
const parsed = JSON.parse(ln[1]);
console.log('list_neighborhoods count:', parsed.count,
  '| has Green Valley:', parsed.neighborhoods.includes('Green Valley'),
  "| has Hall's Hill / High View Park:", parsed.neighborhoods.includes("Hall's Hill / High View Park"));

await client.close();
