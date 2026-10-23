// What the extract keeps, and why. Every list here mirrors a query or a tag read in the app
// (Site Due Diligence, src/main/connectors/). If the app changes a query, change it here in the
// same commit, or the tiles silently stop carrying what the app asks for (primer trap #27:
// a classifier branch for a tag the query never requests is dead code, and it is invisible).
// `npm test` checks POI_TAG_FILTERS against the app's OSM_TAG_FILTERS when the app is on disk.

/**
 * Layer `pois`: the amenity query in amenitiesOsm.ts (AMENITY_QUERY = nwr[k=v] for every pair
 * of OSM_TAG_FILTERS, `out center tags`). Copied verbatim, same order.
 */
export const POI_TAG_FILTERS = [
  ['shop', 'supermarket'],
  ['shop', 'grocery'],
  ['shop', 'greengrocer'],
  ['shop', 'convenience'],
  ['shop', 'chemist'],
  ['amenity', 'marketplace'],
  ['leisure', 'park'],
  ['leisure', 'recreation_ground'],
  ['amenity', 'community_centre'],
  ['amenity', 'library'],
  ['amenity', 'pharmacy'],
  ['amenity', 'hospital'],
  ['amenity', 'clinic'],
  ['amenity', 'doctors'],
  ['amenity', 'college'],
  ['healthcare', 'clinic'],
  ['healthcare', 'hospital'],
  ['healthcare', 'doctor'],
  ['amenity', 'social_facility'],
  ['highway', 'bus_stop'],
  ['public_transport', 'platform'],
  ['public_transport', 'station'],
  ['railway', 'station'],
  ['railway', 'halt'],
  ['railway', 'tram_stop'],
  ['amenity', 'ferry_terminal']
]

/**
 * Tags the app reads from a POI after the query: classifyAmenity, forSeniors, exclusionFor,
 * verifyNoteFor, classifyTransit, the unnamed flag, osmAddress and pickAttrs. Everything else
 * is dropped to keep the tiles small. A record keeps a tag only when the feature has it.
 */
export const POI_KEEP_TAGS = [
  // classification (amenity and transit)
  'shop', 'amenity', 'leisure', 'healthcare', 'public_transport', 'highway', 'railway', 'station',
  // forSeniors
  'social_facility:for', 'community_centre:for', 'social_centre:for',
  // exclusionFor and verifyNoteFor
  'access', 'school', 'library:type', 'healthcare:speciality', 'pharmacy', 'dispensing',
  // name, osmAddress, pickAttrs
  'name', 'addr:housenumber', 'addr:street', 'addr:city', 'brand', 'operator', 'opening_hours'
]

/**
 * Layer `barriers`: BARRIER_QUERY in amenitiesOsm.ts (`out geom`, ways only):
 *   way[highway=motorway]; way[highway=trunk]; way[waterway=river]; way[waterway=canal];
 *   way[railway=rail][service!~"yard|spur|siding"];
 * toBarrier reads only `waterway` and `railway`; `highway` is kept so a record says what it is.
 */
export const BARRIER_TAG_FILTERS = [
  ['highway', 'motorway'],
  ['highway', 'trunk'],
  ['waterway', 'river'],
  ['waterway', 'canal'],
  ['railway', 'rail']
]
/** Overpass `[service!~"yard|spur|siding"]`: an unanchored regex, so it matches anywhere in the value. */
export const BARRIER_SERVICE_EXCLUDE = /yard|spur|siding/
export const BARRIER_KEEP_TAGS = ['highway', 'waterway', 'railway']

/**
 * Layer `substations`: infrastructure.ts substations() (`nwr["power"="substation"]`, `out center
 * tags`), which reads name, operator and voltage.
 */
export const SUBSTATION_TAG_FILTERS = [['power', 'substation']]
export const SUBSTATION_KEEP_TAGS = ['power', 'name', 'operator', 'voltage']

export const LAYERS = {
  pois: { filters: POI_TAG_FILTERS, keep: POI_KEEP_TAGS, types: ['n', 'w', 'r'], geometry: 'center' },
  substations: { filters: SUBSTATION_TAG_FILTERS, keep: SUBSTATION_KEEP_TAGS, types: ['n', 'w', 'r'], geometry: 'center' },
  barriers: { filters: BARRIER_TAG_FILTERS, keep: BARRIER_KEEP_TAGS, types: ['w'], geometry: 'full' }
}

/** True when `tags` matches one of the layer's filters (and, for barriers, the service rule). */
export function matchesLayer(layer, type, tags) {
  const L = LAYERS[layer]
  if (!L.types.includes(type)) return false
  const hit = L.filters.some(([k, v]) => tags[k] === v)
  if (!hit) return false
  if (layer === 'barriers' && tags.railway === 'rail' && tags.highway !== 'motorway' && tags.highway !== 'trunk' && tags.waterway !== 'river' && tags.waterway !== 'canal') {
    // Only the rail clause carries the service filter; a way that matches another clause too is
    // returned by that clause regardless of its service tag (Overpass unions the five sets).
    if (tags.service != null && BARRIER_SERVICE_EXCLUDE.test(tags.service)) return false
  }
  return true
}

/** The filter key=value strings a feature matched, used for per-category counts in the manifest. */
export function matchedFilters(layer, tags) {
  return LAYERS[layer].filters.filter(([k, v]) => tags[k] === v).map(([k, v]) => `${k}=${v}`)
}

export function keepTags(layer, tags) {
  const out = {}
  for (const k of LAYERS[layer].keep) if (tags[k] != null) out[k] = tags[k]
  return out
}

/**
 * The osmium tags-filter expressions for every layer, grouped by key (`nwr/shop=a,b,c`).
 * Referenced objects are kept (no -R), so ways come with their nodes and relations with their
 * members, which the build needs for coordinates and bounding boxes.
 */
export function osmiumExpressions() {
  const groups = new Map()
  for (const L of Object.values(LAYERS)) {
    const prefix = L.types.join('')
    for (const [k, v] of L.filters) {
      const key = `${prefix}/${k}`
      if (!groups.has(key)) groups.set(key, new Set())
      groups.get(key).add(v)
    }
  }
  return [...groups].map(([key, vals]) => `${key}=${[...vals].join(',')}`)
}
