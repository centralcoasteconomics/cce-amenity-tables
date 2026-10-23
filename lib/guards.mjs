// Publish guards, in the spirit of cce-transit-tables: a held set of tiles always beats a
// degraded one. A red run publishes nothing, so the last good tiles stay live, and it exits
// non-zero so the run is visibly red.
//
// COLLAPSE. OSM in California grows a little every week; a statewide layer does not lose a tenth
// of its features in seven days. A truncated download, a Geofabrik hiccup or a filter typo
// would still parse and still yield tiles, and every site in the state would quietly score
// fewer amenities. So the build compares against the last PUBLISHED summary (state/published.json):
//   - a layer total below (1 - MAX_TOTAL_DROP) of the published one holds the run;
//   - a category (one key=value filter, e.g. pois:amenity=library) with at least
//     CATEGORY_MIN_PREV features published, below (1 - MAX_CATEGORY_DROP), holds the run. This is
//     the feed-dropout analogue: the statewide total can survive one tag going to zero.
//   - a smaller drop is published with a warning, because real clean-ups do happen.
// GOLDEN PROBE (golden.json): a fixed list of long-standing public places, each looked up
// through reader.mjs against the tiles just written. One missing holds the run. This is the
// end-to-end check that the tiles, the tiling and the reader agree, on real places.
// VINTAGE. An extract older than the published one never replaces it (red); the same one is
// skipped (green, nothing new); one older than MAX_AGE_DAYS at build time is red, because the
// app would be citing a stale vintage as this week's.

export const MAX_TOTAL_DROP = 0.1
export const WARN_TOTAL_DROP = 0.03
export const MAX_CATEGORY_DROP = 0.25
export const CATEGORY_MIN_PREV = 100
export const MAX_AGE_DAYS = 14

/**
 * @param {{ totals: Record<string, number>, categories: Record<string, number>, osmTimestamp: string } | null} prev last published summary
 * @param {{ totals: Record<string, number>, categories: Record<string, number>, osmTimestamp: string, buildDate: string }} next
 * @returns {{ red: string[], warn: string[], skip: string | null }}
 */
export function checkSummary(prev, next) {
  const red = [], warn = []
  let skip = null
  for (const [layer, n] of Object.entries(next.totals)) {
    if (layer !== 'barriers' && n === 0) red.push(`${layer}: 0 features`)
  }
  if (!next.osmTimestamp) red.push('the extract carries no OSM data timestamp, so the vintage cannot be cited')
  else {
    const ageDays = (Date.parse(next.buildDate) - Date.parse(next.osmTimestamp)) / 86400000
    if (!(ageDays <= MAX_AGE_DAYS)) red.push(`the extract is ${Math.round(ageDays)} days old (OSM timestamp ${next.osmTimestamp}); limit ${MAX_AGE_DAYS}`)
  }
  if (prev) {
    if (prev.osmTimestamp && next.osmTimestamp) {
      if (next.osmTimestamp < prev.osmTimestamp) red.push(`the extract (${next.osmTimestamp}) is older than the published one (${prev.osmTimestamp})`)
      else if (next.osmTimestamp === prev.osmTimestamp) skip = `the extract (${next.osmTimestamp}) is the one already published`
    }
    for (const [layer, p] of Object.entries(prev.totals ?? {})) {
      const n = next.totals[layer] ?? 0
      if (!p) continue
      const drop = 1 - n / p
      if (drop > MAX_TOTAL_DROP) red.push(`${layer}: COLLAPSED ${p} -> ${n} (-${(drop * 100).toFixed(1)}%), limit ${MAX_TOTAL_DROP * 100}%`)
      else if (drop > WARN_TOTAL_DROP) warn.push(`${layer}: down ${(drop * 100).toFixed(1)}% (${p} -> ${n}); published, check the extract`)
    }
    for (const [cat, p] of Object.entries(prev.categories ?? {})) {
      if (p < CATEGORY_MIN_PREV) continue
      const n = next.categories[cat] ?? 0
      const drop = 1 - n / p
      if (drop > MAX_CATEGORY_DROP) red.push(`${cat}: DROPPED ${p} -> ${n} (-${(drop * 100).toFixed(1)}%), limit ${MAX_CATEGORY_DROP * 100}%`)
    }
  }
  return { red, warn, skip }
}

/**
 * Golden probe. Each entry: { label, layer, tag: "k=v", name: "<regex>", lat, lng, withinM }.
 * Passes when the reader returns, within `withinM` of the point, an element carrying the tag
 * whose name matches the regex (case-insensitive).
 * @param {{ query: Function }} reader a reader over the tiles just built
 */
export async function goldenProbe(reader, golden) {
  const results = []
  for (const g of golden) {
    const [k, v] = g.tag.split('=')
    const re = new RegExp(g.name, 'i')
    const { elements } = await reader.query(g.layer ?? 'pois', g.lat, g.lng, g.withinM)
    const hit = elements.find((e) => e.tags?.[k] === v && re.test(e.tags?.name ?? ''))
    results.push({ label: g.label, ok: !!hit, found: hit ? `${hit.type}/${hit.id} "${hit.tags.name}"` : null })
  }
  return results
}
