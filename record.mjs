#!/usr/bin/env node
// Record a run in state/ (committed to main by the workflow).
//   node record.mjs --published   after the data branch was pushed: the summary becomes the
//                                 baseline the next run's guards compare against
//   node record.mjs               held or skipped: history only, the baseline is untouched
// state/published.json  the last PUBLISHED summary (totals, categories, OSM timestamp)
// state/history.json    the last 104 runs (two years of weekly runs), newest last

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const published = process.argv.includes('--published')
const stateDir = join(HERE, 'state')
const resultPath = join(HERE, 'result.json')
if (!existsSync(resultPath)) {
  console.error('record: no result.json (the build did not finish); nothing recorded')
  process.exit(1)
}
const r = JSON.parse(readFileSync(resultPath, 'utf8'))
mkdirSync(stateDir, { recursive: true })

if (published) {
  const { schema, buildDate, osmTimestamp, source, totals, categories } = r.summary
  writeFileSync(join(stateDir, 'published.json'), JSON.stringify({ schema, buildDate, osmTimestamp, source, totals, categories }, null, 1) + '\n')
}
const histPath = join(stateDir, 'history.json')
const hist = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : []
hist.push({
  buildDate: r.summary.buildDate,
  osmTimestamp: r.summary.osmTimestamp,
  status: published ? 'published' : r.status,
  totals: r.summary.totals,
  red: r.red,
  warn: r.warn,
  goldenMissing: r.golden.filter((g) => !g.ok).map((g) => g.label)
})
writeFileSync(histPath, JSON.stringify(hist.slice(-104), null, 1) + '\n')
console.log(`recorded: ${published ? 'published' : r.status} (${r.summary.osmTimestamp})`)
