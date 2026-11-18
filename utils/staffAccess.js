import prisma from "../config/prisma.js";

const isActivePortalStatus = (status) =>
  String(status || "").trim().toLowerCase() === "active";

const emailCondition = (email) =>
  email ? { email: { equals: email, mode: "insensitive" } } : null;

export async function hasActivePortalAccess(user, database = prisma) {
  const profileType = String(user.profile_type || "").toLowerCase();
  const roles = [user.role, ...(Array.isArray(user.roles) ? user.roles : [])]
    .map((role) => String(role || "").toLowerCase());
  const isStudent = profileType === "student" || roles.includes("student");
  const isParent = profileType === "parent" || roles.includes("parent");
  const isStudentOrParent = isStudent || isParent;

  if (isStudent) {
    const studentConditions = [
      ...(user.profile_id ? [{ id: String(user.profile_id) }] : []),
      ...(user.id ? [{ id: String(user.id) }] : []),
      ...((user.admission_number || user.username)
        ? [{ admission_number: user.admission_number || user.username }]
        : []),
    ];
    const students = studentConditions.length
      ? await database.student.findMany({
          where: { OR: studentConditions },
          select: { status: true },
        })
      : [];
    return students.length > 0 &&
      students.every(({ status }) => isActivePortalStatus(status));
  }

  if (isParent) {
    const parentConditions = [
      ...(user.profile_id ? [{ id: String(user.profile_id) }] : []),
      ...(user.id ? [{ id: String(user.id) }] : []),
      ...((user.parent_id || user.username)
        ? [{ parent_id: user.parent_id || user.username }]
        : []),
      ...(user.user_id ? [{ user_id: String(user.user_id) }] : []),
      ...(user.email ? [emailCondition(String(user.email).trim())] : []),
    ];
    const parents = parentConditions.length
      ? await database.parent.findMany({
          where: { OR: parentConditions },
          select: { status: true },
        })
      : [];
    return parents.length > 0 &&
      parents.every(({ status }) => isActivePortalStatus(status));
  }

  if (profileType === "adminuser" || profileType === "admin") return true;
  const isNonAcademicStaff =
    profileType === "nonacademicstaff" || roles.includes("accountant");
  const isTeacher = profileType === "teacher" ||
    roles.some((role) => ["teacher", "head_teacher", "principal"].includes(role)) ||
    Boolean(user.teacher_type);
  const email = String(user.email || "").trim();
  const staffId = String(
    user.staff_id || (isTeacher || isNonAcademicStaff ? user.username : "") || "",
  ).trim();
  const profileId = String(user.profile_id || "").trim();

  const teacherConditions = [
    ...(profileId && (isTeacher || profileType === "teacher") ? [{ id: profileId }] : []),
    ...(user.id && profileType === "teacher" ? [{ id: user.id }] : []),
    ...(staffId ? [{ staff_id: staffId }] : []),
    ...(email && !isStudentOrParent ? [emailCondition(email)] : []),
  ].filter(Boolean);

  if (!isStudentOrParent && teacherConditions.length) {
    const teachers = await database.teacher.findMany({
      where: { OR: teacherConditions },
      select: { status: true },
    });
    if (isTeacher && !teachers.length) return false;
    if (teachers.some(({ status }) => !isActivePortalStatus(status))) return false;
  }

  const staffConditions = [
    ...(profileId && isNonAcademicStaff ? [{ id: profileId }] : []),
    ...(user.id && isNonAcademicStaff ? [{ id: user.id }] : []),
    ...(staffId ? [{ staff_id: staffId }] : []),
    ...(email && !isStudentOrParent ? [emailCondition(email)] : []),
  ].filter(Boolean);

  if (!isStudentOrParent && staffConditions.length) {
    const staffRecords = await database.nonAcademicStaff.findMany({
      where: { OR: staffConditions },
      select: { status: true },
    });
    if (
      (isNonAcademicStaff && !staffRecords.length) ||
      staffRecords.some(({ status }) => !isActivePortalStatus(status))
    ) {
      return false;
    }
  }

  const staffRoleConditions = [
    ...(email ? [{ user_email: { equals: email, mode: "insensitive" } }] : []),
    ...(user.id ? [{ user_id: user.id }] : []),
    ...(staffId ? [{ teacher_id: staffId }, { user_id: staffId }] : []),
    ...(profileId ? [{ teacher_id: profileId }, { user_id: profileId }] : []),
  ];
  if (!["student", "parent"].includes(profileType) && staffRoleConditions.length) {
    const staffRoles = await database.staffRole.findMany({
      where: { OR: staffRoleConditions },
      select: { status: true },
    });
    if (staffRoles.some(({ status }) => !isActivePortalStatus(status))) return false;
  }

  return true;
}
