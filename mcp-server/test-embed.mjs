import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] || 'http://127.0.0.1:8788/mcp';
const client = new Client({ name: 'arlnow-embed-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(base)));

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '), '\n');

async function call(args) {
  const r = await client.callTool({ name: 'generate_pin_embed', arguments: args });
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  console.log('■ generate_pin_embed', JSON.stringify(args));
  console.log(texts[0]);
  if (texts[1]) console.log('JSON:', texts[1]);
  console.log();
  return texts;
}

// defaults (labels on, close zoom, 420px)
await call({ pins: [{ address: '2100 Clarendon Blvd' }] });
// multiple pins, custom label, medium zoom, custom height, labels off
await call({
  pins: [
    { address: '3100 Columbia Pike', label: 'Crash site' },
    { address: '2000 block of N Quincy St' },
  ],
  show_labels: false, zoom: 'medium', height: 500,
});
// wide zoom
await call({ pins: [{ address: '1100 Wilson Blvd' }], zoom: 'wide' });
// just outside Arlington: intersection (Fairfax County), Fairfax address with a
// Falls Church mailing address, Old Town Alexandria, downtown DC (all in the
// embed area -> jurisdiction captions), plus the StreetName-junk regression
await call({ pins: [
  { address: 'Columbia Pike & Carlin Springs Rd' },
  { address: '5800 Columbia Pike, Falls Church' },
  { address: '5800 Columbia Pike' },
  { address: '100 King St, Alexandria, VA' },
  { address: '1600 Pennsylvania Ave NW, Washington DC' },
]});
// mixed near/far + fully out of range
await call({ pins: [{ address: '4420 33rd St N' }, { address: '350 5th Ave, New York' }] });
await call({ pins: [{ address: '350 5th Ave, New York' }] });

await client.close();
