import prisma from "../config/prisma.js";

export const isDeactivatedStaffStatus = (status) =>
  ["inactive", "deactivated", "terminated"].includes(
    String(status || "").trim().toLowerCase(),
  );

const emailCondition = (email) =>
  email ? { email: { equals: email, mode: "insensitive" } } : null;

export async function hasActiveStaffAccess(user, database = prisma) {
  const profileType = String(user.profile_type || "").toLowerCase();
  const roles = [user.role, ...(Array.isArray(user.roles) ? user.roles : [])]
    .map((role) => String(role || "").toLowerCase());
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
    ...(isTeacher && email ? [emailCondition(email)] : []),
  ].filter(Boolean);

  if (isTeacher && teacherConditions.length) {
    const teachers = await database.teacher.findMany({
      where: { OR: teacherConditions },
      select: { status: true },
    });
    if ((profileType === "teacher" || user.teacher_type) && !teachers.length) return false;
    if (teachers.some(({ status }) => isDeactivatedStaffStatus(status))) return false;
  }

  const staffConditions = [
    ...(profileId && isNonAcademicStaff ? [{ id: profileId }] : []),
    ...(user.id && isNonAcademicStaff ? [{ id: user.id }] : []),
    ...(staffId ? [{ staff_id: staffId }] : []),
    ...(isNonAcademicStaff && email ? [emailCondition(email)] : []),
  ].filter(Boolean);

  if (isNonAcademicStaff && staffConditions.length) {
    const staffRecords = await database.nonAcademicStaff.findMany({
      where: { OR: staffConditions },
      select: { status: true },
    });
    if (
      !staffRecords.length ||
      staffRecords.some(({ status }) => isDeactivatedStaffStatus(status))
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
    if (staffRoles.some(({ status }) => isDeactivatedStaffStatus(status))) return false;
  }

  return true;
}
