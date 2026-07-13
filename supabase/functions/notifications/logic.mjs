export const ALLOWED_THRESHOLDS = ["warming", "hot", "surging", "blazing", "on fire", "inferno"];

export function normalizeThresholds(value) {
  if (!Array.isArray(value)) return [];
  return ALLOWED_THRESHOLDS.filter((item) => value.includes(item));
}

export function enteredHigherHeat(previousLabel, currentLabel) {
  const currentRank = ALLOWED_THRESHOLDS.indexOf(currentLabel);
  if (currentRank === -1) return false;
  if (typeof previousLabel !== "string") return true;
  if (previousLabel === currentLabel) return false;
  const previousRank = ALLOWED_THRESHOLDS.indexOf(previousLabel);
  return currentRank > previousRank;
}
