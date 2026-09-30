import { randomInt } from "node:crypto";
import { Router } from "express";
import prisma from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

function examIsOpen(exam, now = new Date(), allowStartedAttempt = false, startedAt = null) {
  if (exam.status !== "Published") return false;
  const startTime = exam.start_date ? new Date(exam.start_date) : null;
  const endTime = exam.end_date ? new Date(exam.end_date) : null;
  if (startTime && (!Number.isFinite(startTime.getTime()) || startTime > now)) return false;
  if (!endTime || !Number.isFinite(endTime.getTime())) return false;
  if (endTime < now && (!allowStartedAttempt || !startedAt || new Date(startedAt) > endTime)) return false;
  return true;
}

function publicExam(exam) {
  const safeExam = { ...exam };
  delete safeExam.exam_password;
  return {
    ...safeExam,
    questions: (Array.isArray(exam.questions) ? exam.questions : []).map(
      ({ correct_answer, ...question }) => question,
    ),
  };
}

function examClasses(exam) {
  const classes = Array.isArray(exam.classes) ? exam.classes : exam.class ? [exam.class] : [];
  return [...new Set(classes.filter((className) => typeof className === "string" && className.trim()))];
}

function activeBatchForClass(exam, className) {
  return Number(exam.active_batches?.[className]) || 1;
}

function batchSettingsForClass(exam, className) {
  const settings = exam.batch_settings?.[className] || {};
  return {
    batchCount: Math.trunc(Number(settings.batch_count) || Number(exam.batch_count) || 1),
    studentsPerBatch: Math.trunc(Number(settings.students_per_batch) || Number(exam.students_per_batch) || 40),
  };
}

async function getStudent(user) {
  if (user.profile_id) {
    const student = await prisma.student.findUnique({ where: { id: user.profile_id } });
    if (student) return student;
  }
  const admissionNumber = user.admission_number || user.username;
  return admissionNumber
    ? prisma.student.findFirst({ where: { admission_number: admissionNumber } })
    : null;
}

async function getPinAccess(user, pin, now = new Date(), allowStartedAttempt = false, expectedExamId = null) {
  const student = await getStudent(user);
  if (!student) return { error: "Student record not found.", status: 404 };
  const pinRecord = await prisma.cBTExamPassword.findFirst({
    where: {
      password: String(pin || "").trim(),
      student_id: student.id,
      used: false,
      ...(expectedExamId ? { exam_id: expectedExamId } : {}),
    },
  });
  if (!pinRecord) return { error: "Invalid or already used exam PIN.", status: 404 };

  const exam = await prisma.cBTExam.findUnique({ where: { id: pinRecord.exam_id } });
  if (!exam) return { error: "Exam not found.", status: 404 };
  if (!examIsOpen(exam, now, allowStartedAttempt, pinRecord.started_at)) {
    return { error: "This exam is not open or has expired.", status: 410 };
  }
  if (!examClasses(exam).includes(student.current_class) || pinRecord.class !== student.current_class) {
    return { error: "This exam is not assigned to your class.", status: 403 };
  }
  if (
    Number(pinRecord.batch_number || 1) !== activeBatchForClass(exam, student.current_class) &&
    !(allowStartedAttempt && pinRecord.started_at)
  ) {
    return { error: `This PIN belongs to batch ${pinRecord.batch_number || 1}. Batch ${activeBatchForClass(exam, student.current_class)} is currently taking the exam.`, status: 403 };
  }
  const existingResult = await prisma.cBTResult.findFirst({
    where: { exam_id: exam.id, student_id: student.id },
  });
  if (existingResult) return { error: "You have already taken this exam.", status: 409 };
  return { student, pinRecord, exam };
}

async function getStudentExamAccess(user, examId, pin, now = new Date(), allowStartedAttempt = false) {
  return getPinAccess(user, pin, now, allowStartedAttempt, examId);
}

