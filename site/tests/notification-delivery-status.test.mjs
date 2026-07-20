import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptedDeliveryValues,
  assertDeliveryStatusPersisted,
  DELIVERY_STATUS,
} from "../../supabase/functions/notifications/logic.mjs";

assert.deepEqual(DELIVERY_STATUS, {
  PENDING: "pending",
  ACCEPTED: "accepted",
  DELIVERED: "delivered",
  FAILED_TRANSIENT: "failed_transient",
  FAILED_PERMANENT: "failed_permanent",
});

const acceptedAt = "2026-07-19T12:34:56.000Z";
const acceptedValues = acceptedDeliveryValues(acceptedAt);
assert.deepEqual(acceptedValues, {
  status: "accepted",
  accepted_at: acceptedAt,
  error_message: null,
});
assert.equal(Object.hasOwn(acceptedValues, "delivered_at"), false);

const persistedRow = { id: 42 };
assert.equal(assertDeliveryStatusPersisted({ data: persistedRow, error: null }), persistedRow);
assert.throws(
  () => assertDeliveryStatusPersisted({ data: null, error: { message: "database unavailable" } }),
  /Could not persist notification delivery status: database unavailable/,
);
assert.throws(
  () => assertDeliveryStatusPersisted({ data: null, error: null }),
  /no matching delivery row/,
);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(dirname, "../../supabase/migrations/202607190001_notification_delivery_accepted_status.sql"),
  "utf8",
);
assert.match(migration, /add column if not exists accepted_at timestamptz/);
assert.match(migration, /status in \('pending','accepted','delivered','failed_transient','failed_permanent'\)/);
assert.match(migration, /set status = 'accepted'/);
assert.match(migration, /where status = 'delivered'/);

console.log("notification delivery status tests passed");
