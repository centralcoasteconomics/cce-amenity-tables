# cce-amenity-tables

Weekly California extract of the OpenStreetMap features Site Due Diligence (Central Coast
Economics) reads from Overpass today, published as small gzip JSON tiles, with a reader that
answers in Overpass's own element shape so the app can change sources with a one-line swap.

**Why.** The public Overpass mirrors failed about 95% of calls from 10/20 to 10/23/2026 and 70%
over 30 days; Overpass was the slowest failing source in 55 of 87 runs, and it feeds CTCAC C1
Site Amenities (up to 15 points). A failed call moves points. Design: item 1 of
`~/Developer/CCE_DATA_IN_HOUSE_PLAN_2026-10-23.md`. Pattern: `cce-transit-tables`.

## What is in the tiles

Three layers, each mirroring one Overpass query in the app (`src/main/connectors/`). The lists
live in `lib/tags.mjs`; `npm test` fails if they drift from the app (primer trap #27).

| Layer | App query it replaces | Elements | Tags kept |
|---|---|---|---|
| `pois` | `amenitiesOsm.ts` AMENITY_QUERY: `nwr[k=v]` for all 26 `OSM_TAG_FILTERS`, `out center tags` | nodes, ways, relations | the 24 the app reads: classification (`shop amenity leisure healthcare public_transport highway railway station`), seniors (`social_facility:for community_centre:for social_centre:for`), exclusions and notes (`access school library:type healthcare:speciality pharmacy dispensing`), `name`, `addr:housenumber addr:street addr:city`, `brand operator opening_hours` |
| `barriers` | `amenitiesOsm.ts` BARRIER_QUERY: `way[highway=motorway\|trunk]`, `way[waterway=river\|canal]`, `way[railway=rail][service!~"yard\|spur\|siding"]`, `out geom` | ways, full geometry | `highway waterway railway` |
| `substations` | `infrastructure.ts` substations(): `nwr["power"="substation"]`, `out center tags` | nodes, ways, relations | `power name operator voltage` |

Not covered yet: `siteLines.ts` (service drives, paths, rail beds within 250 ft) and
`buildingFootprints.ts`. Every footway, service road and building in the state would make the
tiles roughly 20 to 50 times larger; they are better served as their own layer later (or from
R2), and both connectors already have a non-OSM partner source.

### Tile files and record shape

- `tiles/<floor(lat*10)>_<floor(lng*10)>.json.gz`: one file per 0.1 degree cell that has
  anything in it (for example `342_-1193` = lat 34.2 to 34.3, lng -119.3 to -119.2). No file
  means no features there. Gzip with no name and a zero mtime, features sorted, so an
  unchanged tile is byte-identical week to week.
- Tile body: `{ schema: 1, tile, osmTimestamp, attribution, pois: [], substations: [], barriers: [] }`.
- A node: `{ t: "n", id, lat, lng, tags }`.
- A way or relation (pois, substations): `{ t: "w"|"r", id, lat, lng, bbox: [s, w, n, e], tags }`.
  `lat`/`lng` is the middle of the bounding box, computed with Overpass's own arithmetic so the
  7th decimal matches `out center` (checked against 84 of 84 live centers).
- A barrier: `{ t: "w", id, g: [[lng, lat], ...], tags }`, every node of the way.
- A way or relation is stored whole in every tile its box (or, for a barrier, any segment)
  touches, so a large park or a long freeway is found from any side; the reader dedupes.
- `manifest.json`: `buildDate`, `osmTimestamp` (the extract's replication timestamp),
  `citeAs`, totals per layer, counts per tag (`pois:amenity=library`), the golden probe
  results, and per tile counts and bytes.

### Reader

`reader.mjs` is self-contained (no imports; Workers and Node 20+), typed by `reader.d.ts`.

```js
import { createReader, sourceLabel } from './reader.mjs'
const tiles = createReader() // default base URL: the data branch on raw.githubusercontent.com
const { elements, vintage } = await tiles.query('pois', lat, lng, 4828)
```

`query(layer, lat, lng, radiusM)` resolves to `{ elements, vintage, osmTimestamps, tiles, missing }`.
`elements` is exactly what `(JSON.parse(text) as OverpassResponse).elements` was:
`{ type, id, lat, lon, tags }` for nodes, `{ type, id, center: { lat, lon }, bounds, tags }`
for ways and relations, `{ type: 'way', id, geometry: [{ lat, lon }], tags }` for barriers,
in Overpass's order (nodes, ways, relations, each by id). Tags carry only the keys listed
above. A 404 tile is empty; any other HTTP failure throws (never a silent empty answer).
Tiles are cached in memory (64 by default), so the amenity, barrier and substation queries
of one run share the same 4 or so fetches. Options: `baseUrl`, `fetch`, `loadTile` (read from
R2, KV or disk), `cacheTiles`.

**The swap in the app** (not done here; the app repo was not touched):

```ts
// amenitiesOsm.ts fetchAmenities()
const [amenityEls, barrierEls] = await Promise.all([
  tiles.query('pois', lat, lng, RADIUS_M).then((r) => r.elements),      // was runQuery(AMENITY_QUERY(...))
  tiles.query('barriers', lat, lng, RADIUS_M).then((r) => r.elements)   // was runQuery(BARRIER_QUERY(...))
])
// infrastructure.ts substations(): data.elements = (await tiles.query('substations', lat, lng, m)).elements
```

Everything after that (classifyAmenity, exclusionFor, verifyNoteFor, toBarrier, distances) is
unchanged, which is why the records match. Change `SOURCE` to `sourceLabel(vintage)`
("OpenStreetMap (OSM extract of 2026-10-19)") so every fact carries its vintage. A sensible
rollout keeps Overpass as the fallback when a tile read throws, and logs which source answered.

### How exact is it

- `test/app-parity.test.mjs` bundles the app's own `amenitiesOsm.ts` (read-only, with the app's
  esbuild; only `fetchText` is stubbed) and runs `fetchAmenities` twice on the fixture: fed a
  hand-written Overpass oracle and fed the reader. The `OsmResult` (amenities, transit,
  barriers, barriersFound) is deeply equal. It also checks the tag lists against the app source.
- Live check, 2026-10-23, Santa Barbara (34.4208, -119.6982, 3 mi): BBBike extract of
  2026-10-16 through osmium, build and reader, against live Overpass the same day. Same 122
  barrier ways, same substation; 504 of 506 POIs (the 2 missing were added or retagged after
  10/16); the app built 219 amenity records from Overpass and 218 from the tiles, all 218
  byte-identical, and the nearest qualifying record in every category was the same. Every
  difference traced to edits between the extract and the live database, none to the pipeline.
- The one deliberate approximation: for a way or relation, Overpass `around` measures to its
  outline; the tiles keep the box, so the reader measures to the box. That can only admit more
  (a large area whose box, not outline, reaches the circle), never fewer, and the app's
  distances use the center either way.

## Guards (a held set of tiles always beats a degraded one)

`build.mjs` writes the tiles to `out/`, then decides. A red run publishes nothing, so the last
good tiles stay live at the same URLs, and the run goes red.

- **Collapse.** A layer total more than 10% below the last published summary
  (`state/published.json`) holds the run. 3 to 10% publishes with a warning.
- **Category dropout.** One tag (for example `pois:amenity=library`) with at least 100
  features published, falling more than 25%, holds the run: the statewide total can survive a
  whole tag going to zero.
- **Golden probe** (`golden.json`). 18 long-standing places across the state (central
  libraries in Los Angeles, San Francisco, San Diego, Sacramento, Ventura, Santa Barbara,
  Bakersfield, Redding and Eureka; Cedars-Sinai, SF General, Kern Medical, Community Regional
  Fresno and Cottage hospitals; Golden Gate, Balboa and Alameda parks; LA Union Station), each
  looked up through `reader.mjs` in the tiles just written. One miss holds the run. Matched by
  tag and name near a point, not by OSM id (a node can be remapped as a way). Edit it only in a
  reviewed commit, never to turn a red run green.
- **Vintage.** An extract older than the published one is red; the same one is skipped (green,
  nothing to publish); one more than 14 days old at build time is red; no timestamp is red.
- **Download.** Verified against Geofabrik's `.md5`, three attempts, then red.

Each run is appended to `state/history.json` (last 104 runs).

## Schedule and pipeline

`.github/workflows/weekly.yml`: Mondays 09:41 UTC, plus manual dispatch.

1. Install osmium-tool (apt) and run `npm test` (unit tests and the osmium end-to-end test).
2. Download `california-latest.osm.pbf` from Geofabrik inside the runner (about 1.33 GB on
   2026-10-21; never committed), check the `.md5`.
3. `node build.mjs --pbf ...`: `osmium fileinfo` (replication timestamp),
   `osmium tags-filter` (exactly the tags above, referenced objects kept),
   `osmium add-locations-to-ways -f opl` streamed into Node, tiles, manifest, golden probe, guards.
4. Green: `out/` is force-pushed as a single commit to the `data` branch (the repo does not
   grow by a statewide copy each week). Then `record.mjs` commits `state/` to `main`.

## Size estimate for California

Measured on the Santa Barbara extract (8.7 MB PBF): 1,014 POIs, 10 substations, 307 barrier
ways, 6 tiles, 63 KB gzip (301 KB raw), built in under a second. Scaled by PBF size to the 1.33
GB state extract (x154) and allowing for long rivers, canals and freeways being repeated in
every tile they cross: **about 10 to 40 MB gzip in about 4,000 to 4,500 tile files**
(roughly 50 to 200 MB uncompressed), most tiles a few KB and the densest Los Angeles and Bay
Area tiles in the low hundreds of KB. A 3 mile query reads 4 to 6 tiles. The first real run's
manifest gives the actual figure. The runner needs well under its 14 GB disk and 16 GB RAM.

## License and citation

The tiles are a derived database of OpenStreetMap: **© OpenStreetMap contributors, ODbL**.
They are offered under the ODbL 1.0 (see `ATTRIBUTION.md`, also published on the data branch).
The app must cite the vintage on every fact, map and exhibit built from them:
"© OpenStreetMap contributors, ODbL. OSM extract of YYYY-MM-DD", where the date is the
reader's `vintage` (`sourceLabel(vintage)` builds the source string). Never "live" or "current".

## Local development

```sh
npm test                                   # unit tests; osmium and app-parity tests run when available
node build.mjs --pbf small.osm.pbf --golden none --published .work/no-baseline.json   # an absent file = no baseline
```

Do not build the full state extract on an 8 GB Mac; use a city extract (BBBike) and
`--golden <subset.json>`. `CCE_APP_DIR` points the parity test at another app checkout.

## Publishing (for the lead)

1. Review the commits in `~/Developer/cce-amenity-tables`.
2. Create the public repo and push:
   ```sh
   cd ~/Developer/cce-amenity-tables
   gh repo create centralcoasteconomics/cce-amenity-tables --public --description "Weekly California OpenStreetMap amenity tiles for Site Due Diligence (ODbL)"
   git remote add origin https://github.com/centralcoasteconomics/cce-amenity-tables.git
   git config credential.helper '' && git config --add credential.helper '!gh auth git-credential'   # primer trap #4 (already set in this clone)
   git push -u origin main
   ```
3. In the repo settings, Actions, General: Workflow permissions "Read and write" (the workflow
   pushes the `data` branch and `state/`).
4. Run it once: `gh workflow run weekly-amenity-tiles -R centralcoasteconomics/cce-amenity-tables`,
   then `gh run watch -R centralcoasteconomics/cce-amenity-tables`. The first run has no
   published baseline, so only the golden probe and vintage guards apply; it should take about
   10 to 20 minutes.
5. Check `https://raw.githubusercontent.com/centralcoasteconomics/cce-amenity-tables/data/manifest.json`
   (totals, golden all ok) and one tile, for example
   `https://raw.githubusercontent.com/centralcoasteconomics/cce-amenity-tables/data/tiles/342_-1193.json.gz`.
6. Then wire the reader into the app (the swap above), behind the Overpass fallback, in an app session.

Later: the same `out/` can be synced to an R2 bucket and read with `createReader({ baseUrl })`
or `loadTile`, which removes the raw.githubusercontent.com dependency and its short cache.
