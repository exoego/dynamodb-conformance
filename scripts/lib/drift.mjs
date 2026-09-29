// Raw-message drift between two capture blocks.
//
// A "block" is one region's slice of a capture document, the shape that
// scripts/capture-validation-messages.mjs emits per region:
//
//   { probes: [{ id, name, message, n, fields, ... }], nullRoundTrip: {...} }
//
// Drift is a difference in the *raw* values a probe returned - the error type
// (`name`), the full `message`, the `N validation error detected` count, or the
// named `fields` list - less the per-run noise masked below. This is
// deliberately independent of whether the Tier 3 suite would pass or fail: a
// probe whose error type and field are unchanged but whose prose was reworded
// still *passes* the tolerant (type + field + constraint) assertions, yet its
// raw message drifted. That passing-but-different
// case is exactly what a pass/fail signal is blind to and why drift is measured
// by diffing captured messages, never by re-running the suite.
//
// Pure and dependency-free so it can be unit-tested directly (no AWS, no
// network) and mirrored in the website's lens derivation.

/** The raw fields that count as drift when they move. */
function pick(probe) {
  return {
    name: probe?.name ?? null,
    message: probe?.message ?? null,
    n: probe?.n ?? null,
    fields: probe?.fields ?? [],
  }
}

function sameFields(a = [], b = []) {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

// Two things in a captured answer change on every capture without AWS changing
// anything. Compared raw, c_bw_over25 differed in all ten consecutive pairs of
// weekly eu-west-2 captures from 2026-08-18 to 2026-09-27, so no diff was ever
// clean and every scheduled red was labelled drift.
//
// - The fixture table the capture creates is named with a nonce, and the name
//   turns up in echoed values and, in the validation framework's wording, in
//   the field path.
// - Two probes echo a collection, which AWS renders through Java's toString:
//   object identity hashes, and two formats that alternate from one request to
//   the next.
//
// Each echo is ignored only as far as the probe's own test ignores it, so a
// change that would fail the test still reaches the verdict. The raw answers
// are what a diff reports.
const FIXTURE_TABLE = /_(?:conformance|capture)_[A-Za-z0-9_]+/g
const ECHOED_VALUE = /Value '([\s\S]*?)' at '/g
const KEY_SCHEMA_ELEMENT =
  /KeySchemaElement\(attributeName=\w+, keyType=(?:HASH|RANGE)\)|com\.amazonaws\.dynamodb\.v\d+\.KeySchemaElement@[0-9a-f]+/g

const ECHO_TOLERANCE = {
  // tests/tier3/error-messages/batchWriteItem.test.ts: any requests, inside
  // the one-table map.
  c_bw_over25: (echo) => echo.replace(/^\{<table>=\[[\s\S]+\]\}$/, '{<table>=[<requests>]}'),
  // tests/tier3/error-messages/createTable.test.ts: either rendering of each
  // element, with the count pinned.
  c_ct_3keys: (echo) => echo.replace(KEY_SCHEMA_ELEMENT, '<KeySchemaElement>'),
}

function unnamed(s) {
  return typeof s === 'string' ? s.replace(FIXTURE_TABLE, '<table>') : s
}

function comparable(probe, id) {
  let message = unnamed(probe.message ?? null)
  const tolerate = ECHO_TOLERANCE[id]
  if (tolerate && typeof message === 'string') {
    message = message.replace(ECHOED_VALUE, (_, echo) => `Value '${tolerate(echo)}' at '`)
  }
  return { message, fields: (probe.fields ?? []).map(unnamed) }
}

/** Diff one probe against its baseline. Returns null when nothing moved. */
export function diffProbe(baseline, observed) {
  const id = baseline.id ?? observed.id
  const base = comparable(baseline, id)
  const obs = comparable(observed, id)
  const changed = []
  if (baseline.name !== observed.name) changed.push('name')
  if (base.message !== obs.message) changed.push('message')
  if (baseline.n !== observed.n) changed.push('n')
  if (!sameFields(base.fields, obs.fields)) changed.push('fields')
  if (changed.length === 0) return null
  // Only the prose moved - type, field and count are intact - so a tolerant
  // assertion still passes while the raw wording drifted.
  const passingButDifferent = changed.length === 1 && changed[0] === 'message'
  return {
    id: baseline.id ?? observed.id,
    changed,
    passingButDifferent,
    baseline: pick(baseline),
    observed: pick(observed),
  }
}

// Key-order-insensitive serialisation: DynamoDB does not guarantee the order of
// attributes in a returned item map, so a reordered-but-identical round-trip
// must not read as drift.
function stableKey(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableKey).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableKey(v[k])).join(',') + '}'
}

