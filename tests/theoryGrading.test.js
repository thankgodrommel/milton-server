import assert from "node:assert/strict";
import test from "node:test";
import { gradeTheoryAnswer } from "../services/theoryGrading.js";

test("awards full marks for a matching reference answer despite case and punctuation", () => {
  assert.deepEqual(
    gradeTheoryAnswer("Photosynthesis converts light into chemical energy.", "PHOTOSYNTHESIS converts light into chemical energy!", "normal", 5),
    { score: 5, similarity: 1, threshold: 0.6 },
  );
});

test("uses strictness to gate partial keyword coverage and still awards partial marks", () => {
  const answer = "alpha beta gamma delta";

  assert.equal(gradeTheoryAnswer(answer, "alpha beta gamma", "strict", 10).score, 0);
  const normalScore = gradeTheoryAnswer(answer, "alpha beta gamma", "normal", 10);
  assert.equal(normalScore.score, 7.5);
  assert.equal(normalScore.similarity, 0.75);
  assert.equal(gradeTheoryAnswer(answer, "alpha beta gamma", "very_fair", 10).score, 7.5);
});

test("returns zero when no reference keywords match and defaults unknown strictness to normal", () => {
  assert.deepEqual(
    gradeTheoryAnswer("The earth orbits the sun", "The moon has craters", "unknown", 4),
    { score: 0, similarity: 0, threshold: 0.6 },
  );
});
