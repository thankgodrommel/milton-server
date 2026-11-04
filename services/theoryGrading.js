const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "for", "from", "had", "has", "have", "he", "her", "hers", "him", "his",
  "i", "in", "into", "is", "it", "its", "of", "on", "or", "our", "ours",
  "she", "that", "the", "their", "theirs", "them", "they", "this", "those",
  "to", "was", "we", "were", "what", "when", "where", "which", "who", "will",
  "with", "you", "your", "yours",
]);

const STRICTNESS_THRESHOLDS = {
  strict: 0.8,
  normal: 0.6,
  very_fair: 0.4,
};

function answerTokens(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function keyTerms(text) {
  const tokens = answerTokens(text);
  const contentTerms = tokens.filter((token) => !STOP_WORDS.has(token));
  return new Set(contentTerms.length ? contentTerms : tokens);
}

export function gradeTheoryAnswer(referenceAnswer, studentAnswer, strictness = "normal", maxMarks = 1) {
  const expectedTerms = keyTerms(referenceAnswer);
  const responseTerms = keyTerms(studentAnswer);
  const matchingTerms = [...expectedTerms].filter((term) => responseTerms.has(term)).length;
  const similarity = expectedTerms.size > 0
    ? matchingTerms / expectedTerms.size
    : 0;
  const threshold = STRICTNESS_THRESHOLDS[strictness] ?? STRICTNESS_THRESHOLDS.normal;
  const availableMarks = Number.isFinite(Number(maxMarks)) && Number(maxMarks) > 0
    ? Number(maxMarks)
    : 1;
  const score = similarity >= threshold
    ? Math.round(availableMarks * similarity * 100) / 100
    : 0;

  return { score, similarity, threshold };
}
