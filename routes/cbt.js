import { randomInt, randomUUID } from "node:crypto";
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

async function getPinAccess(user, pin, now = new Date(), allowStartedAttempt = false) {
  const student = await getStudent(user);
  if (!student) return { error: "Student record not found.", status: 404 };
  const pinRecord = await prisma.cBTExamPassword.findFirst({
    where: { password: String(pin || "").trim(), student_id: student.id, used: false },
  });
  if (!pinRecord) return { error: "Invalid or already used C.A.Test PIN.", status: 404 };

  const exam = await prisma.cBTExam.findUnique({ where: { id: pinRecord.exam_id } });
  if (!exam || exam.exam_type !== "C.A.Test") {
    return { error: "This PIN is not for a C.A.Test.", status: 404 };
  }
  if (!examIsOpen(exam, now, allowStartedAttempt, pinRecord.started_at)) {
    return { error: "This C.A.Test is not open or has expired.", status: 410 };
  }
  const examClasses = Array.isArray(exam.classes) ? exam.classes : [];
  if (!examClasses.includes(student.current_class)) {
    return { error: "This C.A.Test is not assigned to your class.", status: 403 };
  }
  const existingResult = await prisma.cBTResult.findFirst({
    where: { exam_id: exam.id, student_id: student.id },
  });
  if (existingResult) return { error: "You have already taken this C.A.Test.", status: 409 };
  return { student, pinRecord, exam };
}

async function getStudentExamAccess(user, examId, now = new Date(), allowStartedAttempt = false) {
  const student = await getStudent(user);
  if (!student) return { error: "Student record not found.", status: 404 };
  const exam = await prisma.cBTExam.findUnique({ where: { id: examId } });
  if (!exam || exam.exam_type !== "C.A.Test") {
    return { error: "C.A.Test not found.", status: 404 };
  }
  const examClasses = Array.isArray(exam.classes) ? exam.classes : exam.class ? [exam.class] : [];
  if (!examClasses.includes(student.current_class)) {
    return { error: "This C.A.Test is not assigned to your class.", status: 403 };
  }
  const pinRecord = await prisma.cBTExamPassword.findFirst({
    where: { exam_id: exam.id, student_id: student.id },
    orderBy: { created_date: "asc" },
  });
  if (pinRecord?.used) return { error: "You have already taken this C.A.Test.", status: 409 };
  if (!examIsOpen(exam, now, allowStartedAttempt, pinRecord?.started_at)) {
    return { error: "This C.A.Test is not open or has expired.", status: 410 };
  }
  const existingResult = await prisma.cBTResult.findFirst({
    where: { exam_id: exam.id, student_id: student.id },
  });
  if (existingResult) return { error: "You have already taken this C.A.Test.", status: 409 };
  return { student, pinRecord, exam };
}

router.get("/available", authorize("student"), async (req, res) => {
  try {
    const student = await getStudent(req.user);
    if (!student) return res.status(404).json({ error: "Student record not found." });
    const [exams, results] = await Promise.all([
      prisma.cBTExam.findMany({ where: { status: "Published" }, orderBy: { created_date: "desc" } }),
      prisma.cBTResult.findMany({ where: { student_id: student.id }, select: { exam_id: true } }),
    ]);
    const now = new Date();
    const takenIds = new Set(results.map(({ exam_id }) => exam_id));
    const available = exams.filter((exam) => {
      const classes = Array.isArray(exam.classes) ? exam.classes : exam.class ? [exam.class] : [];
      if (!classes.includes(student.current_class) || takenIds.has(exam.id)) return false;
      if (exam.start_date && (!Number.isFinite(new Date(exam.start_date).getTime()) || new Date(exam.start_date) > now)) return false;
      if (exam.end_date && (!Number.isFinite(new Date(exam.end_date).getTime()) || new Date(exam.end_date) < now)) return false;
      return true;
    });
    return res.json(available.map((exam) => (
      exam.exam_type === "C.A.Test" ? publicExam(exam) : exam
    )));
  } catch (error) {
    console.error("[GET /cbt/available]", error);
    return res.status(500).json({ error: "Unable to load available CBT exams." });
  }
});

