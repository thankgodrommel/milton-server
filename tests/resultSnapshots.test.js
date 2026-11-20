import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResultSnapshot,
  populateHistoricalResultMetadata,
  repairResultSnapshot,
} from "../services/resultSnapshots.js";

const classResults = [
  {
    id: "result-active-1",
    student_id: "active-1",
    class: "Class A",
    term: "First_Term",
    session: "2025/2026",
    section: "Primary",
    subject_id: "math",
    subject_name: "Mathematics",
    total: 80,
    status: "Approved",
    class_position: 2,
    subject_position: 2,
    class_average_score: 80,
    total_in_class: 4,
  },
  {
    id: "result-active-2",
    student_id: "active-2",
    class: "Class A",
    term: "First_Term",
    session: "2025/2026",
    section: "Primary",
    subject_id: "math",
    subject_name: "Mathematics",
    total: 60,
    status: "Approved",
  },
  {
    id: "result-withdrawn",
    student_id: "withdrawn",
    class: "Class A",
    term: "First_Term",
    session: "2025/2026",
    section: "Primary",
    subject_id: "math",
    subject_name: "Mathematics",
    total: 100,
    status: "Approved",
  },
];

const activeStudents = [
  { id: "active-1" },
  { id: "active-2" },
  { id: "active-3" },
];

function createDatabase() {
  const updates = new Map();
  return {
    updates,
    student: {
      findUnique: async () => ({
        id: "active-1",
        first_name: "Active",
        last_name: "Student",
        admission_number: "A001",
        current_class: "Class A",
        section: "Primary",
        status: "Active",
      }),
      findMany: async () => activeStudents,
    },
    result: {
      findMany: async () => classResults,
      findUnique: async ({ where }) => classResults.find((result) => result.id === where.id),
      update: async ({ where, data }) => updates.set(where.id, data),
    },
    reportCard: { findMany: async () => [] },
    subject: { findMany: async () => [] },
    attendance: { findMany: async () => [] },
    teacher: { findFirst: async () => null },
    schoolSettings: { findFirst: async () => null },
  };
}

test("class snapshots exclude withdrawn students from class and subject statistics", async () => {
  const snapshot = await buildResultSnapshot(createDatabase(), {
    studentId: "active-1",
    term: "First Term",
    session: "2025/2026",
    className: "Class A",
  });

  assert.equal(snapshot.rankings.classPosition, 1);
  assert.equal(snapshot.rankings.totalInClass, 3);
  assert.equal(snapshot.results[0].subject_position, 1);
  assert.equal(snapshot.results[0].class_average_score, 70);
});

test("repairing a snapshot replaces class statistics inflated by withdrawn students", async () => {
  const db = createDatabase();
  const repaired = await repairResultSnapshot(db, {
    student_id: "active-1",
    term: "First Term",
    session: "2025/2026",
    class: "Class A",
  }, {
    student: { id: "active-1", admission_number: "A001" },
    rankings: { classPosition: 2, totalInClass: 4 },
    results: [{
      subject_id: "math",
      subject_name: "Mathematics",
      class_position: 2,
      subject_position: 2,
      class_average_score: 80,
      total_in_class: 4,
    }],
  });

  assert.equal(repaired.rankings.classPosition, 1);
  assert.equal(repaired.rankings.totalInClass, 3);
  assert.equal(repaired.results[0].class_position, 1);
  assert.equal(repaired.results[0].subject_position, 1);
  assert.equal(repaired.results[0].class_average_score, 70);
  assert.equal(repaired.results[0].total_in_class, 3);
});

test("historical metadata backfill uses only active students for ranks, averages, and class size", async () => {
  const db = createDatabase();
  await populateHistoricalResultMetadata(db);

  assert.equal(db.updates.get("result-active-1").class_position, 1);
  assert.equal(db.updates.get("result-active-1").subject_position, 1);
  assert.equal(db.updates.get("result-active-1").class_average_score, 70);
  assert.equal(db.updates.get("result-active-1").total_in_class, 3);
  assert.equal(db.updates.has("result-withdrawn"), false);
});
