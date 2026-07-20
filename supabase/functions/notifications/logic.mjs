export const ALLOWED_THRESHOLDS = ["warming", "hot", "surging", "blazing", "on fire", "inferno"];

export const PUSH_DELIVERY_OPTIONS = Object.freeze({
  // Request enough retention for an overnight Android Doze interval without
  // allowing time-sensitive deal notifications to arrive more than a day late.
  TTL: 24 * 60 * 60,
  // These alerts always produce a user-visible notification, so ask the push
  // service to attempt immediate delivery instead of batching for power savings.
  urgency: "high",
});

export const DELIVERY_STATUS = Object.freeze({
  PENDING: "pending",
  ACCEPTED: "accepted",
  DELIVERED: "delivered",
  FAILED_TRANSIENT: "failed_transient",
  FAILED_PERMANENT: "failed_permanent",
});

export function acceptedDeliveryValues(acceptedAt) {
  return {
    status: DELIVERY_STATUS.ACCEPTED,
    accepted_at: acceptedAt,
    error_message: null,
  };
}

export function assertDeliveryStatusPersisted(result) {
  if (result?.error) {
    const message = result.error.message || String(result.error);
    throw new Error(`Could not persist notification delivery status: ${message}`);
  }
  if (!result?.data) {
    throw new Error("Could not persist notification delivery status: no matching delivery row.");
  }
  return result.data;
}

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
