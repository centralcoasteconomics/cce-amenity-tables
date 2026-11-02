# Attribution and license

The tiles published by this repository (the `data` branch: `tiles/`, `manifest.json`) are a
**derived database** of OpenStreetMap data.

**© OpenStreetMap contributors, ODbL.**

- Source: OpenStreetMap, https://www.openstreetmap.org/copyright, via the Geofabrik California
  extract (https://download.geofabrik.de/north-america/us/california.html).
- License: Open Database License (ODbL) 1.0, https://opendatacommons.org/licenses/odbl/1-0/.
  The tiles are offered under the same license. Anyone may use them on the ODbL's terms; a
  database derived from them must also be shared under the ODbL.
- What was done to the data: filtered to the tags listed in `lib/tags.mjs`, reduced to the tags
  the reading application uses, ways and relations reduced to a representative point (the
  middle of the bounding box) plus the box, barrier ways kept with full geometry, and split
  into 0.1 degree tiles. No data from any other source is mixed in.
- Vintage: `manifest.json` `osmTimestamp` (the extract's replication timestamp). Every tile
  also carries it.

## How the application must cite it

Every fact, map and exhibit built from these tiles shows:

> © OpenStreetMap contributors, ODbL. OSM extract of YYYY-MM-DD.

where the date is the `osmTimestamp` (first ten characters) of the tiles that answered. The
reader returns it as `vintage`, and `sourceLabel(vintage)` builds the source string
`OpenStreetMap (OSM extract of YYYY-MM-DD)`. A report must never call the data "live" or
"current": it is the state of the map on that date.

The code in this repository (everything outside the tiles) is the property of Central Coast
Economics and is not covered by the ODbL.
