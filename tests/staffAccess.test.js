import assert from "node:assert/strict";
import test from "node:test";
import { hasActiveStaffAccess } from "../utils/staffAccess.js";

test("denies teacher access when any matching teacher profile is deactivated", async () => {
  const database = {
    teacher: {
      findMany: async () => [{ status: "Active" }, { status: "Deactivated" }],
    },
  };

  assert.equal(
    await hasActiveStaffAccess({
      profile_type: "Teacher",
      profile_id: "teacher-profile",
      staff_id: "T-100",
      role: "teacher",
    }, database),
    false,
  );
});

test("denies accountant access when the stored profile type is missing", async () => {
  const database = {
    teacher: { findMany: async () => [] },
    nonAcademicStaff: { findMany: async () => [{ status: "Inactive" }] },
  };

  assert.equal(
    await hasActiveStaffAccess({
      username: "S-100",
      role: "accountant",
    }, database),
    false,
  );
});
