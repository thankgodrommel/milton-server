import assert from "node:assert/strict";
import test from "node:test";
import {
  getTranscriptStages,
  matchesTranscriptHistoryClass,
  matchesTranscriptStudentClass,
  TRANSCRIPT_STAGE,
} from "../utils/transcriptAccess.js";

test("transcript stages are limited to the caller's role", () => {
  assert.deepEqual(getTranscriptStages({ role: "head_teacher" }), ["primary5"]);
  assert.deepEqual(getTranscriptStages({ role: "principal" }), ["ss3"]);
  assert.deepEqual(
    getTranscriptStages({ role: "admin" }),
    ["primary5", "ss3"],
  );
  assert.deepEqual(getTranscriptStages({ role: "teacher" }), []);
});

test("transcript eligibility distinguishes final classes from academic history", () => {
  assert.equal(matchesTranscriptStudentClass("Primary 5B", TRANSCRIPT_STAGE.PRIMARY_5), true);
  assert.equal(matchesTranscriptStudentClass("Primary 4A", TRANSCRIPT_STAGE.PRIMARY_5), false);
  assert.equal(matchesTranscriptStudentClass("SS3 Sci A", TRANSCRIPT_STAGE.SS3), true);
  assert.equal(matchesTranscriptStudentClass("SS3 Science A", TRANSCRIPT_STAGE.SS3), true);
  assert.equal(matchesTranscriptStudentClass("SS2 Sci A", TRANSCRIPT_STAGE.SS3), false);
  assert.equal(matchesTranscriptHistoryClass("Primary 3A", TRANSCRIPT_STAGE.PRIMARY_5), true);
  assert.equal(matchesTranscriptHistoryClass("SS2 Arts B", TRANSCRIPT_STAGE.SS3), true);
});
