// cce-amenity-tables reader. Self-contained (no imports), so the app can vendor this one file.
//
// It answers the three OpenStreetMap questions the app sends to Overpass today, from the weekly
// California tiles, in the SAME element shape Overpass returns. The app keeps every line of its
// own classification (classifyAmenity, exclusionFor, toBarrier...), so the records it builds are
// unchanged; only the source of the elements moves:
//
//   amenitiesOsm.ts   runQuery(AMENITY_QUERY(lat, lng, RADIUS_M))  ->  tiles.query('pois', lat, lng, RADIUS_M)
//                     runQuery(BARRIER_QUERY(lat, lng, RADIUS_M))  ->  tiles.query('barriers', lat, lng, RADIUS_M)
//   infrastructure.ts substations(): the Overpass POST            ->  tiles.query('substations', lat, lng, m)
//
// `query` resolves to { elements, vintage, osmTimestamps, tiles, missing }. `elements` is what
// `(JSON.parse(text) as OverpassResponse).elements` was. Cite the vintage on every fact:
// sourceLabel(vintage) gives "OpenStreetMap (OSM extract of 2026-10-19)".
//
// Data: (c) OpenStreetMap contributors, ODbL 1.0. See ATTRIBUTION.md.

export const TILE_DEG = 0.1
export const SCHEMA = 1
export const ATTRIBUTION = '© OpenStreetMap contributors, ODbL'
export const DEFAULT_BASE_URL = 'https://raw.githubusercontent.com/centralcoasteconomics/cce-amenity-tables/data'
const EARTH_M = 6371008.8
const RAD = Math.PI / 180

/** Tile id for a point: integer tenths of a degree, "<floor(lat*10)>_<floor(lng*10)>". */
export function tileKey(lat, lng) {
  return `${Math.floor(lat / TILE_DEG + 1e-9)}_${Math.floor(lng / TILE_DEG + 1e-9)}`
}

/** Every tile id a [south, west, north, east] box overlaps. */
export function tilesForBBox(s, w, n, e) {
  const out = []
  const i0 = Math.floor(s / TILE_DEG + 1e-9), i1 = Math.floor(n / TILE_DEG + 1e-9)
  const j0 = Math.floor(w / TILE_DEG + 1e-9), j1 = Math.floor(e / TILE_DEG + 1e-9)
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(`${i}_${j}`)
  return out
}

/** The box (degrees) that holds a circle of `radiusM` metres around a point, with a small margin. */
export function radiusBBox(lat, lng, radiusM) {
  const dLat = (radiusM / EARTH_M) / RAD * 1.001
  const dLng = dLat / Math.max(0.01, Math.cos(lat * RAD))
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng]
}

export function tilesForRadius(lat, lng, radiusM) {
  return tilesForBBox(...radiusBBox(lat, lng, radiusM))
}

/** Great-circle distance in metres. */
export function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Distance (m) from a point to a lat/lng box: 0 inside, else to the nearest point of the box. */
export function bboxDistanceM(lat, lng, [s, w, n, e]) {
  return haversineM(lat, lng, Math.min(n, Math.max(s, lat)), Math.min(e, Math.max(w, lng)))
}

/** Distance (m) from a point to a polyline of [lng, lat] pairs (local plane around the point). */
export function lineDistanceM(lat, lng, coords) {
  const kx = Math.cos(lat * RAD) * RAD * EARTH_M, ky = RAD * EARTH_M
  let best = Infinity
  for (let i = 0; i < coords.length; i++) {
    const ax = (coords[i][0] - lng) * kx, ay = (coords[i][1] - lat) * ky
    if (coords.length === 1) return Math.hypot(ax, ay)
    if (i === coords.length - 1) break
    const bx = (coords[i + 1][0] - lng) * kx, by = (coords[i + 1][1] - lat) * ky
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy
    const t = L > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
  }
  return best
}

const TYPE = { n: 'node', w: 'way', r: 'relation' }

/**
 * One tile record as an Overpass element.
 *   pois / substations (`out center tags`): node -> { type, id, lat, lon, tags };
 *     way / relation -> { type, id, center: { lat, lon }, bounds, tags }. `bounds` is extra
 *     (Overpass `out bb` names) and harmless to the app, which never reads it.
 *   barriers (`out geom`): { type: 'way', id, geometry: [{ lat, lon }], tags }.
 */
export function toOverpassElement(layer, f) {
  const type = TYPE[f.t]
  if (layer === 'barriers') return { type, id: f.id, geometry: f.g.map(([lon, lat]) => ({ lat, lon })), tags: { ...f.tags } }
  if (f.t === 'n') return { type, id: f.id, lat: f.lat, lon: f.lng, tags: { ...f.tags } }
  const [s, w, n, e] = f.bbox
  return { type, id: f.id, center: { lat: f.lat, lon: f.lng }, bounds: { minlat: s, minlon: w, maxlat: n, maxlon: e }, tags: { ...f.tags } }
}

