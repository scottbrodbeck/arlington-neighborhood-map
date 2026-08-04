# Generating ARLnow pin-map embeds

The **arlnow-neighborhoods** MCP connector
(`https://arlnow-neighborhoods-mcp.local-news-now-group.workers.dev/mcp`)
has a `generate_pin_embed` tool that turns a list of Arlington, VA addresses
into a ready-to-paste, responsive `<iframe>` map embed for ARLnow articles.

## When to use it

Whenever a story references one or more specific Arlington locations and a
small locator map would help — a crash site, a new restaurant, a list of
affected blocks. Give the tool the addresses; paste the returned iframe into
the article HTML as-is.

## Input

```json
{
  "pins": [
    { "address": "3100 Columbia Pike", "label": "Crash site" },
    { "address": "2000 block of N Quincy St" }
  ],
  "show_labels": true,
  "zoom": "close",
  "height": 420
}
```

- **pins** (required, 1–20): each needs an `address` — a street address
  (`"3100 Columbia Pike"`) or a block (`"2000 block of N Quincy St"`).
  `label` is optional; it's the text shown on the map pin. Default label is
  the matched street address (or the block phrase as written). Keep labels
  short — a few words.
- **show_labels** (default `true`): `true` opens every pin's label on load;
  `false` shows labels only when a reader clicks a pin. Turn off when many
  pins are close together and open labels would overlap.
- **zoom** (default `"close"`): `"close"` frames the pins tightly,
  `"medium"` backs off for more context, `"wide"` always shows the whole
  county. Use `"wide"` when county-wide context matters ("all five sites"),
  `"close"` for a single location.
- **height** (default `420`): embed height in px, 200–900. Width is always
  responsive (100% of the article column, max 650px) — don't change that.

## Output

The reply contains the iframe snippet ready to paste, plus a JSON line with:
`embedUrl`, `embedCode`, `pins` (each with `lat`, `lng`, `label`, and its
ARLnow `neighborhood` — useful for phrasing the story), and `failed`
(addresses that couldn't be found in Arlington and were skipped).

If an address lands in `failed`, tell the user rather than silently dropping
it — it usually means a typo or a non-Arlington location.

## Rules and limits

- **Arlington County only.** Out-of-county addresses are skipped and listed
  in `failed`; the tool never returns coordinates for them.
- **Max 20 pins** per embed.
- **Embeds are stateless and immutable.** All pin data lives in the URL;
  nothing is stored. To change pins after publishing, generate a new embed
  and replace the iframe in the article.
- The same connector also offers `lookup_neighborhood` /
  `lookup_by_coordinates` (which neighborhood is this address in, including
  "on the border of X and Y") and `list_neighborhoods` (canonical spellings)
  — use those for phrasing, and `generate_pin_embed` for the map itself.

## Example exchange

> **User:** Make a map for the story: fires at 4600 Fairfax Dr and the
> 800 block of S Walter Reed Dr.
>
> **Call:** `generate_pin_embed` with
> `{"pins":[{"address":"4600 Fairfax Dr"},{"address":"800 block of S Walter Reed Dr"}]}`
>
> **Then:** paste the returned `<iframe … >` snippet into the article and
> mention each pin's neighborhood (from the JSON) in the copy.
