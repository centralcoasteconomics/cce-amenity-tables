// Turns parsed OSM objects (lib/opl.mjs) into per-tile feature lists for the three layers.
// Pure: no I/O, so the tests drive it directly.
//
// Geometry rules, chosen to match what Overpass returns to the app:
//   - `out center` for a way is the middle of its bounding box, and for a relation the middle of
//     the box around its members. The tiles store that point as lat/lng plus the box itself.
//   - `out geom` for a barrier way is the full node list. A way is stored WHOLE in every tile any
//     of its segments touches, so a reader that loads the tiles around a site sees the same
//     geometry Overpass would send, never a clipped piece that could fake or hide a crossing.
//   - A way or relation with a center is stored in every tile its box overlaps, so a large park
//     whose center sits outside the tiles a query loads is still found.

import { LAYERS, matchesLayer, keepTags, matchedFilters } from './tags.mjs'
import { tileKey, tilesForBBox } from '../reader.mjs'

// The middle of a box, printed to 7 decimals exactly as Overpass prints `out center`. Overpass
// keeps latitude as an integer offset by 91 degrees and longitude as plain degrees, and the
// last digit of a midpoint that falls on half a unit depends on that arithmetic. Matched against
// 84 of 84 live Overpass centers in Santa Barbara on 2026-10-23 (the naive midpoint matched 41).
export const centerLat = (s, n) => Number((((Math.round((s + 91) * 1e7) / 1e7 - 91) + (Math.round((n + 91) * 1e7) / 1e7 - 91)) / 2).toFixed(7))
export const centerLon = (w, e) => Number(((w + e) / 2).toFixed(7))

function bboxOf(points) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity
  for (const p of points) {
    if (p.lat == null || p.lng == null) continue
    if (p.lat < s) s = p.lat
    if (p.lat > n) n = p.lat
    if (p.lng < w) w = p.lng
    if (p.lng > e) e = p.lng
  }
  return s === Infinity ? null : [s, w, n, e]
}

function union(a, b) {
  if (!a) return b
  if (!b) return a
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

export class Tiler {
  constructor() {
    /** tile id -> { pois: [], substations: [], barriers: [] } */
    this.tiles = new Map()
    /** unique feature counts per layer and per filter (key=value) */
    this.totals = { pois: 0, substations: 0, barriers: 0 }
    this.categories = {}
    /** every unique feature, by layer, for the golden probe and tests */
    this.features = { pois: [], substations: [], barriers: [] }
    this.keepFeatures = true
    // Coordinates and boxes of objects a relation may reference. Nodes here are only the tagged
    // ones osmium keeps; multipolygon members are ways, which is what matters.
    this.nodePos = new Map()
    this.wayBox = new Map()
    this.skipped = { noLocation: 0, relationNoMembers: 0 }
  }

  _put(layer, feature, tileIds) {
    for (const id of tileIds) {
      let t = this.tiles.get(id)
      if (!t) this.tiles.set(id, (t = { pois: [], substations: [], barriers: [] }))
      t[layer].push(feature)
    }
    this.totals[layer]++
    for (const c of matchedFilters(layer, feature.tags)) this.categories[`${layer}:${c}`] = (this.categories[`${layer}:${c}`] ?? 0) + 1
    if (this.keepFeatures) this.features[layer].push(feature)
  }

  _centerFeature(layer, obj, bbox) {
    const tags = keepTags(layer, obj.tags)
    if (obj.t === 'n') return { f: { t: 'n', id: obj.id, lat: obj.lat, lng: obj.lng, tags }, tiles: [tileKey(obj.lat, obj.lng)] }
    const [s, w, n, e] = bbox
    return {
      f: { t: obj.t, id: obj.id, lat: centerLat(s, n), lng: centerLon(w, e), bbox: [s, w, n, e], tags },
      tiles: tilesForBBox(s, w, n, e)
    }
  }

  /** Feed one parsed OPL object. Objects arrive nodes, then ways, then relations. */
  add(obj) {
    if (!obj) return
    const centerLayers = ['pois', 'substations'].filter((L) => matchesLayer(L, obj.t, obj.tags))
    if (obj.t === 'n') {
      if (obj.lat == null || obj.lng == null) { if (centerLayers.length) this.skipped.noLocation++; return }
      this.nodePos.set(obj.id, [obj.lat, obj.lng])
      for (const L of centerLayers) { const { f, tiles } = this._centerFeature(L, obj); this._put(L, f, tiles) }
      return
    }
    if (obj.t === 'w') {
      const nodes = obj.nodes ?? []
      const bbox = bboxOf(nodes)
      if (bbox) this.wayBox.set(obj.id, bbox)
      if (!bbox) { if (centerLayers.length || matchesLayer('barriers', 'w', obj.tags)) this.skipped.noLocation++; return }
      for (const L of centerLayers) { const { f, tiles } = this._centerFeature(L, obj, bbox); this._put(L, f, tiles) }
      if (matchesLayer('barriers', 'w', obj.tags)) {
        const g = nodes.filter((p) => p.lat != null && p.lng != null).map((p) => [p.lng, p.lat])
        const tiles = new Set()
        if (g.length === 1) tiles.add(tileKey(g[0][1], g[0][0]))
        for (let i = 0; i + 1 < g.length; i++) {
          const [x1, y1] = g[i], [x2, y2] = g[i + 1]
          for (const id of tilesForBBox(Math.min(y1, y2), Math.min(x1, x2), Math.max(y1, y2), Math.max(x1, x2))) tiles.add(id)
        }
        this._put('barriers', { t: 'w', id: obj.id, g, tags: keepTags('barriers', obj.tags) }, [...tiles])
      }
      return
    }
    if (obj.t === 'r') {
      if (!centerLayers.length) return
      let bbox = null
      for (const m of obj.members ?? []) {
        if (m.t === 'w') bbox = union(bbox, this.wayBox.get(m.id) ?? null)
        else if (m.t === 'n') { const p = this.nodePos.get(m.id); if (p) bbox = union(bbox, [p[0], p[1], p[0], p[1]]) }
      }
      if (!bbox) { this.skipped.relationNoMembers++; return }
      for (const L of centerLayers) { const { f, tiles } = this._centerFeature(L, obj, bbox); this._put(L, f, tiles) }
    }
  }

  /** Tiles in a stable order with features sorted by type and id, so unchanged tiles are byte-identical. */
  sortedTiles() {
    const order = { n: 0, w: 1, r: 2 }
    const cmp = (a, b) => order[a.t] - order[b.t] || a.id - b.id
    return [...this.tiles.keys()].sort().map((id) => {
      const t = this.tiles.get(id)
      return [id, { pois: t.pois.sort(cmp), substations: t.substations.sort(cmp), barriers: t.barriers.sort(cmp) }]
    })
  }
}

export { LAYERS }
