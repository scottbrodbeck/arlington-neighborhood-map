/* Pin-drop embed builder — unlisted page that geocodes Arlington-area
 * addresses or blocks in the browser and emits a copy-paste <iframe> pointing
 * at embed.html?pins=... . Pins just outside Arlington (Bailey's Crossroads,
 * Falls Church, Alexandria, D.C.) are allowed and get their jurisdiction in
 * place of a neighborhood. Fully stateless: nothing is saved server-side. */

import { classify, describe, parseBlock } from './classify.js?v=3';
import { geocode, lookupJurisdiction } from './geocode.js?v=3';

const EMBED_BASE = 'https://map.arlnow.com/embed.html';
const MAX_PINS = 20;

let hoods = null;
let countyRing = null;
const dataReady = Promise.all([
  fetch('./neighborhoods.json').then((r) => r.json()),
  fetch('./county.json').then((r) => r.json()),
]).then(([h, c]) => {
  hoods = h;
  countyRing = c.ring;
});

// { lat, lng, label, hood, sub } — `hood` is what the list shows (neighborhood
// or jurisdiction); `sub` is only set for out-of-county pins and rides in the
// embed URL since the embed can't compute jurisdictions itself.
const pins = [];

const form = document.getElementById('add-form');
const input = document.getElementById('add-input');
const statusEl = document.getElementById('add-status');
const listEl = document.getElementById('pin-list');
const outputEl = document.getElementById('builder-output');
const heightInput = document.getElementById('height-input');
const labelsInput = document.getElementById('labels-input');
const zoomInputs = document.querySelectorAll('#zoom-row input[name="zoom"]');
const previewEl = document.getElementById('preview');
const codeEl = document.getElementById('embed-code');
const copyBtn = document.getElementById('copy-btn');

// "2100 CLARENDON BLVD, ARLINGTON, VIRGINIA" -> "2100 Clarendon Blvd"
function defaultLabel(matched) {
  const street = matched.split(',')[0].trim();
  return street.replace(/\S+/g, (w) =>
    /^\d/.test(w) || /^(?:N|S|E|W|NE|NW|SE|SW)$/i.test(w)
      ? w.toUpperCase()
      : w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function showStatus(text, isError = false) {
  statusEl.hidden = !text;
  statusEl.className = isError ? 'error' : '';
  statusEl.textContent = text;
}

// Street number (or block form) followed by a street name, or an intersection
// ("Columbia Pike & Carlin Springs Rd").
function looksLikeAddress(clause) {
  return /^(?:the\s+)?\d{1,5}\s+(?:block\s+of\s+)?\S*[a-z]/i.test(clause) ||
    /[a-z]\s+(?:&|and|at|\/)\s+[a-z]/i.test(clause);
}

// Unit-style clauses ("Suite 200", "Apt 3B", "#4", "2nd floor") are dropped;
// any other non-address clause (a city, "VA", "VA 22204") is kept as context
// on the preceding address, which matters for out-of-county pins.
function isUnitClause(clause) {
  return /^(?:suite|ste|apt|apartment|unit|#|floor|fl|room|rm|bldg|building)\b/i.test(clause) ||
    /^\d+(?:st|nd|rd|th)\s+(?:floor|fl)\b/i.test(clause);
}

// "1100 Wilson Blvd, Suite 200, 100 King St, Alexandria, VA"
//   -> ["1100 Wilson Blvd", "100 King St, Alexandria, VA"]
function splitAddresses(raw) {
  const out = [];
  for (const clause of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (looksLikeAddress(clause)) out.push(clause);
    else if (out.length && !isUnitClause(clause)) out[out.length - 1] += `, ${clause}`;
  }
  return out;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw) return;
  if (pins.length >= MAX_PINS) {
    showStatus(`Embeds are capped at ${MAX_PINS} pins.`, true);
    return;
  }
  await dataReady;

  // Comma-separated addresses become one pin each; when nothing looks like a
  // street address, fall back to geocoding the whole input as one query so
  // named places ("Wakefield High School") keep working.
  const addresses = splitAddresses(raw);
  const queries = addresses.length ? addresses : [raw];

  showStatus('Searching…');
  const failed = [];
  let added = 0;
  for (const q of queries) {
    if (pins.length >= MAX_PINS) {
      failed.push(`${q} (over the ${MAX_PINS}-pin cap)`);
      continue;
    }
    const geo = await geocode(parseBlock(q)); // null unless in the embed area
    if (!geo) {
      failed.push(q);
      continue;
    }
    const d = describe(classify(hoods, countyRing, geo.lng, geo.lat));
    const pin = {
      lat: +geo.lat.toFixed(5),
      lng: +geo.lng.toFixed(5),
      label: /block\s+of/i.test(q) ? q : defaultLabel(geo.matched),
      hood: null,
      sub: null,
    };
    if (d.status === 'in_neighborhood') {
      pin.hood = d.neighborhood;
    } else if (d.status === 'outside_arlington') {
      // Just over the line: caption with the jurisdiction instead.
      pin.sub = (await lookupJurisdiction(geo.lng, geo.lat)) || 'Outside Arlington';
      pin.hood = pin.sub;
    }
    pins.push(pin);
    added++;
  }

  if (added) input.value = '';
  if (!failed.length) {
    showStatus('');
  } else if (added) {
    showStatus(`Added ${added}, but couldn't find near Arlington: ${failed.join('; ')}`, true);
  } else {
    showStatus("Couldn't find that in or near Arlington. Try a street address " +
      'like “3100 Columbia Pike”, a block like “2000 block of N Quincy St”, or an ' +
      'intersection like “Columbia Pike & Carlin Springs Rd”.', true);
  }
  render();
});

function render() {
  listEl.textContent = '';
  pins.forEach((pin, i) => {
    const li = document.createElement('li');

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = pin.label;
    labelInput.setAttribute('aria-label', `Label for pin ${i + 1}`);
    labelInput.addEventListener('input', () => {
      pin.label = labelInput.value;
      scheduleOutputUpdate();
    });
    li.appendChild(labelInput);

    const meta = document.createElement('span');
    meta.className = 'pin-meta';
    meta.textContent = pin.hood ? pin.hood : `${pin.lat}, ${pin.lng}`;
    li.appendChild(meta);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      pins.splice(i, 1);
      render();
    });
    li.appendChild(removeBtn);

    listEl.appendChild(li);
  });
  updateOutput();
}

