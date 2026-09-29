import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { diffCaptures, diffProbe, diffRegions, driftedProbes, isClean } from './drift.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const snapshot = JSON.parse(
  readFileSync(join(here, '../../captures/2026-06-09-validation-rewording.json'), 'utf8'),
)

const probe = (over) => ({
  id: 'p1',
  name: 'ValidationException',
  message: 'a message',
  n: 1,
  fields: ['tableName'],
  ...over,
})

const block = (...probes) => ({ probes, nullRoundTrip: { put: 'accepted' } })

describe('diffProbe', () => {
  it('returns null when nothing moved', () => {
    expect(diffProbe(probe(), probe())).toBeNull()
  })

  it('flags a changed message with both texts', () => {
    const d = diffProbe(probe({ message: 'old' }), probe({ message: 'new' }))
    expect(d.changed).toEqual(['message'])
    expect(d.baseline.message).toBe('old')
    expect(d.observed.message).toBe('new')
  })

  it('marks a prose-only change as passing-but-different', () => {
    // same type, count and field; only the wording moved
    const d = diffProbe(probe({ message: 'old prose' }), probe({ message: 'new prose' }))
    expect(d.passingButDifferent).toBe(true)
  })

  it('does NOT mark a field or type change as passing-but-different', () => {
    const d = diffProbe(probe({ fields: ['tableName'] }), probe({ message: 'new', fields: ['TableName'] }))
    expect(d.changed).toContain('fields')
    expect(d.passingButDifferent).toBe(false)
  })

  it('flags a changed N count', () => {
    expect(diffProbe(probe({ n: 1 }), probe({ n: 2 })).changed).toContain('n')
  })

  it('flags a changed field list (order-sensitive)', () => {
    const d = diffProbe(probe({ fields: ['a', 'b'] }), probe({ fields: ['b', 'a'] }))
    expect(d.changed).toContain('fields')
  })
})

describe('diffCaptures', () => {
  it('is clean when blocks are identical', () => {
    const b = block(probe())
    expect(isClean(diffCaptures(b, b))).toBe(true)
  })

  it('reports an added and a removed probe', () => {
    const base = block(probe({ id: 'only-base' }))
    const obs = block(probe({ id: 'only-obs' }))
    const ids = diffCaptures(base, obs).probes
    expect(ids.find((p) => p.id === 'only-base').changed).toEqual(['removed'])
    expect(ids.find((p) => p.id === 'only-obs').changed).toEqual(['added'])
  })

  it('does not count an added or removed probe as drift', () => {
    // Adding a probe to the capture script leaves every older baseline without
    // it. That is a changed probe set, not a changed answer, and reporting it
    // as drift made a scheduled red name the new probe as the thing that moved.
    const base = block(probe({ id: 'kept' }))
    const obs = block(probe({ id: 'kept' }), probe({ id: 'brand-new' }))
    const d = diffCaptures(base, obs)
    expect(d.probes.map((p) => p.id)).toEqual(['brand-new'])
    expect(driftedProbes(d)).toEqual([])
    expect(isClean(d)).toBe(true)
  })

  it('still counts a probe whose answer moved, alongside an added one', () => {
    const base = block(probe({ id: 'kept', message: 'before' }))
    const obs = block(probe({ id: 'kept', message: 'after' }), probe({ id: 'brand-new' }))
    const d = diffCaptures(base, obs)
    expect(driftedProbes(d).map((p) => p.id)).toEqual(['kept'])
    expect(isClean(d)).toBe(false)
  })

  it('flags a nullRoundTrip divergence', () => {
    const base = { probes: [], nullRoundTrip: { put: 'accepted', returnedItem: { x: { NULL: true } } } }
    const obs = { probes: [], nullRoundTrip: { put: 'rejected', name: 'ValidationException' } }
    const d = diffCaptures(base, obs)
    expect(d.nullRoundTrip).not.toBeNull()
    expect(d.nullRoundTrip.observed.put).toBe('rejected')
  })

  it('does not flag a nullRoundTrip whose returned item only reordered its keys', () => {
    const base = { probes: [], nullRoundTrip: { put: 'accepted', returnedItem: { pk: { S: 'a' }, attr1: { NULL: true } } } }
    const obs = { probes: [], nullRoundTrip: { put: 'accepted', returnedItem: { attr1: { NULL: true }, pk: { S: 'a' } } } }
    expect(isClean(diffCaptures(base, obs))).toBe(true)
  })
})