router.post("/exams/:examId/pins", authorize("admin", "teacher"), async (req, res) => {
  try {
    const exam = await prisma.cBTExam.findUnique({ where: { id: req.params.examId } });
    if (!exam || exam.exam_type !== "C.A.Test") {
      return res.status(404).json({ error: "C.A.Test not found." });
    }
    const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
      .map((role) => String(role || "").toLowerCase());
    if (!roles.some((role) => ["admin", "director"].includes(role)) && exam.created_by !== req.user?.email) {
      return res.status(403).json({ error: "You can only generate PINs for your own C.A.Test." });
    }
    if (exam.status !== "Draft") {
      return res.status(409).json({ error: "Generate student PINs while the C.A.Test is still a draft." });
    }
    const examClasses = Array.isArray(exam.classes) ? exam.classes : [];
    if (examClasses.length !== 1) {
      return res.status(400).json({ error: "A C.A.Test must target exactly one class." });
    }
    const students = await prisma.student.findMany({
      where: { current_class: examClasses[0], status: "Active" },
      orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
    });
    if (students.length === 0) return res.status(400).json({ error: "No active students are enrolled in this class." });

    const existingResults = await prisma.cBTResult.count({ where: { exam_id: exam.id } });
    if (existingResults > 0) return res.status(409).json({ error: "PINs cannot be regenerated after students have submitted." });

    const usedPins = new Set();
    const pinRows = students.map((student) => {
      let password;
      do {
        password = String(randomInt(0, 1_000_000)).padStart(6, "0");
      } while (usedPins.has(password));
      usedPins.add(password);
      return {
        exam_id: exam.id,
        exam_title: exam.title,
        subject_name: exam.subject_name,
        student_id: student.id,
        student_name: `${student.first_name} ${student.last_name}`.trim(),
        admission_number: student.admission_number,
        class: student.current_class,
        password,
        generated_by: req.user?.email || req.user?.id,
        generated_date: new Date().toISOString(),
      };
    });

    await prisma.$transaction([
      prisma.cBTExamPassword.deleteMany({ where: { exam_id: exam.id } }),
      prisma.cBTExamPassword.createMany({ data: pinRows }),
    ]);
    return res.status(201).json({ pins: pinRows });
  } catch (error) {
    console.error("[POST /cbt/exams/:examId/pins]", error);
    return res.status(500).json({ error: "Unable to generate C.A.Test PINs." });
  }
});