router.get("/available", authorize("student"), async (req, res) => {
  try {
    const student = await getStudent(req.user);
    if (!student) return res.status(404).json({ error: "Student record not found." });
    const [exams, results, pins] = await Promise.all([
      prisma.cBTExam.findMany({ where: { status: "Published" }, orderBy: { created_date: "desc" } }),
      prisma.cBTResult.findMany({ where: { student_id: student.id }, select: { exam_id: true } }),
      prisma.cBTExamPassword.findMany({
        where: { student_id: student.id, used: false },
        select: { exam_id: true, class: true, batch_number: true },
      }),
    ]);
    const now = new Date();
    const takenIds = new Set(results.map(({ exam_id }) => exam_id));
    const available = exams.filter((exam) => {
      if (!examClasses(exam).includes(student.current_class) || takenIds.has(exam.id)) return false;
      if (!examIsOpen(exam, now)) return false;
      const pin = pins.find((record) => record.exam_id === exam.id && record.class === student.current_class);
      return pin && Number(pin.batch_number || 1) === activeBatchForClass(exam, student.current_class);
    });
    return res.json(available.map((exam) => {
      const safeExam = publicExam(exam);
      const questions = Array.isArray(exam.questions) ? exam.questions : [];
      delete safeExam.questions;
      return {
        ...safeExam,
        question_count: questions.length,
        has_theory: questions.some(({ type }) => type === "theory"),
        active_batch_number: activeBatchForClass(exam, student.current_class),
      };
    }));
  } catch (error) {
    console.error("[GET /cbt/available]", error);
    return res.status(500).json({ error: "Unable to load available CBT exams." });
  }
});

router.post("/exams/:examId/pins", authorize("admin", "teacher"), async (req, res) => {
  try {
    const exam = await prisma.cBTExam.findUnique({ where: { id: req.params.examId } });
    if (!exam) return res.status(404).json({ error: "Exam not found." });
    const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
      .map((role) => String(role || "").toLowerCase());
    if (!roles.some((role) => ["admin", "director"].includes(role)) && exam.created_by !== req.user?.email) {
      return res.status(403).json({ error: "You can only generate PINs for your own exam." });
    }
    if (!['Draft', 'Published'].includes(exam.status)) {
      return res.status(409).json({ error: "Generate student PINs before the exam is closed." });
    }
    const classes = examClasses(exam);
    if (classes.length === 0) {
      return res.status(400).json({ error: "Select at least one class before generating PINs." });
    }
    const existingResults = await prisma.cBTResult.count({ where: { exam_id: exam.id } });
    if (existingResults > 0) return res.status(409).json({ error: "PINs cannot be regenerated after students have submitted." });
    if (exam.status === "Published") {
      const existingAttempts = await prisma.cBTExamPassword.count({
        where: { exam_id: exam.id, OR: [{ started_at: { not: null } }, { used: true }] },
      });
      if (existingAttempts > 0) {
        return res.status(409).json({ error: "PINs cannot be regenerated after a student has started." });
      }
    }

    const usedPins = new Set();
    const pinRows = [];
    const batchCounts = [];
    for (const className of classes) {
      const { batchCount, studentsPerBatch } = batchSettingsForClass(exam, className);
      if (batchCount < 1 || studentsPerBatch < 1) {
        return res.status(400).json({ error: `${className}: batch count and students per batch must be at least one.` });
      }
      const students = await prisma.student.findMany({
        where: { current_class: className, status: "Active" },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
      });
      if (students.length === 0) {
        return res.status(400).json({ error: `No active students are enrolled in ${className}.` });
      }
      if (batchCount > students.length || Math.ceil(students.length / batchCount) > studentsPerBatch) {
        return res.status(400).json({
          error: `${className} has ${students.length} active students. Choose 1-${students.length} batches and a capacity of at least ${Math.ceil(students.length / Math.min(batchCount, students.length))} students per batch.`,
        });
      }
      const baseBatchSize = Math.floor(students.length / batchCount);
      const largerBatchCount = students.length % batchCount;
      let studentIndex = 0;
      for (let batchNumber = 1; batchNumber <= batchCount; batchNumber += 1) {
        const currentBatchSize = baseBatchSize + (batchNumber <= largerBatchCount ? 1 : 0);
        for (const student of students.slice(studentIndex, studentIndex + currentBatchSize)) {
          let password;
          do {
            password = String(randomInt(0, 1_000_000)).padStart(6, "0");
          } while (usedPins.has(password));
          usedPins.add(password);
          pinRows.push({
            exam_id: exam.id,
            exam_title: exam.title,
            subject_name: exam.subject_name,
            student_id: student.id,
            student_name: `${student.first_name} ${student.last_name}`.trim(),
            admission_number: student.admission_number,
            class: className,
            batch_number: batchNumber,
            password,
            generated_by: req.user?.email || req.user?.id,
            generated_date: new Date().toISOString(),
          });
        }
        batchCounts.push({ class: className, batch_number: batchNumber, student_count: currentBatchSize });
        studentIndex += currentBatchSize;
      }
    }
    const activeBatches = Object.fromEntries(classes.map((className) => [className, 1]));

    await prisma.$transaction([
      prisma.cBTExamPassword.deleteMany({ where: { exam_id: exam.id } }),
      prisma.cBTExamPassword.createMany({ data: pinRows }),
      prisma.cBTExam.update({ where: { id: exam.id }, data: { active_batches: activeBatches } }),
    ]);
    return res.status(201).json({ pins: pinRows, batches: batchCounts });
  } catch (error) {
    console.error("[POST /cbt/exams/:examId/pins]", error);
    return res.status(500).json({ error: "Unable to generate exam PINs." });
  }
});