// Answers from the weekly eu-west-2 captures, trimmed to one WriteRequest where
// the original echoed 26. AWS changed nothing between the paired captures, and
// until the per-run noise was masked every pair read as drift.
const bwOver25 = (echo) => ({
  id: 'c_bw_over25',
  family: 'echo-collection',
  name: 'ValidationException',
  message:
    `1 validation error detected: Value '${echo}' at 'requestItems' failed to satisfy constraint: ` +
    'Map value must satisfy constraint: [Member must have length less than or equal to 25, Member must have length greater than or equal to 1]',
  n: 1,
  fields: ['requestItems'],
})
const ct3Keys = (echo) => ({
  id: 'c_ct_3keys',
  family: 'echo-collection',
  name: 'ValidationException',
  message: `1 validation error detected: Value '${echo}' at 'keySchema' failed to satisfy constraint: Member must have length less than or equal to 2`,
  n: 1,
  fields: ['keySchema'],
})

describe('noise that changes on every capture', () => {
  it("ignores the fixture table's name and the object hashes in an echoed collection", () => {
    const before = bwOver25(
      '{_conformance_capdrift_h_1789897063468953098=[WriteRequest(putRequest=PutRequest(item={pk=com.amazonaws.dynamodb.v20120810.AttributeValue@483470e1}, workloadProfileName=null), deleteRequest=null)]}',
    )
    const after = bwOver25(
      '{_conformance_capdrift_h_1790504629067269608=[WriteRequest(putRequest=PutRequest(item={pk=com.amazonaws.dynamodb.v20120810.AttributeValue@7c1e2b0a}, workloadProfileName=null), deleteRequest=null)]}',
    )
    expect(diffProbe(before, after)).toBeNull()
  })

  it('ignores an echoed collection flipping between the two renderings AWS uses', () => {
    const hashes = ct3Keys(
      '[com.amazonaws.dynamodb.v20120810.KeySchemaElement@ad28eb1d, com.amazonaws.dynamodb.v20120810.KeySchemaElement@38b9654b, com.amazonaws.dynamodb.v20120810.KeySchemaElement@3e80eb03]',
    )
    const fields = ct3Keys(
      '[KeySchemaElement(attributeName=pk, keyType=HASH), KeySchemaElement(attributeName=sk, keyType=RANGE), KeySchemaElement(attributeName=extra, keyType=RANGE)]',
    )
    expect(diffProbe(hashes, fields)).toBeNull()
  })

  it("ignores the fixture table's name in a field path", () => {
    const framework = (table) => ({
      id: 'c_bw_over25',
      family: 'echo-collection',
      name: 'ValidationException',
      message: `1 validation error detected: Value at 'RequestItems.${table}.member' failed to satisfy constraint: Member must have length less than or equal to 25`,
      n: 1,
      fields: [`RequestItems.${table}.member`],
    })
    expect(
      diffProbe(framework('_conformance_capdrift_h_1788685284526756476'), framework('_conformance_capdrift_h_1789290845611208339')),
    ).toBeNull()
  })

  it("still reports the 2026-09-06 change, when eu-west-2 moved BatchWriteItem to the validation framework's wording", () => {
    const table = '_conformance_capdrift_h_1788685284526756476'
    const baseline = block(
      bwOver25(`{${table}=[WriteRequest(putRequest=PutRequest(item={pk=com.amazonaws.dynamodb.v20120810.AttributeValue@483470e1}, workloadProfileName=null), deleteRequest=null)]}`),
      { id: 'o_bw_empty_requestitems', family: 'ordering', name: 'ValidationException', message: 'The requestItems parameter is required for BatchWriteItem', n: null, fields: [] },
    )
    const observed = block(
      {
        ...bwOver25(''),
        message: `1 validation error detected: Value at 'RequestItems.${table}.member' failed to satisfy constraint: Member must have length less than or equal to 25`,
        fields: [`RequestItems.${table}.member`],
      },
      {
        id: 'o_bw_empty_requestitems',
        family: 'ordering',
        name: 'ValidationException',
        message: "1 validation error detected: Value at 'RequestItems' failed to satisfy constraint: Member must have length greater than or equal to 1",
        n: 1,
        fields: ['RequestItems'],
      },
    )
    expect(driftedProbes(diffCaptures(baseline, observed)).map((p) => p.id)).toEqual([
      'c_bw_over25',
      'o_bw_empty_requestitems',
    ])
  })

  it('still reports a changed scalar echo, which exact tests pin', () => {
    const scalar = (message) => ({ id: 's_ct_table_short', family: 'echo-scalar', name: 'ValidationException', message, n: 1, fields: ['tableName'] })
    const d = diffProbe(
      scalar("1 validation error detected: Value 'ab' at 'tableName' failed to satisfy constraint: Member must have length greater than or equal to 3"),
      scalar("1 validation error detected: Value 'ac' at 'tableName' failed to satisfy constraint: Member must have length greater than or equal to 3"),
    )
    expect(d?.changed).toEqual(['message'])
  })

  // What the masking ignores is what each probe's test ignores, and no more.
  // Each change below fails that test, so it has to reach the verdict.
  it('still reports a KeySchemaElement rendering the CreateTable test rejects', () => {
    const known = ct3Keys(
      '[KeySchemaElement(attributeName=pk, keyType=HASH), KeySchemaElement(attributeName=sk, keyType=RANGE), KeySchemaElement(attributeName=extra, keyType=RANGE)]',
    )
    const extraField = ct3Keys(
      '[KeySchemaElement(attributeName=pk, keyType=HASH, workloadProfileName=null), KeySchemaElement(attributeName=sk, keyType=RANGE, workloadProfileName=null), KeySchemaElement(attributeName=extra, keyType=RANGE, workloadProfileName=null)]',
    )
    expect(diffProbe(known, extraField)?.changed).toEqual(['message'])
  })

  it('still reports a changed number of echoed KeySchemaElements', () => {
    const three = ct3Keys(
      '[KeySchemaElement(attributeName=pk, keyType=HASH), KeySchemaElement(attributeName=sk, keyType=RANGE), KeySchemaElement(attributeName=extra, keyType=RANGE)]',
    )
    const two = ct3Keys('[KeySchemaElement(attributeName=pk, keyType=HASH), KeySchemaElement(attributeName=sk, keyType=RANGE)]')
    expect(diffProbe(three, two)?.changed).toEqual(['message'])
  })

  it('still reports a BatchWriteItem echo that lost its one-table map', () => {
    const mapped = bwOver25(
      '{_conformance_capdrift_h_1789897063468953098=[WriteRequest(putRequest=PutRequest(item={pk=com.amazonaws.dynamodb.v20120810.AttributeValue@483470e1}, workloadProfileName=null), deleteRequest=null)]}',
    )
    const bare = bwOver25(
      '[WriteRequest(putRequest=PutRequest(item={pk=com.amazonaws.dynamodb.v20120810.AttributeValue@483470e1}, workloadProfileName=null), deleteRequest=null)]',
    )
    expect(diffProbe(mapped, bare)?.changed).toEqual(['message'])
  })

  it('reports the raw answers, not the masked ones, so a reader sees what AWS said', () => {
    const before = ct3Keys('[KeySchemaElement(attributeName=pk, keyType=HASH)]')
    const after = { ...ct3Keys('[KeySchemaElement(attributeName=pk, keyType=HASH)]'), n: 2 }
    const d = diffProbe(before, after)
    expect(d.changed).toEqual(['n'])
    expect(d.baseline.message).toContain('KeySchemaElement(attributeName=pk')
  })
})

