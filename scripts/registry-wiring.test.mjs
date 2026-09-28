import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadRegistry } from './lib/registry.mjs'
import { PROVISIONAL_ACCEPTED_DETAIL } from '../src/observation-sink.js'

// Per-region scoring joins three hand-maintained artefacts on prose
// identity: a registry row names its test by (file, fullName), the wired
// test records the target's answer via src/observation-sink.ts, and an
// accepted answer is credited only when the detail string the test stamps
// byte-matches the row's. None of those joins fails loudly on its own - a
// renamed test, an unwired row, or a reworded detail just degrades scoring
// back to the conservative fail-everywhere path with nothing going red,
// which is exactly how 2.0.0 shipped with the evidence half missing. These
// assertions are what make that drift loud.

const registry = loadRegistry()

// Titles as they appear in source: the first string literal argument of a
// describe()/it() call. The split tests use plain single-quoted titles; a
// row whose test moves to a template literal or computed title will fail the
// fullName join below, which is the correct moment for a human to strengthen
// this extraction.
const titleLiterals = (source, kind) =>
  [...source.matchAll(new RegExp(`\\b${kind}\\(\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map(
    (m) => m[1].replaceAll("\\'", "'"),
  )

// The source of one test: from its it() call to the next test-structure call
// (it, test or describe, with or without a modifier such as .each or .skipIf,
// and whatever its title is written as), or the end of the file. Several rows
// can key to tests in one file, so the wiring checks read the named test's
// block rather than the whole file, which would let one wired test vouch for
// its unwired neighbours.
//
// The test is found by its describe title as well as its own: the nearest
// describe() above it plus its it() title must end the row's fullName. Two
// describes can hold tests with the same title, and matching on the it()
// title alone would hand both rows the first one's block. A test this cannot
// place resolves to null and fails its row loudly rather than borrowing a
// neighbour's block.
const TEST_CALL = /(?<![.\w])(it|test|describe)((?:\.\w+)*)\(\s*(?:'((?:[^'\\]|\\.)*)')?/g
const testBlock = (source, fullName) => {
  const calls = [...source.matchAll(TEST_CALL)].map((m) => ({
    kind: m[1],
    plain: m[2] === '',
    title: m[3] === undefined ? null : m[3].replaceAll("\\'", "'"),
    index: m.index,
  }))
  let describeTitle = null
  let at = -1
  let matched = ''
  calls.forEach((call, i) => {
    if (call.kind === 'describe') {
      describeTitle = call.plain ? call.title : null
      return
    }
    if (call.kind !== 'it' || !call.plain || call.title === null || describeTitle === null) return
    const name = `${describeTitle} ${call.title}`
    if (fullName !== name && !fullName.endsWith(` ${name}`)) return
    if (name.length > matched.length) {
      at = i
      matched = name
    }
  })
  if (at === -1) return null
  const start = calls[at].index
  const end = calls[at + 1]?.index ?? source.length
  return { start, text: source.slice(start, end) }
}

// Whether a block calls observeSplit or recordObserved, ignoring comments: the
// row id lives in a comment by convention, and a comment that merely mentions
// the helper must not pass for a test that never records its answer.
const recordsObservation = (block) =>
  /\b(?:observeSplit|recordObserved)\s*\(/.test(
    block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'),
  )

describe('every registry row resolves to a wired split test', () => {
  it('no two rows share a test block, which keeps per-test assertions exact', () => {
    // The wiring checks below read only the named test's own block, so rows
    // may share a file. Two rows resolving to one block would let one wired
    // test satisfy both rows' checks, which is what this guards against.
    const blocks = registry.splits.map((row) => {
      const source = existsSync(row.test.file) ? readFileSync(row.test.file, 'utf8') : ''
      return `${row.test.file}\0${testBlock(source, row.test.fullName)?.start}`
    })
    expect(new Set(blocks).size).toBe(blocks.length)
  })

  for (const row of registry.splits) {
    describe(row.id, () => {
      const source = existsSync(row.test.file) ? readFileSync(row.test.file, 'utf8') : null
      const block = source === null ? null : testBlock(source, row.test.fullName)?.text ?? null
      const acceptedDetails = Object.values(row.regions)
        .filter((observation) => observation.outcome === 'accepted')
        .map((observation) => observation.detail)

      it('names a test file that exists', () => {
        expect(source, `${row.test.file} does not exist`).not.toBeNull()
      })

      it('joins on a fullName composed of a real describe/it pair in that file', () => {
        // Scoring and drift detection join rows to results on fullName
        // (describe title + space + it title). A renamed title silently
        // un-joins the row - every target then scores the conservative
        // fail-everywhere path - so the composition is asserted here.
        const titles = titleLiterals(source, 'it')
        const title = titles.find((t) => row.test.fullName.endsWith(` ${t}`))
        expect(title, `no it() title in ${row.test.file} ends ${row.test.fullName}`)
          .toBeDefined()
        const prefix = row.test.fullName.slice(0, -(title.length + 1))
        expect(titleLiterals(source, 'describe')).toContain(prefix)
      })

      it('is named by its test, which records an observation', () => {
        // Convention: a split test carries its registry row id in a comment,
        // and captures the target's answer. A row admitted without wiring
        // the test would score as fail-everywhere for every target.
        expect(block, `no it() block in ${row.test.file} for ${row.test.fullName}`).not.toBeNull()
        expect(block).toContain(row.id)
        expect(recordsObservation(block), `${row.test.fullName} never calls observeSplit`).toBe(true)
      })

      it('has every accepted detail it records present verbatim in the test', () => {
        // An accepted answer is stamped from a literal in the test, so a
        // reworded registry detail silently stops matching unless the test
        // moves in lockstep. Rejected answers are captured verbatim from the
        // target at run time and need no literal.
        for (const detail of acceptedDetails) {
          expect(block, `detail "${detail}" not found in the test's block`).toContain(detail)
        }
      })

      it('never records the provisional accepted detail as a real answer', () => {
        // The provisional detail exists to match nothing; a row recording it
        // would let an unverified acceptance claim a region match.
        expect(acceptedDetails).not.toContain(PROVISIONAL_ACCEPTED_DETAIL)
      })
    })
  }
})