router.post("/exams/:examId/publish", authorize("admin", "teacher"), async (req, res) => {
  try {
    const exam = await prisma.cBTExam.findUnique({ where: { id: req.params.examId } });
    if (!exam) return res.status(404).json({ error: "Exam not found." });
    const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
      .map((role) => String(role || "").toLowerCase());
    if (!roles.some((role) => ["admin", "director"].includes(role)) && exam.created_by !== req.user?.email) {
      return res.status(403).json({ error: "You can only publish your own exam." });
    }
    if (exam.status !== "Draft") return res.status(409).json({ error: "This exam is no longer a draft." });
    if (!Array.isArray(exam.questions) || exam.questions.length === 0 || Number(exam.duration_minutes) <= 0) {
      return res.status(400).json({ error: "Add questions and set a valid exam duration before publishing." });
    }
    const startTime = exam.start_date ? new Date(exam.start_date) : null;
    const endTime = exam.end_date ? new Date(exam.end_date) : null;
    if (
      !startTime || !endTime || !Number.isFinite(startTime.getTime()) || !Number.isFinite(endTime.getTime()) ||
      endTime <= startTime || endTime <= new Date()
    ) {
      return res.status(400).json({ error: "Set a valid start and future end date/time before publishing." });
    }
    if (exam.exam_type === "C.A.Test") {
      if (
        !["1st", "2nd", "3rd"].includes(exam.ca_test_number) || !exam.subject_id
      ) {
        return res.status(400).json({ error: "Select the C.A.Test number and subject before publishing." });
      }
    }
    const classes = examClasses(exam);
    if (classes.length === 0) return res.status(400).json({ error: "Select at least one class before publishing." });
    const activeBatches = {};
    for (const className of classes) {
      const { batchCount, studentsPerBatch } = batchSettingsForClass(exam, className);
      if (batchCount < 1 || studentsPerBatch < 1) {
        return res.status(400).json({ error: `${className}: set a valid batch count and batch size.` });
      }
      const students = await prisma.student.findMany({
        where: { current_class: className, status: "Active" },
        select: { id: true },
      });
      const pins = await prisma.cBTExamPassword.findMany({
        where: { exam_id: exam.id, class: className },
        select: { student_id: true, batch_number: true, password: true, used: true },
      });
      const studentIds = new Set(students.map(({ id }) => id));
      const pinStudentIds = new Set(pins.map(({ student_id }) => student_id));
      const pinCodes = new Set(pins.map(({ password }) => password));
      const pinsByBatch = new Map();
      pins.forEach((pin) => pinsByBatch.set(pin.batch_number, (pinsByBatch.get(pin.batch_number) || 0) + 1));
      const batchesValid = Array.from({ length: batchCount }, (_, index) => index + 1)
        .every((batchNumber) => pinsByBatch.has(batchNumber) && pinsByBatch.get(batchNumber) <= studentsPerBatch);
      if (
        students.length === 0 || pins.length !== students.length || pins.some(({ used }) => used) || pinCodes.size !== pins.length ||
        pinStudentIds.size !== students.length || students.some(({ id }) => !pinStudentIds.has(id)) || !batchesValid
      ) {
        return res.status(400).json({ error: `Generate unique PINs for every active student in ${className} before publishing.` });
      }
      activeBatches[className] = 1;
    }
    const publishedExam = await prisma.cBTExam.update({
      where: { id: exam.id },
      data: { status: "Published", active_batches: activeBatches },
    });
    return res.json(publishedExam);
  } catch (error) {
    console.error("[POST /cbt/exams/:examId/publish]", error);
    return res.status(500).json({ error: "Unable to publish this exam." });
  }
});

