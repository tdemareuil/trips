# Trips

A small static site for upcoming trips, meant to be served with GitHub Pages. Each trip is a day-by-day itinerary with photos and a map. There is no build step: the page is plain HTML, CSS and JavaScript, and the map uses [MapLibre GL](https://maplibre.org) with the OpenFreeMap Liberty basemap.

## Views

- **Home** (`#/`): one card per trip.
- **Trip** (`#/california`, `#/california/3`): slide 0 is an overview, with the whole route on the map and the list of days. Slides 1 to N are the days. The arrow keys, the side arrows, the day rail at the bottom and swipes all move between days, and the right arrow on the last day goes back to the overview. Each day shows its date, its places as photo tiles (click a tile to flip it to a short cultural note), the night, the transport times, and the route animated on the map.

## Layout

```
index.html            page shell
css/style.css
js/app.js             router, story view, map view
data/trips.json       ordered list of trip ids
data/trips/<id>.json  one itinerary per trip (edited by hand)
data/images.json      photos, credits, coordinates and French Wikipedia extracts (generated)
data/routes.json      driving geometry per day (generated)
scripts/build_data.py fills the two generated files
```

## Adding a trip

1. Create `data/trips/<id>.json` and add `<id>` to `data/trips.json`. `california.json` is the reference. The trip has a `start` date (`YYYY-MM-DD`), and each day gets its date from it; an optional `altStart` shows an alternative departure date on the overview. Each day has a title, a summary, optional `parts` (for example one line per person), `stops` (can be empty), a `stay`, `transport` lines (modes: `car`, `transit`, `flight`, `boat`, `bus`, `train`), and optional `notes` (short warnings or logistics, shown in a highlighted box). A trip without `start` simply shows no dates.
2. Each stop needs a `wiki` field, the title of its English Wikipedia article. The script takes the lead photo and the coordinates from it. A stop can also set:
   - `coords: [lat, lon]` to override or supply the position (needed when the article has no coordinates, or none exists);
   - `photo: "File:Name.jpg"` to use a specific Wikimedia Commons file instead of the article's lead image;
   - `culture: "..."`, a sentence or two shown on the back of the tile. Without it, the tile falls back to the intro of the French Wikipedia article, which is often dry, so it is worth writing one.
3. Set `"route": "drive"` on days that are made by car to get a road geometry. Other days get a dashed straight line between their places.
4. Run the script, then reload the page:

   ```bash
   python3 scripts/build_data.py
   ```

   Existing entries are kept, so only new places and changed days are fetched. `--refresh` fetches everything again. If Python reports a certificate error, point it at the system certificates with `SSL_CERT_FILE=/etc/ssl/cert.pem`.

## Guides and comparisons

Comparisons and studies that go with a trip (rankings of reefs or islands, climate, a variant of the route) live in the trip's `guides` list. Each guide is a page, `#/<trip>/guide/<guide-id>`, listed under "Guides & comparatifs" on the trip overview. A guide has an `id`, a `title`, a `summary` and `blocks`, where each block is one of:

- `{ "type": "heading", "text": "..." }`
- `{ "type": "text", "text": "..." }`
- `{ "type": "list", "ordered": true, "items": ["..."] }`
- `{ "type": "table", "columns": ["..."], "rows": [["..."]] }`

Tables scroll sideways on desktop and turn into one card per row on phones. `brazil.json` has four guides.

## Access code

A trip can ask for a code before it opens. Add a `lock` field to its JSON with the SHA-256 hash of the code:

```bash
printf '%s' 'the-code' | shasum -a 256
```

The code is checked in the browser and remembered for the tab session. This is a light gate, not security: the trip files stay readable in the repository.

## Running locally

```bash
python3 -m http.server 8822
```

Then open http://localhost:8822.

## Deploying

In the repository settings, set Pages to deploy from the `main` branch, root folder.

## Credits

Photos come from Wikipedia and Wikimedia Commons and are hotlinked, not copied. Each photo carries its own free licence; the © on a photo links to its author and licence. Routes come from the public [OSRM](https://project-osrm.org) demo server and map tiles from [OpenFreeMap](https://openfreemap.org) and map data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
