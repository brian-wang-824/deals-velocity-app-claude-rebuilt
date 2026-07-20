import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import {
  acceptedDeliveryValues,
  assertDeliveryStatusPersisted,
  DELIVERY_STATUS,
  normalizeThresholds,
  PUSH_DELIVERY_OPTIONS,
  processNotificationSnapshot,
} from "./logic.mjs";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function thresholds(value: unknown): string[] {
  return normalizeThresholds(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function authenticate(installationId: string, managementSecret: string) {
  if (!installationId || !managementSecret) return null;
  const { data, error } = await supabase.from("push_subscriptions").select("*")
    .eq("installation_id", installationId).maybeSingle();
  if (error) throw error;
  if (!data || data.management_secret_hash !== await sha256(managementSecret)) return null;
  return data;
}

async function installationExists(installationId: string): Promise<boolean> {
  if (!installationId) return false;
  const { data, error } = await supabase.from("push_subscriptions").select("id")
    .eq("installation_id", installationId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function subscribe(req: Request, body: any) {
  const selected = thresholds(body.thresholds);
  if (!selected.length) return response({ error: "Select at least one threshold." }, 400);
  const subscription = body.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return response({ error: "Invalid push subscription." }, 400);
  }

  let installationId = body.installationId as string | null;
  let managementSecret = body.managementSecret as string | null;
  let existing = installationId && managementSecret
    ? await authenticate(installationId, managementSecret) : null;
  if (installationId && !existing) {
    const stale = !await installationExists(installationId);
    return response({
      error: stale ? "This notification installation is no longer registered." : "Invalid installation credentials.",
      code: stale ? "stale_installation" : "invalid_installation_credentials",
    }, 401);
  }
  let newSecret: string | null = null;
  if (!existing) {
    installationId = crypto.randomUUID();
    managementSecret = randomSecret();
    newSecret = managementSecret;
  }

  const record = {
    installation_id: installationId,
    management_secret_hash: await sha256(managementSecret!),
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    expiration_time: subscription.expirationTime,
    thresholds: selected,
    enabled: true,
    user_agent: req.headers.get("user-agent"),
    updated_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };
  const query = existing
    ? supabase.from("push_subscriptions").update(record).eq("id", existing.id)
    : supabase.from("push_subscriptions").upsert(record, { onConflict: "endpoint" });
  const { error } = await query;
  if (error) {
    console.error("Could not save push subscription", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return response({ error: "Could not save subscription." }, 500);
  }
  return response({ installationId, managementSecret: newSecret });
}

async function disable(body: any) {
  const existing = await authenticate(body.installationId, body.managementSecret);
  if (!existing) {
    if (body.installationId && !await installationExists(body.installationId)) {
      return response({ ok: true, alreadyDisabled: true });
    }
    return response({ error: "Invalid installation credentials.", code: "invalid_installation_credentials" }, 401);
  }
  const { error } = await supabase.from("push_subscriptions").delete().eq("id", existing.id);
  if (error) {
    console.error("Could not disable push subscription", {
      code: error.code, message: error.message, details: error.details, hint: error.hint,
    });
    return response({ error: "Could not disable subscription." }, 500);
  }
  return response({ ok: true });
}

async function markDelivery(delivery: any, values: Record<string, unknown>) {
  const result = await supabase.from("notification_deliveries")
    .update({
      ...values,
      processing_started_at: null,
      claim_token: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", delivery.delivery_id)
    .eq("status", "processing")
    .eq("claim_token", delivery.claim_token)
    .select("id")
    .maybeSingle();
  try {
    assertDeliveryStatusPersisted(result);
  } catch (error) {
    console.error("Could not persist notification delivery status", {
      deliveryId: delivery.delivery_id,
      subscriptionId: delivery.subscription_id,
      threadId: delivery.thread_id,
      velocityLabel: delivery.velocity_label,
      status: values.status,
      code: result.error?.code,
      message: result.error?.message,
    });
    throw error;
  }
}

async function sendDelivery(delivery: any): Promise<boolean> {
  let pushError: any = null;
  try {
    await webpush.sendNotification({
      endpoint: delivery.endpoint,
      keys: { p256dh: delivery.p256dh, auth: delivery.auth },
    }, JSON.stringify(delivery.payload), PUSH_DELIVERY_OPTIONS);
  } catch (error) {
    pushError = error;
  }

  if (!pushError) {
    await markDelivery(delivery, acceptedDeliveryValues(new Date().toISOString()));
    return true;
  }

  const permanent = pushError?.statusCode === 404 || pushError?.statusCode === 410;
  await markDelivery(delivery, {
    status: permanent ? DELIVERY_STATUS.FAILED_PERMANENT : DELIVERY_STATUS.FAILED_TRANSIENT,
    error_message: String(pushError?.message || pushError).slice(0, 1000),
    ...(permanent ? {} : { next_attempt_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() }),
  });
  if (permanent) {
    const { error } = await supabase.from("push_subscriptions").delete().eq("id", delivery.subscription_id);
    if (error) throw error;
  }
  return false;
}

async function loadHeatState(threadIds: string[]) {
  const { data, error } = await supabase.from("deal_heat_state")
    .select("thread_id,velocity_label").in("thread_id", threadIds);
  if (error) throw error;
  return data || [];
}

async function loadActiveSubscriptions() {
  const { data, error } = await supabase.from("push_subscriptions")
    .select("id,thresholds").eq("enabled", true);
  if (error) throw error;
  return data || [];
}

async function enqueueDeliveries(deliveries: any[]) {
  const { error } = await supabase.from("notification_deliveries").upsert(deliveries, {
    onConflict: "subscription_id,thread_id,velocity_label",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

async function advanceHeatState(deals: any[], scrapedAt: string) {
  const now = new Date().toISOString();
  const { error } = await supabase.from("deal_heat_state").upsert(
    deals.map((deal) => ({
      thread_id: String(deal.thread_id),
      velocity_label: String(deal.velocity_label || ""),
      observed_at: scrapedAt,
      updated_at: now,
    })),
    { onConflict: "thread_id" },
  );
  if (error) throw error;
}

async function claimDeliveries() {
  const { data, error } = await supabase.rpc("claim_notification_deliveries", { claim_limit: 100 });
  if (error) throw error;
  return data || [];
}

async function processSnapshot(req: Request, body: any) {
  if (req.headers.get("x-scrape-secret") !== Deno.env.get("SCRAPE_DISPATCH_SECRET")) {
    return response({ error: "Unauthorized." }, 401);
  }
  if (!Array.isArray(body.deals) || !body.scraped_at) return response({ error: "Invalid snapshot." }, 400);
  webpush.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com",
    Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!,
  );

  const result = await processNotificationSnapshot(body, {
    loadHeatState,
    loadActiveSubscriptions,
    enqueueDeliveries,
    advanceHeatState,
    claimDeliveries,
    sendDelivery,
  });
  return response({ ok: true, ...result });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return response({ error: "Method not allowed." }, 405);
  try {
    const path = new URL(req.url).pathname.replace(/\/$/, "");
    const body = await req.json();
    if (path.endsWith("/subscribe")) return await subscribe(req, body);
    if (path.endsWith("/disable")) return await disable(body);
    if (path.endsWith("/process")) return await processSnapshot(req, body);
    return response({ error: "Not found." }, 404);
  } catch (error) {
    console.error(error);
    return response({ error: "Unexpected notification service error." }, 500);
  }
});
