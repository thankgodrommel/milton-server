import { Router } from "express";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "milton_college_dev_secret";
const CARD_LIFETIME_YEARS = 3;
const CARD_TYPES = new Set(["student", "teacher", "non_academic_staff"]);

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function addYears(date, years) {
  const expiry = new Date(date);
  const day = expiry.getUTCDate();
  expiry.setUTCDate(1);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + years);
  const lastDayOfMonth = new Date(
    Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0),
  ).getUTCDate();
  expiry.setUTCDate(Math.min(day, lastDayOfMonth));
  return expiry;
}

function recordIsInactive(record) {
  return ["inactive", "withdrawn", "archived", "suspended"].includes(
    String(record.status || "").toLowerCase(),
  );
}

async function findCardHolder(type, id) {
  if (type === "student") {
    return prisma.student.findFirst({
      where: { OR: [{ id }, { admission_number: id }] },
    });
  }
  if (type === "teacher") {
    return prisma.teacher.findFirst({
      where: { OR: [{ id }, { staff_id: id }] },
    });
  }
  if (type === "non_academic_staff") {
    return prisma.nonAcademicStaff.findFirst({
      where: { OR: [{ id }, { staff_id: id }] },
    });
  }
  return null;
}

function formatCardHolder(type, record) {
  const fullName = [record.first_name, record.middle_name, record.last_name]
    .filter(Boolean)
    .join(" ");
  const isStudent = type === "student";
  const id = isStudent
    ? record.admission_number || record.id
    : record.staff_id || record.id;

  return {
    id: record.id,
    person_type: type,
    name: fullName,
    display_id: id,
    photo: record.passport_photo || null,
    class_name: isStudent ? record.current_class : record.assigned_class || null,
    section: record.section || null,
    date_of_birth: isStudent ? record.date_of_birth || null : null,
    state_of_origin: isStudent
      ? [record.state_of_origin, record.local_government].filter(Boolean).join(" / ")
      : null,
    house: isStudent ? record.sport_house || null : null,
    date_employed: isStudent ? null : record.date_employed || null,
    designation: isStudent
      ? null
      : record.teacher_type || record.role || "Staff",
  };
}

function invalidCardResponse(res, error, failureMessage = "Unable to verify the ID card.") {
  if (error?.name === "TokenExpiredError") {
    return res.status(410).json({ error: "This ID card has expired.", expired: true });
  }
  if (
    error?.name === "JsonWebTokenError" ||
    error?.name === "NotBeforeError" ||
    error?.code === "INVALID_CARD_TOKEN"
  ) {
    return res.status(400).json({ error: "The ID card QR code is invalid." });
  }
  console.error("[ID Card Verification]", error);
  return res.status(500).json({ error: failureMessage });
}

async function verifyCardToken(token) {
  const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  if (
    payload.purpose !== "milton-id-card" ||
    !CARD_TYPES.has(payload.person_type) ||
    typeof payload.person_id !== "string"
  ) {
    const error = new Error("Invalid ID card token.");
    error.code = "INVALID_CARD_TOKEN";
    throw error;
  }
  const record = await findCardHolder(payload.person_type, payload.person_id);
  if (!record || recordIsInactive(record)) {
    const error = new Error("ID card holder is unavailable.");
    error.status = 404;
    throw error;
  }
  return { payload, record, holder: formatCardHolder(payload.person_type, record) };
}

router.post("/issue", authenticate, authorize("admin", "accountant"), async (req, res) => {
  const { person_type: personType, person_id: personId } = req.body || {};
  if (!CARD_TYPES.has(personType) || typeof personId !== "string" || !personId.trim()) {
    return res.status(400).json({ error: "A valid staff/student type and ID are required." });
  }

  try {
    const record = await findCardHolder(personType, personId.trim());
    if (!record || recordIsInactive(record)) {
      return res.status(404).json({ error: "No active record was found for this ID." });
    }

    const issuedAt = new Date();
    const expiresAt = addYears(issuedAt, CARD_LIFETIME_YEARS);
    const token = jwt.sign(
      {
        purpose: "milton-id-card",
        person_type: personType,
        person_id: record.id,
        issued_at: issuedAt.toISOString(),
        exp: Math.floor(expiresAt.getTime() / 1000),
      },
      JWT_SECRET,
      { algorithm: "HS256", noTimestamp: true },
    );

    return res.json({
      token,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      holder: formatCardHolder(personType, record),
    });
  } catch (error) {
    console.error("[POST /id-cards/issue]", error);
    return res.status(500).json({ error: "Failed to generate the ID card." });
  }
});

router.get("/verify", async (req, res) => {
  if (typeof req.query.token !== "string" || !req.query.token) {
    return res.status(400).json({ error: "An ID card token is required." });
  }
  try {
    const { payload, holder } = await verifyCardToken(req.query.token);
    return res.json({
      valid: true,
      holder: {
        person_type: holder.person_type,
        name: holder.name,
        display_id: holder.display_id,
        class_name: holder.class_name,
        designation: holder.designation,
      },
      issued_at: payload.issued_at,
      expires_at: new Date(payload.exp * 1000).toISOString(),
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    return invalidCardResponse(res, error);
  }
});

router.post("/attendance", async (req, res) => {
  const token = req.body?.token;
  if (typeof token !== "string" || !token) {
    return res.status(400).json({ error: "An ID card token is required." });
  }

  try {
    const { payload, holder, record } = await verifyCardToken(token);
    const attendanceDate = new Date().toISOString().slice(0, 10);
    const attendanceClass =
      payload.person_type === "student" ? record.current_class : "Staff";
    const existing = await prisma.attendance.findFirst({
      where: {
        student_id: record.id,
        class: attendanceClass,
        date: attendanceDate,
      },
      select: { id: true },
    });
    if (existing) {
      return res.json({
        registered: true,
        already_registered: true,
        date: attendanceDate,
        name: holder.name,
      });
    }

    await prisma.attendance.create({
      data: {
        student_id: record.id,
        student_name: holder.name,
        admission_number:
          payload.person_type === "student"
            ? record.admission_number || holder.display_id
            : holder.display_id,
        class: attendanceClass,
        section: record.section || null,
        date: attendanceDate,
        status: "Present",
        marked_by: "ID Card QR",
      },
    });

    return res.json({
      registered: true,
      already_registered: false,
      date: attendanceDate,
      name: holder.name,
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    return invalidCardResponse(res, error, "Unable to register attendance.");
  }
});

export default router;
