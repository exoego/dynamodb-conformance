// The regional note, checked in the pages a reader sees (#271).
//
// A row's letter is read from the target's best-matching regions, and where
// some other region would grade it lower the row says so. The rule that decides
// that lives in the suite (regionalGapOf). This module works the same answer
// out again from the published per-region figures and holds the built HTML to
// it. Checking the data alone would pass with the note missing from every page,
// and checking the pages against the helper that drew them would agree with
// itself if the helper stopped finding anything.
//
// It replaced a check that failed the build whenever a zero-divergence row's
// letter did not survive its worst region. That one fired on 11 October 2026,
// and the revisit kept the criteria and moved the claim: a letter may fail to
// hold in a region provided the row says so. This holds every scored row to
// that, not only zero-divergence ones, because the same gap can sit under any
// letter.

import { GROUND_TRUTH_SLUG, REGIONAL_CAUSE, axesOf, gradeOf } from "./scoring.mjs";

const ORDER = ["A+", "A", "B", "C", "D", "F"];

/**
 * Every scored target whose letter some observed region would lower, from a
 * published summary (the site's per-target model, as build-evidence.json
 * carries it). Returns `{ scored, expected }`: `scored` counts the rows that
 * had a letter to check, so a caller can tell "nothing to check" from
 * "checked and clean"; `expected` maps slug to `[{ letter, regions }]`.
 */
export function expectedRegionalNotes(summary) {
  const expected = new Map();
  let scored = 0;
  for (const [slug, t] of Object.entries(summary?.targets ?? {})) {
    if (slug === GROUND_TRUTH_SLUG) continue;
    const regions = t.regions ?? [];
    const headline = regions.find((r) => r.region === t.suiteHeadlineRegion);
    if (!headline) continue;
    const { divergence, coverage } = axesOf(headline);
    const published = gradeOf(divergence, coverage).letter;
    if (published === null) continue;
    scored++;

    const lower = new Map();
    for (const r of regions) {
      const { letter } = gradeOf(axesOf(r).divergence, coverage);
      if (letter === null || ORDER.indexOf(letter) <= ORDER.indexOf(published)) continue;
      if (!lower.has(letter)) lower.set(letter, []);
      lower.get(letter).push(r.region);
    }
    if (lower.size) expected.set(slug, [...lower].map(([letter, rs]) => ({ letter, regions: rs })));
  }
  return { scored, expected };
}

// A note is any element carrying data-regional-note. The two shapes the
// templates use are a <p> holding a span and a link, and a bare <span> inside a
// card that is itself a link; neither nests its own tag, so a lazy match on the
// closing tag is exact.
const NOTE = /<(p|span)\b[^>]*\bdata-regional-note="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
const textOf = (html) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// A changelog entry can quote a note's wording, as the 3.7.0 entry does, and a
// target page shows that entry beside the run on its date. The popover is not a
// note, so its text is left out of the cause count rather than read as a note
// missing its attribute. The popover holds no <details> of its own, so a lazy
// match on the closing tag is exact.
const CHANGE_NOTE = /<details\b[^>]*\bdata-change-note\b[^>]*>[\s\S]*?<\/details>/g;

export function notesIn(html) {
  return [...html.matchAll(NOTE)].map((m) => ({ slug: m[2], text: textOf(m[3]) }));
}

// What a note for this gap has to say: each lower letter, the regions it
// applies to (named up to three, counted beyond), and the cause.
function textProblems(text, gap) {
  const problems = [];
  for (const { letter, regions } of gap) {
    if (!text.includes(`${letter} against `)) problems.push(`does not give ${letter}`);
    if (regions.length > 3) {
      if (!text.includes(`${regions.length} regions`)) problems.push(`does not count ${regions.length} regions`);
    } else {
      for (const region of regions) if (!text.includes(region)) problems.push(`does not name ${region}`);
    }
  }
  if (!text.includes(REGIONAL_CAUSE)) problems.push("does not put the cause on the regions");
  return problems;
}

/**
 * Hold built pages to the expected notes. `pages` is `[{ path, html, own }]`,
 * where `own` is the slug a target page belongs to and null for the board.
 *
 * On the board every expected target carries exactly one note and no other
 * target carries any. On a target page the target's own note is present
 * exactly when expected; any other note on it (a build's card) must belong to
 * a target that is expected to carry one. Every note found must say the right
 * thing, and the cause must not appear on a page more often than the notes do,
 * outside a changelog popover, which is what catches a note rendered without
 * the attribute.
 */
export function checkRegionalNotes({ expected }, pages) {
  const problems = [];
  for (const { path, html, own } of pages) {
    const notes = notesIn(html);

    for (const { slug, text } of notes) {
      const gap = expected.get(slug);
      if (!gap) {
        problems.push(`${path} notes ${slug}, whose letter holds in every region`);
        continue;
      }
      for (const p of textProblems(text, gap)) problems.push(`${path}: ${slug}'s note ${p}`);
    }

    const causes = textOf(html.replace(CHANGE_NOTE, "")).split(REGIONAL_CAUSE).length - 1;
    if (causes > notes.length) {
      problems.push(`${path} states the regional cause ${causes} time(s) but carries ${notes.length} note(s)`);
    }

    if (own === null) {
      for (const slug of expected.keys()) {
        const n = notes.filter((x) => x.slug === slug).length;
        if (n !== 1) problems.push(`${path} carries ${n} note(s) for ${slug}, which needs exactly one`);
      }
    } else if (expected.has(own) && !notes.some((x) => x.slug === own)) {
      problems.push(`${path} does not note where ${own}'s letter fails to hold`);
    }
  }
  return problems;
}
