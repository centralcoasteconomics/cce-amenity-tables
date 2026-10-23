// Unit tests: OPL parsing, tiling, the reader against a hand-written Overpass oracle, and guards.
// No network, no osmium: the fixture's filtered OPL is committed (test/fixtures/fixture.opl, made
// from fixture.osm by the same two osmium commands the workflow runs; test/osmium.test.mjs
// re-makes it when osmium is installed and checks it is unchanged).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseOplLine } from '../lib/opl.mjs'
import { LAYERS, matchesLayer, osmiumExpressions } from '../lib/tags.mjs'
import { checkSummary, goldenProbe } from '../lib/guards.mjs'
import { build } from '../build.mjs'
import { createReader, tileKey, tilesForRadius, haversineM, lineDistanceM, sourceLabel } from '../reader.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures')
const oracle = JSON.parse(readFileSync(join(FIX, 'overpass-expected.json'), 'utf8'))

async function buildFixture(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cce-amenity-'))
  const r = await build({
    opl: join(FIX, 'fixture.opl'), out: join(dir, 'out'), result: join(dir, 'result.json'), published: join(dir, 'none.json'),
    osmTimestamp: '2026-10-18T12:00:00Z', buildDate: '2026-10-19T00:00:00Z', golden: join(FIX, 'golden-fixture.json'), ...extra
  })
  const reader = createReader({ loadTile: async (id) => { const p = join(dir, 'out', 'tiles', `${id}.json.gz`); return existsSync(p) ? readFileSync(p) : null } })
  return { dir, r, reader }
}

test('OPL: tags with escapes, node coordinates, way locations, relation members', () => {
  const n = parseOplLine('n12 Tamenity=pharmacy,name=Fixture%20%Pharmacy%2c%%20%"Rx"%20%&%20%Co x-119.2945 y34.2865')
  assert.deepEqual(n, { t: 'n', id: 12, tags: { amenity: 'pharmacy', name: 'Fixture Pharmacy, "Rx" & Co' }, lng: -119.2945, lat: 34.2865 })
  const w = parseOplLine('w120 Thighway=motorway Nn121x-119.2935y34.27,n122x,n123x-119.2935y34.31')
  assert.equal(w.nodes.length, 3)
  assert.deepEqual(w.nodes[1], { id: 122, lat: null, lng: null })
  const r = parseOplLine('r200 Ttype=multipolygon,leisure=park Mw201@outer,n5@')
  assert.deepEqual(r.members, [{ t: 'w', id: 201, role: 'outer' }, { t: 'n', id: 5, role: '' }])
  assert.deepEqual(parseOplLine('w201 T Nn1x1y2').tags, {})
})

test('tags: barrier rail filter follows Overpass [service!~"yard|spur|siding"]', () => {
  assert.equal(matchesLayer('barriers', 'w', { railway: 'rail' }), true)
  assert.equal(matchesLayer('barriers', 'w', { railway: 'rail', service: 'yard' }), false)
  assert.equal(matchesLayer('barriers', 'w', { railway: 'rail', service: 'spur;siding' }), false)
  assert.equal(matchesLayer('barriers', 'w', { railway: 'rail', service: 'crossover' }), true)
  assert.equal(matchesLayer('barriers', 'n', { highway: 'motorway' }), false, 'barriers are ways only')
  assert.equal(matchesLayer('pois', 'r', { leisure: 'park' }), true)
  assert.ok(osmiumExpressions().includes('w/railway=rail'))
  assert.ok(osmiumExpressions().some((e) => e.startsWith('nwr/amenity=') && e.includes('library')))
})

test('tiles: keys and radius cover', () => {
  assert.equal(tileKey(34.285, -119.295), '342_-1193')
  assert.equal(tileKey(34.3, -119.3), '343_-1193')
  assert.equal(tileKey(-0.05, 0.05), '-1_0')
  const ids = tilesForRadius(34.29, -119.29, 4828)
  assert.ok(ids.includes('342_-1193') && ids.includes('343_-1193') && ids.includes('343_-1194'))
  assert.ok(Math.abs(haversineM(34, -119, 34.1, -119) - 11119.5) < 5)
  assert.ok(Math.abs(lineDistanceM(34, -119, [[-119.01, 33.9], [-119.01, 34.1]]) - 922) < 5)
})

