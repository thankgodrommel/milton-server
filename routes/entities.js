import { Router } from "express";
import prisma from "../config/prisma.js";
import {
  authenticate,
  authenticateOptional,
  authorize,
} from "../middleware/auth.js";
import { getRequiredRoles } from "../utils/roleGuard.js";
import { toUIEnums, toPrismaEnums } from "../utils/enumMapper.js";
import { sanitizeAndCoerce } from "../utils/payloadSanitizer.js";
import { sendEmail } from "../services/email.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Map model name (string) → Prisma delegate
// ─────────────────────────────────────────────────────────────────────────────
const MODEL_MAP = {
  Student: () => prisma.student,
  Teacher: () => prisma.teacher,
  Parent: () => prisma.parent,
  ParentStudent: () => prisma.parentStudent,
  Subject: () => prisma.subject,
  StaffRole: () => prisma.staffRole,
  Result: () => prisma.result,
  ReportCard: () => prisma.reportCard,
  ResultToken: () => prisma.resultToken,
  Attendance: () => prisma.attendance,
  Assignment: () => prisma.assignment,
  AssignmentSubmission: () => prisma.assignmentSubmission,
  CBTExam: () => prisma.cBTExam,
  CBTResult: () => prisma.cBTResult,
  CBTExamPassword: () => prisma.cBTExamPassword,
  CBTMalpractice: () => prisma.cBTMalpractice,
  SchoolFeePayment: () => prisma.schoolFeePayment,
  FeePayment: () => prisma.schoolFeePayment,
  SalaryPayment: () => prisma.salaryPayment,
  Expense: () => prisma.expense,
  SchoolSettings: () => prisma.schoolSettings,
  AdmissionApplication: () => prisma.admissionApplication,
  ArchivedStudent: () => prisma.archivedStudent,
  Timetable: () => prisma.timetable,
  LessonNote: () => prisma.lessonNote,
  Newsletter: () => prisma.newsletter,
  Gallery: () => prisma.gallery,
  Calendar: () => prisma.calendar,
  Holiday: () => prisma.holiday,
  Message: () => prisma.message,
  Award: () => prisma.award,
  Discipline: () => prisma.discipline,
  Rating: () => prisma.rating,
  NonAcademicStaff: () => prisma.nonAcademicStaff,
  SchoolProject: () => prisma.schoolProject,
  DirectorNotification: () => prisma.directorNotification,
  ChatMessage: () => prisma.chatMessage,
  ChatPresence: () => prisma.chatPresence,
  Meeting: () => prisma.meeting,
  AdminUser: () => prisma.adminUser,
  User: () => prisma.user,
  PublicMessage: () => prisma.publicMessage,
  SchoolClass: () => prisma.schoolClass,
  Class: () => prisma.schoolClass,
  PTAMeeting: () => prisma.pTAMeeting,
};

function resolveModel(modelName) {
  const factory = MODEL_MAP[modelName];
  if (!factory) return null;
  return factory();
}

function buildAuthChain(modelName, operation) {
  const roles = getRequiredRoles(modelName, operation);
  if (roles === null) {
    return [authenticateOptional];
  }
  if (roles.length === 0) {
    return [authenticate];
  }
  return [authenticate, authorize(...roles)];
}

function parseSort(sortStr) {
  if (!sortStr) return { created_date: "desc" };
  const desc = sortStr.startsWith("-");
  const field = desc ? sortStr.slice(1) : sortStr;
  // Keep field as-is (already in snake_case from client)
  return { [field]: desc ? "desc" : "asc" };
}

function buildWhere(query) {
  const where = {};
  const skip = ["_sort", "_limit", "_skip"];
  for (const [key, val] of Object.entries(query)) {
    if (skip.includes(key)) continue;
    // Convert camelCase (e.g. staffId) to snake_case (e.g. staff_id) to match Prisma schema
    const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    where[snakeKey] = val;
  }
  return where;
}

