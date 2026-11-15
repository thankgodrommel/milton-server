export const TRANSCRIPT_STAGE = {
  PRIMARY_5: "primary5",
  SS3: "ss3",
};

export function getTranscriptStages(user = {}) {
  const roles = [
    user.role,
    ...(Array.isArray(user.roles) ? user.roles : []),
    user.profile_type,
  ].map((role) => String(role || "").toLowerCase().replace(/[\s-]+/g, "_"));

  if (roles.includes("admin")) {
    return [TRANSCRIPT_STAGE.PRIMARY_5, TRANSCRIPT_STAGE.SS3];
  }

  return [
    ...(roles.includes("head_teacher") ? [TRANSCRIPT_STAGE.PRIMARY_5] : []),
    ...(roles.includes("principal") ? [TRANSCRIPT_STAGE.SS3] : []),
  ];
}

export function matchesTranscriptStudentClass(className, stage) {
  const normalizedClass = String(className || "").trim().toLowerCase();
  if (stage === TRANSCRIPT_STAGE.PRIMARY_5) {
    return /^primary\s+5(?:\s*[ab])?$/.test(normalizedClass);
  }
  if (stage === TRANSCRIPT_STAGE.SS3) {
    return /^ss3(?:\s+(?:arts?|sci(?:ence)?|com(?:merce)?)(?:\s+[ab])?)?$/.test(normalizedClass);
  }
  return false;
}

export function matchesTranscriptHistoryClass(className, stage) {
  const normalizedClass = String(className || "").trim().toLowerCase();
  if (stage === TRANSCRIPT_STAGE.PRIMARY_5) {
    return /^primary\s+[1-5](?:\s*[ab])?$/.test(normalizedClass);
  }
  if (stage === TRANSCRIPT_STAGE.SS3) {
    return /^ss[1-3](?:\s+(?:arts?|sci(?:ence)?|com(?:merce)?)(?:\s+[ab])?)?$/.test(normalizedClass);
  }
  return false;
}
