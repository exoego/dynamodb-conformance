import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load as loadYaml } from 'js-yaml'
import { MEASURED_FIELDS } from './lib/measured.mjs'

// The measured-ref design holds together across four workflow files, and most
// of what could break it is invisible inside any one of them: a value one
// workflow emits and another gates on, a job that runs when the job it depends
// on failed, a field name that only has to match a validator in another
// language. Every assertion below stands in for a failure that would otherwise
// surface hours into a real-AWS run, or not at all.
//
// Written in the same idiom as registry-wiring.test.mjs and
// sweep-publish-wiring.test.mjs, including their care about vacuous passes: an
// assertion that goes green when the line it guards is DELETED is worse than no
// assertion, so every lookup asserts presence before asserting anything else.

const read = (name) => readFileSync(`.github/workflows/${name}.yml`, 'utf8')

// Comments stripped before anything is asserted about the code. These files
// explain themselves at length, and prose quoting the condition it describes
// would otherwise satisfy an assertion about the condition itself.
const uncommented = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

describe('a merge to main does not move the published board', () => {
  // The single requirement the whole change exists to create. It rests on one
  // `if:` in results-table.yml, and re-adding `push` to that event list would
  // restore the old behaviour with every other test in the repo still green.
  const code = uncommented(read('results-table'))

  it('publishes only from a schedule or a dispatch, never a push', () => {
    const gate = code.slice(code.indexOf('if: >-'))
    expect(gate, 'results-table.yml no longer has an `if:` gate on its update job').toContain(
      'workflow_run.event',
    )
    expect(gate).toContain("github.event.workflow_run.event == 'schedule'")
    expect(gate).toContain("github.event.workflow_run.event == 'workflow_dispatch'")
    // The assertion that actually matters, and the one a well-meaning revert
    // would trip: a push-triggered conformance run must never reach the publish.
    expect(
      /workflow_run\.event\s*==\s*'push'/.test(gate),
      "results-table.yml accepts a push-triggered run again, so a merge to main would move the board",
    ).toBe(false)
  })

  it('still refuses a run that did not come from this repository on main', () => {
    // Pre-existing fork guard. The measured-ref work runs through the same
    // condition, so it is asserted here rather than assumed to have survived.
    expect(code).toContain("github.event.workflow_run.head_branch == 'main'")
    expect(code).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    )
  })
})

describe('the release measurement reaches the publisher', () => {
  it('dispatches conformance on main and names the tag as an input', () => {
    // A run dispatched on the tag reports the tag as its head_branch, and the
    // publisher above requires main - so the measurement would be correct and
    // publish nothing, three hours later, with nothing failing to say why.
    const release = uncommented(read('release'))
    expect(release).toMatch(/gh workflow run conformance\.yml --ref main -f "ref=v\$VERSION"/)
  })

  it('dispatches as the App rather than with GITHUB_TOKEN', () => {
    // GITHUB_TOKEN starts the run - a workflow_dispatch is the documented
    // exception to it not starting further runs - but GitHub attributes that
    // run to github-actions[bot] and emits no workflow_run event when it
    // completes. So results-table.yml never hears the measurement finish and
    // the draft never flips, which is what happened to v3.2.0: three hours
    // green, nothing published, nothing red to say why. Only the identity
    // holding the token fixes it, so only the identity is asserted here.
    const steps = loadYaml(read('release')).jobs.release.steps
    const measure = steps.find((step) => step.name === 'Measure the new tag')
    expect(measure, 'release.yml no longer has a step named "Measure the new tag"').toBeTruthy()

    const token = measure.env?.GH_TOKEN ?? ''
    expect(token, 'the measurement is dispatched with GITHUB_TOKEN again').not.toContain(
      'github.token',
    )

    const mintedBy = /steps\.([\w-]+)\.outputs\.token/.exec(token)?.[1]
    expect(mintedBy, `the dispatch reads ${token}, which no step in this job mints`).toBeTruthy()

    const mint = steps.find((step) => step.id === mintedBy)
    expect(mint, `no step with id ${mintedBy} mints the token the dispatch reads`).toBeTruthy()
    expect(mint.uses).toContain('actions/create-github-app-token')
    // Narrowed at the mint, not inherited: create-github-app-token hands back
    // everything the installation grants unless it is asked for less.
    expect(mint.with?.['permission-actions']).toBe('write')
  })
})

