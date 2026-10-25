import { toPrismaEnums } from "../utils/enumMapper.js";

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function countSchoolDays(openingDate, vacatingDate, holidayDates) {
  if (!isValidDate(openingDate) || !isValidDate(vacatingDate) || openingDate > vacatingDate) return null;

  let total = 0;
  const current = new Date(`${openingDate}T00:00:00.000Z`);
  const last = new Date(`${vacatingDate}T00:00:00.000Z`);
  while (current <= last) {
    const date = current.toISOString().slice(0, 10);
    const dayOfWeek = current.getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !holidayDates.has(date)) total++;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return total;
}

function calculateGrade(score, section) {
  if (section === "Secondary") {
    if (score >= 75) return "A1";
    if (score >= 70) return "B2";
    if (score >= 65) return "B3";
    if (score >= 60) return "C4";
    if (score >= 55) return "C5";
    if (score >= 50) return "C6";
    if (score >= 45) return "D7";
    if (score >= 40) return "E8";
    return "F9";
  }
  if (score >= 70) return "A";
  if (score >= 60) return "B";
  if (score >= 50) return "C";
  if (score >= 45) return "D";
  if (score >= 40) return "E";
  return "F";
}

function calculateRemark(score, section) {
  if (section === "Secondary") {
    if (score >= 75) return "Excellent";
    if (score >= 70) return "Very Good";
    if (score >= 65) return "Good";
    if (score >= 50) return "Credit";
    if (score >= 40) return "Pass";
    return "Fail";
  }
  if (score >= 70) return "Excellent";
  if (score >= 60) return "Very Good";
  if (score >= 50) return "Good";
  if (score >= 45) return "Pass";
  if (score >= 40) return "Weak Pass";
  return "Fail";
}

function completeDerivedResultFields(result) {
  const components = [result.first_ca, result.second_ca, result.third_ca, result.exam_score];
  const hasScoreComponent = components.some((score) => score !== null && score !== undefined);
  const total = result.total ?? (hasScoreComponent
    ? components.reduce((sum, score) => sum + (Number(score) || 0), 0)
    : null);
  const resultWithTotal = { ...result, total };
  if (total === null) return resultWithTotal;
  return {
    ...resultWithTotal,
    grade: result.grade || calculateGrade(total, result.section),
    remark: result.remark || calculateRemark(total, result.section),
  };
}

export function hydrateResultRecord(result) {
  if (!result) return result;
  const components = [result.first_ca, result.second_ca, result.third_ca, result.exam_score];
  const hasScoreComponent = components.some((score) => score !== null && score !== undefined);
  const total = result.total ?? (hasScoreComponent
    ? components.reduce((sum, score) => sum + (Number(score) || 0), 0)
    : null);
  const next = { ...result, total };
  if (total === null) return next;
  return {
    ...next,
    grade: result.grade || calculateGrade(total, result.section),
    remark: result.remark || calculateRemark(total, result.section),
  };
}

