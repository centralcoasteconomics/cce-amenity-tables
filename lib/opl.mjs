// A minimal reader for osmium's OPL text format, the output of
//   osmium add-locations-to-ways <filtered.pbf> -f opl,add_metadata=false -o -
// One object per line: "n123 Tk=v,k2=v2 x-118.1 y34.2", "w5 Tk=v Nn1x-118.1y34.2,n2x..y..",
// "r9 Tk=v Mw5@outer,n1@". Spaces, commas, "=", "@" and "%" inside values are escaped as
// %<hex code point>%, so splitting on spaces and commas is safe.

const unescape = (s) => (s.includes('%') ? s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16))) : s)

function parseTags(field) {
  const tags = {}
  if (!field) return tags
  for (const kv of field.split(',')) {
    if (!kv) continue
    const i = kv.indexOf('=')
    if (i < 0) continue
    tags[unescape(kv.slice(0, i))] = unescape(kv.slice(i + 1))
  }
  return tags
}

/** Parse one OPL line. Returns null for blank lines. Coordinates are numbers or null when absent. */
export function parseOplLine(line) {
  if (!line) return null
  const parts = line.split(' ')
  const head = parts[0]
  const t = head[0]
  const id = Number(head.slice(1))
  const obj = { t, id, tags: {} }
  for (let k = 1; k < parts.length; k++) {
    const p = parts[k]
    const c = p[0]
    const rest = p.slice(1)
    if (c === 'T') obj.tags = parseTags(rest)
    else if (t === 'n' && c === 'x') obj.lng = rest === '' ? null : Number(rest)
    else if (t === 'n' && c === 'y') obj.lat = rest === '' ? null : Number(rest)
    else if (t === 'w' && c === 'N') {
      obj.nodes = []
      if (rest) {
        for (const ref of rest.split(',')) {
          const m = /^n(-?\d+)(?:x(-?[\d.]*))?(?:y(-?[\d.]*))?$/.exec(ref)
          if (!m) continue
          const lng = m[2] ? Number(m[2]) : null
          const lat = m[3] ? Number(m[3]) : null
          obj.nodes.push({ id: Number(m[1]), lat, lng })
        }
      }
    } else if (t === 'r' && c === 'M') {
      obj.members = []
      if (rest) {
        for (const ref of rest.split(',')) {
          const at = ref.indexOf('@')
          const mt = ref[0]
          const mid = Number(at < 0 ? ref.slice(1) : ref.slice(1, at))
          obj.members.push({ t: mt, id: mid, role: at < 0 ? '' : unescape(ref.slice(at + 1)) })
        }
      }
    }
  }
  return obj
}