describe('testBlock finds the named test and nothing else', () => {
  // Fixtures stand in for split test files. Each test body carries a marker so
  // an assertion can say which block came back.
  const source = [
    "describe('Outer one', () => {",
    "  it('writes the item', async () => { /* A */ })",
    "  it('full error', async () => { /* B */ })",
    "  it('error', async () => { /* C */ })",
    "  it.each([1, 2])('parameterised %i', async () => { /* D */ })",
    "  it('before a template title', async () => { /* E */ })",
    "  it(`template ${1}`, async () => { /* F */ })",
    "})",
    "describe('Outer two', () => {",
    "  it('writes the item', async () => { /* G */ })",
    "})",
  ].join('\n')
  const text = (fullName) => testBlock(source, fullName)?.text ?? null

  it('tells apart two tests with one title under different describes', () => {
    expect(text('Outer one writes the item')).toContain('/* A */')
    expect(text('Outer two writes the item')).toContain('/* G */')
    expect(text('Outer two writes the item')).not.toContain('/* A */')
  })

  it('does not let a short title claim a longer one that ends with it', () => {
    expect(text('Outer one full error')).toContain('/* B */')
    expect(text('Outer one error')).toContain('/* C */')
    expect(text('Outer one error')).not.toContain('/* B */')
  })

  it('ends a block at a modified or template-titled neighbour', () => {
    expect(text('Outer one error')).not.toContain('/* D */')
    expect(text('Outer one before a template title')).not.toContain('/* F */')
  })

  it('resolves a name it cannot place to null', () => {
    expect(text('Outer three writes the item')).toBeNull()
    expect(text('writes the item')).toBeNull()
  })

  it('ignores .test( on a regex inside a block', () => {
    const withRegex = [
      "describe('Suite', () => {",
      "  it('checks', () => { expect(/x/.test('x')).toBe(true); /* H */ })",
      '})',
    ].join('\n')
    expect(testBlock(withRegex, 'Suite checks')?.text).toContain('/* H */')
  })
})

describe('recordsObservation', () => {
  it('counts a real call', () => {
    expect(recordsObservation('await observeSplit(ctx.task, () => send())')).toBe(true)
    expect(recordsObservation('recordObserved(ctx.task, observation)')).toBe(true)
  })

  it('does not count a helper named only in a comment', () => {
    expect(recordsObservation('// wired through observeSplit(ctx.task, ...) later\nawait send()')).toBe(false)
    expect(recordsObservation('/* observeSplit( */ await send()')).toBe(false)
  })
})