describe('a lane never measures a ref the resolver did not give it', () => {
  // The non-gating lanes run under always() so a failed gating run does not
  // skip them. But when the `changes` job itself fails, its outputs are empty,
  // and actions/checkout reads an empty `ref` as "use the triggering ref" - so
  // the lane spends real-AWS time measuring main while reporting nothing wrong.
  const workflow = loadYaml(read('conformance'))

  const alwaysLanes = Object.entries(workflow.jobs).filter(
    ([, job]) =>
      typeof job.if === 'string' &&
      job.if.includes('always()') &&
      [].concat(job.needs ?? []).includes('changes'),
  )

  it('finds the lanes this rule is about', () => {
    // Presence asserted, so the per-lane assertion below cannot pass by
    // iterating an empty list if these jobs are renamed or restructured.
    expect(alwaysLanes.length).toBeGreaterThan(0)
  })

  it.each(alwaysLanes.map(([name]) => name))(
    '%s runs only when the resolver succeeded',
    (name) => {
      expect(workflow.jobs[name].if).toContain("needs.changes.result == 'success'")
    },
  )
})

describe('the measured identity survives the trip between workflows', () => {
  // conformance.yml writes measured/suite.json in shell; scripts/lib/measured.mjs
  // validates it in JS and refuses a partial identity. Nothing but this test
  // makes the two agree, and a rename would otherwise surface as a refused
  // publish at the end of a three-hour run.
  const step = (() => {
    const text = read('conformance')
    const start = text.indexOf('- name: Record what was measured')
    expect(start, 'conformance.yml no longer has a "Record what was measured" step').toBeGreaterThan(
      -1,
    )
    return text.slice(start, text.indexOf('- name: Upload what was measured', start))
  })()

  it.each(MEASURED_FIELDS)('writes the %s field the validator requires', (field) => {
    expect(step).toMatch(new RegExp(`--arg ${field}\\b`))
  })

  it('builds the JSON with jq rather than interpolating into a heredoc', () => {
    // `version` is read from package.json at whatever ref was measured, so it
    // is not this workflow's to trust. Interpolated into a JSON string position
    // it could close the field and append its own `"kind": "tag"`, which is the
    // only gate on publishing.
    expect(step).toContain('jq -n')
    expect(
      /cat\s*>\s*measured\/suite\.json\s*<<\s*EOF/.test(step),
      'the identity is built by an unquoted heredoc again, so a crafted version can forge kind',
    ).toBe(false)
  })
})

describe("a scheduled red is triaged against the measured suite's own capture", () => {
  // A scheduled run measures the latest release tag, so the question a red
  // run's triage has to answer is whether eu-west-2 has moved since that tag
  // was cut. The tag carries the weekly capture as it stood then, in the tree
  // the job checks out. A dated file answers against whatever week it was
  // taken, and every probe added since is invisible to it; main's latest
  // capture would absorb drift the tag still fails on, and call the next
  // week's red a flake.
  const wf = loadYaml(read('conformance'))
  const job = wf.jobs['test-dynamodb']

  it('checks out the measured ref, which is what makes its capture the right baseline', () => {
    const checkout = job.steps.find((s) => String(s.uses).startsWith('actions/checkout'))
    expect(checkout, 'test-dynamodb no longer checks anything out').toBeDefined()
    expect(checkout.with?.ref).toBe('${{ needs.changes.outputs.ref }}')
  })

  it('diffs against the committed weekly capture, not a dated one', () => {
    const verdict = job.steps.find((s) => s.name === 'Compute the drift verdict')
    expect(verdict, 'test-dynamodb no longer has a "Compute the drift verdict" step').toBeDefined()
    const baseline = uncommented(verdict.run).match(/--baseline\s+(\S+)/)
    expect(baseline, 'the drift verdict step no longer passes --baseline').not.toBeNull()
    expect(baseline[1]).toBe('captures/cross-region-latest.json')
  })

  it('reads the file the weekly capture writes, so the baseline stays fed', () => {
    const capture = wf.jobs['capture-cross-region'].steps.find((s) =>
      String(s.run).includes('capture-validation-messages.mjs'),
    )
    expect(capture, 'capture-cross-region no longer runs the capture').toBeDefined()
    expect(capture.run).toContain('> captures/cross-region-latest.json')
    expect(capture.run).toContain('eu-west-2')
  })
})
