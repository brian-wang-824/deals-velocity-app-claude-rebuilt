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

function notificationBody(deal) {
  const details = [deal.store, deal.price].filter(Boolean).join(" \u00b7 ");
  return details || "Tap to view this deal.";
}

export function notificationPayload(deal) {
  const velocityLabel = String(deal.velocity_label || "");
  return {
    title: `${velocityLabel.toUpperCase()}: ${deal.title || "Deal alert"}`,
    body: notificationBody(deal),
    url: deal.url || "/",
    tag: `${deal.thread_id}:${velocityLabel}`,
    icon: deal.image_url || "/icons/app-icon-192.png",
  };
}

export function deliveriesForTransitions(transitions, subscriptions) {
  const deliveries = [];
  for (const deal of transitions) {
    const velocityLabel = String(deal.velocity_label || "");
    const threadId = String(deal.thread_id);
    for (const subscription of subscriptions) {
      if (!Array.isArray(subscription.thresholds) || !subscription.thresholds.includes(velocityLabel)) continue;
      deliveries.push({
        subscription_id: subscription.id,
        thread_id: threadId,
        velocity_label: velocityLabel,
        payload: notificationPayload(deal),
        status: "pending",
        attempts: 0,
      });
    }
  }
  return deliveries;
}

export async function processNotificationSnapshot(snapshot, dependencies) {
  const currentDeals = snapshot.deals.filter((deal) => String(deal.thread_id || ""));
  let queued = 0;

  if (currentDeals.length) {
    const threadIds = currentDeals.map((deal) => String(deal.thread_id));
    const priorRows = await dependencies.loadHeatState(threadIds);
    const priorByThread = new Map(priorRows.map((row) => [row.thread_id, row.velocity_label]));
    const transitions = currentDeals.filter((deal) =>
      enteredHigherHeat(priorByThread.get(String(deal.thread_id)), String(deal.velocity_label || ""))
    );
    const subscriptions = transitions.length ? await dependencies.loadActiveSubscriptions() : [];
    const deliveries = deliveriesForTransitions(transitions, subscriptions);

    if (deliveries.length) {
      await dependencies.enqueueDeliveries(deliveries);
      queued = deliveries.length;
    }
    await dependencies.advanceHeatState(currentDeals, snapshot.scraped_at);
  }

  let sent = 0;
  let failed = 0;
  const deliveryErrors = [];
  const claimedDeliveries = await dependencies.claimDeliveries();
  for (const delivery of claimedDeliveries) {
    try {
      if (await dependencies.sendDelivery(delivery)) sent += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      deliveryErrors.push(error);
    }
  }
  if (deliveryErrors.length) {
    throw new AggregateError(
      deliveryErrors,
      `${deliveryErrors.length} notification delivery error(s) occurred while draining the queue.`,
    );
  }
  return { queued, sent, failed };
}
