#!/usr/bin/env node
// Build the California amenity tiles from an OSM extract, check them, and say whether to publish.
//
//   node build.mjs --pbf california-latest.osm.pbf        (the weekly run; osmium-tool required)
//   node build.mjs --opl filtered.opl --osm-timestamp ... (tests: an OPL file already filtered)
//
// Writes:  out/tiles/<lat10>_<lng10>.json.gz, out/manifest.json, out/ATTRIBUTION.md, out/README.md
//          result.json  { status: "publish" | "skip" | "held", red[], warn[], summary }
// Exit 1 when held (red). Publishing is the workflow's job, and only when status is "publish".

import { spawn, execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOplLine } from './lib/opl.mjs'
import { Tiler } from './lib/tiler.mjs'
import { osmiumExpressions } from './lib/tags.mjs'
import { checkSummary, goldenProbe } from './lib/guards.mjs'
import { createReader, SCHEMA, ATTRIBUTION, TILE_DEG } from './reader.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function args(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    a[k] = v
  }
  return a
}

function osmTimestampOf(pbf) {
  // Geofabrik writes the replication timestamp into the PBF header; that is the data's vintage.
  const header = execFileSync('osmium', ['fileinfo', '-g', 'header.option.osmosis_replication_timestamp', pbf], { encoding: 'utf8' }).trim()
  if (header) return header
  // Extracts without the header (some sub-extract services): the newest object in the file.
  console.warn('  no replication timestamp in the header; using the newest object timestamp (slow scan)')
  return execFileSync('osmium', ['fileinfo', '-e', '-g', 'data.timestamp.last', pbf], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim() || null
}

async function feedLines(input, tiler) {
  const rl = createInterface({ input, crlfDelay: Infinity })
  let n = 0
  for await (const line of rl) {
    tiler.add(parseOplLine(line))
    if (++n % 1_000_000 === 0) console.log(`  ${n.toLocaleString()} objects read`)
  }
  return n
}

export async function build(opts) {
  const out = opts.out ?? join(HERE, 'out')
  const work = opts.work ?? join(HERE, '.work')
  const buildDate = opts.buildDate ?? new Date().toISOString()
  const tiler = new Tiler()
  let osmTimestamp = opts.osmTimestamp ?? null
  let objects = 0
  const t0 = Date.now()

  if (opts.pbf) {
    if (!osmTimestamp) osmTimestamp = osmTimestampOf(opts.pbf)
    mkdirSync(work, { recursive: true })
    const filtered = join(work, 'filtered.osm.pbf')
    const exprs = osmiumExpressions()
    console.log(`osmium tags-filter ${exprs.join(' ')}`)
    execFileSync('osmium', ['tags-filter', opts.pbf, ...exprs, '-o', filtered, '--overwrite'], { stdio: 'inherit' })
    const child = spawn('osmium', ['add-locations-to-ways', filtered, '-f', 'opl,add_metadata=false', '-o', '-'], { stdio: ['ignore', 'pipe', 'inherit'] })
    const done = new Promise((res, rej) => child.on('close', (code) => (code === 0 ? res() : rej(new Error(`osmium add-locations-to-ways exited ${code}`)))))
    objects = await feedLines(child.stdout, tiler)
    await done
  } else if (opts.opl) {
    objects = await feedLines(createReadStream(opts.opl), tiler)
  } else throw new Error('give --pbf <extract.osm.pbf> or --opl <filtered.opl>')

  // Write tiles.
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'tiles'), { recursive: true })
  const tiles = {}
  let bytes = 0
  for (const [id, t] of tiler.sortedTiles()) {
    const body = { schema: SCHEMA, tile: id, osmTimestamp, attribution: ATTRIBUTION, ...t }
    // gzipSync writes no file name and a zero mtime, so an unchanged tile is byte-identical.
    const gz = gzipSync(JSON.stringify(body), { level: 9 })
    writeFileSync(join(out, 'tiles', `${id}.json.gz`), gz)
    tiles[id] = { pois: t.pois.length, substations: t.substations.length, barriers: t.barriers.length, bytes: gz.length }
    bytes += gz.length
  }

  const summary = {
    schema: SCHEMA,
    buildDate,
    osmTimestamp,
    source: opts.sourceLabel ?? (opts.pbf ? opts.pbf.split('/').pop() : opts.opl.split('/').pop()),
    attribution: ATTRIBUTION,
    license: 'ODbL-1.0',
    citeAs: `OpenStreetMap (OSM extract of ${String(osmTimestamp ?? '').slice(0, 10)})`,
    tileDeg: TILE_DEG,
    totals: { ...tiler.totals, tiles: Object.keys(tiles).length, bytes },
    categories: Object.fromEntries(Object.entries(tiler.categories).sort()),
    skipped: tiler.skipped,
    objectsRead: objects
  }

  // Golden probe through the reader, against the files just written.
  const golden = opts.golden === false ? [] : JSON.parse(readFileSync(opts.golden ?? join(HERE, 'golden.json'), 'utf8')).places
  const reader = createReader({ loadTile: async (id) => (existsSync(join(out, 'tiles', `${id}.json.gz`)) ? readFileSync(join(out, 'tiles', `${id}.json.gz`)) : null) })
  const probe = await goldenProbe(reader, golden)

  const prevPath = opts.published ?? join(HERE, 'state', 'published.json')
  const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, 'utf8')) : null
  const { red, warn, skip } = checkSummary(prev, summary)
  for (const p of probe) if (!p.ok) red.push(`golden probe: ${p.label} not found`)
  const status = red.length ? 'held' : skip ? 'skip' : 'publish'

  const manifest = { ...summary, golden: probe, tiles }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
  copyFileSync(join(HERE, 'ATTRIBUTION.md'), join(out, 'ATTRIBUTION.md'))
  writeFileSync(join(out, 'README.md'), `# cce-amenity-tables data\n\nGenerated ${buildDate} from ${summary.source}, OSM data as of ${osmTimestamp}.\nDerived from OpenStreetMap. ${ATTRIBUTION}. See ATTRIBUTION.md. Code and docs: the main branch.\n`)

  const result = { status, red, warn, skip, summary, golden: probe, seconds: Math.round((Date.now() - t0) / 1000) }
  writeFileSync(opts.result ?? join(HERE, 'result.json'), JSON.stringify(result, null, 1) + '\n')
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2))
  const r = await build({
    pbf: a.pbf, opl: a.opl, out: a.out, work: a.work, published: a.published, result: a.result,
    golden: a.golden === 'none' ? false : a.golden, osmTimestamp: a['osm-timestamp'], buildDate: a['build-date'], sourceLabel: a.source
  })
  const s = r.summary
  console.log(`\nOSM ${s.osmTimestamp}: ${s.totals.pois} POIs, ${s.totals.substations} substations, ${s.totals.barriers} barrier ways in ${s.totals.tiles} tiles, ${(s.totals.bytes / 1e6).toFixed(1)} MB gzip (${r.seconds} s)`)
  for (const g of r.golden) console.log(`  golden ${g.ok ? 'ok  ' : 'MISS'} ${g.label}${g.found ? ` -> ${g.found}` : ''}`)
  for (const w of r.warn) console.warn(`  warning: ${w}`)
  if (r.skip) console.log(`  nothing new: ${r.skip}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${r.status}\nosm=${s.osmTimestamp}\n`)
  if (r.red.length) {
    console.error(`\nHELD: refusing to publish; the last published tiles stay live.`)
    for (const x of r.red) console.error(`  - ${x}`)
    process.exitCode = 1
  } else console.log(`\nstatus: ${r.status}`)
}
