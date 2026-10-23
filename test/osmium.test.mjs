// End to end through osmium-tool, exactly as the workflow runs it (skipped when osmium is absent).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { osmiumExpressions } from '../lib/tags.mjs'
import { build } from '../build.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures')
let osmium = true
try { execFileSync('osmium', ['--version'], { stdio: 'ignore' }) } catch { osmium = false }

test('osmium: the committed fixture.opl is what the two osmium commands produce', { skip: !osmium && 'osmium-tool not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cce-amenity-osmium-'))
  execFileSync('osmium', ['tags-filter', join(FIX, 'fixture.osm'), ...osmiumExpressions(), '-o', join(dir, 'f.osm.pbf')])
  const opl = execFileSync('osmium', ['add-locations-to-ways', join(dir, 'f.osm.pbf'), '-f', 'opl,add_metadata=false', '-o', '-'], { encoding: 'utf8' })
  assert.equal(opl, readFileSync(join(FIX, 'fixture.opl'), 'utf8'))
  rmSync(dir, { recursive: true, force: true })
})

test('osmium: build --pbf runs the whole pipeline and reads the vintage from the file', { skip: !osmium && 'osmium-tool not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cce-amenity-osmium-'))
  const pbf = join(dir, 'fixture.osm.pbf')
  execFileSync('osmium', ['cat', join(FIX, 'fixture.osm'), '-o', pbf])
  const r = await build({ pbf, out: join(dir, 'out'), work: join(dir, 'work'), result: join(dir, 'r.json'), published: join(dir, 'none.json'), buildDate: '2026-10-19T00:00:00Z', golden: join(FIX, 'golden-fixture.json') })
  assert.equal(r.status, 'publish', r.red.join('; '))
  assert.equal(r.summary.osmTimestamp, '2026-10-18T12:00:00Z', 'no replication header in the fixture, so the newest object timestamp')
  assert.deepEqual(r.summary.totals.pois, 14)
  assert.deepEqual(r.summary.totals.barriers, 4)
  rmSync(dir, { recursive: true, force: true })
})