function diffNullRoundTrip(baseline, observed) {
  if (stableKey(baseline ?? null) === stableKey(observed ?? null)) return null
  return { changed: ['nullRoundTrip'], baseline: baseline ?? null, observed: observed ?? null }
}

function indexById(probes = []) {
  const map = new Map()
  for (const p of probes) if (p && p.id != null) map.set(p.id, p)
  return map
}

/**
 * Diff an observed block against a baseline block. Returns the probe-level
 * divergences (probes present in only one side are reported as added/removed)
 * and any nullRoundTrip divergence. An empty `probes` array and a null
 * `nullRoundTrip` means the two blocks match.
 */
export function diffCaptures(baseline, observed) {
  const base = indexById(baseline?.probes)
  const obs = indexById(observed?.probes)
  const ids = [...new Set([...base.keys(), ...obs.keys()])]
  const probes = []
  for (const id of ids) {
    const b = base.get(id)
    const o = obs.get(id)
    if (!b) {
      probes.push({ id, changed: ['added'], passingButDifferent: false, observed: pick(o) })
      continue
    }
    if (!o) {
      probes.push({ id, changed: ['removed'], passingButDifferent: false, baseline: pick(b) })
      continue
    }
    const d = diffProbe(b, o)
    if (d) probes.push(d)
  }
  return { probes, nullRoundTrip: diffNullRoundTrip(baseline?.nullRoundTrip, observed?.nullRoundTrip) }
}

/**
 * The probes in a diff that actually moved.
 *
 * A probe present on only one side is reported by diffCaptures as added or
 * removed, which is true and worth seeing, but it is not drift: a probe with no
 * baseline has no earlier answer to have moved from. Only an across-time diff
 * can produce those - a cross-region diff compares two blocks from the same
 * capture run, so both sides always carry the same probe set - and across time
 * they mean the capture script gained or lost a probe, not that AWS changed.
 * Counted as drift, a newly added probe is named on every red run that follows,
 * against a baseline that never carried it.
 */
export function driftedProbes(diff) {
  const onlyTheProbeSetMoved = (p) =>
    Array.isArray(p?.changed) &&
    p.changed.length > 0 &&
    p.changed.every((c) => c === 'added' || c === 'removed')
  return (diff?.probes ?? []).filter((p) => !onlyTheProbeSetMoved(p))
}

/** True when a diff result carries no divergence at all. */
export function isClean(diff) {
  return driftedProbes(diff).length === 0 && !diff?.nullRoundTrip
}

/**
 * Compare every non-baseline region in a capture document against the
 * baseline region within the same document. Used for the cross-region lens:
 * "which regions differ from eu-west-2 right now". Returns
 * { baselineRegion, regions: { <region>: <diffCaptures result> } }.
 */
export function diffRegions(captureDoc, baselineRegion = 'eu-west-2') {
  const regions = captureDoc?.regions ?? {}
  const base = regions[baselineRegion]
  const out = {}
  for (const [region, block] of Object.entries(regions)) {
    if (region === baselineRegion) continue
    out[region] = diffCaptures(base, block)
  }
  return { baselineRegion, regions: out }
}
