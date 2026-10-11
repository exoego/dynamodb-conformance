import { test } from "node:test";
import assert from "node:assert/strict";

import { checkAPlusPremise } from "./premise.mjs";

// No row has held zero divergence since 2026-08-12, so on the live board this
// rule runs on nothing and passes. That is honest, and check-build says so
// rather than reporting a green check - but it means the board cannot tell
// anyone whether the rule still works. These fixtures can.

const SPLIT = {
  id: "batch-get-item-empty-request-items-message",
  test: { file: "tests/tier3/error-messages/batchGetItem.test.ts", fullName: "BatchGetItem rejects empty RequestItems" },
};
const CONFIRMED = `${SPLIT.test.file}::${SPLIT.test.fullName}`;
const UNRELATED = "tests/tier1/putItem/basic.test.ts::PutItem writes an item";

// A target that is clean in its headline region and fails in one other.
//
// Coverage is 80%. It was chosen when this rule also compared letters, to keep
// both readings in one band so the registry matching stayed the thing under
// test; the letter half has since moved to lib/regional-note.mjs, and the
// tests at the bottom pin that it no longer lives here.
const target = ({ failed, names, worst, coverage = 800 }) => ({
  targets: {
    alpha: {
      suiteHeadlineRegion: "eu-west-2",
      divergenceBest: 0,
      divergenceWorst: worst,
      regions: [
        { region: "eu-west-2", passed: coverage, failed: 0, skipped: 1000 - coverage, indeterminate: 0, count: 1000 },
        { region: "us-east-1", passed: coverage - failed, failed, skipped: 1000 - coverage, indeterminate: 0, count: 1000 },
      ],
      ...(names ? { regionFailures: { "us-east-1": names } } : {}),
    },
  },
});

test("a failure the registry records is confirmed", () => {
  const r = checkAPlusPremise(target({ failed: 1, names: [CONFIRMED], worst: 0.1 }), [SPLIT]);
  assert.equal(r.guarded, 1, "the row must actually have been checked");
  assert.deepEqual(r.unconfirmed, []);
  assert.deepEqual(r.uncheckable, []);
});

test("a failure the registry does not record is a breach", () => {
  // The case the guard exists for: zero divergence in the headline region,
  // failing elsewhere on a behaviour nobody has confirmed real AWS splits on.
  const r = checkAPlusPremise(target({ failed: 1, names: [UNRELATED], worst: 0.1 }), [SPLIT]);
  assert.equal(r.guarded, 1);
  assert.equal(r.unconfirmed.length, 1);
  assert.match(r.unconfirmed[0], /PutItem writes an item/);
});

test("a same-named test in a different file does not count as confirmed", () => {
  // Matching on the title alone accepted this. The identity is file-scoped
  // because fullName is only unique within a file.
  const elsewhere = `tests/tier3/error-messages/other.test.ts::${SPLIT.test.fullName}`;
  const r = checkAPlusPremise(target({ failed: 1, names: [elsewhere], worst: 0.1 }), [SPLIT]);
  assert.equal(r.unconfirmed.length, 1);
});

test("failing somewhere without naming the tests is uncheckable, not a pass", () => {
  // Passing on absent evidence is how a check by name silently becomes a check
  // by count, which is the thing this guard was written to stop being.
  const r = checkAPlusPremise(target({ failed: 3, names: null, worst: 0.3 }), [SPLIT]);
  assert.equal(r.guarded, 1);
  assert.equal(r.unconfirmed.length, 0);
  assert.equal(r.uncheckable.length, 1);
  assert.match(r.uncheckable[0], /published no test identities/);
});

test("naming fewer tests than the row declares is uncheckable", () => {
  const r = checkAPlusPremise(target({ failed: 3, names: [CONFIRMED], worst: 0.3 }), [SPLIT]);
  assert.match(r.uncheckable[0], /declares 3 fail\(s\) but names 1/);
});

test("enough confirmed splits to move the letter is no longer a breach here", () => {
  // This rule used to compare the published letter with the worst region's and
  // fail the build when they differed. That fired on 11 October 2026, and the
  // revisit (#271) kept the criteria: a letter may fail to hold in a region
  // provided the row says so, which lib/regional-note.mjs checks in the built
  // pages. Every one of these 90 failures is recorded, so this rule is content.
  const names = Array.from({ length: 90 }, () => CONFIRMED);
  const r = checkAPlusPremise(target({ failed: 90, names, worst: 9 }), [SPLIT]);
  assert.equal(r.guarded, 1);
  assert.deepEqual(r.unconfirmed, []);
  assert.deepEqual(r.uncheckable, []);
});

test("an A+ row failing a confirmed split elsewhere is not a breach here either", () => {
  const r = checkAPlusPremise(
    target({ failed: 1, names: [CONFIRMED], worst: 0.1, coverage: 1000 }),
    [SPLIT],
  );
  assert.equal(r.guarded, 1);
  assert.deepEqual(r.unconfirmed, []);
});

test("a row that is perfect everywhere needs nothing confirmed", () => {
  const r = checkAPlusPremise(target({ failed: 0, names: null, worst: 0 }), [SPLIT]);
  assert.equal(r.guarded, 1);
  assert.deepEqual(r.unconfirmed, []);
  assert.deepEqual(r.uncheckable, []);
});

test("a row that diverges in its headline region is not in scope", () => {
  const summary = target({ failed: 1, names: [UNRELATED], worst: 0.5 });
  summary.targets.alpha.divergenceBest = 0.2;
  const r = checkAPlusPremise(summary, [SPLIT]);
  assert.equal(r.guarded, 0, "the premise is only about zero-divergence rows");
  assert.deepEqual(r.unconfirmed, []);
});

test("a registry row carrying no test identity confirms nothing", () => {
  const r = checkAPlusPremise(target({ failed: 1, names: [UNRELATED], worst: 0.1 }), [{ id: "shapeless" }]);
  assert.equal(r.unconfirmed.length, 1);
});

test("an empty board reports nothing checked rather than a clean pass", () => {
  const r = checkAPlusPremise({ targets: {} }, [SPLIT]);
  assert.equal(r.guarded, 0);
  assert.deepEqual(r.unconfirmed, []);
});