// lat,lng[,label[,sub]] — sub only for out-of-county pins.
function pinsParam() {
  return pins.map((p) => {
    const label = p.label.trim();
    let s = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    if (label || p.sub) s += `,${encodeURIComponent(label)}`;
    if (p.sub) s += `,${encodeURIComponent(p.sub)}`;
    return s;
  }).join('|');
}

function updateOutput() {
  outputEl.hidden = pins.length === 0;
  if (!pins.length) return;

  const zoom = [...zoomInputs].find((r) => r.checked)?.value || 'close';
  const query = `?pins=${pinsParam()}` +
    (labelsInput.checked ? '&labels=1' : '') +
    (zoom !== 'close' ? `&zoom=${zoom}` : '');
  const height = Math.max(200, Math.min(900, +heightInput.value || 420));
  codeEl.value =
    `<iframe src="${EMBED_BASE}${query}"\n` +
    `  style="width:100%;max-width:650px;height:${height}px;border:0;display:block"\n` +
    `  loading="lazy" title="Map of Arlington locations"></iframe>`;

  previewEl.style.height = `${height}px`;
  const src = `embed.html${query}`;
  if (previewEl.getAttribute('src') !== src) previewEl.src = src;
}

// Reloading the preview iframe on every keystroke would thrash the map.
let outputTimer = null;
function scheduleOutputUpdate() {
  clearTimeout(outputTimer);
  outputTimer = setTimeout(updateOutput, 500);
}

heightInput.addEventListener('input', scheduleOutputUpdate);
labelsInput.addEventListener('change', updateOutput);
for (const r of zoomInputs) r.addEventListener('change', updateOutput);

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(codeEl.value);
  } catch {
    codeEl.select();
    document.execCommand('copy');
  }
  copyBtn.textContent = 'Copied!';
  setTimeout(() => { copyBtn.textContent = 'Copy embed code'; }, 1500);
});
