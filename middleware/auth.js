import jwt from 'jsonwebtoken';
import { hasActiveStaffAccess } from '../utils/staffAccess.js';

const JWT_SECRET = process.env.JWT_SECRET || 'milton_college_dev_secret';

function normalizeDirectorRole(user) {
  const roles = Array.isArray(user.roles) && user.roles.length > 0
    ? user.roles
    : [user.role];
  if (
    String(user.profile_type || '').toLowerCase() === 'director' ||
    roles.some((role) => String(role || '').toLowerCase() === 'director')
  ) {
    user.role = 'director';
    user.roles = ['director'];
  }
  return user;
}

/**
 * authenticate — Verifies JWT from Authorization header.
 * Attaches decoded payload to req.user.
 * Passes through if no token (for public routes that call authenticate optionally).
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided. Please log in.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid token.' });
  }

  req.user = normalizeDirectorRole(decoded);
  hasActiveStaffAccess(req.user).then((active) => {
    if (!active) {
      return res.status(401).json({ error: 'This staff account is deactivated. Contact an administrator.' });
    }
    return next();
  }).catch((err) => {
    console.error('[Authentication] Failed to verify staff account status:', err);
    return res.status(500).json({ error: 'Unable to verify account status. Please try again.' });
  });
}

/**
 * authenticateOptional — Like authenticate but doesn't fail if no token.
 * Useful for public routes that behave differently when authenticated.
 */
export function authenticateOptional(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (token) {
    try {
      req.user = normalizeDirectorRole(jwt.verify(token, JWT_SECRET));
    } catch {
      // Invalid token — treat as unauthenticated
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

/**
 * authorize(...roles) — Role-based access control middleware.
 * Must be used AFTER authenticate.
 *
 * @param  {...string} roles - Allowed roles (e.g., 'admin', 'teacher', 'principal')
 * @returns Express middleware
 *
 * Example:
 *   router.delete('/:id', authenticate, authorize('admin'), handler)
 */
export function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    const userRoles = (
      Array.isArray(req.user.roles) && req.user.roles.length > 0 
        ? req.user.roles 
        : [req.user.role]
    ).map(r => (r || '').toLowerCase());
    const isSuperUser = userRoles.includes('admin');
    const hasRole = roles.length === 0 || isSuperUser || roles.some(r => userRoles.includes((r || '').toLowerCase()));
    if (!hasRole) {
      return res.status(403).json({
        error: `Access denied. Required role(s): ${roles.join(', ')}. Your role(s): ${userRoles.join(', ')}`,
      });
    }
    next();
  };
}

/**
 * generateToken — Creates a signed JWT for a user.
 *
 * @param {object} payload - { id, email, role, name }
 * @returns {string} JWT string
 */
export function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}