/** True when a tile feature falls within `radiusM` of the point, by the rule Overpass `around` uses. */
export function withinRadius(layer, f, lat, lng, radiusM) {
  if (layer === 'barriers') return lineDistanceM(lat, lng, f.g) <= radiusM
  if (f.t === 'n') return haversineM(lat, lng, f.lat, f.lng) <= radiusM
  // Ways and relations: Overpass measures to the geometry; the tiles keep its bounding box, which
  // can only be nearer, so this admits every feature Overpass would and, rarely, a large area
  // whose box (not outline) reaches the circle. The app's distances use the center either way.
  return bboxDistanceM(lat, lng, f.bbox) <= radiusM
}

/** "2026-10-19T20:21:03Z" -> "OpenStreetMap (OSM extract of 2026-10-19)". */
export function sourceLabel(vintage) {
  return `OpenStreetMap (OSM extract of ${String(vintage ?? 'unknown date').slice(0, 10)})`
}

async function gunzipToText(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  // Already plain JSON (a server or test that decompressed it): starts with "{".
  if (bytes[0] === 0x7b) return new TextDecoder().decode(bytes)
  const ds = new DecompressionStream('gzip')
  const stream = new Blob([bytes]).stream().pipeThrough(ds)
  return await new Response(stream).text()
}

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] where `tiles/<id>.json.gz` and `manifest.json` live
 * @param {typeof fetch} [opts.fetch]
 * @param {(id: string) => Promise<Uint8Array|null>} [opts.loadTile] read a tile yourself (null = no such tile)
 * @param {number} [opts.cacheTiles] tiles kept in memory (default 64)
 */
export function createReader(opts = {}) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const doFetch = opts.fetch ?? globalThis.fetch
  const cacheMax = opts.cacheTiles ?? 64
  const cache = new Map()
  let manifestP = null

  async function loadRaw(id) {
    if (opts.loadTile) return opts.loadTile(id)
    const res = await doFetch(`${baseUrl}/tiles/${id}.json.gz`)
    // No file = no features in that tenth of a degree (ocean, desert); the build writes a tile
    // only when it has something. Any other status is a failure, never an empty answer.
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`amenity tiles: HTTP ${res.status} for tile ${id}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async function tile(id) {
    if (cache.has(id)) {
      const t = cache.get(id)
      cache.delete(id); cache.set(id, t)
      return t
    }
    const p = (async () => {
      const raw = await loadRaw(id)
      if (raw == null) return null
      const t = JSON.parse(await gunzipToText(raw))
      if (t.schema !== SCHEMA) throw new Error(`amenity tiles: tile ${id} has schema ${t.schema}, this reader reads ${SCHEMA}`)
      return t
    })()
    cache.set(id, p)
    p.catch(() => cache.delete(id))
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value)
    return p
  }

  async function manifest() {
    if (!manifestP) {
      manifestP = (async () => {
        const res = await doFetch(`${baseUrl}/manifest.json`)
        if (!res.ok) throw new Error(`amenity tiles: HTTP ${res.status} for manifest.json`)
        return res.json()
      })()
      manifestP.catch(() => { manifestP = null })
    }
    return manifestP
  }

  /**
   * Overpass-shaped elements of one layer within `radiusM` metres of the point.
   * @param {'pois'|'barriers'|'substations'} layer
   */
  async function query(layer, lat, lng, radiusM) {
    if (!['pois', 'barriers', 'substations'].includes(layer)) throw new Error(`amenity tiles: unknown layer ${layer}`)
    const ids = tilesForRadius(lat, lng, radiusM)
    const tiles = await Promise.all(ids.map(tile))
    const seen = new Set()
    const elements = []
    const stamps = new Set()
    const missing = []
    tiles.forEach((t, i) => {
      if (!t) { missing.push(ids[i]); return }
      if (t.osmTimestamp) stamps.add(t.osmTimestamp)
      for (const f of t[layer] ?? []) {
        const k = f.t + f.id
        if (seen.has(k)) continue // a large feature is stored in every tile it touches
        if (!withinRadius(layer, f, lat, lng, radiusM)) continue
        seen.add(k)
        elements.push(toOverpassElement(layer, f))
      }
    })
    // Overpass prints nodes, then ways, then relations, each by id. Keep that order: the app sorts
    // by distance with a stable sort, so equal distances keep this order in both sources.
    const ord = { node: 0, way: 1, relation: 2 }
    elements.sort((a, b) => ord[a.type] - ord[b.type] || a.id - b.id)
    let osmTimestamps = [...stamps].sort()
    if (!osmTimestamps.length) {
      const m = await manifest().catch(() => null)
      if (m?.osmTimestamp) osmTimestamps = [m.osmTimestamp]
    }
    // Two vintages can meet for a few minutes while a new build propagates; cite the older.
    return { elements, vintage: osmTimestamps[0] ?? null, osmTimestamps, tiles: ids, missing }
  }

  return { query, manifest, tile }
}
