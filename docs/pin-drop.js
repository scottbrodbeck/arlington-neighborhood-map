/* Pin-drop embed builder — unlisted page that geocodes Arlington addresses or
 * blocks in the browser and emits a copy-paste <iframe> pointing at
 * embed.html?pins=... . Fully stateless: nothing is saved server-side. */

import { classify, describe, parseBlock } from './classify.js';
import { geocode } from './geocode.js';

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

const pins = []; // { lat, lng, label, hood }

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
    /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function showStatus(text, isError = false) {
  statusEl.hidden = !text;
  statusEl.className = isError ? 'error' : '';
  statusEl.textContent = text;
}

// Street number (or block form) followed by a street name — filters out
// comma-separated clauses like "Suite 200", "Arlington", or "VA 22201".
function looksLikeAddress(clause) {
  return /^(?:the\s+)?\d{1,5}\s+(?:block\s+of\s+)?\S*[a-z]/i.test(clause);
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
  const clauses = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const addresses = clauses.filter(looksLikeAddress);
  const queries = addresses.length ? addresses : [raw];

  showStatus('Searching…');
  const failed = [];
  let added = 0;
  for (const q of queries) {
    if (pins.length >= MAX_PINS) {
      failed.push(`${q} (over the ${MAX_PINS}-pin cap)`);
      continue;
    }
    const geo = await geocode(parseBlock(q), countyRing);
    const d = geo && describe(classify(hoods, countyRing, geo.lng, geo.lat));
    if (!geo || d.status === 'outside_arlington') {
      failed.push(q);
      continue;
    }
    pins.push({
      lat: +geo.lat.toFixed(5),
      lng: +geo.lng.toFixed(5),
      label: /block\s+of/i.test(q) ? q : defaultLabel(geo.matched),
      hood: d.status === 'in_neighborhood' ? d.neighborhood : null,
    });
    added++;
  }

  if (added) input.value = '';
  if (!failed.length) {
    showStatus('');
  } else if (added) {
    showStatus(`Added ${added}, but couldn't find in Arlington: ${failed.join('; ')}`, true);
  } else {
    showStatus("Couldn't find that in Arlington. Try a street address like " +
      '“3100 Columbia Pike” or “2000 block of N Quincy St”.', true);
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

function pinsParam() {
  return pins.map((p) => {
    const label = p.label.trim();
    return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}` +
      (label ? `,${encodeURIComponent(label)}` : '');
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
