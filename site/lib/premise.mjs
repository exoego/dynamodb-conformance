// The A+ premise: what a zero-divergence row is allowed to be hiding.
//
// A target with no failures in its headline region can still fail elsewhere.
// The board's claim is that when it does, the behaviour is one real DynamoDB
// splits on by region. Counts cannot settle that - three fails matching three
// splits and three fails on unrelated behaviours are the same number - so it is
// checked by name, against the split registry.
//
// This lives here, apart from the build check that calls it, because it is the
// one rule qualifying the top of the scale and for most of a year there has
// been no row for it to run on. Left inline it was exercised only by whatever
// the board happened to hold, which since 2026-08-12 is nothing: a guard that
// can only be tested by waiting for a target to earn A+ is a guard nobody can
// tell is working. As a function it takes fixtures.
//
// It used to compare the row's letter with its worst region's as well. That
// half fired on 11 October 2026, and the revisit (#271) kept the criteria and
// moved the claim: a letter may fail to hold in a region provided the row says
// so. lib/regional-note.mjs checks that, on every scored row, in the built
// pages.

/**
 * Check every zero-divergence row in a published summary against the registry.
 *
 * Returns `{ guarded, unconfirmed, uncheckable }`. `guarded` counts the rows
 * the premise applies to, so a caller can tell "nothing to check" from
 * "checked and clean" - the distinction that makes a vacuous pass honest.
 *
 * `unconfirmed` is a breach: a failure the registry does not explain.
 * `uncheckable` is the
 * artefact not carrying the evidence, which is also a failure - passing on
 * absent evidence is how a check by name silently becomes a check by count.
 */
export function checkAPlusPremise(summary, splits = []) {
  const unconfirmed = [];
  const uncheckable = [];
  let guarded = 0;

  // A registry row with no test identity confirms nothing: it cannot be matched
  // against a named failure, so it is left out rather than allowed to widen the
  // set by accident.
  const confirmed = new Set(
    splits.filter((row) => row?.test?.file).map((row) => `${row.test.file}::${row.test.fullName}`),
  );

  for (const [slug, t] of Object.entries(summary?.targets ?? {})) {
    const best = t.divergenceBest;
    if (best !== 0) continue; // not a zero-divergence target; the claim is not about it
    guarded++;

    const failingRegions = (t.regions ?? []).filter((r) => r.failed > 0).map((r) => r.region);

    if (failingRegions.length > 0 && !t.regionFailures) {
      uncheckable.push(`${slug} fails in ${failingRegions.length} region(s) but published no test identities`);
    } else {
      for (const region of failingRegions) {
        const names = t.regionFailures[region] ?? [];
        const declared = t.regions.find((r) => r.region === region)?.failed ?? 0;
        if (names.length !== declared) {
          uncheckable.push(`${slug}/${region} declares ${declared} fail(s) but names ${names.length}`);
          continue;
        }
        for (const identity of names) {
          // `<file>::<fullName>`, the suite's own test identity. Matching on
          // the name alone accepted a same-named test from a different file.
          if (!confirmed.has(identity)) unconfirmed.push(`${slug}/${region}: "${identity}"`);
        }
      }
    }
  }

  return { guarded, unconfirmed, uncheckable };
}
