import { Router } from "express";
import prisma from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { toUIEnums } from "../utils/enumMapper.js";
import {
  getTranscriptStages,
  matchesTranscriptHistoryClass,
  matchesTranscriptStudentClass,
  TRANSCRIPT_STAGE,
} from "../utils/transcriptAccess.js";

const router = Router();
const TRANSCRIPT_ROLES = ["admin", "principal", "head_teacher"];
const STUDENT_SELECT = {
  id: true,
  first_name: true,
  middle_name: true,
  last_name: true,
  admission_number: true,
  current_class: true,
  section: true,
  gender: true,
  date_of_birth: true,
  admission_date: true,
  passport_photo: true,
};

function requestedStage(value) {
  return value === TRANSCRIPT_STAGE.PRIMARY_5 || value === TRANSCRIPT_STAGE.SS3
    ? value
    : null;
}

function hasStageAccess(user, stage) {
  return getTranscriptStages(user).includes(stage);
}

async function findEligibleStudent(studentId, stage) {
  const student = await prisma.student.findFirst({
    where: {
      id: studentId,
      status: { in: ["Active", "Graduated"] },
    },
    select: STUDENT_SELECT,
  });
  return student && matchesTranscriptStudentClass(student.current_class, stage)
    ? student
    : null;
}

router.get(
  "/students",
  authenticate,
  authorize(...TRANSCRIPT_ROLES),
  async (req, res) => {
    const stage = requestedStage(req.query.stage);
    if (!stage) {
      return res.status(400).json({ error: "Select Primary 5 or SS3." });
    }
    if (!hasStageAccess(req.user, stage)) {
      return res.status(403).json({ error: "You cannot access this transcript stage." });
    }

    try {
      const students = await prisma.student.findMany({
        where: {
          status: { in: ["Active", "Graduated"] },
          current_class: {
            startsWith: stage === TRANSCRIPT_STAGE.PRIMARY_5 ? "Primary 5" : "SS3",
          },
        },
        select: STUDENT_SELECT,
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
      });
      return res.json(
        students.filter((student) =>
          matchesTranscriptStudentClass(student.current_class, stage),
        ),
      );
    } catch (error) {
      console.error("[GET /api/transcripts/students]", error);
      return res.status(500).json({ error: "Could not load transcript students." });
    }
  },
);

router.get(
  "/students/:studentId",
  authenticate,
  authorize(...TRANSCRIPT_ROLES),
  async (req, res) => {
    const stage = requestedStage(req.query.stage);
    if (!stage) {
      return res.status(400).json({ error: "Select Primary 5 or SS3." });
    }
    if (!hasStageAccess(req.user, stage)) {
      return res.status(403).json({ error: "You cannot access this transcript stage." });
    }

    try {
      const student = await findEligibleStudent(req.params.studentId, stage);
      if (!student) {
        return res.status(404).json({ error: "The student is not eligible for this transcript." });
      }

      const [records, savedTranscript] = await Promise.all([
        prisma.result.findMany({
          where: {
            student_id: student.id,
            ...(stage === TRANSCRIPT_STAGE.PRIMARY_5
              ? { class: { startsWith: "Primary " } }
              : {
                  OR: [1, 2, 3].map((level) => ({
                    class: { startsWith: `SS${level}` },
                  })),
                }),
          },
          orderBy: [{ session: "asc" }, { term: "asc" }],
        }),
        prisma.studentTranscript.findUnique({
          where: {
            student_id_stage: { student_id: student.id, stage },
          },
          select: { data: true, updated_date: true },
        }),
      ]);
      const subjectIds = [...new Set(records.map((record) => record.subject_id).filter(Boolean))];
      const subjects = subjectIds.length
        ? await prisma.subject.findMany({
            where: { id: { in: subjectIds } },
            select: { id: true, code: true },
          })
        : [];
      const subjectCodes = new Map(subjects.map(({ id, code }) => [id, code || ""]));
      const results = records
        .filter((record) => matchesTranscriptHistoryClass(record.class, stage))
        .map((record) => ({
          ...record,
          subject_code: subjectCodes.get(record.subject_id) || "",
        }));

      return res.json({
        student,
        results: toUIEnums(results),
        transcript: savedTranscript
          ? {
              data: savedTranscript.data,
              updated_date: savedTranscript.updated_date,
            }
          : null,
      });
    } catch (error) {
      console.error("[GET /api/transcripts/students/:studentId]", error);
      return res.status(500).json({ error: "Could not load the student's transcript." });
    }
  },
);

router.put(
  "/students/:studentId",
  authenticate,
  authorize(...TRANSCRIPT_ROLES),
  async (req, res) => {
    const stage = requestedStage(req.body.stage);
    const data = req.body.data;
    if (!stage || !data || typeof data !== "object" || Array.isArray(data) ||
      !data.student || typeof data.student !== "object" || Array.isArray(data.student) ||
      !Array.isArray(data.years) || data.years.length === 0 ||
      data.years.some((year) =>
        !year || typeof year !== "object" || Array.isArray(year) || !Array.isArray(year.subjects)
      )) {
      return res.status(400).json({ error: "A transcript stage and transcript years are required." });
    }
    if (!hasStageAccess(req.user, stage)) {
      return res.status(403).json({ error: "You cannot access this transcript stage." });
    }
    if (JSON.stringify(data).length > 500000) {
      return res.status(413).json({ error: "Transcript data is too large to save." });
    }

    try {
      const student = await findEligibleStudent(req.params.studentId, stage);
      if (!student) {
        return res.status(404).json({ error: "The student is not eligible for this transcript." });
      }

      const transcript = await prisma.studentTranscript.upsert({
        where: {
          student_id_stage: { student_id: student.id, stage },
        },
        create: {
          student_id: student.id,
          stage,
          data,
          updated_by: req.user.profile_id || req.user.id || null,
        },
        update: {
          data,
          updated_by: req.user.profile_id || req.user.id || null,
        },
      });
      return res.json({ transcript: { data: transcript.data, updated_date: transcript.updated_date } });
    } catch (error) {
      console.error("[PUT /api/transcripts/students/:studentId]", error);
      return res.status(500).json({ error: "Could not save the student's transcript." });
    }
  },
);

export default router;
