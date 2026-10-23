// Types for reader.mjs. The element shapes are the ones Overpass returns, so the app's
// OsmElement (amenitiesOsm.ts) accepts them unchanged.

export type Layer = 'pois' | 'barriers' | 'substations'

/** An element as Overpass prints it: `out center tags` (pois, substations) or `out geom` (barriers). */
export interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  /** nodes */
  lat?: number
  lon?: number
  /** ways and relations in pois / substations: the middle of the bounding box, as Overpass computes it */
  center?: { lat: number; lon: number }
  /** ways and relations in pois / substations (extra; Overpass `out bb` names) */
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number }
  /** barriers: every node of the way */
  geometry?: { lat: number; lon: number }[]
  /** only the tags the app reads (lib/tags.mjs *_KEEP_TAGS); a tag is present only when the feature has it */
  tags: Record<string, string>
}

export interface QueryResult {
  /** what `(JSON.parse(text) as OverpassResponse).elements` was; nodes, then ways, then relations, by id */
  elements: OverpassElement[]
  /** OSM data timestamp to cite (the oldest, if two builds met mid-publish), e.g. "2026-10-19T20:21:03Z" */
  vintage: string | null
  osmTimestamps: string[]
  /** tile ids read */
  tiles: string[]
  /** tile ids with no file (no features there); not an error */
  missing: string[]
}

/** One feature as stored in a tile. */
export interface TileFeature {
  t: 'n' | 'w' | 'r'
  id: number
  /** pois / substations: the point (node) or box middle (way, relation) */
  lat?: number
  lng?: number
  /** ways and relations in pois / substations: [south, west, north, east] */
  bbox?: [number, number, number, number]
  /** barriers: [lng, lat] for every node */
  g?: [number, number][]
  tags: Record<string, string>
}

export interface Tile {
  schema: 1
  tile: string
  osmTimestamp: string
  attribution: string
  pois: TileFeature[]
  substations: TileFeature[]
  barriers: TileFeature[]
}

export interface Manifest {
  schema: 1
  buildDate: string
  osmTimestamp: string
  source: string
  attribution: string
  license: 'ODbL-1.0'
  citeAs: string
  tileDeg: number
  totals: { pois: number; substations: number; barriers: number; tiles: number; bytes: number }
  categories: Record<string, number>
  golden: { label: string; ok: boolean; found: string | null }[]
  tiles: Record<string, { pois: number; substations: number; barriers: number; bytes: number }>
}

export interface ReaderOptions {
  /** where tiles/<id>.json.gz and manifest.json live; default DEFAULT_BASE_URL (the data branch) */
  baseUrl?: string
  fetch?: typeof fetch
  /** read a tile yourself (R2, KV, disk); resolve null when there is no such tile */
  loadTile?: (id: string) => Promise<Uint8Array | null>
  /** tiles kept in memory, default 64 */
  cacheTiles?: number
}

export interface AmenityTilesReader {
  query(layer: Layer, lat: number, lng: number, radiusM: number): Promise<QueryResult>
  manifest(): Promise<Manifest>
  tile(id: string): Promise<Tile | null>
}

export const TILE_DEG: 0.1
export const SCHEMA: 1
export const ATTRIBUTION: string
export const DEFAULT_BASE_URL: string
export function createReader(opts?: ReaderOptions): AmenityTilesReader
export function sourceLabel(vintage: string | null | undefined): string
export function tileKey(lat: number, lng: number): string
export function tilesForBBox(s: number, w: number, n: number, e: number): string[]
export function tilesForRadius(lat: number, lng: number, radiusM: number): string[]
export function radiusBBox(lat: number, lng: number, radiusM: number): [number, number, number, number]
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number
export function bboxDistanceM(lat: number, lng: number, bbox: [number, number, number, number]): number
export function lineDistanceM(lat: number, lng: number, coords: [number, number][]): number
export function toOverpassElement(layer: Layer, f: TileFeature): OverpassElement
export function withinRadius(layer: Layer, f: TileFeature, lat: number, lng: number, radiusM: number): boolean