router.post("/exams/:examId/publish", authorize("admin", "teacher"), async (req, res) => {
  try {
    const exam = await prisma.cBTExam.findUnique({ where: { id: req.params.examId } });
    if (!exam || exam.exam_type !== "C.A.Test") {
      return res.status(404).json({ error: "C.A.Test not found." });
    }
    const roles = [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
      .map((role) => String(role || "").toLowerCase());
    if (!roles.some((role) => ["admin", "director"].includes(role)) && exam.created_by !== req.user?.email) {
      return res.status(403).json({ error: "You can only publish your own C.A.Test." });
    }
    if (exam.status !== "Draft") return res.status(409).json({ error: "This C.A.Test is no longer a draft." });
    const startTime = exam.start_date ? new Date(exam.start_date) : null;
    const endTime = exam.end_date ? new Date(exam.end_date) : null;
    if (
      !["1st", "2nd", "3rd"].includes(exam.ca_test_number) || !exam.subject_id ||
      !Array.isArray(exam.questions) || exam.questions.length === 0 ||
      Number(exam.duration_minutes) <= 0 || !startTime || !endTime ||
      !Number.isFinite(startTime.getTime()) || !Number.isFinite(endTime.getTime()) ||
      endTime <= startTime || endTime <= new Date()
    ) {
      return res.status(400).json({ error: "Complete the C.A.Test number, subject, questions, duration, and valid test window before publishing." });
    }
    const examClasses = Array.isArray(exam.classes) ? exam.classes : [];
    if (examClasses.length !== 1) return res.status(400).json({ error: "A C.A.Test must target exactly one class." });
    const students = await prisma.student.count({
      where: { current_class: examClasses[0], status: "Active" },
    });
    if (students === 0) return res.status(400).json({ error: "No active students are enrolled in this class." });
    const publishedExam = await prisma.cBTExam.update({
      where: { id: exam.id },
      data: { status: "Published" },
    });
    return res.json(publishedExam);
  } catch (error) {
    console.error("[POST /cbt/exams/:examId/publish]", error);
    return res.status(500).json({ error: "Unable to publish this C.A.Test." });
  }
});

router.post("/exams/:examId/start", authorize("student"), async (req, res) => {
  try {
    const access = await getStudentExamAccess(req.user, req.params.examId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    let { student, pinRecord, exam } = access;
    if (!pinRecord) {
      pinRecord = await prisma.cBTExamPassword.create({
        data: {
          exam_id: exam.id,
          exam_title: exam.title,
          subject_name: exam.subject_name,
          student_id: student.id,
          student_name: `${student.first_name} ${student.last_name}`.trim(),
          admission_number: student.admission_number,
          class: student.current_class,
          password: randomUUID(),
          started_at: new Date().toISOString(),
        },
      });
    } else if (!pinRecord.started_at) {
      const startedAt = new Date().toISOString();
      await prisma.cBTExamPassword.updateMany({
        where: { id: pinRecord.id, started_at: null, used: false },
        data: { started_at: startedAt },
      });
      pinRecord = await prisma.cBTExamPassword.findUnique({ where: { id: pinRecord.id } });
    }
    const durationSeconds = Math.max(1, Number(exam.duration_minutes) || 1) * 60;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(pinRecord.started_at).getTime()) / 1000));
    if (elapsedSeconds > durationSeconds + 60) {
      return res.status(410).json({ error: "The C.A.Test duration has expired." });
    }
    return res.json({ exam: publicExam(exam), started_at: pinRecord.started_at });
  } catch (error) {
    console.error("[POST /cbt/exams/:examId/start]", error);
    return res.status(500).json({ error: "Unable to start this C.A.Test." });
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
      return res.status(410).json({ error: "The C.A.Test duration has expired." });
    }
    return res.json({ exam: publicExam(access.exam), started_at: startedAt });
  } catch (error) {
    console.error("[POST /cbt/access]", error);
    return res.status(500).json({ error: "Unable to open this C.A.Test." });
  }
});

router.post("/submit", authorize("student"), async (req, res) => {
  try {
    const now = new Date();
    let access;
    if (req.body.exam_id) {
      access = await getStudentExamAccess(req.user, req.body.exam_id, now, true);
      if (!access.error && !access.pinRecord?.started_at) {
        return res.status(409).json({ error: "Start the C.A.Test before submitting." });
      }
    } else {
      access = await getPinAccess(req.user, req.body.pin, now, true);
    }
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { student, pinRecord, exam } = access;
    if (!pinRecord.started_at) {
      return res.status(409).json({ error: "Open the C.A.Test with your PIN before submitting." });
    }
    const elapsedSeconds = Math.max(0, Math.floor((now - new Date(pinRecord.started_at)) / 1000));
    const durationSeconds = Math.max(1, Number(exam.duration_minutes) || 1) * 60;
    if (elapsedSeconds > durationSeconds + 60) {
      return res.status(410).json({ error: "The C.A.Test duration has expired." });
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
      if (claimedPin.count !== 1) throw new Error("This C.A.Test PIN has already been used.");
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
    return res.status(500).json({ error: "Unable to submit this C.A.Test." });
  }
});

export default router;