describe('fixture regression: the June 2026 four-region snapshot', () => {
  const euw2 = snapshot.regions['eu-west-2']

  it('finds no drift comparing eu-west-2 to itself', () => {
    expect(isClean(diffCaptures(euw2, euw2))).toBe(true)
  })

  it('reproduces the 21 eu-west-2-vs-us-east-1 divergences (old vs new wording)', () => {
    // 22 before the fixture table's name was masked: c_bw_over25 differed
    // between the two regions only in the name of the table each one created.
    // It was also the one prose-only divergence this snapshot offered, so the
    // passing-but-different case is left to the unit test above rather than
    // asserted here on noise.
    const d = diffCaptures(euw2, snapshot.regions['us-east-1'])
    expect(d.probes).toHaveLength(21)
    expect(d.probes.map((p) => p.id)).not.toContain('c_bw_over25')
    expect(d.probes.some((p) => p.passingButDifferent)).toBe(false)
    // the empty-TableName case moved both prose and the field token (camelCase -> PascalCase)
    const empty = d.probes.find((p) => p.id === 's_put_table_empty')
    expect(empty.changed).toEqual(expect.arrayContaining(['message', 'fields']))
    expect(empty.baseline.message).toContain("at 'TableName'")
    expect(empty.observed.message).toContain("at 'tableName'")
    // { NULL: false } acceptance differs between the lead and laggard regions
    expect(d.nullRoundTrip).not.toBeNull()
  })

  it('shows eu-central-1 tracking eu-west-2 far more closely than the laggards', () => {
    const cr = diffRegions(snapshot, 'eu-west-2')
    expect(cr.baselineRegion).toBe('eu-west-2')
    expect(cr.regions['eu-central-1'].probes.length).toBeLessThan(
      cr.regions['us-east-1'].probes.length,
    )
    expect(cr.regions['us-east-1'].probes).toHaveLength(21)
    expect(cr.regions['ap-southeast-2'].probes).toHaveLength(21)
  })
})
