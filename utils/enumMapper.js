/**
 * enumMapper.js
 * Maps human-readable UI string values to Prisma Enum keys and vice versa.
 */

const ENUM_MAPPINGS = {
  // Term
  'First Term': 'First_Term',
  'Second Term': 'Second_Term',
  'Third Term': 'Third_Term',

  // Blood Group
  'A+': 'A_PLUS',
  'A-': 'A_MINUS',
  'B+': 'B_PLUS',
  'B-': 'B_MINUS',
  'AB+': 'AB_PLUS',
  'AB-': 'AB_MINUS',
  'O+': 'O_PLUS',
  'O-': 'O_MINUS',

  // Sport House
  'Red House': 'Red_House',
  'Blue House': 'Blue_House',
  'Green House': 'Green_House',
  'Yellow House': 'Yellow_House',

  // Teacher Type
  'Class Teacher': 'Class_Teacher',
  'Subject Teacher': 'Subject_Teacher',
  'Form Teacher': 'Form_Teacher',
  'Head Teacher': 'Head_Teacher',

  // Teacher Status
  'On Leave': 'On_Leave',

  // Admission Status
  'Under Review': 'Under_Review',
  'Offered Admission': 'Offered_Admission',

  // Payment Method
  'Bank Transfer': 'Bank_Transfer',

  // Expense Status
  'Pending Approval': 'Pending_Approval',

  // Staff Role Type
  'Non-Academic Staff': 'Non_Academic_Staff',
};

// Inverse mappings (Prisma Enum key -> UI string)
const REVERSE_MAPPINGS = {};
for (const [uiVal, prismaVal] of Object.entries(ENUM_MAPPINGS)) {
  REVERSE_MAPPINGS[prismaVal] = uiVal;
}

/**
 * Converts UI string values to Prisma Enum keys in an object or string.
 */
export function toPrismaEnums(data) {
  if (!data) return data;

  if (typeof data === 'string') {
    return ENUM_MAPPINGS[data] || data;
  }

  if (Array.isArray(data)) {
    return data.map(toPrismaEnums);
  }

  if (typeof data === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        result[key] = ENUM_MAPPINGS[value] || value;
      } else if (
        typeof value === "object" &&
        value !== null &&
        !(value instanceof Date)
      ) {
        result[key] = toPrismaEnums(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return data;
}

/**
 * Converts Prisma Enum keys back to UI strings in an object or record.
 */
export function toUIEnums(data) {
  if (!data) return data;

  if (typeof data === 'string') {
    return REVERSE_MAPPINGS[data] || data;
  }

  if (Array.isArray(data)) {
    return data.map(toUIEnums);
  }

  if (typeof data === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        result[key] = REVERSE_MAPPINGS[value] || value;
      } else if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
        result[key] = toUIEnums(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return data;
}