export async function populateHistoricalResultMetadata(db) {
  const results = await db.result.findMany({
    orderBy: [{ class: "asc" }, { term: "asc" }, { session: "asc" }],
  });

  const groups = new Map();
  for (const result of results) {
    const key = `${result.class}|${result.term}|${result.session}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }

  for (const resultsForGroup of groups.values()) {
    const studentTotals = new Map();
    const studentSubjectTotals = new Map();
    const subjectGroups = new Map();
    for (const result of resultsForGroup) {
      const hydrated = hydrateResultRecord(result);
      studentTotals.set(hydrated.student_id, (studentTotals.get(hydrated.student_id) || 0) + (hydrated.total || 0));
      const subjectKey = `${hydrated.class}|${hydrated.subject_id}|${hydrated.term}|${hydrated.session}`;
      if (!subjectGroups.has(subjectKey)) subjectGroups.set(subjectKey, []);
      subjectGroups.get(subjectKey).push(hydrated);
      if (!studentSubjectTotals.has(hydrated.student_id)) studentSubjectTotals.set(hydrated.student_id, 0);
      studentSubjectTotals.set(hydrated.student_id, studentSubjectTotals.get(hydrated.student_id) + (hydrated.total || 0));
    }

    const classRoster = new Set(resultsForGroup.map((result) => result.student_id));
    const [activeClassStudents, reportCards] = await Promise.all([
      db.student.count({
        where: { current_class: resultsForGroup[0].class, status: "Active" },
      }),
      db.reportCard.findMany({
        where: {
          class: resultsForGroup[0].class,
          term: resultsForGroup[0].term,
          session: resultsForGroup[0].session,
        },
        select: { total_students: true },
      }),
    ]);
    const classSize = Math.max(
      classRoster.size,
      activeClassStudents,
      ...reportCards.map((reportCard) => Number(reportCard.total_students) || 0),
    );
    const classRanking = [...classRoster].map((studentId) => ({ studentId, total: studentTotals.get(studentId) || 0 })).sort((a, b) => b.total - a.total);
    const classRankMap = new Map(classRanking.map((entry, index) => [entry.studentId, index + 1]));

    for (const [subjectKey, rows] of subjectGroups) {
      const subjectScores = [...rows].sort((a, b) => (b.total || 0) - (a.total || 0));
      const subjectRankMap = new Map(subjectScores.map((entry, index) => [entry.student_id, index + 1]));
      const avg = subjectScores.length ? Number((subjectScores.reduce((sum, entry) => sum + (entry.total || 0), 0) / subjectScores.length).toFixed(1)) : 0;
      for (const row of rows) {
        const studentId = row.student_id;
        const existing = await db.result.findUnique({ where: { id: row.id } });
        if (!existing) continue;
        const nextData = { 
          total: hydrateResultRecord(row).total,
          grade: row.grade || hydrateResultRecord(row).grade,
          remark: row.remark || hydrateResultRecord(row).remark,
          subject_position: row.subject_position ?? subjectRankMap.get(studentId) ?? null,
          class_average_score: row.class_average_score ?? avg,
          class_position: row.class_position ?? classRankMap.get(studentId) ?? null,
          total_in_class: row.total_in_class ?? classSize,
          total_score_all_subjects: row.total_score_all_subjects ?? studentSubjectTotals.get(studentId) ?? null,
        };
        const updatePayload = Object.fromEntries(Object.entries(nextData).filter(([, value]) => value !== null && value !== undefined));
        if (Object.keys(updatePayload).length > 0) {
          await db.result.update({ where: { id: row.id }, data: updatePayload });
        }
      }
    }
  }

  const reportCards = await db.reportCard.findMany();
  for (const reportCard of reportCards) {
    const missingAverage = reportCard.average == null && reportCard.total_score != null && reportCard.total_students ? Number((reportCard.total_score / reportCard.total_students).toFixed(2)) : reportCard.average;
    const updatePayload = {};
    if (reportCard.total_score == null && reportCard.subjects_data) {
      const subjects = Array.isArray(reportCard.subjects_data) ? reportCard.subjects_data : Object.values(reportCard.subjects_data || {});
      const score = subjects.reduce((sum, item) => sum + (Number(item?.total || item?.score || 0) || 0), 0);
      updatePayload.total_score = Number(score.toFixed(2));
    }
    if (reportCard.average == null && missingAverage != null) updatePayload.average = missingAverage;
    if (reportCard.position == null && reportCard.total_students) updatePayload.position = 1;
    if (Object.keys(updatePayload).length > 0) {
      await db.reportCard.update({ where: { id: reportCard.id }, data: updatePayload });
    }
  }
}

export async function buildResultSnapshot(db, {
  studentId,
  admissionNumber,
  term,
  session,
  className,
  fallbackStudent,
  preferStoredSummary = false,
}) {
  const where = {
    term: toPrismaEnums(term),
    session,
    status: "Approved",
  };
  const studentRecord = studentId
    ? await db.student.findUnique({ where: { id: studentId } })
    : await db.student.findFirst({
      where: { admission_number: { equals: admissionNumber, mode: "insensitive" } },
    });
  const student = studentRecord || (fallbackStudent ? {
    id: fallbackStudent.id || studentId,
    first_name: fallbackStudent.first_name || String(fallbackStudent.student_name || "").split(" ")[0] || "",
    last_name: fallbackStudent.last_name || String(fallbackStudent.student_name || "").split(" ").slice(1).join(" "),
    admission_number: fallbackStudent.admission_number || admissionNumber || null,
    current_class: fallbackStudent.current_class || fallbackStudent.class || className || "",
    section: fallbackStudent.section || null,
  } : null);
  if (!student) return null;

  const resultClass = className || student.current_class;
  const allClassResults = (await db.result.findMany({
    where: { ...where, class: resultClass },
    orderBy: { subject_name: "asc" },
  })).map(completeDerivedResultFields);
  const [roster, classReportCards, allClassResultRows] = await Promise.all([
    db.student.findMany({
      where: { current_class: resultClass, status: "Active" },
      select: { id: true },
    }),
    db.reportCard.findMany({
      where: { term: toPrismaEnums(term), session, class: resultClass },
      select: { subjects_data: true, total_students: true, position: true },
    }),
    db.result.findMany({
      where: { term: toPrismaEnums(term), session, class: resultClass },
      select: { subject_id: true, subject_name: true, section: true },
    }),
  ]);
  const studentResults = allClassResults
    .filter((result) => result.student_id === student.id)
    .map(completeDerivedResultFields);
  const expectedSubjects = new Map();
  for (const result of allClassResultRows) {
    expectedSubjects.set(result.subject_id, {
      subject_id: result.subject_id,
      subject_name: result.subject_name || "Subject",
      section: result.section,
    });
  }
  for (const reportCard of classReportCards) {
    const subjects = Array.isArray(reportCard.subjects_data)
      ? reportCard.subjects_data
      : Object.values(reportCard.subjects_data || {});
    for (const subject of subjects) {
      const subjectName = String(subject?.subject_name || subject?.name || "").trim();
      if (!subjectName) continue;
      const existing = [...expectedSubjects.values()].some(
        (item) => item.subject_name.toLowerCase() === subjectName.toLowerCase(),
      );
      if (!existing) {
        expectedSubjects.set(`historical:${subjectName.toLowerCase()}`, {
          subject_id: `historical:${subjectName.toLowerCase()}`,
          subject_name: subjectName,
          section: student.section,
        });
      }
    }
  }
  if (expectedSubjects.size === 0) {
    const assignedSubjects = await db.subject.findMany({
      where: {
        status: "Active",
        OR: [
          { class: resultClass },
          { classes: { array_contains: [resultClass] } },
        ],
      },
      select: { id: true, name: true, section: true },
    });
    for (const subject of assignedSubjects) {
      expectedSubjects.set(subject.id, {
        subject_id: subject.id,
        subject_name: subject.name,
        section: subject.section || student.section,
      });
    }
  }
  const resultSubjects = new Set(studentResults.map((result) => result.subject_id));
  const resultSubjectNames = new Set(studentResults.map((result) => (result.subject_name || "").toLowerCase()));
  for (const subject of expectedSubjects.values()) {
    if (resultSubjects.has(subject.subject_id) ||
      resultSubjectNames.has(subject.subject_name.toLowerCase())) continue;
    studentResults.push({
      id: `missing:${student.id}:${subject.subject_id}`,
      student_id: student.id,
      student_name: `${student.first_name || ""} ${student.last_name || ""}`.trim(),
      admission_number: student.admission_number,
      class: resultClass,
      section: subject.section || student.section,
      term: toPrismaEnums(term),
      session,
      subject_id: subject.subject_id,
      subject_name: subject.subject_name,
      first_ca: null,
      second_ca: null,
      third_ca: null,
      exam_score: null,
      total: null,
      grade: null,
      remark: null,
      status: "Approved",
    });
  }
  studentResults.sort((a, b) => (a.subject_name || "").localeCompare(b.subject_name || ""));

  const totals = new Map();
  const subjectScores = new Map();
  for (const result of allClassResults) {
    const score = Number(result.total) || 0;
    totals.set(result.student_id, (totals.get(result.student_id) || 0) + score);
    if (!subjectScores.has(result.subject_id)) subjectScores.set(result.subject_id, []);
    subjectScores.get(result.subject_id).push({ studentId: result.student_id, score });
  }

  const sortedTotals = [...totals.entries()]
    .map(([id, total]) => ({ id, total }))
    .sort((a, b) => b.total - a.total);
  const calculatedClassPosition = sortedTotals.findIndex(({ id }) => id === student.id) + 1 || null;
  const classPosition = preferStoredSummary
    ? studentResults.find((result) => result.class_position !== null)?.class_position ?? calculatedClassPosition
    : calculatedClassPosition;
  const totalScore = studentResults.reduce((sum, result) => sum + (result.total || 0), 0);
  const totalSubjects = studentResults.length;
  const scoredSubjects = studentResults.filter((result) => result.total !== null && result.total !== undefined).length;
  const calculatedAverage = scoredSubjects ? Number((totalScore / scoredSubjects).toFixed(2)) : 0;
  const totalScoreSnapshot = preferStoredSummary
    ? studentResults.find((result) => result.total_score_all_subjects !== null)?.total_score_all_subjects ?? totalScore
    : totalScore;
  const average = totalSubjects ? Number((totalScoreSnapshot / totalSubjects).toFixed(2)) : 0;
  const resultCohortSize = new Set(allClassResults.map((result) => result.student_id)).size;
  const storedClassSize = studentResults.find((result) => result.total_in_class !== null)?.total_in_class
    ?? classReportCards.reduce((max, reportCard) => Math.max(max, reportCard.total_students || 0), 0);
  const totalInClass = Math.max(
    Number(storedClassSize) || 0,
    roster.length,
    resultCohortSize,
  );
  const subjectStats = new Map();

  for (const [subjectId, entries] of subjectScores) {
    const averageScore = Number((entries.reduce((sum, item) => sum + item.score, 0) / entries.length).toFixed(1));
    const ranked = [...entries].sort((a, b) => b.score - a.score);
    const calculatedPosition = ranked.findIndex((item) => item.studentId === student.id) + 1 || null;
    const storedPosition = studentResults.find((result) => result.subject_id === subjectId && result.subject_position !== null)?.subject_position;
    const storedAverage = studentResults.find((result) => result.subject_id === subjectId && result.class_average_score !== null)?.class_average_score;
    subjectStats.set(subjectId, {
      averageScore: preferStoredSummary ? storedAverage ?? averageScore : averageScore,
      position: preferStoredSummary ? storedPosition ?? calculatedPosition : calculatedPosition,
    });
  }

  const results = studentResults.map((result) => {
    const stats = subjectStats.get(result.subject_id);
    return {
      ...result,
      subject_position: stats?.position ?? result.subject_position ?? null,
      class_average_score: stats?.averageScore ?? result.class_average_score ?? null,
      class_position: classPosition ?? result.class_position ?? null,
      total_in_class: totalInClass,
      total_score_all_subjects: totalScoreSnapshot,
      total_subjects: totalSubjects,
      average: preferStoredSummary ? calculatedAverage : average,
    };
  });

  const termValue = toPrismaEnums(term);
  const [attendanceRecords, teacher, settings] = await Promise.all([
    db.attendance.findMany({
      where: {
        OR: [
          { student_id: student.id },
          ...(student.admission_number
            ? [{ admission_number: { equals: student.admission_number, mode: "insensitive" } }]
            : []),
        ],
        term: termValue,
        session,
      },
      orderBy: { date: "asc" },
    }),
    db.teacher.findFirst({
      where: {
        status: "Active",
        OR: [{ assigned_class: resultClass }, { form_teacher_class: resultClass }],
      },
    }),
    db.schoolSettings.findFirst(),
  ]);
  const nonHolidayRecords = attendanceRecords.filter((item) => !item.holiday_type);
  const holidayDates = new Set(
    attendanceRecords
      .filter((item) => item.holiday_type && isValidDate(item.date))
      .map((item) => item.date)
  );
  const termLabel = String(term || "").replace(/_/g, " ");
  const termDates = settings?.term_dates?.[termLabel] || settings?.term_dates?.[term];
  const configuredSchoolDays = countSchoolDays(
    termDates?.opening_date,
    termDates?.vacating_date,
    holidayDates
  );
  const total = configuredSchoolDays ?? new Set(
    nonHolidayRecords.filter((item) => isValidDate(item.date)).map((item) => item.date)
  ).size;
  const present = nonHolidayRecords.filter((item) => item.status === "Present" || item.status === "Late").length;
  const attendanceSummary = {
    present,
    absent: nonHolidayRecords.filter((item) => item.status === "Absent").length,
    late: nonHolidayRecords.filter((item) => item.status === "Late").length,
    excused: nonHolidayRecords.filter((item) => item.status === "Excused").length,
    total,
    attendanceRate: total ? Math.round((present / total) * 100) : null,
  };

  return {
    student,
    results,
    classTeacher: teacher
      ? {
        name: `${teacher.first_name || ""} ${teacher.last_name || ""}`.trim(),
        phone: teacher.phone,
        email: teacher.email,
      }
      : null,
    rankings: {
      classPosition,
      totalInClass,
      totalScore: totalScoreSnapshot,
      totalSubjects,
      average,
      promoted: results[0]?.promotion_status === "Promoted",
    },
    attendanceSummary,
    settings,
  };
}

export async function repairResultSnapshot(db, token, existingSnapshot = token.snapshot) {
  const fallbackStudent = existingSnapshot?.student || token;
  const rebuilt = await buildResultSnapshot(db, {
    studentId: token.student_id || fallbackStudent.id,
    admissionNumber: token.admission_number || fallbackStudent.admission_number,
    term: token.term,
    session: token.session,
    className: token.class || fallbackStudent.current_class || fallbackStudent.class,
    fallbackStudent,
    preferStoredSummary: true,
  });
  if (!rebuilt?.results.length) return existingSnapshot;

  const currentResults = Array.isArray(existingSnapshot?.results) ? existingSnapshot.results : [];
  const existingSubjectIds = new Set(currentResults.map((result) => result.subject_id).filter(Boolean));
  const existingSubjectNames = new Set(currentResults.map((result) => String(result.subject_name || "").toLowerCase()));
  const missingResults = rebuilt.results.filter((result) =>
    !existingSubjectIds.has(result.subject_id) &&
    !existingSubjectNames.has(String(result.subject_name || "").toLowerCase()),
  );
  const results = currentResults.length > 0
    ? [...currentResults, ...missingResults]
    : rebuilt.results;
  results.sort((a, b) => String(a.subject_name || "").localeCompare(String(b.subject_name || "")));

  const storedClassSize = Math.max(
    Number(existingSnapshot?.rankings?.totalInClass) || 0,
    ...currentResults.map((result) => Number(result.total_in_class) || 0),
  );
  const totalInClass = Math.max(storedClassSize, Number(rebuilt.rankings.totalInClass) || 0);
  const hydratedResults = results.map((result) => ({
    ...result,
    total_in_class: result.total_in_class ?? totalInClass,
    total_subjects: result.total_subjects ?? results.length,
  }));
  return {
    ...rebuilt,
    ...(existingSnapshot || {}),
    student: existingSnapshot?.student || rebuilt.student,
    results: hydratedResults,
    rankings: {
      ...rebuilt.rankings,
      ...(existingSnapshot?.rankings || {}),
      totalInClass,
      totalSubjects: Math.max(
        Number(existingSnapshot?.rankings?.totalSubjects) || 0,
        hydratedResults.length,
      ),
    },
  };
}
