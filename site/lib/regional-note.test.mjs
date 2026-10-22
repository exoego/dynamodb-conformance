import { test } from "node:test";
import assert from "node:assert/strict";

import { REGIONAL_CAUSE } from "./scoring.mjs";
import { checkRegionalNotes, expectedRegionalNotes, notesIn } from "./regional-note.mjs";

// A 1,000-test suite. `fails` maps region to failed count; the headline is the
// first region. Coverage defaults to 88%, so zero divergence reads as an
// effective 4.0: an A that 10 fails anywhere (5.0) pushes to B.
const region = (name, failed, implemented) => ({
  region: name,
  passed: implemented - failed,
  failed,
  skipped: 1000 - implemented,
  indeterminate: 0,
  count: 1000,
});
const summaryOf = (targets) => ({
  targets: Object.fromEntries(
    Object.entries(targets).map(([slug, { fails, implemented = 880 }]) => [
      slug,
      {
        suiteHeadlineRegion: Object.keys(fails)[0],
        regions: Object.entries(fails).map(([name, f]) => region(name, f, implemented)),
      },
    ]),
  ),
});

const SUMMARY = summaryOf({
  // Holds A in its headline region and grades B in two others.
  gappy: { fails: { "af-south-1": 0, "eu-south-2": 10, "me-central-1": 11, "us-east-1": 3 } },
  // Diverges a little more in one region without crossing a boundary.
  steady: { fails: { "af-south-1": 1, "me-central-1": 4 }, implemented: 1000 },
});

const note = (slug, text, tag = "p") => `<${tag} class="x" data-regional-note="${slug}">${text}</${tag}>`;
const GOOD = `<span>B against eu-south-2 and me-central-1, </span><a href="/targets/gappy#regions">${REGIONAL_CAUSE}</a>`;
const page = (path, own, ...bodies) => ({ path, own, html: `<html><body>${bodies.join("")}</body></html>` });

test("works out the gap from the published figures, and only where one exists", () => {
  const { scored, expected } = expectedRegionalNotes(SUMMARY);
  assert.equal(scored, 2, "both rows carry a letter to check");
  assert.deepEqual(expected.get("gappy"), [{ letter: "B", regions: ["eu-south-2", "me-central-1"] }]);
  assert.equal(expected.has("steady"), false);
});

test("passes a board and target pages that carry the right note in the right places", () => {
  const problems = checkRegionalNotes(expectedRegionalNotes(SUMMARY), [
    page("index.html", null, note("gappy", GOOD)),
    page("targets/gappy/index.html", "gappy", note("gappy", GOOD)),
    page("targets/steady/index.html", "steady"),
  ]);
  assert.deepEqual(problems, []);
});

test("fails a board that leaves the note out", () => {
  const problems = checkRegionalNotes(expectedRegionalNotes(SUMMARY), [page("index.html", null)]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /carries 0 note\(s\) for gappy/);
});

test("fails a target page that leaves its own note out", () => {
  const problems = checkRegionalNotes(expectedRegionalNotes(SUMMARY), [page("targets/gappy/index.html", "gappy")]);
  assert.match(problems[0], /does not note where gappy's letter fails to hold/);
});

test("fails a note on a row whose letter holds", () => {
  const problems = checkRegionalNotes(expectedRegionalNotes(SUMMARY), [
    page("index.html", null, note("gappy", GOOD), note("steady", `B against me-central-1, ${REGIONAL_CAUSE}`)),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /notes steady, whose letter holds in every region/);
});

test("fails a note that names the wrong regions, the wrong letter, or no cause", () => {
  const expected = expectedRegionalNotes(SUMMARY);
  const check = (text) => checkRegionalNotes(expected, [page("targets/gappy/index.html", "gappy", note("gappy", text))]);
  assert.match(check(`B against eu-south-2, ${REGIONAL_CAUSE}`).join(), /does not name me-central-1/);
  assert.match(check(`C against eu-south-2 and me-central-1, ${REGIONAL_CAUSE}`).join(), /does not give B/);
  // The wording the note replaced: true, but it reads as the target doing worse.
  assert.match(check("B in eu-south-2 and me-central-1").join(), /does not put the cause on the regions/);
});

test("fails a note rendered without the attribute the check finds it by", () => {
  const problems = checkRegionalNotes(expectedRegionalNotes(SUMMARY), [
    page("index.html", null, note("gappy", GOOD), `<p>B against us-east-1, ${REGIONAL_CAUSE}</p>`),
  ]);
  assert.match(problems.join(), /states the regional cause 2 time\(s\) but carries 1 note\(s\)/);
});

test("counts the regions beyond three rather than naming them", () => {
  const wide = summaryOf({
    wide: { fails: { "af-south-1": 0, "a-1": 10, "b-1": 10, "c-1": 10, "d-1": 10 } },
  });
  const expected = expectedRegionalNotes(wide);
  const ok = checkRegionalNotes(expected, [page("index.html", null, note("wide", `B against 4 regions, ${REGIONAL_CAUSE}`))]);
  assert.deepEqual(ok, []);
  const named = checkRegionalNotes(expected, [page("index.html", null, note("wide", `B against a-1, ${REGIONAL_CAUSE}`))]);
  assert.match(named.join(), /does not count 4 regions/);
});

test("reads a build card's bare span as well as a row's paragraph", () => {
  const html = `${note("gappy", GOOD)}${note("gappy", `B against eu-south-2 and me-central-1, ${REGIONAL_CAUSE}`, "span")}`;
  assert.deepEqual(
    notesIn(html).map((n) => n.slug),
    ["gappy", "gappy"],
  );
});

test("an empty board reports nothing scored rather than a clean pass", () => {
  assert.deepEqual(expectedRegionalNotes({ targets: {} }), { scored: 0, expected: new Map() });
});
