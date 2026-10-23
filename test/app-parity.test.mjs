// Parity with the app itself (skipped when the app is not on this disk, e.g. in CI).
//
// 1. The tag lists here equal the app's: OSM_TAG_FILTERS, the barrier query and the substation
//    query (primer trap #27: a tag the query never requests is invisible).
// 2. The app's OWN fetchAmenities (src/main/connectors/amenitiesOsm.ts, bundled read-only with the
//    app's esbuild; only fetchText is stubbed) is run twice on the fixture site: once fed the
//    hand-written Overpass oracle, once fed reader.mjs. The OsmResult records (amenities, transit,
//    barriers, barriersFound) must be deeply equal. That is the one-line swap, proven.
//
// Point CCE_APP_DIR at the app checkout to run it elsewhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { POI_TAG_FILTERS, BARRIER_TAG_FILTERS } from '../lib/tags.mjs'
import { build } from '../build.mjs'
import { createReader } from '../reader.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures')
const APP = process.env.CCE_APP_DIR ?? join(homedir(), 'Documents/Claude/Projects/Site Due Diligence/app-yield-desk')
const SRC = join(APP, 'src/main/connectors/amenitiesOsm.ts')
const skip = !existsSync(SRC) || !existsSync(join(APP, 'node_modules/esbuild')) ? `app not found at ${APP}` : false

test('tag lists match the app source', { skip }, () => {
  const src = readFileSync(SRC, 'utf8')
  const block = /export const OSM_TAG_FILTERS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(src)[1]
  const appPairs = [...block.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => [m[1], m[2]])
  assert.deepEqual(POI_TAG_FILTERS, appPairs, 'POI_TAG_FILTERS must equal the app OSM_TAG_FILTERS, same order')
  const barrier = /const BARRIER_QUERY[\s\S]*?out geom;/.exec(src)[0]
  const appBarrier = [...barrier.matchAll(/way\[(\w+)=(\w+)\]/g)].map((m) => [m[1], m[2]])
  assert.deepEqual(BARRIER_TAG_FILTERS, appBarrier)
  assert.match(barrier, /\[service!~"yard\|spur\|siding"\]/)
  const infra = readFileSync(join(APP, 'src/main/connectors/infrastructure.ts'), 'utf8')
  assert.match(infra, /nwr\["power"="substation"\]\(around:[^)]*\);out center tags;/)
})

test("the app's own fetchAmenities builds identical records from the reader and from Overpass", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cce-amenity-parity-'))
  const stub = join(dir, 'http-stub.mjs')
  writeFileSync(stub, `export async function fetchText(url, opts) { return globalThis.__overpass(decodeURIComponent(String(opts.init.body).slice(5))) }
export function isSubrequestLimit() { return false }\n`)
  const esbuild = createRequire(join(APP, 'package.json'))('esbuild')
  const bundle = join(dir, 'amenitiesOsm.mjs')
  await esbuild.build({
    entryPoints: [SRC], bundle: true, format: 'esm', platform: 'node', outfile: bundle, absWorkingDir: APP, logLevel: 'silent',
    plugins: [{ name: 'stub-http', setup(b) { b.onResolve({ filter: /core\/http$/ }, () => ({ path: stub })) } }]
  })
  const { fetchAmenities } = await import(pathToFileURL(bundle).href)

  const oracle = JSON.parse(readFileSync(join(FIX, 'overpass-expected.json'), 'utf8'))
  const { lat, lng } = oracle.site
  const isBarrier = (q) => q.includes('waterway')
  const queries = []
  globalThis.__overpass = async (q) => { queries.push(q); return JSON.stringify(isBarrier(q) ? oracle.barrier : oracle.amenity) }
  const fromOverpass = await fetchAmenities(lat, lng)

  await build({ opl: join(FIX, 'fixture.opl'), out: join(dir, 'out'), result: join(dir, 'r.json'), published: join(dir, 'none.json'), osmTimestamp: '2026-10-18T12:00:00Z', buildDate: '2026-10-19T00:00:00Z', golden: false })
  const reader = createReader({ loadTile: async (id) => { const p = join(dir, 'out', 'tiles', `${id}.json.gz`); return existsSync(p) ? readFileSync(p) : null } })
  const radius = Number(/around:(\d+)/.exec(queries[0])[1])
  globalThis.__overpass = async (q) => JSON.stringify(await reader.query(isBarrier(q) ? 'barriers' : 'pois', lat, lng, radius))
  const fromTiles = await fetchAmenities(lat, lng)

  assert.equal(radius, 4828)
  assert.deepEqual(fromTiles, fromOverpass)
  // Not a vacuous pass: the fixture exercises the classifier, the exclusions and the barrier test.
  assert.equal(fromOverpass.amenities.length, 11)
  assert.equal(fromOverpass.transit.length, 2)
  assert.equal(fromOverpass.barriersFound, 3)
  assert.ok(fromOverpass.amenities.some((a) => a.crossesBarrier))
  assert.ok(fromOverpass.amenities.some((a) => a.excludedFromScoring && a.name === 'Private Fixture Park'))
  assert.ok(fromOverpass.amenities.some((a) => a.category === 'senior_center'))
  assert.ok(fromOverpass.amenities.some((a) => a.unnamed))
  assert.ok(fromOverpass.amenities.some((a) => a.address === '651 East Main Street, Ventura'))
  delete globalThis.__overpass
  rmSync(dir, { recursive: true, force: true })
})
