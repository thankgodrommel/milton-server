import prisma from "../config/prisma.js";

export const isDeactivatedStaffStatus = (status) =>
  ["inactive", "deactivated", "terminated"].includes(
    String(status || "").trim().toLowerCase(),
  );

const emailCondition = (email) =>
  email ? { email: { equals: email, mode: "insensitive" } } : null;

export async function hasActiveStaffAccess(user) {
  const profileType = String(user.profile_type || "").toLowerCase();
  const roles = [user.role, ...(Array.isArray(user.roles) ? user.roles : [])]
    .map((role) => String(role || "").toLowerCase());
  if (profileType === "adminuser" || profileType === "admin") return true;
  const isTeacher = profileType === "teacher" ||
    roles.some((role) => ["teacher", "head_teacher", "principal"].includes(role)) ||
    Boolean(user.teacher_type || user.staff_id);
  const isNonAcademicStaff = profileType === "nonacademicstaff";
  const email = String(user.email || "").trim();
  const staffId = String(user.staff_id || (isTeacher ? user.username : "") || "").trim();
  const profileId = String(user.profile_id || "").trim();

  const teacherConditions = [
    ...(profileId && (isTeacher || profileType === "teacher") ? [{ id: profileId }] : []),
    ...(user.id && profileType === "teacher" ? [{ id: user.id }] : []),
    ...(staffId ? [{ staff_id: staffId }] : []),
    ...(isTeacher && email ? [emailCondition(email)] : []),
  ].filter(Boolean);

  if (isTeacher && teacherConditions.length) {
    const teacher = await prisma.teacher.findFirst({ where: { OR: teacherConditions } });
    if ((profileType === "teacher" || user.teacher_type) && !teacher) return false;
    if (teacher && isDeactivatedStaffStatus(teacher.status)) return false;
  }

  const staffConditions = [
    ...(profileId && isNonAcademicStaff ? [{ id: profileId }] : []),
    ...(user.id && isNonAcademicStaff ? [{ id: user.id }] : []),
    ...(staffId ? [{ staff_id: staffId }] : []),
    ...(isNonAcademicStaff && email ? [emailCondition(email)] : []),
  ].filter(Boolean);

  if (isNonAcademicStaff && staffConditions.length) {
    const staff = await prisma.nonAcademicStaff.findFirst({ where: { OR: staffConditions } });
    if (!staff || isDeactivatedStaffStatus(staff.status)) return false;
  }

  const staffRoleConditions = [
    ...(email ? [{ user_email: { equals: email, mode: "insensitive" } }] : []),
    ...(staffId ? [{ teacher_id: staffId }, { user_id: staffId }] : []),
    ...(profileId ? [{ teacher_id: profileId }, { user_id: profileId }] : []),
  ];
  if (!["student", "parent"].includes(profileType) && staffRoleConditions.length) {
    const staffRoles = await prisma.staffRole.findMany({
      where: { OR: staffRoleConditions },
      select: { status: true },
    });
    if (staffRoles.length && !staffRoles.some(({ status }) =>
      String(status || "").toLowerCase() === "active")) {
      return false;
    }
  }

  return true;
}
