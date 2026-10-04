import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma.js";
import { generateToken, authenticate } from "../middleware/auth.js";
import { sendEmail } from "../services/email.js";

const router = Router();

async function normalizePassword(password) {
  if (!password) return null;
  return password.startsWith("$2") ? password : await bcrypt.hash(password, 12);
}

async function syncGenericUser({
  email,
  username,
  password,
  role,
  first_name,
  last_name,
  profile_type,
  profile_id,
}) {
  const filters = [];
  if (email) filters.push({ email: email.toLowerCase() });
  if (username) filters.push({ username: username.trim() });
  if (profile_type && profile_id) filters.push({ profile_type, profile_id });

  const where = filters.length ? { OR: filters } : null;
  const existing = where ? await prisma.user.findFirst({ where }) : null;
  const hashedPassword = password
    ? await normalizePassword(password)
    : undefined;

  const data = {
    role,
    first_name,
    last_name,
    profile_type,
    profile_id,
  };
  if (email) data.email = email.toLowerCase();
  if (username) data.username = username.trim();
  if (hashedPassword) data.password = hashedPassword;

  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data });
    return existing;
  }

  return prisma.user.create({ data });
}

async function resolveStaffRoles(email, staffId, defaultType) {
  const rolesSet = new Set();

  if (defaultType === "Principal") rolesSet.add("principal");
  if (defaultType === "Head Teacher") rolesSet.add("head_teacher");
  if (
    defaultType === "Class Teacher" ||
    defaultType === "Subject Teacher" ||
    defaultType === "Form Teacher"
  )
    rolesSet.add("teacher");
  if (defaultType === "director" || defaultType === "Director") {
    rolesSet.add("director");
  }

  if (email || staffId) {
    const userRec = await prisma.user
      .findFirst({
        where: {
          OR: [
            ...(email ? [{ email: email.toLowerCase() }] : []),
            ...(staffId ? [{ username: staffId }] : []),
          ],
        },
      })
      .catch(() => null);

    if (userRec?.profile_type?.toLowerCase() === "director") {
      rolesSet.add("director");
    }

    const staffRoles = await prisma.staffRole
      .findMany({
        where: {
          OR: [
            ...(email ? [{ user_email: email.toLowerCase() }] : []),
            ...(staffId
              ? [{ user_id: staffId }, { teacher_id: staffId }]
              : []),
          ],
          status: "Active",
        },
      })
      .catch(() => []);

    for (const sr of staffRoles) {
      if (sr.role === "Admin") rolesSet.add("admin");
      if (sr.role === "Principal") rolesSet.add("principal");
      if (sr.role === "Head_Teacher" || sr.role === "Head Teacher")
        rolesSet.add("head_teacher");
      if (sr.role === "Accountant") rolesSet.add("accountant");
      if (sr.role === "Teacher") rolesSet.add("teacher");
    }
  }

  if (email) {
    const adminUser = await prisma.adminUser
      .findUnique({ where: { email: email.toLowerCase() } })
      .catch(() => null);
    if (adminUser) rolesSet.add("admin");
  }

  const teacher =
    staffId || email
      ? await prisma.teacher
          .findFirst({
            where: {
              OR: [
                ...(staffId ? [{ staff_id: staffId }] : []),
                ...(email ? [{ email: email.toLowerCase() }] : []),
              ],
            },
          })
          .catch(() => null)
      : null;

  if (teacher) {
    if (teacher.teacher_type === "Principal") rolesSet.add("principal");
    if (teacher.teacher_type === "Head Teacher") rolesSet.add("head_teacher");
    if (
      teacher.teacher_type === "Class Teacher" ||
      teacher.teacher_type === "Subject Teacher" ||
      teacher.teacher_type === "Form Teacher" ||
      teacher.assigned_class ||
      teacher.form_teacher_class ||
      (teacher.assigned_subjects &&
        Array.isArray(teacher.assigned_subjects) &&
        teacher.assigned_subjects.length > 0)
    ) {
      rolesSet.add("teacher");
    }
  }

  // Directors must NOT have the admin role
  if (rolesSet.has("director")) {
    rolesSet.delete("admin");
  }

  const roleHierarchy = [
    "director",
    "admin",
    "principal",
    "head_teacher",
    "accountant",
    "teacher",
    "student",
    "parent",
  ];
  let highestRole = defaultType
    ? defaultType.toLowerCase().replace(" ", "_")
    : "teacher";

  for (const h of roleHierarchy) {
    if (rolesSet.has(h)) {
      highestRole = h;
      break;
    }
  }

  if (rolesSet.size === 0 && highestRole) {
    rolesSet.add(highestRole);
  }

  return { highestRole, roles: Array.from(rolesSet) };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login — Unified login across all authenticated roles
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res
        .status(400)
        .json({ error: "Identifier and password are required." });
    }

    const loginKey = identifier.trim();
    const emailKey = loginKey.toLowerCase();

    const student = await prisma.student.findUnique({
      where: { admission_number: loginKey },
    });
    if (student) {
      let valid = false;
      if (student.custom_password) {
        const isBcrypt = student.custom_password.startsWith("$2");
        if (isBcrypt) {
          valid = await bcrypt.compare(password, student.custom_password);
        } else {
          valid = password === student.custom_password;
        }
      } else {
        valid = password === "User123";
      }

      if (!valid) {
        return res
          .status(401)
          .json({ error: "Invalid admission number or password." });
      }

      await syncGenericUser({
        email: student.parent_email || "",
        username: student.admission_number,
        password: student.custom_password || "User123",
        role: "student",
        first_name: student.first_name,
        last_name: student.last_name,
        profile_type: "Student",
        profile_id: student.id,
      });

      const token = generateToken({
        id: student.id,
        email: student.parent_email || "",
        role: "student",
        username: student.admission_number,
        admission_number: student.admission_number,
        name: `${student.first_name} ${student.last_name}`,
        profile_type: "Student",
        profile_id: student.id,
      });

      return res.json({
        token,
        user: {
          id: student.id,
          email: student.parent_email || "",
          username: student.admission_number,
          admission_number: student.admission_number,
          role: "student",
          first_name: student.first_name,
          last_name: student.last_name,
          profile_type: "Student",
          profile_id: student.id,
        },
      });
    }

    const genericUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: emailKey }, { username: loginKey }],
      },
    });

    if (genericUser && genericUser.password) {
      const isBcrypt = genericUser.password.startsWith("$2");
      const valid = isBcrypt
        ? await bcrypt.compare(password, genericUser.password)
        : password === genericUser.password;

      if (valid) {
        const { highestRole, roles } = await resolveStaffRoles(
          genericUser.email,
          genericUser.username,
          genericUser.role
        );

        let resolvedStaffId = null;
        if (
          roles.includes("teacher") ||
          roles.includes("head_teacher") ||
          roles.includes("principal") ||
          roles.includes("accountant")
        ) {
          const teacherRecord = await prisma.teacher.findFirst({
            where: {
              OR: [
                ...(genericUser.email ? [{ email: genericUser.email.toLowerCase() }] : []),
                ...(genericUser.username ? [{ staff_id: genericUser.username }] : []),
                ...(genericUser.profile_id ? [{ id: genericUser.profile_id }] : []),
              ],
            },
          }).catch(() => null);
          if (teacherRecord) {
            resolvedStaffId = teacherRecord.staff_id;
          }
        }

        const token = generateToken({
          id: genericUser.id,
          email: genericUser.email || "",
          role: highestRole,
          roles,
          username: genericUser.username,
          staff_id: resolvedStaffId || genericUser.username,
          name: `${genericUser.first_name || ""} ${genericUser.last_name || ""}`.trim(),
          profile_type: genericUser.profile_type,
          profile_id: genericUser.profile_id,
        });

        return res.json({
          token,
          user: {
            id: genericUser.id,
            email: genericUser.email,
            username: genericUser.username,
            staff_id: resolvedStaffId || genericUser.username,
            role: highestRole,
            roles,
            first_name: genericUser.first_name,
            last_name: genericUser.last_name,
            profile_type: genericUser.profile_type,
            profile_id: genericUser.profile_id,
          },
        });
      }
    }

    const admin = await prisma.adminUser.findUnique({
      where: { email: emailKey },
    });
    if (admin) {
      const valid = await bcrypt.compare(password, admin.password);
      if (valid) {
        const { highestRole, roles } = await resolveStaffRoles(
          admin.email,
          admin.email,
          admin.role
        );

        await syncGenericUser({
          email: admin.email,
          username: admin.email,
          password: admin.password,
          role: highestRole,
          first_name: admin.first_name,
          last_name: admin.last_name,
          profile_type: "AdminUser",
          profile_id: admin.id,
        });

        const token = generateToken({
          id: admin.id,
          email: admin.email,
          role: highestRole,
          roles,
          username: admin.email,
          name: `${admin.first_name} ${admin.last_name}`,
          profile_type: "AdminUser",
          profile_id: admin.id,
        });

        return res.json({
          token,
          user: {
            id: admin.id,
            email: admin.email,
            username: admin.email,
            role: highestRole,
            roles,
            first_name: admin.first_name,
            last_name: admin.last_name,
            profile_type: "AdminUser",
            profile_id: admin.id,
          },
        });
      }
    }

    const teacher = await prisma.teacher.findFirst({
      where: {
        OR: [{ staff_id: loginKey }, { email: emailKey }],
      },
    });
    if (teacher) {
      let valid = false;
      if (teacher.custom_password) {
        const isBcrypt = teacher.custom_password.startsWith("$2");
        if (isBcrypt) {
          valid = await bcrypt.compare(password, teacher.custom_password);
        } else {
          valid = password === teacher.custom_password;
        }
      } else {
        valid = password === "User123";
      }

      if (valid) {
        const { highestRole, roles } = await resolveStaffRoles(
          teacher.email,
          teacher.staff_id,
          teacher.teacher_type
        );

        await syncGenericUser({
          email: teacher.email,
          username: teacher.staff_id,
          password: teacher.custom_password || "User123",
          role: highestRole,
          first_name: teacher.first_name,
          last_name: teacher.last_name,
          profile_type: "Teacher",
          profile_id: teacher.id,
        });

        const token = generateToken({
          id: teacher.id,
          email: teacher.email,
          role: highestRole,
          roles,
          username: teacher.staff_id,
          name: `${teacher.first_name} ${teacher.last_name}`,
          profile_type: "Teacher",
          profile_id: teacher.id,
        });

        return res.json({
          token,
          user: {
            id: teacher.id,
            email: teacher.email,
            username: teacher.staff_id,
            role: highestRole,
            roles,
            first_name: teacher.first_name,
            last_name: teacher.last_name,
            profile_type: "Teacher",
            profile_id: teacher.id,
          },
        });
      }
    }

    const parent = await prisma.parent.findUnique({
      where: { parent_id: loginKey },
    });
    if (parent) {
      let valid = false;
      if (parent.custom_password) {
        const isBcrypt = parent.custom_password.startsWith("$2");
        if (isBcrypt) {
          valid = await bcrypt.compare(password, parent.custom_password);
        } else {
          valid = password === parent.custom_password;
        }
      } else {
        valid =
          (parent.phone && password === parent.phone) || password === "User123";
      }

      if (valid) {
        await syncGenericUser({
          email: parent.email || "",
          username: parent.parent_id,
          password: parent.custom_password || parent.phone || "User123",
          role: "parent",
          first_name: parent.first_name,
          last_name: parent.last_name,
          profile_type: "Parent",
          profile_id: parent.id,
        });

        const token = generateToken({
          id: parent.id,
          email: parent.email || "",
          role: "parent",
          username: parent.parent_id,
          name: `${parent.first_name || ""} ${parent.last_name || ""}`.trim(),
          profile_type: "Parent",
          profile_id: parent.id,
        });

        return res.json({
          token,
          user: {
            id: parent.id,
            email: parent.email || "",
            username: parent.parent_id,
            role: "parent",
            first_name: parent.first_name,
            last_name: parent.last_name,
            profile_type: "Parent",
            profile_id: parent.id,
          },
        });
      }
    }

    const staff = await prisma.nonAcademicStaff.findUnique({
      where: { staff_id: loginKey },
    });
    if (staff) {
      let valid = false;
      if (staff.custom_password) {
        const isBcrypt = staff.custom_password.startsWith("$2");
        if (isBcrypt) {
          valid = await bcrypt.compare(password, staff.custom_password);
        } else {
          valid = password === staff.custom_password;
        }
      } else {
        valid = password === "admin220" || password === "User123";
      }

      if (valid) {
        await syncGenericUser({
          email: staff.email || "",
          username: staff.staff_id,
          password: staff.custom_password || "admin220",
          role: "accountant",
          first_name: staff.first_name,
          last_name: staff.last_name,
          profile_type: "NonAcademicStaff",
          profile_id: staff.id,
        });

        const token = generateToken({
          id: staff.id,
          email: staff.email || "",
          role: "accountant",
          username: staff.staff_id,
          name: `${staff.first_name} ${staff.last_name}`,
          profile_type: "NonAcademicStaff",
          profile_id: staff.id,
        });

        return res.json({
          token,
          user: {
            id: staff.id,
            email: staff.email || "",
            username: staff.staff_id,
            role: "accountant",
            first_name: staff.first_name,
            last_name: staff.last_name,
            profile_type: "NonAcademicStaff",
            profile_id: staff.id,
          },
        });
      }
    }

    return res.status(401).json({ error: "Invalid credentials." });
  } catch (err) {
    console.error("[auth/login]", err);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/teacher-login — Teacher login (staff_id + password)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/teacher-login", async (req, res) => {
  try {
    const { staff_id, password } = req.body;
    if (!staff_id || !password) {
      return res
        .status(400)
        .json({ error: "Staff ID and password are required." });
    }

    const teacher = await prisma.teacher.findUnique({
      where: { staff_id: staff_id.trim() },
    });
    if (!teacher) {
      return res.status(401).json({ error: "Invalid Staff ID or password." });
    }

    // Support plain-text passwords, bcrypt hashes, and default passwords
    let valid = false;
    if (teacher.custom_password) {
      const isBcrypt = teacher.custom_password.startsWith("$2");
      if (isBcrypt) {
        valid = await bcrypt.compare(password, teacher.custom_password);
      } else {
        valid = password === teacher.custom_password;
      }
    } else {
      valid = password === "User123";
    }

    if (!valid) {
      return res.status(401).json({ error: "Invalid Staff ID or password." });
    }

    const { highestRole, roles } = await resolveStaffRoles(
      teacher.email,
      teacher.staff_id,
      teacher.teacher_type
    );

    await syncGenericUser({
      email: teacher.email,
      username: teacher.staff_id,
      password: teacher.custom_password || "User123",
      role: highestRole,
      first_name: teacher.first_name,
      last_name: teacher.last_name,
      profile_type: "Teacher",
      profile_id: teacher.id,
    });

    const token = generateToken({
      id: teacher.id,
      email: teacher.email,
      role: highestRole,
      roles,
      staff_id: teacher.staff_id,
      name: `${teacher.first_name} ${teacher.last_name}`,
      teacher_type: teacher.teacher_type,
    });

    return res.json({
      token,
      teacher: {
        id: teacher.id,
        staff_id: teacher.staff_id,
        first_name: teacher.first_name,
        last_name: teacher.last_name,
        email: teacher.email,
        teacher_type: teacher.teacher_type,
        section: teacher.section,
        assigned_class: teacher.assigned_class,
        assigned_subjects: teacher.assigned_subjects,
        form_teacher_class: teacher.form_teacher_class,
        role: highestRole,
        roles,
      },
    });
  } catch (err) {
    console.error("[auth/teacher-login]", err);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/student-login — Student login (admission_number + password)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/student-login", async (req, res) => {
  try {
    const { admission_number, password } = req.body;
    if (!admission_number || !password) {
      return res
        .status(400)
        .json({ error: "Admission number and password are required." });
    }

    const student = await prisma.student.findUnique({
      where: { admission_number: admission_number.trim() },
    });
    if (!student) {
      return res
        .status(401)
        .json({ error: "Invalid admission number or password." });
    }

    let valid = false;
    if (student.custom_password) {
      const isBcrypt = student.custom_password.startsWith("$2");
      if (isBcrypt) {
        valid = await bcrypt.compare(password, student.custom_password);
      } else {
        valid = password === student.custom_password;
      }
    } else {
      valid = password === "User123";
    }

    if (!valid) {
      return res
        .status(401)
        .json({ error: "Invalid admission number or password." });
    }

    await syncGenericUser({
      email: student.parent_email || "",
      username: student.admission_number,
      password: student.custom_password || "User123",
      role: "student",
      first_name: student.first_name,
      last_name: student.last_name,
      profile_type: "Student",
      profile_id: student.id,
    });

    const token = generateToken({
      id: student.id,
      email: student.parent_email || "",
      role: "student",
      username: student.admission_number,
      admission_number: student.admission_number,
      name: `${student.first_name} ${student.last_name}`,
      profile_type: "Student",
      profile_id: student.id,
    });

    return res.json({
      token,
      student: {
        id: student.id,
        admission_number: student.admission_number,
        first_name: student.first_name,
        last_name: student.last_name,
        current_class: student.current_class,
        section: student.section,
        role: "student",
      },
    });
  } catch (err) {
    console.error("[auth/student-login]", err);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/parent-login — Parent login (parent_id + password)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/parent-login", async (req, res) => {
  try {
    const { parent_id, password } = req.body;
    if (!parent_id || !password) {
      return res
        .status(400)
        .json({ error: "Parent ID and password are required." });
    }

    const parent = await prisma.parent.findUnique({
      where: { parent_id: parent_id.trim() },
    });
    if (!parent) {
      return res.status(401).json({ error: "Invalid Parent ID or password." });
    }

    let valid = false;
    if (parent.custom_password) {
      const isBcrypt = parent.custom_password.startsWith("$2");
      if (isBcrypt) {
        valid = await bcrypt.compare(password, parent.custom_password);
      } else {
        valid = password === parent.custom_password;
      }
    } else {
      valid =
        (parent.phone && password === parent.phone) || password === "User123";
    }

    if (!valid) {
      return res.status(401).json({ error: "Invalid Parent ID or password." });
    }

    await syncGenericUser({
      email: parent.email || "",
      username: parent.parent_id,
      password: parent.custom_password || parent.phone || "User123",
      role: "parent",
      first_name: parent.first_name,
      last_name: parent.last_name,
      profile_type: "Parent",
      profile_id: parent.id,
    });

    const token = generateToken({
      id: parent.id,
      email: parent.email || "",
      role: "parent",
      parent_id: parent.parent_id,
      name: `${parent.first_name || ""} ${parent.last_name || ""}`.trim(),
    });

    return res.json({
      token,
      parent: {
        id: parent.id,
        parent_id: parent.parent_id,
        first_name: parent.first_name,
        last_name: parent.last_name,
        email: parent.email,
        phone: parent.phone,
        custom_password: parent.custom_password,
        role: "parent",
      },
    });
  } catch (err) {
    console.error("[auth/parent-login]", err);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/accountant-login — Accountant login (staff_id + password)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/accountant-login", async (req, res) => {
  try {
    const { staff_id, password } = req.body;
    if (!staff_id || !password) {
      return res
        .status(400)
        .json({ error: "Staff ID and password are required." });
    }

    // Accountants use NonAcademicStaff or StaffRole
    const staffRole = await prisma.staffRole.findFirst({
      where: {
        user_email: staff_id.trim(),
        role: "Accountant",
        status: "Active",
      },
    });

    // Try NonAcademicStaff table
    const staff = await prisma.nonAcademicStaff.findUnique({
      where: { staff_id: staff_id.trim() },
    });

    if (!staff && !staffRole) {
      return res.status(401).json({ error: "Invalid Staff ID or password." });
    }

    const record = staff;
    let valid = false;
    if (record?.custom_password) {
      const isBcrypt = record.custom_password.startsWith("$2");
      if (isBcrypt) {
        valid = await bcrypt.compare(password, record.custom_password);
      } else {
        valid = password === record.custom_password;
      }
    } else {
      valid = password === "admin220" || password === "User123";
    }

    if (!valid) {
      return res.status(401).json({ error: "Invalid Staff ID or password." });
    }

    await syncGenericUser({
      email: record.email || "",
      username: record.staff_id,
      password: record.custom_password || "admin220",
      role: "accountant",
      first_name: record.first_name,
      last_name: record.last_name,
      profile_type: "NonAcademicStaff",
      profile_id: record.id,
    });

    const token = generateToken({
      id: record.id,
      email: record.email || "",
      role: "accountant",
      staff_id: record.staff_id,
      name: `${record.first_name} ${record.last_name}`,
    });

    return res.json({ token, staff: { ...record, role: "accountant" } });
  } catch (err) {
    console.error("[auth/accountant-login]", err);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me — Returns current authenticated user from JWT
// ─────────────────────────────────────────────────────────────────────────────
router.get("/me", authenticate, async (req, res) => {
  try {
    const user = { ...req.user };
    const teacher = await prisma.teacher.findFirst({
      where: {
        OR: [
          ...(user.email ? [{ email: user.email.toLowerCase() }] : []),
          ...(user.username ? [{ staff_id: user.username }] : []),
          ...(user.staff_id ? [{ staff_id: user.staff_id }] : []),
          ...(user.profile_id ? [{ id: user.profile_id }] : []),
          ...(user.id ? [{ id: user.id }] : []),
        ],
      },
    }).catch(() => null);

    if (teacher) {
      if (!user.staff_id) user.staff_id = teacher.staff_id;
      user.teacher_id = teacher.id;
      if (!user.first_name) user.first_name = teacher.first_name;
      if (!user.last_name) user.last_name = teacher.last_name;
      user.bank_name = teacher.bank_name || null;
      user.account_number = teacher.account_number || null;
      user.account_name = teacher.account_name || null;
      user.salary = teacher.salary || null;
      user.phone = teacher.phone || user.phone || null;
      user.qualification = teacher.qualification || user.qualification || null;
    } else {
      const staff = await prisma.nonAcademicStaff.findFirst({
        where: {
          OR: [
            ...(user.email ? [{ email: user.email.toLowerCase() }] : []),
            ...(user.username ? [{ staff_id: user.username }] : []),
            ...(user.staff_id ? [{ staff_id: user.staff_id }] : []),
            ...(user.profile_id ? [{ id: user.profile_id }] : []),
            ...(user.id ? [{ id: user.id }] : []),
          ],
        },
      }).catch(() => null);

      if (staff) {
        if (!user.staff_id) user.staff_id = staff.staff_id;
        user.bank_name = staff.bank_name || null;
        user.account_number = staff.account_number || null;
        user.account_name = staff.account_name || null;
        user.salary = staff.salary || null;
      }
    }
    return res.json(user);
  } catch (err) {
    console.error("[auth/me]", err);
    return res.json(req.user);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register-admin — Create the first admin user (one-time setup)
// Protected by a setup token in env so it can't be called by anyone
// ─────────────────────────────────────────────────────────────────────────────
router.post("/register-admin", async (req, res) => {
  try {
    const { setup_token, email, password, first_name, last_name } = req.body;
    const expectedToken = process.env.SETUP_TOKEN;

    if (!expectedToken || setup_token !== expectedToken) {
      return res.status(403).json({ error: "Invalid setup token." });
    }

    const existing = await prisma.adminUser.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (existing) {
      return res.status(409).json({ error: "Admin user already exists." });
    }

    const hashed = await bcrypt.hash(password, 12);
    const admin = await prisma.adminUser.create({
      data: {
        email: email.toLowerCase(),
        password: hashed,
        first_name,
        last_name,
        role: "admin",
      },
    });

    await syncGenericUser({
      email: admin.email,
      username: admin.email,
      password: hashed,
      role: admin.role,
      first_name: admin.first_name,
      last_name: admin.last_name,
      profile_type: "AdminUser",
      profile_id: admin.id,
    });

    return res.status(201).json({
      message: "Admin created successfully.",
      id: admin.id,
      email: admin.email,
    });
  } catch (err) {
    console.error("[auth/register-admin]", err);
    return res.status(500).json({ error: "Failed to create admin." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/create-director — Admin creates Director account
// ─────────────────────────────────────────────────────────────────────────────
router.post("/create-director", authenticate, async (req, res) => {
  try {
    const requesterRole = req.user?.role;
    const requesterRoles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    if (requesterRole !== "admin" && !requesterRoles.includes("admin")) {
      return res.status(403).json({ error: "Only administrators can create director accounts." });
    }

    const { email, first_name, last_name, phone } = req.body;
    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Director email is required." });
    }

    const cleanEmail = email.trim().toLowerCase();
    const defaultPassword = "User123";
    const hashedPassword = await bcrypt.hash(defaultPassword, 12);

    const existingUser = await prisma.user.findFirst({
      where: { email: cleanEmail },
    });

    let directorUser;
    if (existingUser) {
      directorUser = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          role: "admin",
          profile_type: "director",
          password: hashedPassword,
          first_name: first_name?.trim() || existingUser.first_name || "Director",
          last_name: last_name?.trim() || existingUser.last_name || "",
        },
      });
    } else {
      directorUser = await prisma.user.create({
        data: {
          email: cleanEmail,
          username: cleanEmail,
          password: hashedPassword,
          role: "admin",
          profile_type: "director",
          first_name: first_name?.trim() || "Director",
          last_name: last_name?.trim() || "",
        },
      });
    }

    // Directors should not have admin role — clean up any admin StaffRole
    await prisma.staffRole.deleteMany({
      where: { user_email: cleanEmail, role: "Admin" },
    }).catch(() => {});

    return res.status(201).json({
      message: "Director account created successfully.",
      user: {
        id: directorUser.id,
        email: directorUser.email,
        first_name: directorUser.first_name,
        last_name: directorUser.last_name,
        role: "director",
        profile_type: "director",
        default_password: defaultPassword,
      },
    });
  } catch (err) {
    console.error("[auth/create-director]", err);
    return res.status(500).json({ error: "Failed to create director account: " + (err.message || "Unknown error") });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/directors — List all director accounts
// ─────────────────────────────────────────────────────────────────────────────
router.get("/directors", authenticate, async (req, res) => {
  try {
    const requesterRole = req.user?.role;
    const requesterRoles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    if (requesterRole !== "admin" && !requesterRoles.includes("admin") && requesterRole !== "director") {
      return res.status(403).json({ error: "Access denied." });
    }

    const directors = await prisma.user.findMany({
      where: {
        profile_type: "director",
      },
      select: {
        id: true,
        email: true,
        username: true,
        first_name: true,
        last_name: true,
        profile_type: true,
        role: true,
        created_date: true,
        updated_date: true,
      },
      orderBy: {
        created_date: "desc",
      },
    });
    return res.json(directors);
  } catch (err) {
    console.error("[auth/directors]", err);
    return res.status(500).json({ error: "Failed to fetch director accounts." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-director-password — Reset director password to default
// ─────────────────────────────────────────────────────────────────────────────
router.post("/reset-director-password", authenticate, async (req, res) => {
  try {
    const requesterRole = req.user?.role;
    const requesterRoles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    if (requesterRole !== "admin" && !requesterRoles.includes("admin")) {
      return res.status(403).json({ error: "Only administrators can reset director passwords." });
    }

    const { id, email } = req.body;
    if (!id && !email) {
      return res.status(400).json({ error: "Director ID or email is required." });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(id ? [{ id }] : []),
          ...(email ? [{ email: email.toLowerCase() }] : []),
        ],
      },
    });

    if (!user) {
      return res.status(404).json({ error: "Director not found." });
    }

    const defaultPassword = "User123";
    const hashedPassword = await bcrypt.hash(defaultPassword, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    return res.json({
      message: `Password for ${user.email} has been reset to default (${defaultPassword}).`,
      default_password: defaultPassword,
    });
  } catch (err) {
    console.error("[auth/reset-director-password]", err);
    return res.status(500).json({ error: "Failed to reset director password." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/auth/directors/:id — Delete a director account
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/directors/:id", authenticate, async (req, res) => {
  try {
    const requesterRole = req.user?.role;
    const requesterRoles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    if (requesterRole !== "admin" && !requesterRoles.includes("admin")) {
      return res.status(403).json({ error: "Only administrators can delete director accounts." });
    }

    const { id } = req.params;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ error: "Director not found." });
    }

    await prisma.user.delete({ where: { id } });
    if (user.email) {
      await prisma.staffRole.deleteMany({ where: { user_email: user.email.toLowerCase() } }).catch(() => {});
    }

    return res.json({ message: "Director account deleted successfully." });
  } catch (err) {
    console.error("[auth/delete-director]", err);
    return res.status(500).json({ error: "Failed to delete director account." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/change-password — Authenticated password change for all roles
// ─────────────────────────────────────────────────────────────────────────────
router.post("/change-password", authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 6) {
      return res
        .status(400)
        .json({ error: "New password must be at least 6 characters long." });
    }

    const userId = req.user.id;
    const userEmail = req.user.email ? req.user.email.toLowerCase() : null;
    const userRole = req.user.role;
    const profileType = req.user.profile_type;
    const profileId = req.user.profile_id;
    const username = req.user.username;
    const admissionNumber = req.user.admission_number || (userRole === "student" ? username : null);

    // Find Student record if user is student
    let studentRecord = null;
    if (profileType === "Student" || userRole === "student") {
      studentRecord = await prisma.student.findFirst({
        where: {
          OR: [
            ...(profileId ? [{ id: profileId }] : []),
            ...(userId ? [{ id: userId }] : []),
            ...(admissionNumber ? [{ admission_number: admissionNumber }] : []),
            ...(username ? [{ admission_number: username }] : []),
          ],
        },
      });
    }

    // Find User table record
    const userRecord = await prisma.user.findFirst({
      where: {
        OR: [
          { id: userId },
          ...(userEmail ? [{ email: userEmail }] : []),
          ...(username ? [{ username: username }] : []),
          ...(admissionNumber ? [{ username: admissionNumber }] : []),
          ...(profileId ? [{ profile_id: profileId }] : []),
          ...(studentRecord ? [{ profile_id: studentRecord.id }] : []),
        ],
      },
    });

    if (current_password) {
      let valid = false;
      if (userRecord && userRecord.password) {
        const isBcrypt = userRecord.password.startsWith("$2");
        valid = isBcrypt
          ? await bcrypt.compare(current_password, userRecord.password)
          : current_password === userRecord.password;
      }
      if (!valid && studentRecord) {
        if (studentRecord.custom_password) {
          const isBcrypt = studentRecord.custom_password.startsWith("$2");
          valid = isBcrypt
            ? await bcrypt.compare(current_password, studentRecord.custom_password)
            : current_password === studentRecord.custom_password;
        } else {
          valid = current_password === "User123";
        }
      }
      if (!valid && !userRecord && !studentRecord) {
        // Fallback for edge cases without generic user or student record
      } else if (!valid) {
        return res.status(400).json({ error: "Current password is incorrect." });
      }
    }

    const hashedPassword = await bcrypt.hash(new_password, 12);

    // 1. Update User table
    if (userRecord) {
      await prisma.user.update({
        where: { id: userRecord.id },
        data: { password: hashedPassword },
      });
    } else if (studentRecord) {
      await syncGenericUser({
        email: studentRecord.parent_email || "",
        username: studentRecord.admission_number,
        password: hashedPassword,
        role: "student",
        first_name: studentRecord.first_name,
        last_name: studentRecord.last_name,
        profile_type: "Student",
        profile_id: studentRecord.id,
      });
    }

    // 2. Update role-specific entity table
    if (profileType === "AdminUser" || userRole === "admin") {
      const admin = await prisma.adminUser.findFirst({
        where: {
          OR: [
            ...(profileId ? [{ id: profileId }] : []),
            ...(userEmail ? [{ email: userEmail }] : []),
          ],
        },
      });
      if (admin) {
        await prisma.adminUser.update({
          where: { id: admin.id },
          data: { password: hashedPassword },
        });
      }
    } else if (
      profileType === "Teacher" ||
      userRole === "teacher" ||
      userRole === "head_teacher" ||
      userRole === "principal"
    ) {
      const teacher = await prisma.teacher.findFirst({
        where: {
          OR: [
            ...(profileId ? [{ id: profileId }] : []),
            ...(userEmail ? [{ email: userEmail }] : []),
            ...(username ? [{ staff_id: username }] : []),
          ],
        },
      });
      if (teacher) {
        await prisma.teacher.update({
          where: { id: teacher.id },
          data: { custom_password: hashedPassword },
        });
      }
    } else if (profileType === "Student" || userRole === "student") {
      const student = studentRecord || await prisma.student.findFirst({
        where: {
          OR: [
            ...(profileId ? [{ id: profileId }] : []),
            ...(userId ? [{ id: userId }] : []),
            ...(admissionNumber ? [{ admission_number: admissionNumber }] : []),
            ...(username ? [{ admission_number: username }] : []),
          ],
        },
      });
      if (student) {
        await prisma.student.update({
          where: { id: student.id },
          data: { custom_password: hashedPassword },
        });
      }
    } else if (profileType === "Parent" || userRole === "parent") {
      const parent = await prisma.parent.findFirst({
        where: {
          OR: [
            ...(profileId ? [{ id: profileId }] : []),
            ...(userEmail ? [{ email: userEmail }] : []),
            ...(username ? [{ parent_id: username }] : []),
          ],
        },
      });
      if (parent) {
        await prisma.parent.update({
          where: { id: parent.id },
          data: { custom_password: hashedPassword },
        });
      }
    } else if (
      profileType === "NonAcademicStaff" ||
      userRole === "accountant"
    ) {
      const staff = await prisma.nonAcademicStaff.findFirst({
        where: {
          OR: [
            ...(profileId ? [{ id: profileId }] : []),
            ...(userEmail ? [{ email: userEmail }] : []),
            ...(username ? [{ staff_id: username }] : []),
          ],
        },
      });
      if (staff) {
        await prisma.nonAcademicStaff.update({
          where: { id: staff.id },
          data: { custom_password: hashedPassword },
        });
      }
    }

    return res.json({ message: "Password updated successfully." });
  } catch (err) {
    console.error("[auth/change-password]", err);
    return res
      .status(500)
      .json({ error: "Failed to change password. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password-lookup — Look up account for password reset
// ─────────────────────────────────────────────────────────────────────────────
router.post("/forgot-password-lookup", async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ error: "Identifier is required." });
    }

    const key = identifier.trim();
    const emailKey = key.toLowerCase();

    // 1. Check AdminUser
    const admin = await prisma.adminUser.findUnique({
      where: { email: emailKey },
    });
    if (admin) {
      return res.json({
        found: true,
        entity_type: "AdminUser",
        record_id: admin.id,
        identifier_label: "Admin Email",
        identifier_value: admin.email,
        verification_type: "email",
        masked_hint: admin.email.replace(/(.{2})(.*)(@.*)/, "$1***$3"),
      });
    }

    // 2. Check Teacher
    const teacher = await prisma.teacher.findFirst({
      where: {
        OR: [{ staff_id: key }, { email: emailKey }],
      },
    });
    if (teacher) {
      const phone = teacher.phone || "";
      return res.json({
        found: true,
        entity_type: "Teacher",
        record_id: teacher.id,
        identifier_label: "Staff ID or Email",
        identifier_value: teacher.staff_id || teacher.email,
        verification_type: phone ? "phone" : "email",
        masked_hint: phone
          ? phone.slice(0, 3) + "****" + phone.slice(-3)
          : teacher.email.replace(/(.{2})(.*)(@.*)/, "$1***$3"),
      });
    }

    // 3. Check Student
    const student = await prisma.student.findFirst({
      where: {
        OR: [{ admission_number: key }],
      },
    });
    if (student) {
      const parentPhone = student.parent_phone || "";
      return res.json({
        found: true,
        entity_type: "Student",
        record_id: student.id,
        identifier_label: "Admission Number",
        identifier_value: student.admission_number,
        verification_type: parentPhone ? "phone" : "none",
        masked_hint: parentPhone
          ? parentPhone.slice(0, 3) + "****" + parentPhone.slice(-3)
          : "Admission Number Verified",
      });
    }

    // 4. Check Parent
    const parent = await prisma.parent.findFirst({
      where: {
        OR: [{ parent_id: key }, { email: emailKey }, { phone: key }],
      },
    });
    if (parent) {
      const phone = parent.phone || "";
      return res.json({
        found: true,
        entity_type: "Parent",
        record_id: parent.id,
        identifier_label: "Parent ID / Phone",
        identifier_value: parent.parent_id || parent.phone,
        verification_type: phone ? "phone" : "email",
        masked_hint: phone
          ? phone.slice(0, 3) + "****" + phone.slice(-3)
          : (parent.email || "").replace(/(.{2})(.*)(@.*)/, "$1***$3"),
      });
    }

    // 5. Check NonAcademicStaff
    const staff = await prisma.nonAcademicStaff.findFirst({
      where: {
        OR: [{ staff_id: key }, { email: emailKey }],
      },
    });
    if (staff) {
      const phone = staff.phone || "";
      return res.json({
        found: true,
        entity_type: "NonAcademicStaff",
        record_id: staff.id,
        identifier_label: "Staff ID",
        identifier_value: staff.staff_id || staff.email,
        verification_type: phone ? "phone" : "email",
        masked_hint: phone
          ? phone.slice(0, 3) + "****" + phone.slice(-3)
          : (staff.email || "").replace(/(.{2})(.*)(@.*)/, "$1***$3"),
      });
    }

    return res.status(404).json({
      error: "No account found matching this identifier. Please verify and try again.",
    });
  } catch (err) {
    console.error("[auth/forgot-password-lookup]", err);
    return res
      .status(500)
      .json({ error: "Failed to look up account. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password-reset — Verify and reset password
// ─────────────────────────────────────────────────────────────────────────────
router.post("/forgot-password-reset", async (req, res) => {
  try {
    const { entity_type, record_id, verifier, new_password } = req.body;

    if (!entity_type || !record_id || !new_password) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    if (new_password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters long." });
    }

    const normalizePhone = (p) => (p || "").replace(/[\s+\-()]/g, "");

    // Verify identity depending on entity type
    if (entity_type === "AdminUser") {
      const admin = await prisma.adminUser.findUnique({
        where: { id: record_id },
      });
      if (!admin) return res.status(404).json({ error: "Admin not found." });
      if (verifier && verifier.trim().toLowerCase() !== admin.email.toLowerCase()) {
        return res.status(400).json({ error: "Verification email does not match." });
      }
    } else if (entity_type === "Teacher") {
      const teacher = await prisma.teacher.findUnique({
        where: { id: record_id },
      });
      if (!teacher) return res.status(404).json({ error: "Teacher record not found." });
      if (
        verifier &&
        normalizePhone(verifier) !== normalizePhone(teacher.phone) &&
        verifier.trim().toLowerCase() !== (teacher.email || "").toLowerCase()
      ) {
        return res
          .status(400)
          .json({ error: "Phone number or email does not match record on file." });
      }
    } else if (entity_type === "Student") {
      const student = await prisma.student.findUnique({
        where: { id: record_id },
      });
      if (!student) return res.status(404).json({ error: "Student record not found." });
      if (
        verifier &&
        student.parent_phone &&
        normalizePhone(verifier) !== normalizePhone(student.parent_phone) &&
        verifier.trim().toLowerCase() !== (student.admission_number || "").toLowerCase()
      ) {
        return res
          .status(400)
          .json({ error: "Parent phone number does not match student record." });
      }
    } else if (entity_type === "Parent") {
      const parent = await prisma.parent.findUnique({
        where: { id: record_id },
      });
      if (!parent) return res.status(404).json({ error: "Parent record not found." });
      if (
        verifier &&
        normalizePhone(verifier) !== normalizePhone(parent.phone) &&
        verifier.trim().toLowerCase() !== (parent.email || "").toLowerCase()
      ) {
        return res
          .status(400)
          .json({ error: "Phone number does not match parent record." });
      }
    } else if (entity_type === "NonAcademicStaff") {
      const staff = await prisma.nonAcademicStaff.findUnique({
        where: { id: record_id },
      });
      if (!staff) return res.status(404).json({ error: "Staff record not found." });
      if (
        verifier &&
        normalizePhone(verifier) !== normalizePhone(staff.phone) &&
        verifier.trim().toLowerCase() !== (staff.email || "").toLowerCase()
      ) {
        return res
          .status(400)
          .json({ error: "Phone number does not match staff record." });
      }
    }

    const hashedPassword = await bcrypt.hash(new_password, 12);

    switch (entity_type) {
      case "Teacher":
        await prisma.teacher.update({
          where: { id: record_id },
          data: { custom_password: hashedPassword },
        });
        break;
      case "Student":
        await prisma.student.update({
          where: { id: record_id },
          data: { custom_password: hashedPassword },
        });
        break;
      case "Parent":
        await prisma.parent.update({
          where: { id: record_id },
          data: { custom_password: hashedPassword },
        });
        break;
      case "NonAcademicStaff":
        await prisma.nonAcademicStaff.update({
          where: { id: record_id },
          data: { custom_password: hashedPassword },
        });
        break;
      case "AdminUser":
        await prisma.adminUser.update({
          where: { id: record_id },
          data: { password: hashedPassword },
        });
        break;
    }

    // Sync generic User table
    const genericUser = await prisma.user.findFirst({
      where: {
        OR: [
          { profile_type: entity_type, profile_id: record_id },
          { id: record_id },
        ],
      },
    });

    if (genericUser) {
      await prisma.user.update({
        where: { id: genericUser.id },
        data: { password: hashedPassword },
      });
    }

    return res.json({ message: "Password reset successfully. You can now log in." });
  } catch (err) {
    console.error("[auth/forgot-password-reset]", err);
    return res
      .status(500)
      .json({ error: "Failed to reset password. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password — Legacy Reset password with bcrypt hashing
// ─────────────────────────────────────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  try {
    const { entity_type, record_id, new_password } = req.body;

    if (!entity_type || !record_id || !new_password) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    if (new_password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });
    }

    const hashedPassword = await bcrypt.hash(new_password, 12);

    switch (entity_type) {
      case "Teacher":
        await prisma.teacher.update({
          where: { id: record_id },
          data: { custom_password: hashedPassword },
        });
        break;
      case "Student":
        await prisma.student.update({
          where: { id: record_id },
          data: { custom_password: hashedPassword },
        });
        break;
      case "Parent":
        await prisma.parent.update({
          where: { id: record_id },
          data: { custom_password: hashedPassword },
        });
        break;
      case "NonAcademicStaff":
        await prisma.nonAcademicStaff.update({
          where: { id: record_id },
          data: { custom_password: hashedPassword },
        });
        break;
      case "AdminUser":
        await prisma.adminUser.update({
          where: { id: record_id },
          data: { password: hashedPassword },
        });
        break;
      default:
        return res.status(400).json({ error: "Invalid entity type." });
    }

    // Sync generic User record if present
    const genericUser = await prisma.user.findFirst({
      where: { profile_type: entity_type, profile_id: record_id },
    });

    if (genericUser) {
      await prisma.user.update({
        where: { id: genericUser.id },
        data: { password: hashedPassword },
      });
    }

    return res.json({ success: true, message: "Password updated successfully." });
  } catch (err) {
    console.error("[auth/reset-password]", err);
    return res.status(500).json({ error: "Failed to reset password. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/send-password-reset-email — Send Password Reset Link via Resend
// ─────────────────────────────────────────────────────────────────────────────
router.post("/send-password-reset-email", async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || !identifier.trim()) {
      return res
        .status(400)
        .json({ error: "Please provide your email, staff ID, or admission number." });
    }

    const key = identifier.trim();
    const emailKey = key.toLowerCase();

    let targetEmail = null;
    let targetName = "User";
    let entityType = "User";
    let recordId = null;

    // 1. Look in AdminUser
    const admin = await prisma.adminUser.findFirst({
      where: {
        OR: [{ email: emailKey }, { id: key }],
      },
    });
    if (admin && admin.email) {
      targetEmail = admin.email;
      targetName = `${admin.first_name || "Admin"} ${admin.last_name || ""}`.trim();
      entityType = "AdminUser";
      recordId = admin.id;
    }

    // 2. Look in Teacher
    if (!targetEmail) {
      const teacher = await prisma.teacher.findFirst({
        where: {
          OR: [{ email: emailKey }, { staff_id: key }],
        },
      });
      if (teacher && teacher.email) {
        targetEmail = teacher.email;
        targetName = `${teacher.first_name || ""} ${teacher.last_name || ""}`.trim();
        entityType = "Teacher";
        recordId = teacher.id;
      }
    }

    // 3. Look in Parent
    if (!targetEmail) {
      const parent = await prisma.parent.findFirst({
        where: {
          OR: [{ email: emailKey }, { parent_id: key }, { phone: key }],
        },
      });
      if (parent && parent.email) {
        targetEmail = parent.email;
        targetName = `${parent.first_name || parent.full_name || "Parent"} ${parent.last_name || ""}`.trim();
        entityType = "Parent";
        recordId = parent.id;
      }
    }

    // 4. Look in Student (sends to parent_email)
    if (!targetEmail) {
      const student = await prisma.student.findFirst({
        where: {
          OR: [{ admission_number: key }, { parent_email: emailKey }],
        },
      });
      if (student && student.parent_email) {
        targetEmail = student.parent_email;
        targetName = `${student.first_name} ${student.last_name}`.trim();
        entityType = "Student";
        recordId = student.id;
      }
    }

    // 5. Look in NonAcademicStaff
    if (!targetEmail) {
      const staff = await prisma.nonAcademicStaff.findFirst({
        where: {
          OR: [{ email: emailKey }, { staff_id: key }],
        },
      });
      if (staff && staff.email) {
        targetEmail = staff.email;
        targetName = `${staff.first_name || ""} ${staff.last_name || ""}`.trim();
        entityType = "NonAcademicStaff";
        recordId = staff.id;
      }
    }

    // 6. Look in User table as fallback
    if (!targetEmail) {
      const user = await prisma.user.findFirst({
        where: {
          OR: [{ email: emailKey }, { username: key }],
        },
      });
      if (user && user.email) {
        targetEmail = user.email;
        targetName = `${user.first_name || ""} ${user.last_name || ""}`.trim() || "User";
        entityType = user.profile_type || "User";
        recordId = user.profile_id || user.id;
      }
    }

    if (!targetEmail) {
      return res.status(404).json({
        error: "No account found matching this identifier or no registered email address on file.",
      });
    }

    // Create a secure 1-hour JWT token for password reset
    const jwtSecret = process.env.JWT_SECRET || "milton_jwt_secret_fallback";
    const resetToken = jwt.sign(
      {
        id: recordId,
        email: targetEmail.toLowerCase(),
        entity_type: entityType,
        purpose: "password-reset",
      },
      jwtSecret,
      { expiresIn: "1h" }
    );

    // Determine client origin URL
    const rawOrigin = req.headers.origin || req.headers.referer || process.env.CLIENT_ORIGIN || "https://www.milton-college.com.ng";
    const originUrl = rawOrigin.replace(/\/+$/, "");
    const resetLink = `${originUrl}/ResetPassword?token=${encodeURIComponent(resetToken)}`;

    // Prepare rich HTML email
    const subject = "Password Reset Request — Milton College Portal";
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 0; }
          .container { max-width: 560px; margin: 30px auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
          .header { background: #1e3a5f; color: #ffffff; padding: 32px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
          .header p { margin: 6px 0 0 0; color: #94a3b8; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; }
          .content { padding: 32px; color: #334155; line-height: 1.6; }
          .content p { margin: 0 0 16px 0; font-size: 15px; }
          .btn-container { text-align: center; margin: 28px 0; }
          .btn { display: inline-block; background: #1e3a5f; color: #ffffff !important; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 600; font-size: 15px; box-shadow: 0 2px 4px rgba(30,58,95,0.25); }
          .btn:hover { background: #2b4c7e; }
          .link-fallback { background: #f1f5f9; padding: 12px; border-radius: 8px; font-size: 12px; word-break: break-all; color: #475569; }
          .footer { background: #f8fafc; padding: 20px 32px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Milton College</h1>
            <p>Portal Security</p>
          </div>
          <div class="content">
            <p>Hello <strong>${targetName}</strong>,</p>
            <p>We received a request to reset your password for your Milton College Portal account.</p>
            <p>Click the button below to choose a new password. This link is valid for <strong>1 hour</strong>.</p>
            
            <div class="btn-container">
              <a href="${resetLink}" class="btn" target="_blank">Reset Password</a>
            </div>

            <p style="font-size: 13px; color: #64748b;">If the button above does not work, copy and paste this link into your web browser:</p>
            <div class="link-fallback">${resetLink}</div>

            <p style="margin-top: 24px; font-size: 13px; color: #94a3b8;">
              If you did not request this password reset, please ignore this email. Your password will remain unchanged.
            </p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} Milton College. All rights reserved.
          </div>
        </div>
      </body>
      </html>
    `;

    const textBody = `Hello ${targetName},\n\nYou requested a password reset for your Milton College Portal account.\n\nUse this link to reset your password (valid for 1 hour):\n${resetLink}\n\nIf you did not request this, you can safely ignore this email.\n\nMilton College Administration`;

    // Send email via Resend SMTP
    await sendEmail({
      to: targetEmail,
      subject,
      text: textBody,
      html: htmlBody,
    });

    const maskedEmail = targetEmail.replace(/(.{2})(.*)(@.*)/, "$1***$3");
    return res.json({
      success: true,
      message: `A password reset link has been sent to ${maskedEmail}. Please check your inbox or spam folder.`,
      masked_email: maskedEmail,
    });
  } catch (err) {
    console.error("[auth/send-password-reset-email]", err);
    return res.status(500).json({
      error: "Failed to send password reset email. Please verify your email configuration or try again.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-reset-token — Verify Token Validity
// ─────────────────────────────────────────────────────────────────────────────
router.post("/verify-reset-token", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Reset token is required." });
    }

    const jwtSecret = process.env.JWT_SECRET || "milton_jwt_secret_fallback";
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res
          .status(400)
          .json({ error: "This password reset link has expired. Please request a new one." });
      }
      return res
        .status(400)
        .json({ error: "Invalid password reset link." });
    }

    if (decoded.purpose !== "password-reset") {
      return res.status(400).json({ error: "Invalid token purpose." });
    }

    const maskedEmail = (decoded.email || "").replace(/(.{2})(.*)(@.*)/, "$1***$3");
    return res.json({
      valid: true,
      email: decoded.email,
      masked_email: maskedEmail,
      entity_type: decoded.entity_type,
    });
  } catch (err) {
    console.error("[auth/verify-reset-token]", err);
    return res.status(500).json({ error: "Failed to verify reset token." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/complete-password-reset — Set New Password from Token
// ─────────────────────────────────────────────────────────────────────────────
router.post("/complete-password-reset", async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ error: "Token and new password are required." });
    }

    if (new_password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters long." });
    }

    const jwtSecret = process.env.JWT_SECRET || "milton_jwt_secret_fallback";
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res
          .status(400)
          .json({ error: "This password reset link has expired. Please request a new one." });
      }
      return res.status(400).json({ error: "Invalid or expired password reset link." });
    }

    if (decoded.purpose !== "password-reset") {
      return res.status(400).json({ error: "Invalid token purpose." });
    }

    const { id: recordId, email: targetEmail, entity_type: entityType } = decoded;
    const hashedPassword = await bcrypt.hash(new_password, 12);

    // Update in role-specific entity table
    switch (entityType) {
      case "AdminUser":
        await prisma.adminUser.updateMany({
          where: {
            OR: [
              ...(recordId ? [{ id: recordId }] : []),
              ...(targetEmail ? [{ email: targetEmail }] : []),
            ],
          },
          data: { password: hashedPassword },
        });
        break;
      case "Teacher":
        await prisma.teacher.updateMany({
          where: {
            OR: [
              ...(recordId ? [{ id: recordId }] : []),
              ...(targetEmail ? [{ email: targetEmail }] : []),
            ],
          },
          data: { custom_password: hashedPassword },
        });
        break;
      case "Parent":
        await prisma.parent.updateMany({
          where: {
            OR: [
              ...(recordId ? [{ id: recordId }] : []),
              ...(targetEmail ? [{ email: targetEmail }] : []),
            ],
          },
          data: { custom_password: hashedPassword },
        });
        break;
      case "Student":
        await prisma.student.updateMany({
          where: {
            OR: [
              ...(recordId ? [{ id: recordId }] : []),
              ...(targetEmail ? [{ parent_email: targetEmail }] : []),
            ],
          },
          data: { custom_password: hashedPassword },
        });
        break;
      case "NonAcademicStaff":
        await prisma.nonAcademicStaff.updateMany({
          where: {
            OR: [
              ...(recordId ? [{ id: recordId }] : []),
              ...(targetEmail ? [{ email: targetEmail }] : []),
            ],
          },
          data: { custom_password: hashedPassword },
        });
        break;
    }

    // Always synchronize the User table
    await prisma.user.updateMany({
      where: {
        OR: [
          ...(recordId ? [{ id: recordId }, { profile_id: recordId }] : []),
          ...(targetEmail ? [{ email: targetEmail }, { username: targetEmail }] : []),
        ],
      },
      data: { password: hashedPassword },
    });

    return res.json({
      success: true,
      message: "Your password has been successfully updated. You can now log in.",
    });
  } catch (err) {
    console.error("[auth/complete-password-reset]", err);
    return res.status(500).json({ error: "Failed to reset password. Please try again." });
  }
});

export default router;