test('reader returns exactly what Overpass returns for the fixture (hand-written oracle)', async () => {
  const { dir, reader } = await buildFixture()
  const { lat, lng, radiusM } = oracle.site
  for (const [layer, key] of [['pois', 'amenity'], ['barriers', 'barrier'], ['substations', 'substation']]) {
    const got = await reader.query(layer, lat, lng, radiusM)
    const want = oracle[key].elements
    assert.deepEqual(got.elements.map((e) => `${e.type}/${e.id}`), want.map((e) => `${e.type}/${e.id}`), `${layer}: same elements, same order`)
    got.elements.forEach((g, i) => {
      const w = want[i]
      if ('lat' in w) { assert.equal(g.lat, w.lat); assert.equal(g.lon, w.lon) }
      if (w.center) assert.deepEqual(g.center, w.center)
      if (w.geometry) assert.deepEqual(g.geometry, w.geometry)
      // Tags: every tag the app reads is present with the same value; nothing else is invented.
      for (const [k, v] of Object.entries(g.tags)) assert.equal(w.tags[k], v, `${layer} ${w.id} tag ${k}`)
      for (const k of LAYERS[layer].keep) assert.equal(g.tags[k], w.tags[k], `${layer} ${w.id} kept tag ${k}`)
    })
    assert.equal(got.vintage, '2026-10-18T12:00:00Z')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('reader: a feature in several tiles is returned once; empty radius returns nothing', async () => {
  const { dir, reader } = await buildFixture()
  // The big park (w110) spans four tiles; the motorway two rows.
  const q = await reader.query('pois', 34.3, -119.3, 600)
  assert.deepEqual(q.elements.filter((e) => e.id === 110).length, 1)
  const far = await reader.query('pois', 35.5, -118.5, 1000)
  assert.equal(far.elements.length, 0)
  assert.ok(far.missing.length > 0)
  rmSync(dir, { recursive: true, force: true })
})

test('reader over HTTP: 404 = empty tile, other errors throw, gzip decoded', async () => {
  const { dir } = await buildFixture()
  const calls = []
  const fakeFetch = async (url) => {
    calls.push(url)
    const m = /tiles\/(.+)\.json\.gz$/.exec(url)
    const p = m && join(dir, 'out', 'tiles', `${m[1]}.json.gz`)
    if (p && existsSync(p)) return new Response(readFileSync(p), { status: 200 })
    if (url.endsWith('manifest.json')) return new Response(readFileSync(join(dir, 'out', 'manifest.json')), { status: 200 })
    return new Response('nope', { status: 404 })
  }
  const reader = createReader({ baseUrl: 'https://example.test/data/', fetch: fakeFetch })
  const q = await reader.query('pois', 34.285, -119.295, 4828)
  assert.equal(q.elements.length, oracle.amenity.elements.length)
  assert.ok(calls.every((u) => u.startsWith('https://example.test/data/tiles/')))
  const n = calls.length
  await reader.query('barriers', 34.285, -119.295, 4828)
  assert.equal(calls.length, n, 'tiles are cached between layers')
  const failing = createReader({ baseUrl: 'https://example.test', fetch: async () => new Response('', { status: 503 }) })
  await assert.rejects(failing.query('pois', 34.285, -119.295, 100), /HTTP 503/)
  assert.equal(sourceLabel(q.vintage), 'OpenStreetMap (OSM extract of 2026-10-18)')
  rmSync(dir, { recursive: true, force: true })
})

test('golden probe: passes on the fixture places, fails on a missing one', async () => {
  const { dir, r, reader } = await buildFixture()
  assert.equal(r.status, 'publish')
  assert.ok(r.golden.every((g) => g.ok))
  const miss = await goldenProbe(reader, [{ label: 'nope', tag: 'amenity=library', name: 'Nonexistent', lat: 34.286, lng: -119.294, withinM: 200 }])
  assert.equal(miss[0].ok, false)
  const held = await build({
    opl: join(FIX, 'fixture.opl'), out: join(dir, 'out2'), result: join(dir, 'r2.json'), published: join(dir, 'none.json'),
    osmTimestamp: '2026-10-18T12:00:00Z', buildDate: '2026-10-19T00:00:00Z', golden: join(FIX, 'golden-fixture-missing.json')
  })
  assert.equal(held.status, 'held')
  assert.match(held.red.join('\n'), /golden probe: Not in the fixture not found/)
  rmSync(dir, { recursive: true, force: true })
})

test('guards: collapse, category dropout, vintage', () => {
  const prev = { osmTimestamp: '2026-10-11T20:00:00Z', totals: { pois: 1000, substations: 100, barriers: 500 }, categories: { 'pois:amenity=library': 200, 'pois:shop=chemist': 50 } }
  const next = (o = {}) => ({ osmTimestamp: '2026-10-18T20:00:00Z', buildDate: '2026-10-19T09:00:00Z', totals: { pois: 990, substations: 100, barriers: 500 }, categories: { 'pois:amenity=library': 199, 'pois:shop=chemist': 50 }, ...o })
  assert.deepEqual(checkSummary(prev, next()).red, [])
  assert.match(checkSummary(prev, next({ totals: { pois: 850, substations: 100, barriers: 500 } })).red.join(), /pois: COLLAPSED 1000 -> 850/)
  assert.equal(checkSummary(prev, next({ totals: { pois: 950, substations: 100, barriers: 500 } })).warn.length, 1)
  assert.match(checkSummary(prev, next({ categories: { 'pois:amenity=library': 100, 'pois:shop=chemist': 50 } })).red.join(), /amenity=library: DROPPED/)
  assert.deepEqual(checkSummary(prev, next({ categories: { 'pois:amenity=library': 200, 'pois:shop=chemist': 0 } })).red, [], 'small categories do not hold the run')
  assert.match(checkSummary(prev, next({ osmTimestamp: '2026-10-01T00:00:00Z' })).red.join(), /older than the published/)
  assert.equal(checkSummary(prev, next({ osmTimestamp: prev.osmTimestamp, buildDate: '2026-10-12T00:00:00Z' })).skip?.includes('already published'), true)
  assert.match(checkSummary(null, next({ osmTimestamp: '2026-09-01T00:00:00Z' })).red.join(), /days old/)
  assert.match(checkSummary(null, next({ totals: { pois: 0, substations: 1, barriers: 1 } })).red.join(), /pois: 0 features/)
  assert.match(checkSummary(null, next({ osmTimestamp: null })).red.join(), /no OSM data timestamp/)
})

test('tiles are deterministic (an unchanged tile is byte-identical)', async () => {
  const a = await buildFixture(), b = await buildFixture()
  for (const id of ['342_-1193', '343_-1194']) {
    assert.deepEqual(readFileSync(join(a.dir, 'out', 'tiles', `${id}.json.gz`)), readFileSync(join(b.dir, 'out', 'tiles', `${id}.json.gz`)))
  }
  rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true })
})