router.get("/exams/:examId/pins", authorize("admin", "teacher", "principal"), async (req, res) => {
  try {
    const exam = await prisma.cBTExam.findUnique({ where: { id: req.params.examId } });
    if (!exam) return res.status(404).json({ error: "Exam not found." });
    const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
      .map((role) => String(role || "").toLowerCase());
    if (!roles.some((role) => ["admin", "director", "principal"].includes(role)) && exam.created_by !== req.user?.email) {
      return res.status(403).json({ error: "You can only view PINs for your own exam." });
    }
    const pins = await prisma.cBTExamPassword.findMany({
      where: { exam_id: exam.id },
      orderBy: [{ class: "asc" }, { batch_number: "asc" }, { student_name: "asc" }],
    });
    return res.json({ pins, active_batches: exam.active_batches || {} });
  } catch (error) {
    console.error("[GET /cbt/exams/:examId/pins]", error);
    return res.status(500).json({ error: "Unable to load exam PINs." });
  }
});

router.post("/exams/:examId/active-batch", authorize("admin", "teacher"), async (req, res) => {
  try {
    const exam = await prisma.cBTExam.findUnique({ where: { id: req.params.examId } });
    if (!exam) return res.status(404).json({ error: "Exam not found." });
    const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
      .map((role) => String(role || "").toLowerCase());
    if (!roles.some((role) => ["admin", "director"].includes(role)) && exam.created_by !== req.user?.email) {
      return res.status(403).json({ error: "You can only manage batches for your own exam." });
    }
    if (exam.status !== "Published") return res.status(409).json({ error: "Publish the exam before changing its active batch." });
    const className = String(req.body.class_name || "");
    const batchNumber = Math.trunc(Number(req.body.batch_number));
    const { batchCount } = batchSettingsForClass(exam, className);
    if (!examClasses(exam).includes(className) || batchNumber < 1 || batchNumber > batchCount) {
      return res.status(400).json({ error: "Select a class and valid batch number for this exam." });
    }
    const assignedPins = await prisma.cBTExamPassword.count({
      where: { exam_id: exam.id, class: className, batch_number: batchNumber },
    });
    if (assignedPins === 0) return res.status(400).json({ error: "There are no students assigned to this batch." });
    const activeBatches = { ...(exam.active_batches || {}), [className]: batchNumber };
    const updatedExam = await prisma.cBTExam.update({
      where: { id: exam.id },
      data: { active_batches: activeBatches },
    });
    return res.json(updatedExam);
  } catch (error) {
    console.error("[POST /cbt/exams/:examId/active-batch]", error);
    return res.status(500).json({ error: "Unable to change the active batch." });
  }
});

router.post("/exams/:examId/start", authorize("student"), async (req, res) => {
  try {
    const access = await getStudentExamAccess(req.user, req.params.examId, req.body.pin);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { pinRecord, exam } = access;
    let startedAt = pinRecord.started_at;
    if (!startedAt) {
      const initialStart = new Date().toISOString();
      await prisma.cBTExamPassword.updateMany({
        where: { id: pinRecord.id, started_at: null, used: false },
        data: { started_at: initialStart },
      });
      const startedPin = await prisma.cBTExamPassword.findUnique({ where: { id: pinRecord.id } });
      startedAt = startedPin?.started_at || initialStart;
    }
    const durationSeconds = Math.max(1, Number(exam.duration_minutes) || 1) * 60;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
    if (elapsedSeconds > durationSeconds + 60) {
      return res.status(410).json({ error: "The exam duration has expired." });
    }
    return res.json({ exam: publicExam(exam), started_at: startedAt, batch_number: pinRecord.batch_number || 1 });
  } catch (error) {
    console.error("[POST /cbt/exams/:examId/start]", error);
    return res.status(500).json({ error: "Unable to start this exam." });
  }
});

