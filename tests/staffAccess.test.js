import assert from "node:assert/strict";
import test from "node:test";
import { isDeactivatedStaffStatus } from "../utils/staffAccess.js";

test("recognizes deactivated staff status regardless of capitalization or whitespace", () => {
  assert.equal(isDeactivatedStaffStatus("Deactivated"), true);
  assert.equal(isDeactivatedStaffStatus(" INACTIVE "), true);
  assert.equal(isDeactivatedStaffStatus("Terminated"), true);
  assert.equal(isDeactivatedStaffStatus("Active"), false);
  assert.equal(isDeactivatedStaffStatus(null), false);
});
