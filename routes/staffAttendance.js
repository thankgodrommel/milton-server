import jwt from "jsonwebtoken";
import { Router } from "express";
import prisma from "../config/prisma.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();
const jwtSecret = () => process.env.JWT_SECRET || "milton_college_dev_secret";
const schoolTimeZone = () => process.env.SCHOOL_TIME_ZONE || "Africa/Lagos";
const QR_LIFETIME_SECONDS = 120;
const MAX_RANGE_DAYS = 366;
const SCANNER_ROLES = new Set(["admin", "accountant", "principal"]);
const STAFF_REPORT_ROLES = new Set([...SCANNER_ROLES, "director"]);
const STAFF_TYPES = new Set(["teacher", "non_academic_staff", "admin_user"]);

router.use(authenticate);
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function getRoles(user) {
  return [...new Set([user.role, ...(Array.isArray(user.roles) ? user.roles : [])]
    .map((role) => String(role || "").toLowerCase()))];
}

function hasRole(user, allowedRoles) {
  return getRoles(user).some((role) => allowedRoles.has(role));
}

function isActive(record) {
  return !["inactive", "withdrawn", "archived", "suspended"].includes(
    String(record?.status || "").toLowerCase(),
  );
}

function schoolDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schoolTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function rangeLength(startDate, endDate) {
  return (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`))
    / 86_400_000 + 1;
}

function getStaffType(profileType) {
  const value = String(profileType || "").toLowerCase().replace(/[\s_-]/g, "");
  if (value.includes("nonacademicstaff")) return "non_academic_staff";
  if (value === "adminuser") return "admin_user";
  if (value === "teacher") return "teacher";
  return null;
}

function fullName(record) {
  return [record.first_name, record.middle_name, record.last_name].filter(Boolean).join(" ");
}

function toStaffSnapshot(type, record) {
  return {
    staff_id: record.id,
    staff_type: type,
    staff_name: fullName(record),
    staff_identifier: record.staff_id || record.email || null,
  };
}

async function findStaff(type, id) {
  if (!STAFF_TYPES.has(type) || typeof id !== "string" || !id) return null;
  const model = type === "teacher"
    ? prisma.teacher
    : type === "admin_user"
      ? prisma.adminUser
      : prisma.nonAcademicStaff;
  const record = await model.findFirst({
    where: type === "admin_user"
      ? { OR: [{ id }, { email: id.toLowerCase() }] }
      : { OR: [{ id }, { staff_id: id }] },
  });
  return record && isActive(record) ? record : null;
}

async function resolveSelfStaff(user) {
  const profileType = getStaffType(user.profile_type);
  const roles = getRoles(user);
  const types = profileType
    ? [profileType]
    : [
        ...(roles.some((role) => ["teacher", "head_teacher", "principal"].includes(role)) ? ["teacher"] : []),
        ...(roles.includes("accountant") ? ["non_academic_staff"] : []),
      ];
  const identifiers = [...new Set([
    user.profile_id,
    user.id,
    user.staff_id,
    user.username,
    user.email,
  ].filter((value) => typeof value === "string" && value.trim()))];

  for (const type of types) {
    const model = type === "teacher"
      ? prisma.teacher
      : type === "admin_user"
        ? prisma.adminUser
        : prisma.nonAcademicStaff;
    for (const identifier of identifiers) {
      const record = await model.findFirst({
        where: type === "admin_user"
          ? {
            OR: [{ id: identifier }, { email: identifier.toLowerCase() }],
          }
          : {
          OR: [
            { id: identifier },
            { staff_id: identifier },
            ...(type === "teacher" ? [{ email: identifier.toLowerCase() }, { user_id: identifier }] : [{ email: identifier }]),
          ],
          },
      });
      if (record && isActive(record)) return { type, record };
    }
  }
  return null;
}

function hasDateRange(startDate, endDate, res) {
  if (!isDateString(startDate) || !isDateString(endDate)) {
    res.status(400).json({ error: "startDate and endDate must be valid YYYY-MM-DD dates." });
    return false;
  }
  if (startDate > endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate." });
    return false;
  }
  if (rangeLength(startDate, endDate) > MAX_RANGE_DAYS) {
    res.status(400).json({ error: `Date ranges may not exceed ${MAX_RANGE_DAYS} days.` });
    return false;
  }
  return true;
}

function addOneDay(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function findHolder(type, id) {
  const record = await findStaff(type, id);
  if (!record) {
    const error = new Error("The staff member could not be found or is inactive.");
    error.status = 404;
    throw error;
  }
  return record;
}

async function verifyAttendanceToken(qrData) {
  let payload;
  try {
    payload = jwt.verify(qrData, jwtSecret(), { algorithms: ["HS256"] });
  } catch (error) {
    const invalid = new Error(
      error.name === "TokenExpiredError" ? "The QR code has expired." : "The QR code is invalid.",
    );
    invalid.status = error.name === "TokenExpiredError" ? 410 : 400;
    throw invalid;
  }

  let type;
  let id;
  if (payload.purpose === "milton-staff-attendance") {
    type = payload.staff_type;
    id = payload.staff_id;
    const generatedAt = Date.parse(payload.generated_at);
    if (
      !STAFF_TYPES.has(type)
      || typeof id !== "string"
      || !Number.isFinite(generatedAt)
      || generatedAt > Date.now() + 5_000
      || Date.now() - generatedAt > QR_LIFETIME_SECONDS * 1_000
    ) {
      const error = new Error("The QR code is invalid or expired.");
      error.status = 400;
      throw error;
    }
  } else if (
    payload.purpose === "milton-id-card"
    && STAFF_TYPES.has(payload.person_type)
    && typeof payload.person_id === "string"
  ) {
    type = payload.person_type;
    id = payload.person_id;
  } else {
    const error = new Error("The QR code is not a valid staff attendance code.");
    error.status = 400;
    throw error;
  }

  const record = await findHolder(type, id);
  return { type, record };
}

async function registerScan(staff, markedBy, scannedAt, date) {
  const where = {
    staff_type_staff_id_date: {
      staff_type: staff.type,
      staff_id: staff.record.id,
      date,
    },
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.staffAttendance.findUnique({ where });
        if (!existing) {
          const record = await tx.staffAttendance.create({
            data: {
              ...toStaffSnapshot(staff.type, staff.record),
              date,
              time_in: scannedAt,
              marked_by: markedBy,
            },
          });
          return { record, scanType: "time_in" };
        }

        if (!existing.time_in) {
          const updated = await tx.staffAttendance.updateMany({
            where: { id: existing.id, time_in: null },
            data: { time_in: scannedAt, status: "present" },
          });
          const record = await tx.staffAttendance.findUnique({ where: { id: existing.id } });
          if (updated.count) return { record, scanType: "time_in" };
          if (record.time_out) return { record, scanType: "duplicate" };
        } else if (!existing.time_out) {
          const updated = await tx.staffAttendance.updateMany({
            where: { id: existing.id, time_out: null },
            data: { time_out: scannedAt },
          });
          const record = await tx.staffAttendance.findUnique({ where: { id: existing.id } });
          if (updated.count) return { record, scanType: "time_out" };
          if (record.time_out) return { record, scanType: "duplicate" };
        } else {
          return { record: existing, scanType: "duplicate" };
        }

        return { record: await tx.staffAttendance.findUnique({ where: { id: existing.id } }), scanType: "duplicate" };
      });
    } catch (error) {
      if ((error.code === "P2002" || error.code === "P2034") && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("Could not register the attendance scan.");
}

router.get("/qr", async (req, res) => {
  try {
    const staff = await resolveSelfStaff(req.user);
    if (!staff) return res.status(403).json({ error: "Only authenticated staff can generate an attendance QR code." });
    const generatedAt = new Date();
    const qrData = jwt.sign({
      purpose: "milton-staff-attendance",
      staff_type: staff.type,
      staff_id: staff.record.id,
      staff_name: fullName(staff.record),
      staff_identifier: staff.record.staff_id || staff.record.email || null,
      generated_at: generatedAt.toISOString(),
    }, jwtSecret(), { algorithm: "HS256", expiresIn: QR_LIFETIME_SECONDS });
    return res.json({
      qrData,
      staffName: fullName(staff.record),
      staffId: staff.record.staff_id || staff.record.email || staff.record.id,
      generatedAt: generatedAt.toISOString(),
    });
  } catch (error) {
    console.error("[GET /api/staff-attendance/qr]", error);
    return res.status(500).json({ error: "Could not generate an attendance QR code." });
  }
});

router.post("/scan", async (req, res) => {
  if (!hasRole(req.user, SCANNER_ROLES)) {
    return res.status(403).json({ error: "Only administrators, accountants, and principals can scan attendance codes." });
  }
  const qrData = req.body?.qrData;
  if (typeof qrData !== "string" || !qrData.trim() || qrData.length > 8_192) {
    return res.status(400).json({ error: "qrData must contain a valid staff QR code." });
  }

  try {
    const staff = await verifyAttendanceToken(qrData.trim());
    const scannedAt = new Date();
    const result = await registerScan(
      staff,
      req.user.profile_id || req.user.id || req.user.email || null,
      scannedAt,
      schoolDate(scannedAt),
    );
    return res.json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error("[POST /api/staff-attendance/scan]", error);
    return res.status(500).json({ error: "Could not register the attendance scan." });
  }
});

router.get("/records", async (req, res) => {
  const { startDate, endDate, staffId } = req.query;
  if (!hasDateRange(startDate, endDate, res)) return;

  try {
    let target;
    if (hasRole(req.user, STAFF_REPORT_ROLES)) {
      if (staffId) {
        if (typeof staffId !== "string" || staffId.length > 200) {
          return res.status(400).json({ error: "staffId is invalid." });
        }
        const matches = (await Promise.all([
          findStaff("teacher", staffId).then((record) => record && ({ type: "teacher", record })),
          findStaff("non_academic_staff", staffId).then((record) => record && ({ type: "non_academic_staff", record })),
        ])).filter(Boolean);
        if (matches.length > 1) return res.status(400).json({ error: "staffId is ambiguous; use the staff record ID." });
        if (!matches.length) return res.status(404).json({ error: "Staff member not found." });
        target = matches[0];
      }
    } else {
      const self = await resolveSelfStaff(req.user);
      if (!self) return res.status(403).json({ error: "Staff attendance is available only to staff and authorized administrators." });
      if (staffId && staffId !== self.record.id && staffId !== self.record.staff_id) {
        return res.status(403).json({ error: "You may only view your own attendance records." });
      }
      target = self;
    }

    const records = await prisma.staffAttendance.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        ...(target ? { staff_type: target.type, staff_id: target.record.id } : {}),
      },
      orderBy: [{ date: "desc" }, { staff_name: "asc" }],
    });
    return res.json({ records });
  } catch (error) {
    console.error("[GET /api/staff-attendance/records]", error);
    return res.status(500).json({ error: "Could not load staff attendance records." });
  }
});

router.get("/requests", async (req, res) => {
  try {
    let where = {};
    if (!hasRole(req.user, SCANNER_ROLES)) {
      const self = await resolveSelfStaff(req.user);
      if (!self) return res.status(403).json({ error: "Only staff and authorized administrators can view requests." });
      where = { staff_type: self.type, staff_id: self.record.id };
    }
    const requests = await prisma.staffAttendanceRequest.findMany({
      where,
      orderBy: [{ created_date: "desc" }, { start_date: "asc" }],
    });
    return res.json({ requests });
  } catch (error) {
    console.error("[GET /api/staff-attendance/requests]", error);
    return res.status(500).json({ error: "Could not load staff attendance requests." });
  }
});

router.post("/requests", async (req, res) => {
  const { startDate, endDate, reason } = req.body || {};
  if (!hasDateRange(startDate, endDate, res)) return;
  if (startDate <= schoolDate()) {
    return res.status(400).json({ error: "Permission requests must be for future dates in the school timezone." });
  }
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 1_000) {
    return res.status(400).json({ error: "reason is required and must be at most 1000 characters." });
  }

  try {
    const staff = await resolveSelfStaff(req.user);
    if (!staff) return res.status(403).json({ error: "Only staff can submit attendance permission requests." });
    const request = await prisma.staffAttendanceRequest.create({
      data: {
        ...toStaffSnapshot(staff.type, staff.record),
        start_date: startDate,
        end_date: endDate,
        reason: reason.trim(),
      },
    });
    return res.status(201).json({ request });
  } catch (error) {
    console.error("[POST /api/staff-attendance/requests]", error);
    return res.status(500).json({ error: "Could not submit the attendance permission request." });
  }
});

router.patch("/requests/:id", async (req, res) => {
  if (!hasRole(req.user, SCANNER_ROLES)) {
    return res.status(403).json({ error: "Only administrators, accountants, and principals can review requests." });
  }
  const { status } = req.body || {};
  if (!["approved", "declined"].includes(status)) {
    return res.status(400).json({ error: "status must be 'approved' or 'declined'." });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.staffAttendanceRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) return { error: "Permission request not found.", statusCode: 404 };
      if (existing.status !== "pending") {
        return { error: "This permission request has already been reviewed.", statusCode: 409 };
      }
      const reviewedAt = new Date();
      const changed = await tx.staffAttendanceRequest.updateMany({
        where: { id: existing.id, status: "pending" },
        data: {
          status,
          reviewed_by: req.user.profile_id || req.user.id || req.user.email || null,
          reviewed_at: reviewedAt,
        },
      });
      if (!changed.count) return { error: "This permission request has already been reviewed.", statusCode: 409 };

      if (status === "approved") {
        for (let date = existing.start_date; date <= existing.end_date; date = addOneDay(date)) {
          const key = {
            staff_type_staff_id_date: {
              staff_type: existing.staff_type,
              staff_id: existing.staff_id,
              date,
            },
          };
          await tx.staffAttendance.upsert({
            where: key,
            create: {
              staff_id: existing.staff_id,
              staff_type: existing.staff_type,
              staff_name: existing.staff_name,
              staff_identifier: existing.staff_identifier,
              date,
              status: "excused",
              marked_by: req.user.profile_id || req.user.id || req.user.email || null,
            },
            update: {},
          });
        }
      }
      const request = await tx.staffAttendanceRequest.findUnique({ where: { id: existing.id } });
      return { request };
    });
    if (result.error) return res.status(result.statusCode).json({ error: result.error });
    return res.json({ request: result.request });
  } catch (error) {
    if (error.code === "P2034" || error.code === "P2002") {
      return res.status(409).json({ error: "The request was updated concurrently. Refresh and try again." });
    }
    console.error("[PATCH /api/staff-attendance/requests/:id]", error);
    return res.status(500).json({ error: "Could not review the attendance request." });
  }
});

export default router;
