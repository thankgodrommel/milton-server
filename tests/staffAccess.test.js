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

test("denies the entire account when any linked portal role is deactivated", async () => {
  const database = {
    teacher: { findMany: async () => [{ status: "Active" }] },
    staffRole: {
      findMany: async ({ where }) => {
        assert.ok(
          where.OR.some((condition) => condition.user_id === "user-100"),
        );
        return [{ status: "Active" }, { status: "Inactive" }];
      },
    },
  };

  assert.equal(
    await hasActiveStaffAccess({
      id: "user-100",
      profile_type: "Teacher",
      profile_id: "teacher-100",
      role: "teacher",
    }, database),
    false,
  );
});

test("checks teacher status even when the account resolves as non-academic staff", async () => {
  const database = {
    teacher: { findMany: async () => [{ status: "Inactive" }] },
    nonAcademicStaff: { findMany: async () => [{ status: "Active" }] },
  };

  assert.equal(
    await hasActiveStaffAccess({
      profile_type: "NonAcademicStaff",
      profile_id: "staff-100",
      staff_id: "S-100",
      role: "accountant",
    }, database),
    false,
  );
});