function hideCaTestFromStudent(record, req) {
  const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
    .map((role) => String(role || "").toLowerCase());
  return roles.includes("student") && record.exam_type === "C.A.Test" ? null : record;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/entities/:model — list all
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/:model",
  (req, res, next) => {
    const { model } = req.params;
    const chain = buildAuthChain(model, "list");
    let i = 0;
    const runNext = () => {
      if (i < chain.length) chain[i++](req, res, runNext);
      else next();
    };
    runNext();
  },
  async (req, res) => {
    const { model } = req.params;
    const db = resolveModel(model);
    if (!db) return res.status(404).json({ error: `Unknown entity: ${model}` });

    try {
      const orderBy = parseSort(req.query._sort);
      const take = req.query._limit ? parseInt(req.query._limit) : undefined;

      const records = await db.findMany({ orderBy, take });
      return res.json(toUIEnums(records).filter((record) => hideCaTestFromStudent(record, req)));
    } catch (err) {
      console.error(`[GET /${model}]`, err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/entities/:model/filter — filter by query params
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/:model/filter",
  (req, res, next) => {
    const { model } = req.params;
    const chain = buildAuthChain(model, "filter");
    let i = 0;
    const runNext = () => {
      if (i < chain.length) chain[i++](req, res, runNext);
      else next();
    };
    runNext();
  },
  async (req, res) => {
    const { model } = req.params;
    const db = resolveModel(model);
    if (!db) return res.status(404).json({ error: `Unknown entity: ${model}` });

    try {
      const rawWhere = buildWhere(req.query);
      const where = toPrismaEnums(rawWhere);
      const orderBy = parseSort(req.query._sort);
      const take = req.query._limit ? parseInt(req.query._limit) : undefined;

      const records = await db.findMany({ where, orderBy, take });
      return res.json(toUIEnums(records).filter((record) => hideCaTestFromStudent(record, req)));
    } catch (err) {
      console.error(`[GET /${model}/filter]`, err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/entities/:model/:id — get single record
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/:model/:id",
  (req, res, next) => {
    const { model } = req.params;
    const chain = buildAuthChain(model, "get");
    let i = 0;
    const runNext = () => {
      if (i < chain.length) chain[i++](req, res, runNext);
      else next();
    };
    runNext();
  },
  async (req, res) => {
    const { model } = req.params;
    const db = resolveModel(model);
    if (!db) return res.status(404).json({ error: `Unknown entity: ${model}` });

    try {
      const record = await db.findUnique({ where: { id: req.params.id } });
      if (!record) return res.status(404).json({ error: "Record not found." });
      const visibleRecord = hideCaTestFromStudent(toUIEnums(record), req);
      if (!visibleRecord) return res.status(404).json({ error: "Record not found." });
      return res.json(visibleRecord);
    } catch (err) {
      console.error(`[GET /${model}/:id]`, err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/entities/:model — create record
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:model",
  (req, res, next) => {
    const { model } = req.params;
    const chain = buildAuthChain(model, "create");
    let i = 0;
    const runNext = () => {
      if (i < chain.length) chain[i++](req, res, runNext);
      else next();
    };
    runNext();
  },
  async (req, res) => {
    const { model } = req.params;
    const db = resolveModel(model);
    if (!db) return res.status(404).json({ error: `Unknown entity: ${model}` });

    try {
      const {
        id,
        createdDate,
        updatedDate,
        created_date,
        updated_date,
        ...rawData
      } = req.body;

      if (model === "AdmissionApplication" && req.user) {
        rawData.created_by_id = req.user.id;
      }

      if (model === "CBTExam" && rawData.exam_type === "C.A.Test" && rawData.status === "Published") {
        return res.status(400).json({ error: "Generate C.A.Test student PINs before publishing." });
      }

      if (model === "CBTResult" && rawData.exam_id) {
        const exam = await prisma.cBTExam.findUnique({ where: { id: rawData.exam_id } });
        if (exam?.exam_type === "C.A.Test") {
          return res.status(400).json({ error: "C.A.Test results must be submitted with the student's test PIN." });
        }
      }

      if (model === "AssignmentSubmission") {
        const assignmentId = rawData.assignment_id;
        if (assignmentId) {
          const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
          if (assignment && assignment.due_date) {
            const dueDate = new Date(assignment.due_date.includes("T") ? assignment.due_date : assignment.due_date + "T23:59:59");
            if (new Date() > dueDate) {
              const userRoles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])].map(r => (r || '').toLowerCase());
              const isStaff = ["admin", "teacher", "head_teacher", "principal", "director"].some(r => userRoles.includes(r));
              if (!isStaff) {
                return res.status(400).json({ error: "The deadline for this assignment has expired. Submissions are closed." });
              }
            }
          }
        }
      }

      const prismaData = sanitizeAndCoerce(model, rawData);
      const record = await db.create({ data: prismaData });
      return res.status(201).json(toUIEnums(record));
    } catch (err) {
      console.error(`[POST /${model}]`, err);
      return res.status(400).json({ error: err.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/entities/:model/:id — update record
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  "/:model/:id",
  (req, res, next) => {
    const { model } = req.params;
    const chain = buildAuthChain(model, "update");
    let i = 0;
    const runNext = () => {
      if (i < chain.length) chain[i++](req, res, runNext);
      else next();
    };
    runNext();
  },
  async (req, res) => {
    const { model, id } = req.params;
    const db = resolveModel(model);
    if (!db) return res.status(404).json({ error: `Unknown entity: ${model}` });

    try {
      const {
        id: _id,
        createdDate,
        updatedDate,
        created_date,
        updated_date,
        ...rawData
      } = req.body;

      if (model === "Student" && req.user?.role === "student") {

              if (model === "CBTExam" && rawData.status === "Published") {
                const existingExam = await prisma.cBTExam.findUnique({ where: { id } });
                if ((rawData.exam_type || existingExam?.exam_type) === "C.A.Test") {
                  return res.status(400).json({ error: "Publish C.A.Tests through the PIN-validated publish endpoint." });
                }
              }
        const studentId = req.user.id || req.user.profile_id;
        if (studentId !== id) {
          return res.status(403).json({ error: "You can only update your own student profile." });
        }
        const allowedFields = ["passport_photo"];
        for (const key of Object.keys(rawData)) {
          if (!allowedFields.includes(key)) {
            delete rawData[key];
          }
        }
      }

      if (model === "AssignmentSubmission") {
        const userRoles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])].map(r => (r || '').toLowerCase());
        const isStaff = ["admin", "teacher", "head_teacher", "principal", "director"].some(r => userRoles.includes(r));
        if (!isStaff) {
          const existingSub = await prisma.assignmentSubmission.findUnique({ where: { id } });
          const assignmentId = rawData.assignment_id || existingSub?.assignment_id;
          if (assignmentId) {
            const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
            if (assignment && assignment.due_date) {
              const dueDate = new Date(assignment.due_date.includes("T") ? assignment.due_date : assignment.due_date + "T23:59:59");
              if (new Date() > dueDate) {
                return res.status(400).json({ error: "The deadline for this assignment has expired. Submissions are closed." });
              }
            }
          }
        }
      }

      const prismaData = sanitizeAndCoerce(model, rawData);

      // Workflow: AdmissionApplication → "Offered Admission"
      if (
        model === "AdmissionApplication" &&
        (prismaData.status === "Offered_Admission" ||
          rawData.status === "Offered Admission")
      ) {
        const oldApp = await prisma.admissionApplication.findUnique({
          where: { id },
        });
        if (oldApp && oldApp.status !== "Offered_Admission") {
          try {
            await triggerSendAdmissionOfferEmail(id, req);
          } catch (emailErr) {
            console.error(
              "[Workflow] sendAdmissionOfferEmail failed:",
              emailErr.message,
            );
          }
        }
      }

      const record = await db.update({ where: { id }, data: prismaData });
      return res.json(toUIEnums(record));
    } catch (err) {
      if (err.code === "P2025") {
        return res.status(404).json({ error: "Record not found." });
      }
      console.error(`[PATCH /${model}/:id]`, err);
      return res.status(400).json({ error: err.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/entities/:model/:id — delete record
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  "/:model/:id",
  (req, res, next) => {
    const { model } = req.params;
    const chain = buildAuthChain(model, "delete");
    let i = 0;
    const runNext = () => {
      if (i < chain.length) chain[i++](req, res, runNext);
      else next();
    };
    runNext();
  },
  async (req, res) => {
    const { model, id } = req.params;
    const db = resolveModel(model);
    if (!db) return res.status(404).json({ error: `Unknown entity: ${model}` });

    try {
      await db.delete({ where: { id } });
      return res.json({ success: true, id });
    } catch (err) {
      if (err.code === "P2025") {
        return res.status(404).json({ error: "Record not found." });
      }
      console.error(`[DELETE /${model}/:id]`, err);
      return res.status(500).json({ error: err.message });
    }
  },
);

async function triggerSendAdmissionOfferEmail(applicationId, req) {
  const app = await prisma.admissionApplication.findUnique({
    where: { id: applicationId },
  });
  if (!app || !app.parent_email) return;

  const applicantName = `${app.first_name} ${app.last_name}`.trim();
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const responseUrl = `${baseUrl}/api/functions/handleAdmissionResponse`;
  const acceptLink = `${responseUrl}?app=${applicationId}&action=accept`;
  const rejectLink = `${responseUrl}?app=${applicationId}&action=reject`;

  const tuitionLine = app.tuition_fee
    ? `Tuition Fee: N${Number(app.tuition_fee).toLocaleString()}\n`
    : "";
  const resumeLine = app.resumption_date
    ? `Resumption Date: ${app.resumption_date}\n`
    : "";

  const message = `Dear ${app.parent_name},

CONGRATULATIONS!

We are pleased to inform you that ${applicantName} has been offered provisional admission into ${app.section_applying} section, Class: ${app.final_class_admitted || app.class_applying} at Milton College of Arts and Science, Kaduna.

Admission Number: ${app.admission_number_generated || "To be assigned"}
${tuitionLine}${resumeLine}
To proceed, please choose one of the options below:

ACCEPT ADMISSION:
${acceptLink}

REJECT ADMISSION:
${rejectLink}

If you accept, an acceptance letter (PDF) will be sent to your email immediately. Please print the acceptance letter and bring it to the school.

This offer is valid for 14 days. If you do not respond within this period, the offer may be withdrawn.

Warm regards,
Admissions Office
Milton College of Arts and Science, Kaduna`;

  await sendEmail({
    to: app.parent_email,
    subject: `Admission Offer — ${applicantName} | Milton College`,
    text: message,
  });
}

export default router;
