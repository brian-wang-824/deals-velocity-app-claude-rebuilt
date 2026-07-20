import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ALLOWED_THRESHOLDS,
  enteredHigherHeat,
  normalizeThresholds,
  processNotificationSnapshot,
} from "../../supabase/functions/notifications/logic.mjs";

assert.deepEqual(ALLOWED_THRESHOLDS, ["warming", "hot", "surging", "blazing", "on fire", "inferno"]);
assert.deepEqual(normalizeThresholds(["inferno", "bogus", "warming", "inferno"]), ["warming", "inferno"]);
assert.deepEqual(normalizeThresholds(null), []);

for (const threshold of ALLOWED_THRESHOLDS) {
  assert.equal(enteredHigherHeat(undefined, threshold), true, `first observation at ${threshold} notifies`);
}
assert.equal(enteredHigherHeat(undefined, null), false, "first observation without heat is silent");
assert.equal(enteredHigherHeat(null, "warming"), true);
assert.equal(enteredHigherHeat("warming", "hot"), true);
assert.equal(enteredHigherHeat("warming", "inferno"), true, "skips notify only the observed heat");
assert.equal(enteredHigherHeat("hot", "hot"), false);
assert.equal(enteredHigherHeat("inferno", "hot"), false, "downward movement does not notify");
assert.equal(enteredHigherHeat("hot", null), false);

const migrationSource = fs.readFileSync(
  new URL("../../supabase/migrations/202607190002_durable_notification_outbox.sql", import.meta.url),
  "utf8",
);
const payloadColumnOffset = migrationSource.indexOf("add column if not exists payload jsonb not null default");
const legacyRpcOffset = migrationSource.indexOf("create or replace function public.claim_notification_delivery(");
const dropDefaultOffset = migrationSource.indexOf("alter column payload drop default");
assert.ok(payloadColumnOffset >= 0, "payload is valid and non-null from its first schema statement");
assert.ok(legacyRpcOffset > payloadColumnOffset, "the bridge default exists before replacing the legacy RPC");
assert.ok(dropDefaultOffset > legacyRpcOffset, "the bridge default remains until producers explicitly store payloads");

function deliveryKey(delivery) {
  return `${delivery.subscription_id}:${delivery.thread_id}:${delivery.velocity_label}`;
}

class FakeOutbox {
  constructor(subscriptions) {
    this.subscriptions = subscriptions;
    this.heat = new Map();
    this.deliveries = new Map();
    this.enqueueFailureAfter = null;
    this.sendResults = [];
    this.sendErrors = [];
    this.attemptedPayloads = [];
  }

  async loadHeatState(threadIds) {
    return threadIds.flatMap((threadId) => this.heat.has(threadId)
      ? [{ thread_id: threadId, velocity_label: this.heat.get(threadId) }]
      : []);
  }

  async loadActiveSubscriptions() {
    return this.subscriptions;
  }

  async enqueueDeliveries(deliveries) {
    let processed = 0;
    for (const delivery of deliveries) {
      const key = deliveryKey(delivery);
      if (!this.deliveries.has(key)) this.deliveries.set(key, { ...delivery });
      processed += 1;
      if (this.enqueueFailureAfter === processed) {
        this.enqueueFailureAfter = null;
        throw new Error("injected partial enqueue failure");
      }
    }
  }

  async advanceHeatState(deals) {
    for (const deal of deals) this.heat.set(String(deal.thread_id), String(deal.velocity_label || ""));
  }

  async claimDeliveries() {
    const claimed = [];
    for (const delivery of this.deliveries.values()) {
      if (delivery.status !== "pending" && delivery.status !== "failed_transient") continue;
      delivery.status = "processing";
      claimed.push({ ...delivery });
    }
    return claimed;
  }

  async sendDelivery(delivery) {
    this.attemptedPayloads.push(structuredClone(delivery.payload));
    if (this.sendErrors.length) {
      const error = this.sendErrors.shift();
      if (error) throw error;
    }
    const succeeded = this.sendResults.length ? this.sendResults.shift() : true;
    this.deliveries.get(deliveryKey(delivery)).status = succeeded ? "delivered" : "failed_transient";
    return succeeded;
  }
}

const hotSnapshot = {
  scraped_at: "2026-07-19T12:00:00Z",
  deals: [{
    thread_id: "deal-1",
    velocity_label: "hot",
    title: "Replay-safe deal",
    store: "Example Store",
    price: "$10",
    url: "/deal-1",
  }],
};
const replayStore = new FakeOutbox([
  { id: "subscription-1", thresholds: ["hot"] },
  { id: "subscription-2", thresholds: ["hot"] },
]);
replayStore.enqueueFailureAfter = 1;
await assert.rejects(
  processNotificationSnapshot(hotSnapshot, replayStore),
  /injected partial enqueue failure/,
);
assert.equal(replayStore.heat.has("deal-1"), false, "heat does not advance past a partial enqueue");
assert.equal(replayStore.deliveries.size, 1, "completed enqueue work remains durable");

const replayResult = await processNotificationSnapshot(hotSnapshot, replayStore);
assert.equal(replayStore.heat.get("deal-1"), "hot");
assert.equal(replayStore.deliveries.size, 2, "replay idempotently fills in every recipient");
assert.deepEqual(replayResult, { queued: 2, sent: 2, failed: 0 });

const retryStore = new FakeOutbox([
  { id: "subscription-1", thresholds: ["hot", "blazing"] },
]);
retryStore.sendResults.push(false);
assert.deepEqual(
  await processNotificationSnapshot(hotSnapshot, retryStore),
  { queued: 1, sent: 0, failed: 1 },
);
retryStore.attemptedPayloads.length = 0;

const blazingSnapshot = {
  scraped_at: "2026-07-19T12:10:00Z",
  deals: [{
    thread_id: "deal-1",
    velocity_label: "blazing",
    title: "Deal after heat changed",
    url: "/deal-1-now-blazing",
  }],
};
assert.deepEqual(
  await processNotificationSnapshot(blazingSnapshot, retryStore),
  { queued: 1, sent: 2, failed: 0 },
);
assert.deepEqual(
  retryStore.attemptedPayloads.map(({ title, url }) => ({ title, url })),
  [
    { title: "HOT: Replay-safe deal", url: "/deal-1" },
    { title: "BLAZING: Deal after heat changed", url: "/deal-1-now-blazing" },
  ],
  "the hot retry uses its durable payload even though the current deal is blazing",
);

const drainStore = new FakeOutbox([
  { id: "failing-subscription", thresholds: ["hot"] },
  { id: "later-subscription", thresholds: ["hot"] },
]);
drainStore.sendErrors.push(new Error("injected delivery database error"));
await assert.rejects(
  processNotificationSnapshot(hotSnapshot, drainStore),
  (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /1 notification delivery error/);
    assert.match(error.errors[0].message, /injected delivery database error/);
    return true;
  },
);
assert.equal(drainStore.attemptedPayloads.length, 2, "a row error does not skip later claimed work");
assert.equal(
  drainStore.deliveries.get("failing-subscription:deal-1:hot").status,
  "processing",
  "the failed row remains leased for stale-claim recovery",
);
assert.equal(
  drainStore.deliveries.get("later-subscription:deal-1:hot").status,
  "delivered",
  "later claimed work is finalized before the aggregate error is surfaced",
);

console.log("notification logic tests passed");
