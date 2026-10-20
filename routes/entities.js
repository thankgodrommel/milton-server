import { Router } from "express";
import { Prisma } from "@prisma/client";
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

async function hasIssuedResultToken(result, db = prisma) {
  if (!result?.student_id || !result?.term || !result?.session) return false;
  return Boolean(await db.resultToken.findFirst({
    where: {
      term: result.term,
      session: result.session,
      OR: [
        { student_id: result.student_id },
        ...(result.admission_number ? [{ admission_number: result.admission_number }] : []),
      ],
    },
    select: { id: true },
  }));
}

function lockedResultError() {
  const error = new Error("This result is locked because a result token has already been generated.");
  error.code = "RESULT_LOCKED";
  return error;
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

function omitResultTokenSnapshot(record, model) {
  if (model !== "ResultToken" || !record) return record;
  const { snapshot: _snapshot, ...safeRecord } = record;
  return safeRecord;
}

function isStaffUser(req) {
  return [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
    .some((role) => ["admin", "teacher", "head_teacher", "principal", "director"].includes(String(role || "").toLowerCase()));
}

function isStudentUser(req) {
  return [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
    .some((role) => String(role || "").toLowerCase() === "student");
}

function isParentChatUser(req) {
  return String(req.user?.profile_type || "").toLowerCase() === "parent" ||
    [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
      .some((role) => String(role || "").toLowerCase() === "parent");
}

function isEligibleParentChatStaff(req) {
  return [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
    .some((role) => ["teacher", "head teacher", "principal"].includes(String(role || "").toLowerCase().replace(/_/g, " ")));
}

function getStaffChatRoles(req) {
  return [req.user?.role, ...(Array.isArray(req.user?.roles) ? req.user.roles : [])]
    .map((role) => String(role || "").toLowerCase().replace(/_/g, " "));
}

function isStaffChatUser(req) {
  const profileType = String(req.user?.profile_type || "").toLowerCase();
  return ["teacher", "adminuser", "nonacademicstaff"].includes(profileType) ||
    getStaffChatRoles(req).some((role) =>
      ["admin", "teacher", "head teacher", "principal", "accountant", "non academic staff"].includes(role)
    );
}

function staffChatUserKey(profileType, id) {
  return `${String(profileType || "").toLowerCase()}:${id}`;
}

function staffChatConversationId(first, second) {
  return `staff-chat:${[staffChatUserKey(first.profile_type, first.id), staffChatUserKey(second.profile_type, second.id)].sort().join(":")}`;
}

function normalizeChatPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 13 && digits.startsWith("234")) return digits.slice(3);
  return digits;
}

function isParentChatConversationId(conversationId) {
  return typeof conversationId === "string" && conversationId.startsWith("parent-chat:");
}

function getTeacherChatRole(teacher, student, classRecord, staffRoles) {
  const teacherRoles = staffRoles
    .filter((staffRole) =>
      staffRole.teacher_id === teacher.id ||
      staffRole.teacher_id === teacher.staff_id ||
      staffRole.user_id === teacher.staff_id ||
      staffRole.user_id === teacher.user_id
    )
    .map((staffRole) => String(staffRole.role || "").toLowerCase().replace(/_/g, " "));
  const teacherType = String(teacher.teacher_type || "").toLowerCase().replace(/_/g, " ");
  const isPrincipal = teacherType === "principal" || teacherRoles.includes("principal");
  const isHeadTeacher = teacherType.includes("head teacher") ||
    teacherRoles.includes("head teacher");
  const isClassOrFormTeacher = teacherType.includes("class teacher") ||
    teacherType.includes("form teacher");
  const isClassTeacher =
    (isClassOrFormTeacher &&
      (teacher.assigned_class === student.current_class ||
        teacher.form_teacher_class === student.current_class)) ||
    classRecord?.class_teacher_id === teacher.id ||
    classRecord?.class_teacher_id === teacher.staff_id ||
    classRecord?.class_teacher_id === teacher.user_id;

  if (isPrincipal) return "Principal";
  if (isHeadTeacher && teacher.section === student.section) return "Head Teacher";
  if (isClassTeacher) return "Class/Form Teacher";
  return null;
}

async function getParentChatScope(req) {
  if (!isParentChatUser(req)) return null;
  const profileId = req.user?.profile_id || req.user?.id;
  const parent = profileId
    ? await prisma.parent.findUnique({ where: { id: profileId } })
    : req.user?.username
      ? await prisma.parent.findUnique({ where: { parent_id: req.user.username } })
      : null;
  if (!parent) return { parent: null, conversations: [] };

  const childConditions = [
    ...(parent.phone ? [{ parent_phone: parent.phone }] : []),
    ...(parent.email ? [{ parent_email: parent.email }] : []),
    ...(parent.parent_id ? [{ parent_id: parent.parent_id }] : []),
  ];
  const linkConditions = [
    ...(parent.email ? [{ parent_email: parent.email }] : []),
    ...(parent.parent_id ? [{ parent_id: parent.parent_id }] : []),
    { parent_user_id: parent.id },
  ];
  const normalizedParentPhone = normalizeChatPhone(parent.phone);
  const [directChildren, phoneChildren, parentLinks] = await Promise.all([
    childConditions.length
      ? prisma.student.findMany({ where: { AND: [{ status: "Active" }, { OR: childConditions }] } })
      : Promise.resolve([]),
    parent.phone
      ? prisma.student.findMany({
          where: {
            status: "Active",
            OR: [
              { parent_phone: parent.phone },
              ...(normalizedParentPhone.length >= 4
                ? [{ parent_phone: { contains: normalizedParentPhone.slice(-4) } }]
                : []),
            ],
          },
          select: {
            id: true,
            first_name: true,
            last_name: true,
            current_class: true,
            section: true,
            parent_phone: true,
          },
        })
      : Promise.resolve([]),
    prisma.parentStudent.findMany({ where: { OR: linkConditions } }),
  ]);
  const linkedIds = parentLinks.map((link) => link.student_id).filter(Boolean);
  const linkedChildren = linkedIds.length
    ? await prisma.student.findMany({ where: { id: { in: linkedIds }, status: "Active" } })
    : [];
  const childrenById = new Map(
    [
      ...directChildren,
      ...phoneChildren.filter(
        (student) =>
          normalizedParentPhone &&
          normalizeChatPhone(student.parent_phone) === normalizedParentPhone
      ),
      ...linkedChildren,
    ].map((student) => [student.id, student])
  );
  const children = [...childrenById.values()];
  const classNames = [...new Set(children.map((student) => student.current_class).filter(Boolean))];
  const [classRecords, teachers, staffRoles] = await Promise.all([
    classNames.length
      ? prisma.schoolClass.findMany({ where: { name: { in: classNames } } })
      : Promise.resolve([]),
    prisma.teacher.findMany({ where: { status: "Active" } }),
    prisma.staffRole.findMany({ where: { status: "Active" } }),
  ]);
  const classesByName = new Map(classRecords.map((schoolClass) => [schoolClass.name, schoolClass]));
  const conversations = [];

  children.forEach((student) => {
    const classRecord = classesByName.get(student.current_class);
    teachers.forEach((teacher) => {
      const role = getTeacherChatRole(teacher, student, classRecord, staffRoles);
      if (!role) return;
      conversations.push({
        conversation_id: `parent-chat:${parent.id}:${student.id}:${teacher.id}`,
        parent_id: parent.id,
        parent_name: parent.full_name ||
          `${parent.first_name || ""} ${parent.last_name || ""}`.trim() ||
          "Parent",
        student_id: student.id,
        student_name: `${student.first_name} ${student.last_name}`.trim(),
        student_class: student.current_class,
        recipient_id: teacher.id,
        recipient_name: `${teacher.first_name} ${teacher.last_name}`.trim(),
        recipient_role: role,
        recipient_section: teacher.section,
      });
    });
  });

  return { parent, children, conversations };
}

async function getTeacherParentChatScope(req) {
  if (!isEligibleParentChatStaff(req)) return { teacher: null, conversations: [] };
  const identity = req.user || {};
  const teacherConditions = [
    ...(identity.profile_id ? [{ id: identity.profile_id }] : []),
    ...(identity.id ? [{ id: identity.id }] : []),
    ...(identity.staff_id ? [{ staff_id: identity.staff_id }] : []),
    ...(identity.email ? [{ email: identity.email }] : []),
  ];
  const teacher = teacherConditions.length
    ? await prisma.teacher.findFirst({ where: { OR: teacherConditions } })
    : null;
  if (!teacher) return { teacher: null, conversations: [] };

  const roleRows = await prisma.staffRole.findMany({ where: { status: "Active" } });
  const assignedClasses = await prisma.schoolClass.findMany({
    where: {
      OR: [
        { class_teacher_id: teacher.id },
        ...(teacher.staff_id ? [{ class_teacher_id: teacher.staff_id }] : []),
        ...(teacher.user_id ? [{ class_teacher_id: teacher.user_id }] : []),
      ],
    },
    select: { name: true },
  });
  const classNames = [...new Set([
    teacher.assigned_class,
    teacher.form_teacher_class,
    ...assignedClasses.map(({ name }) => name),
  ].filter(Boolean))];
  const classRecords = classNames.length
    ? await prisma.schoolClass.findMany({ where: { name: { in: classNames } } })
    : [];
  const students = classNames.length
    ? await prisma.student.findMany({
        where: { current_class: { in: classNames }, status: "Active" },
      })
    : [];
  const studentIds = students.map(({ id }) => id);
  const studentLinks = studentIds.length
    ? await prisma.parentStudent.findMany({ where: { student_id: { in: studentIds } } })
    : [];
  const parentWhere = [
    ...studentLinks.flatMap((link) => [
      ...(link.parent_user_id ? [{ id: link.parent_user_id }] : []),
      ...(link.parent_id ? [{ parent_id: link.parent_id }] : []),
      ...(link.parent_email ? [{ email: link.parent_email }] : []),
    ]),
    ...students.flatMap((student) => [
      ...(student.parent_id ? [{ parent_id: student.parent_id }] : []),
      ...(student.parent_email ? [{ email: student.parent_email }] : []),
      ...(student.parent_phone
        ? [
            { phone: student.parent_phone },
            ...(normalizeChatPhone(student.parent_phone).length >= 4
              ? [{ phone: { contains: normalizeChatPhone(student.parent_phone).slice(-4) } }]
              : []),
          ]
        : []),
    ]),
  ];
  const parents = parentWhere.length
    ? await prisma.parent.findMany({ where: { OR: parentWhere } })
    : [];
  const conversationsById = new Map();
  const classesByName = new Map(classRecords.map((classRecord) => [classRecord.name, classRecord]));
  const addConversation = (parent, student, conversationId) => {
    const classRecord = classesByName.get(student.current_class);
    const recipientRole = getTeacherChatRole(teacher, student, classRecord, roleRows);
    if (!recipientRole || !parent) return;
    conversationsById.set(conversationId, {
      conversation_id: conversationId,
      parent_id: parent.id,
      parent_name: parent.full_name ||
        `${parent.first_name || ""} ${parent.last_name || ""}`.trim() ||
        "Parent",
      student_id: student.id,
      student_name: `${student.first_name} ${student.last_name}`.trim(),
      student_class: student.current_class,
      recipient_id: teacher.id,
      recipient_name: `${teacher.first_name} ${teacher.last_name}`.trim(),
      recipient_role: recipientRole,
    });
  };

  students.forEach((student) => {
    const links = studentLinks.filter((link) => link.student_id === student.id);
    const matchingParents = parents.filter((parent) =>
      links.some((link) =>
        link.parent_user_id === parent.id ||
        (link.parent_id && link.parent_id === parent.parent_id) ||
        (link.parent_email && link.parent_email.toLowerCase() === parent.email?.toLowerCase())
      ) ||
      (student.parent_id && student.parent_id === parent.parent_id) ||
      (student.parent_email && student.parent_email.toLowerCase() === parent.email?.toLowerCase()) ||
      (student.parent_phone && normalizeChatPhone(student.parent_phone) &&
        normalizeChatPhone(student.parent_phone) === normalizeChatPhone(parent.phone))
    );
    matchingParents.forEach((parent) =>
      addConversation(parent, student, `parent-chat:${parent.id}:${student.id}:${teacher.id}`)
    );
  });

  return { teacher, conversations: [...conversationsById.values()] };
}

async function getStaffChatIdentity(req) {
  if (!isStaffChatUser(req)) return null;
  const profileType = String(req.user?.profile_type || "").toLowerCase();
  const profileId = req.user?.profile_id || req.user?.id;
  const email = req.user?.email;

  if (profileType === "teacher" || getStaffChatRoles(req).some((role) =>
    ["teacher", "head teacher", "principal"].includes(role)
  )) {
    const teacher = profileId
      ? await prisma.teacher.findUnique({ where: { id: profileId } })
      : email
        ? await prisma.teacher.findFirst({ where: { email } })
        : null;
    if (teacher) {
      return {
        id: teacher.id,
        profile_type: "Teacher",
        name: `${teacher.first_name} ${teacher.last_name}`.trim(),
        role: String(teacher.teacher_type || "Teacher").replace(/_/g, " "),
      };
    }
  }

  if (profileType === "adminuser" || getStaffChatRoles(req).includes("admin")) {
    const admin = profileId
      ? await prisma.adminUser.findUnique({ where: { id: profileId } })
      : email
        ? await prisma.adminUser.findUnique({ where: { email } })
        : null;
    if (admin) {
      return {
        id: admin.id,
        profile_type: "AdminUser",
        name: `${admin.first_name} ${admin.last_name}`.trim(),
        role: "Administrator",
      };
    }
  }

  if (profileType === "nonacademicstaff" ||
    getStaffChatRoles(req).some((role) => ["accountant", "non academic staff"].includes(role))) {
    const staff = profileId
      ? await prisma.nonAcademicStaff.findUnique({ where: { id: profileId } })
      : email
        ? await prisma.nonAcademicStaff.findFirst({ where: { email } })
        : null;
    if (staff) {
      return {
        id: staff.id,
        profile_type: "NonAcademicStaff",
        name: `${staff.first_name} ${staff.last_name}`.trim(),
        role: staff.role || "Staff",
      };
    }
  }
  return null;
}

async function getStaffChatScope(req) {
  const currentUser = await getStaffChatIdentity(req);
  if (!currentUser) return { currentUser: null, contacts: [] };

  const [teachers, staff, admins] = await Promise.all([
    prisma.teacher.findMany({
      where: { status: "Active" },
      select: { id: true, first_name: true, last_name: true, teacher_type: true },
    }),
    prisma.nonAcademicStaff.findMany({
      where: { status: "Active" },
      select: { id: true, first_name: true, last_name: true, role: true },
    }),
    prisma.adminUser.findMany({
      select: { id: true, first_name: true, last_name: true },
    }),
  ]);
  const contacts = [
    ...teachers.map((teacher) => ({
      id: teacher.id,
      profile_type: "Teacher",
      name: `${teacher.first_name} ${teacher.last_name}`.trim(),
      role: String(teacher.teacher_type || "Teacher").replace(/_/g, " "),
    })),
    ...staff.map((person) => ({
      id: person.id,
      profile_type: "NonAcademicStaff",
      name: `${person.first_name} ${person.last_name}`.trim(),
      role: person.role || "Staff",
    })),
    ...admins.map((admin) => ({
      id: admin.id,
      profile_type: "AdminUser",
      name: `${admin.first_name} ${admin.last_name}`.trim(),
      role: "Administrator",
    })),
  ]
    .filter((contact) =>
      contact.id !== currentUser.id || contact.profile_type !== currentUser.profile_type
    )
    .map((contact) => ({
      ...contact,
      conversation_id: staffChatConversationId(currentUser, contact),
    }));

  return { currentUser, contacts };
}

function isFeePaymentModel(model) {
  return model === "SchoolFeePayment" || model === "FeePayment";
}

function missingFeePaymentLinkConditions(field) {
  return [
    { [field]: null },
    { [field]: "" },
    ...["N/A", "null", "undefined"].map((value) => ({
      [field]: { equals: value, mode: "insensitive" },
    })),
  ];
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

async function getStudentFeePaymentLinks(student) {
  const links = [{ student_id: student.id }];
  if (student.admission_number) {
    links.push(
      { admission_number: student.admission_number },
      { student_id: student.admission_number },
    );
  }

  const nameMatches = await prisma.student.findMany({
    where: {
      first_name: { equals: student.first_name, mode: "insensitive" },
      last_name: { equals: student.last_name, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (nameMatches.length === 1 && nameMatches[0].id === student.id) {
    const nameVariants = [
      [student.first_name, student.middle_name, student.last_name]
        .filter(Boolean)
        .join(" "),
      `${student.first_name} ${student.middle_name || ""} ${student.last_name}`.trim(),
      `${student.first_name} ${student.last_name}`,
    ].filter(Boolean);

    if (nameVariants.length) {
      links.push({
        student_name: { in: [...new Set(nameVariants)], mode: "insensitive" },
        AND: [
          { OR: missingFeePaymentLinkConditions("student_id") },
          { OR: missingFeePaymentLinkConditions("admission_number") },
        ],
      });
    }
  }

  return links;
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
router.get("/chat/conversations", authenticate, async (req, res) => {
  try {
    const scope = isParentChatUser(req)
      ? await getParentChatScope(req)
      : await getTeacherParentChatScope(req);
    if (!isParentChatUser(req) && (!isEligibleParentChatStaff(req) || !scope.teacher)) {
      return res.status(403).json({ error: "Parent chat is only available to parents and eligible class staff." });
    }
    return res.json(scope.conversations);
  } catch (err) {
    console.error("[GET /chat/conversations]", err);
    return res.status(500).json({ error: "Failed to load class chat conversations." });
  }
});

router.get("/chat/staff-contacts", authenticate, async (req, res) => {
  try {
    const scope = await getStaffChatScope(req);
    if (!scope.currentUser) {
      return res.status(403).json({ error: "Staff chat is only available to school staff." });
    }
    return res.json(scope.contacts);
  } catch (err) {
    console.error("[GET /chat/staff-contacts]", err);
    return res.status(500).json({ error: "Failed to load staff chat contacts." });
  }
});

router.get("/chat/parent-announcements", authenticate, async (req, res) => {
  if (!isParentChatUser(req)) {
    return res.status(403).json({ error: "Only parents can access parent announcements." });
  }

  try {
    const announcements = await prisma.message.findMany({
      where: {
        message_type: { in: ["Broadcast:All", "Broadcast:Parents"] },
        sender_role: { in: ["admin", "director"] },
        recipient_id: null,
        to_user_id: null,
      },
      orderBy: { created_date: "desc" },
      take: 100,
    });
    return res.json(announcements);
  } catch (err) {
    console.error("[GET /chat/parent-announcements]", err);
    return res.status(500).json({ error: "Failed to load parent announcements." });
  }
});

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
      const where = model === "ChatMessage"
        ? isParentChatUser(req)
          ? {
            conversation_id: {
              in: (await getParentChatScope(req)).conversations.map((item) => item.conversation_id),
            },
          }
          : {
              OR: [
                { conversation_id: null },
                {
                  AND: [
                    { conversation_id: { not: { startsWith: "parent-chat:" } } },
                    { conversation_id: { not: { startsWith: "staff-chat:" } } },
                  ],
                },
              ],
            }
        : undefined;
      if (model === "ChatMessage" && !isParentChatUser(req) && isStaffChatUser(req)) {
        const scope = await getStaffChatScope(req);
        where.OR.push({
          conversation_id: {
            in: scope.contacts.map((contact) => contact.conversation_id),
          },
        });
      }
      const records = await db.findMany({ where, orderBy, take });
      return res.json(toUIEnums(records)
        .map((record) => omitResultTokenSnapshot(record, model))
        .filter((record) => sanitizeExamForStudent(record, req, model)));
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
      if (model === "ChatMessage" && isParentChatUser(req)) {
        const scope = await getParentChatScope(req);
        const allowedIds = scope.conversations.map((item) => item.conversation_id);
        if (where.conversation_id && !allowedIds.includes(where.conversation_id)) {
          return res.status(403).json({ error: "You cannot access this chat conversation." });
        }
        where.conversation_id = { in: allowedIds };
      } else if (model === "ChatMessage") {
        if (isParentChatConversationId(where.conversation_id)) {
          const scope = await getTeacherParentChatScope(req);
          if (!scope.conversations.some((item) => item.conversation_id === where.conversation_id)) {
            return res.status(403).json({ error: "You cannot access this parent conversation." });
          }
        } else if (typeof where.conversation_id === "string" &&
          where.conversation_id.startsWith("staff-chat:")) {
          const scope = await getStaffChatScope(req);
          if (!scope.contacts.some((contact) => contact.conversation_id === where.conversation_id)) {
            return res.status(403).json({ error: "You cannot access this staff conversation." });
          }
        } else {
          where.AND = [
            ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
            {
              OR: [
                { conversation_id: null },
                {
                  AND: [
                    { conversation_id: { not: { startsWith: "parent-chat:" } } },
                    { conversation_id: { not: { startsWith: "staff-chat:" } } },
                  ],
                },
              ],
            },
          ];
        }
      }
      if (isStudentUser(req) && isFeePaymentModel(model)) {
        const student = await getStudentFeePaymentScope(req);
        if (!student) return res.status(403).json({ error: "Student profile not found." });

        delete where.admission_number;
        delete where.student_id;
        where.OR = await getStudentFeePaymentLinks(student);
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
      if (
        model === "ChatMessage" &&
        isParentChatUser(req) &&
        !(
          await getParentChatScope(req)
        ).conversations.some((item) => item.conversation_id === record.conversation_id)
      ) {
        return res.status(404).json({ error: "Record not found." });
      }
      if (
        model === "ChatMessage" &&
        isParentChatConversationId(record.conversation_id) &&
        !isParentChatUser(req)
      ) {
        const scope = await getTeacherParentChatScope(req);
        if (!scope.conversations.some((item) => item.conversation_id === record.conversation_id)) {
          return res.status(404).json({ error: "Record not found." });
        }
      }
      if (model === "ChatMessage" && record.conversation_id?.startsWith("staff-chat:")) {
        const scope = await getStaffChatScope(req);
        if (!scope.contacts.some((contact) => contact.conversation_id === record.conversation_id)) {
          return res.status(404).json({ error: "Record not found." });
        }
      }
      if (isStudentUser(req) && isFeePaymentModel(model)) {
        const student = await getStudentFeePaymentScope(req);
        if (!student) return res.status(403).json({ error: "Student profile not found." });
        const ownsPayment = record.student_id === student.id ||
          (student.admission_number &&
            (record.admission_number === student.admission_number ||
              record.student_id === student.admission_number));
        if (!ownsPayment) return res.status(404).json({ error: "Record not found." });
      }
      const visibleRecord = sanitizeExamForStudent(
        omitResultTokenSnapshot(toUIEnums(record), model),
        req,
        model,
      );
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

      if (model === "ResultToken") {
        return res.status(400).json({ error: "Generate result tokens through the result-token generation endpoint." });
      }
      if (["Result", "ReportCard"].includes(model) && await hasIssuedResultToken(toPrismaEnums(rawData))) {
        return res.status(409).json({ error: "This result is locked because a result token has already been generated." });
      }

      if (model === "Message" && String(rawData.message_type || "").startsWith("Broadcast:")) {
        const roles = [
          req.user?.role,
          ...(Array.isArray(req.user?.roles) ? req.user.roles : []),
        ].map((role) => String(role || "").toLowerCase().replace(/_/g, " "));
        const isDirector = String(req.user?.profile_type || "").toLowerCase() === "director" ||
          roles.includes("director");
        const isAdmin = roles.includes("admin");
        if (!isDirector && !isAdmin) {
          return res.status(403).json({ error: "Only directors and administrators can send broadcast announcements." });
        }
        if (!["Broadcast:All", "Broadcast:Parents", "Broadcast:Teachers", "Broadcast:Students"].includes(rawData.message_type)) {
          return res.status(400).json({ error: "Choose a valid broadcast audience." });
        }
        if (!String(rawData.subject || "").trim() || !String(rawData.content || "").trim()) {
          return res.status(400).json({ error: "Announcement title and content are required." });
        }
        rawData.sender_id = req.user?.profile_id || req.user?.id;
        rawData.sender_role = isDirector ? "director" : "admin";
        rawData.sender_name = isDirector ? "Director's Office" : "Admin Office";
        rawData.recipient_id = null;
        rawData.recipient_name = null;
        rawData.to_user_id = null;
        rawData.to_name = null;
      }

      if (model === "ChatMessage" && isParentChatUser(req)) {
        const scope = await getParentChatScope(req);
        const conversation = scope.conversations.find(
          (item) => item.conversation_id === rawData.conversation_id
        );
        if (!conversation) {
          return res.status(403).json({ error: "You can only message the class staff assigned to your children." });
        }
        rawData.sender_id = scope.parent.id;
        rawData.sender_name = scope.parent.full_name ||
          `${scope.parent.first_name || ""} ${scope.parent.last_name || ""}`.trim() ||
          scope.conversations.find((item) => item.parent_id === scope.parent.id)?.parent_name ||
          "Parent";
        rawData.sender_role = "Parent";
        rawData.recipient_id = conversation.recipient_id;
        rawData.recipient_name = conversation.recipient_name;
        rawData.channel = conversation.conversation_id;
        rawData.conversation_id = conversation.conversation_id;
        rawData.is_broadcast = false;
        rawData.target_audience = null;
        if (!String(rawData.message || rawData.content || "").trim()) {
          return res.status(400).json({ error: "Message cannot be empty." });
        }
      } else if (
        model === "ChatMessage" &&
        isParentChatConversationId(rawData.conversation_id)
      ) {
        const scope = await getTeacherParentChatScope(req);
        const conversation = scope.conversations.find(
          (item) => item.conversation_id === rawData.conversation_id
        );
        if (!conversation) {
          return res.status(403).json({ error: "You cannot message this parent conversation." });
        }
        rawData.sender_id = scope.teacher.id;
        rawData.sender_name = `${scope.teacher.first_name} ${scope.teacher.last_name}`.trim();
        rawData.sender_role = conversation.recipient_role;
        rawData.recipient_id = conversation.parent_id;
        rawData.recipient_name = conversation.parent_name;
        rawData.channel = conversation.conversation_id;
        rawData.is_broadcast = false;
        rawData.target_audience = null;
        if (!String(rawData.message || rawData.content || "").trim()) {
          return res.status(400).json({ error: "Message cannot be empty." });
        }
      } else if (
        model === "ChatMessage" &&
        typeof rawData.conversation_id === "string" &&
        rawData.conversation_id.startsWith("staff-chat:")
      ) {
        const scope = await getStaffChatScope(req);
        const contact = scope.contacts.find(
          (item) => item.conversation_id === rawData.conversation_id
        );
        if (!scope.currentUser || !contact) {
          return res.status(403).json({ error: "You cannot message this staff conversation." });
        }
        rawData.sender_id = scope.currentUser.id;
        rawData.sender_name = scope.currentUser.name;
        rawData.sender_role = scope.currentUser.role;
        rawData.recipient_id = contact.id;
        rawData.recipient_name = contact.name;
        rawData.channel = rawData.conversation_id;
        rawData.is_broadcast = false;
        rawData.target_audience = null;
        if (!String(rawData.message || rawData.content || "").trim()) {
          return res.status(400).json({ error: "Message cannot be empty." });
        }
      }

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
      const record = ["Result", "ReportCard"].includes(model)
        ? await prisma.$transaction(async (tx) => {
          if (await hasIssuedResultToken(prismaData, tx)) throw lockedResultError();
          return (model === "Result" ? tx.result : tx.reportCard).create({ data: prismaData });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        : await db.create({ data: prismaData });
      return res.status(201).json(omitResultTokenSnapshot(toUIEnums(record), model));
    } catch (err) {
      if (err.code === "RESULT_LOCKED") return res.status(409).json({ error: err.message });
      if (err.code === "P2034") {
        return res.status(409).json({ error: "A result token was generated concurrently. Refresh and try again." });
      }
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

      if (model === "ResultToken" && Object.keys(rawData).some((field) => !["status", "is_used"].includes(field))) {
        return res.status(409).json({ error: "Issued result-token details and snapshots cannot be changed." });
      }
      if (["Result", "ReportCard"].includes(model)) {
        const existingResult = model === "Result"
          ? await prisma.result.findUnique({ where: { id } })
          : await prisma.reportCard.findUnique({ where: { id } });
        if (existingResult && await hasIssuedResultToken(existingResult)) {
          return res.status(409).json({ error: "This result is locked because a result token has already been generated." });
        }
      }

      if (model === "ChatMessage") {
        if (isParentChatUser(req)) {
          return res.status(403).json({ error: "Chat messages cannot be edited." });
        }
        const existingMessage = await prisma.chatMessage.findUnique({ where: { id } });
        if (existingMessage && isParentChatConversationId(existingMessage.conversation_id)) {
          const scope = await getTeacherParentChatScope(req);
          if (!scope.conversations.some((item) => item.conversation_id === existingMessage.conversation_id)) {
            return res.status(404).json({ error: "Record not found." });
          }
          return res.status(403).json({ error: "Parent chat messages cannot be edited." });
        }
        if (existingMessage?.conversation_id?.startsWith("staff-chat:")) {
          const scope = await getStaffChatScope(req);
          if (!scope.contacts.some((contact) => contact.conversation_id === existingMessage.conversation_id)) {
            return res.status(404).json({ error: "Record not found." });
          }
          return res.status(403).json({ error: "Staff chat messages cannot be edited." });
        }
      }

      if (model === "Teacher" && req.user?.role === "director") {
        if (Object.keys(rawData).some((field) => field !== "salary")) {
          return res.status(403).json({ error: "Directors can only update teacher salary through this endpoint." });
        }
        const salary = Number(rawData.salary);
        if (!Number.isFinite(salary) || salary <= 0) {
          return res.status(400).json({ error: "Salary must be a valid amount greater than zero." });
        }
        rawData.salary = salary;
      }

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

      const record = ["Result", "ReportCard"].includes(model)
        ? await prisma.$transaction(async (tx) => {
          const resultDb = model === "Result" ? tx.result : tx.reportCard;
          const existingResult = await resultDb.findUnique({ where: { id } });
          if (existingResult && await hasIssuedResultToken(existingResult, tx)) throw lockedResultError();
          return resultDb.update({ where: { id }, data: prismaData });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        : await db.update({ where: { id }, data: prismaData });
      return res.json(omitResultTokenSnapshot(toUIEnums(record), model));
    } catch (err) {
      if (err.code === "RESULT_LOCKED") return res.status(409).json({ error: err.message });
      if (err.code === "P2034") {
        return res.status(409).json({ error: "A result token was generated concurrently. Refresh and try again." });
      }
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
      if (model === "ResultToken") {
        return res.status(409).json({ error: "Issued result tokens cannot be deleted." });
      }
      if (["Result", "ReportCard"].includes(model)) {
        const existingResult = model === "Result"
          ? await prisma.result.findUnique({ where: { id } })
          : await prisma.reportCard.findUnique({ where: { id } });
        if (existingResult && await hasIssuedResultToken(existingResult)) {
          return res.status(409).json({ error: "This result is locked because a result token has already been generated." });
        }
      }
      if (["Result", "ReportCard"].includes(model)) {
        await prisma.$transaction(async (tx) => {
          const resultDb = model === "Result" ? tx.result : tx.reportCard;
          const existingResult = await resultDb.findUnique({ where: { id } });
          if (existingResult && await hasIssuedResultToken(existingResult, tx)) throw lockedResultError();
          await resultDb.delete({ where: { id } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } else {
        await db.delete({ where: { id } });
      }
      return res.json({ success: true, id });
    } catch (err) {
      if (err.code === "RESULT_LOCKED") return res.status(409).json({ error: err.message });
      if (err.code === "P2034") {
        return res.status(409).json({ error: "A result token was generated concurrently. Refresh and try again." });
      }
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