router.post("/access", authorize("student"), async (req, res) => {
  try {
    const access = await getPinAccess(req.user, req.body.pin);
    if (access.error) return res.status(access.status).json({ error: access.error });
    let startedAt = access.pinRecord.started_at;
    if (!access.pinRecord.started_at) {
      const initialStart = new Date().toISOString();
      await prisma.cBTExamPassword.updateMany({
        where: { id: access.pinRecord.id, started_at: null },
        data: { started_at: initialStart },
      });
      const currentPin = await prisma.cBTExamPassword.findUnique({ where: { id: access.pinRecord.id } });
      startedAt = currentPin?.started_at || initialStart;
    }
    const durationSeconds = Math.max(1, Number(access.exam.duration_minutes) || 1) * 60;
    if (Date.now() - new Date(startedAt).getTime() > durationSeconds + 60) {
      return res.status(410).json({ error: "The exam duration has expired." });
    }
    return res.json({ exam: publicExam(access.exam), started_at: startedAt });
  } catch (error) {
    console.error("[POST /cbt/access]", error);
    return res.status(500).json({ error: "Unable to open this exam." });
  }
});

router.post("/submit", authorize("student"), async (req, res) => {
  try {
    const now = new Date();
    const access = await getStudentExamAccess(req.user, req.body.exam_id, req.body.pin, now, true);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { student, pinRecord, exam } = access;
    if (!pinRecord?.started_at) {
      return res.status(409).json({ error: "Open the exam with your PIN before submitting." });
    }
    const elapsedSeconds = Math.max(0, Math.floor((now - new Date(pinRecord.started_at)) / 1000));
    const durationSeconds = Math.max(1, Number(exam.duration_minutes) || 1) * 60;
    if (elapsedSeconds > durationSeconds + 60) {
      return res.status(410).json({ error: "The exam duration has expired." });
    }

    const submittedAnswers = Array.isArray(req.body.answers) ? req.body.answers : [];
    let score = 0;
    let correctCount = 0;
    const questions = Array.isArray(exam.questions) ? exam.questions : [];
    const answers = questions.map((question, index) => {
      const submitted = submittedAnswers[index] || {};
      if (question.type === "objective") {
        const selected = Number.isInteger(submitted.selected_answer) ? submitted.selected_answer : null;
        const isCorrect = selected !== null && selected === question.correct_answer;
        if (isCorrect) {
          score += Number(question.marks) || 1;
          correctCount += 1;
        }
        return { question_index: index, type: "objective", selected_answer: selected, is_correct: isCorrect };
      }
      return {
        question_index: index,
        type: "theory",
        theory_answer: String(submitted.theory_answer || ""),
        is_correct: null,
      };
    });
    const hasTheory = questions.some((question) => question.type === "theory");
    const totalMarks = Number(exam.total_marks) || questions.reduce((sum, question) => sum + (Number(question.marks) || 1), 0);
    const percentage = totalMarks > 0 ? Number(((score / totalMarks) * 100).toFixed(1)) : 0;
    const grade = percentage >= 80 ? "A" : percentage >= 70 ? "B" : percentage >= 60 ? "C" : percentage >= 50 ? "D" : percentage >= 40 ? "E" : "F";

    const result = await prisma.$transaction(async (transaction) => {
      const claimedPin = await transaction.cBTExamPassword.updateMany({
        where: { id: pinRecord.id, used: false },
        data: { used: true },
      });
      if (claimedPin.count !== 1) throw new Error("This exam PIN has already been used.");
      return transaction.cBTResult.create({
        data: {
          exam_id: exam.id,
          exam_title: exam.title,
          exam_type: exam.exam_type,
          subject_name: exam.subject_name,
          teacher_email: exam.created_by,
          student_id: student.id,
          student_name: `${student.first_name} ${student.last_name}`.trim(),
          admission_number: student.admission_number,
          class: student.current_class,
          batch_number: pinRecord.batch_number || 1,
          answers,
          score,
          total_marks: totalMarks,
          percentage,
          grade,
          time_taken_minutes: Math.ceil(elapsedSeconds / 60),
          time_taken_seconds: elapsedSeconds,
          submitted_at: now.toISOString(),
          status: hasTheory ? "Pending" : "Graded",
          theory_graded: !hasTheory,
          auto_submitted: Boolean(req.body.auto_submitted),
        },
      });
    });
    return res.status(201).json({ result, correct_answers: correctCount, has_theory: hasTheory });
  } catch (error) {
    if (error.message.includes("already been used")) return res.status(409).json({ error: error.message });
    console.error("[POST /cbt/submit]", error);
    return res.status(500).json({ error: "Unable to submit this exam." });
  }
});

export default router;