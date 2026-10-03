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

function sanitizeExamForStudent(record, req, model) {
  if (model !== "CBTExam") return record;
  const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
    .map((role) => String(role || "").toLowerCase());
  if (!roles.includes("student")) return record;
  if (record.status !== "Published") return null;
  const safeExam = { ...record };
  delete safeExam.questions;
  delete safeExam.exam_password;
  return safeExam;
}

function isStaffUser(req) {
  return [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
    .some((role) => ["admin", "teacher", "head_teacher", "principal", "director"].includes(String(role || "").toLowerCase()));
}

function isStudentUser(req) {
  return [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
    .some((role) => String(role || "").toLowerCase() === "student");
}

function isFeePaymentModel(model) {
  return model === "SchoolFeePayment" || model === "FeePayment";
}

async function getStudentFeePaymentScope(req) {
  const admissionNumber = req.user?.admission_number || req.user?.username;
  if (admissionNumber) {
    const student = await prisma.student.findUnique({
      where: { admission_number: admissionNumber },
    });
    if (student) return student;
  }

  const studentId = req.user?.profile_id || req.user?.id;
  if (!studentId) return null;

  return prisma.student.findUnique({ where: { id: studentId } });
}

async function validateAssignmentSubmissionAccess(req, assignment, existingSubmission = null) {
  if (isStaffUser(req)) return null;
  const studentId = req.user?.profile_id || req.user?.id;
  if (!studentId || (existingSubmission && existingSubmission.student_id !== studentId)) {
    return { status: 403, error: "You can only submit your own assignment." };
  }
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student || student.current_class !== assignment.class) {
    return { status: 403, error: "This assignment is not assigned to your class." };
  }
  if (existingSubmission?.status === "Graded") {
    return { status: 403, error: "This assignment has already been graded." };
  }
  if (Array.isArray(assignment.reopened_student_ids) && !assignment.reopened_student_ids.includes(studentId)) {
    return { status: 403, error: "This assignment extension is only available to students who have not submitted." };
  }
  if (assignment.due_date) {
    const dueDate = new Date(assignment.due_date.includes("T") ? assignment.due_date : `${assignment.due_date}T23:59:59`);
    if (Number.isFinite(dueDate.getTime()) && new Date() > dueDate) {
      return { status: 400, error: "The deadline for this assignment has expired. Submissions are closed." };
    }
  }
  return null;
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
      return res.json(toUIEnums(records).filter((record) => sanitizeExamForStudent(record, req, model)));
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
      if (isStudentUser(req) && isFeePaymentModel(model)) {
        const student = await getStudentFeePaymentScope(req);
        if (!student) return res.status(403).json({ error: "Student profile not found." });

        const studentPaymentLinks = [{ student_id: student.id }];
        if (student.admission_number) {
          studentPaymentLinks.push(
            { admission_number: student.admission_number },
            { student_id: student.admission_number },
          );
        }

        delete where.admission_number;
        delete where.student_id;
        where.OR = studentPaymentLinks;
      }
      const orderBy = parseSort(req.query._sort);
      const take = req.query._limit ? parseInt(req.query._limit) : undefined;

      const records = await db.findMany({ where, orderBy, take });
      return res.json(toUIEnums(records).filter((record) => sanitizeExamForStudent(record, req, model)));
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
      if (isStudentUser(req) && isFeePaymentModel(model)) {
        const student = await getStudentFeePaymentScope(req);
        if (!student) return res.status(403).json({ error: "Student profile not found." });
        const ownsPayment = record.student_id === student.id ||
          (student.admission_number &&
            (record.admission_number === student.admission_number ||
              record.student_id === student.admission_number));
        if (!ownsPayment) return res.status(404).json({ error: "Record not found." });
      }
      const visibleRecord = sanitizeExamForStudent(toUIEnums(record), req, model);
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

      if (model === "CBTExam" && rawData.status === "Published") {
        return res.status(400).json({ error: "Publish exams through the PIN-validated publish endpoint." });
      }

      if (
        model === "CBTResult" &&
        [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
          .some((role) => String(role || "").toLowerCase() === "student")
      ) {
        return res.status(400).json({ error: "CBT results must be submitted using the student's exam PIN." });
      }

      if (model === "AssignmentSubmission") {
        const assignmentId = rawData.assignment_id;
        if (!isStaffUser(req) && assignmentId) {
          const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
          if (!assignment) return res.status(404).json({ error: "Assignment not found." });
          const accessError = await validateAssignmentSubmissionAccess(req, assignment);
          if (accessError) return res.status(accessError.status).json({ error: accessError.error });
          const existingSubmission = await prisma.assignmentSubmission.findFirst({
            where: { assignment_id: assignmentId, student_id: req.user?.profile_id || req.user?.id },
          });
          if (existingSubmission) {
            return res.status(409).json({ error: "A submission already exists. Update your existing submission instead." });
          }
          const studentId = req.user?.profile_id || req.user?.id;
          const student = await prisma.student.findUnique({ where: { id: studentId } });
          if (rawData.student_id && rawData.student_id !== studentId) {
            return res.status(403).json({ error: "You can only submit your own assignment." });
          }
          rawData.student_id = studentId;
          rawData.student_name = `${student.first_name} ${student.last_name}`.trim();
          rawData.admission_number = student.admission_number;
          rawData.class = student.current_class;
          rawData.assignment_title = assignment.title;
          rawData.total_marks = assignment.total_marks || assignment.max_score || 10;
          rawData.status = "Submitted";
          delete rawData.score;
          delete rawData.feedback;
          delete rawData.teacher_feedback;
          delete rawData.graded_by;
          delete rawData.graded_date;
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

      if (model === "Assignment") {
        const existingAssignment = await prisma.assignment.findUnique({ where: { id } });
        if (existingAssignment) {
          const currentDueDate = existingAssignment.due_date
            ? new Date(existingAssignment.due_date.includes("T") ? existingAssignment.due_date : `${existingAssignment.due_date}T23:59:59`)
            : null;
          const isOverdue = currentDueDate && Number.isFinite(currentDueDate.getTime()) && currentDueDate < new Date();
          const canReopen = isOverdue || existingAssignment.status === "Closed";
          const dueDateChanged = rawData.due_date !== undefined && rawData.due_date !== existingAssignment.due_date;
          const allowlistChanged = rawData.reopened_student_ids !== undefined &&
            JSON.stringify(rawData.reopened_student_ids) !== JSON.stringify(existingAssignment.reopened_student_ids);

          if (allowlistChanged && !canReopen) {
            return res.status(400).json({ error: "Reopen an overdue assignment through the incomplete-student flow." });
          }
          if (canReopen && (dueDateChanged || allowlistChanged)) {
            if (!rawData.due_date) {
              return res.status(400).json({ error: "Set a new due date when reopening an assignment." });
            }
            const newDueDate = new Date(rawData.due_date.includes("T") ? rawData.due_date : `${rawData.due_date}T23:59:59`);
            if (!Number.isFinite(newDueDate.getTime()) || newDueDate <= new Date()) {
              return res.status(400).json({ error: "Choose a future due date to reopen this assignment." });
            }
            if (!Array.isArray(rawData.reopened_student_ids)) {
              return res.status(400).json({ error: "Select only active students who have not submitted before extending the due date." });
            }
            const [students, existingSubmissions] = await Promise.all([
              prisma.student.findMany({
                where: { current_class: existingAssignment.class, status: "Active" },
                select: { id: true },
              }),
              prisma.assignmentSubmission.findMany({
                where: { assignment_id: id },
                select: { student_id: true },
              }),
            ]);
            const submittedIds = new Set(existingSubmissions.map(({ student_id }) => student_id));
            const eligibleIds = new Set(students.filter(({ id: studentId }) => !submittedIds.has(studentId)).map(({ id: studentId }) => studentId));
            const requestedIds = new Set(rawData.reopened_student_ids);
            if (
              requestedIds.size !== rawData.reopened_student_ids.length ||
              requestedIds.size !== eligibleIds.size ||
              [...requestedIds].some((studentId) => !eligibleIds.has(studentId))
            ) {
              return res.status(400).json({ error: "The reopen list must contain exactly the active students who have not submitted." });
            }
          }
        }
      }

      if (model === "CBTExam") {
        const existingExam = await prisma.cBTExam.findUnique({ where: { id } });
        if (rawData.status === "Published" && existingExam?.status !== "Published") {
          return res.status(400).json({ error: "Publish exams through the PIN-validated publish endpoint." });
        }
        if (existingExam?.status === "Published") {
          const currentEndTime = existingExam.end_date ? new Date(existingExam.end_date) : null;
          const isExpired = currentEndTime && Number.isFinite(currentEndTime.getTime()) && currentEndTime < new Date();
          const changesExamAttempt = [
            "exam_type", "subject_id", "classes", "questions", "duration_minutes",
            "start_date", "end_date", "batch_count", "students_per_batch", "batch_settings",
          ].some((field) => rawData[field] !== undefined);
          if (changesExamAttempt) {
            const [startedAttempts, results] = await Promise.all([
              prisma.cBTExamPassword.count({
                where: { exam_id: id, OR: [{ started_at: { not: null } }, { used: true }] },
              }),
              prisma.cBTResult.count({ where: { exam_id: id } }),
            ]);
            if ((startedAttempts > 0 || results > 0) && !isExpired) {
              return res.status(409).json({ error: "Exam settings cannot be changed after a student has started." });
            }
          }
          if (rawData.status === "Published") delete rawData.status;
        }
      }

      if (model === "Student" && req.user?.role === "student") {
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
        if (!isStaffUser(req)) {
          const existingSub = await prisma.assignmentSubmission.findUnique({ where: { id } });
          if (!existingSub) return res.status(404).json({ error: "Submission not found." });
          if (existingSub.student_id !== (req.user?.profile_id || req.user?.id)) {
            return res.status(403).json({ error: "You can only update your own submission." });
          }
          if (rawData.assignment_id && rawData.assignment_id !== existingSub.assignment_id) {
            return res.status(403).json({ error: "A submission cannot be moved to another assignment." });
          }
          const assignmentId = existingSub.assignment_id;
          if (!assignmentId) return res.status(404).json({ error: "Assignment not found." });
          const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
          if (!assignment) return res.status(404).json({ error: "Assignment not found." });
          const accessError = await validateAssignmentSubmissionAccess(req, assignment, existingSub);
          if (accessError) return res.status(accessError.status).json({ error: accessError.error });
          const allowedStudentFields = new Set(["file_url", "submission_text", "text_response", "submitted_at", "submitted_date"]);
          for (const field of Object.keys(rawData)) {
            if (!allowedStudentFields.has(field)) delete rawData[field];
          }
          rawData.status = "Submitted";
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
