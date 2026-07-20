-- Keep the data needed for a delivery in the queue so retries never depend on
-- a later scrape still containing the same deal at the same heat.
alter table public.notification_deliveries
  add column if not exists payload jsonb not null default jsonb_build_object(
    'title', 'Deal alert',
    'body', 'Tap to view this deal.',
    'url', '/',
    'tag', 'legacy-' || gen_random_uuid()::text,
    'icon', '/icons/app-icon-192.png',
    '_legacy_default', true
  ),
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists processing_started_at timestamptz,
  add column if not exists claim_token uuid;

-- Older pending/transient rows did not retain deal details. Preserve their
-- retryability with a generic but valid payload instead of discarding them.
update public.notification_deliveries
set payload = jsonb_build_object(
  'title', upper(velocity_label) || ': Deal alert',
  'body', 'Tap to view this deal.',
  'url', '/',
  'tag', thread_id || ':' || velocity_label,
  'icon', '/icons/app-icon-192.png'
)
where payload is null
   or payload @> '{"_legacy_default":true}'::jsonb;

alter table public.notification_deliveries
  alter column payload set not null,
  alter column attempts set default 0;

alter table public.notification_deliveries
  drop constraint if exists valid_delivery_status;

alter table public.notification_deliveries
  add constraint valid_delivery_status check (
    status in ('pending','processing','accepted','delivered','failed_transient','failed_permanent')
  ),
  add constraint valid_delivery_payload check (jsonb_typeof(payload) = 'object');

comment on column public.notification_deliveries.status is
  'pending is queued; processing is leased; accepted means the push service accepted the request, not device receipt; delivered is legacy; failures are transient or permanent';

create index if not exists notification_deliveries_claimable_idx
  on public.notification_deliveries (next_attempt_at, processing_started_at, id)
  where status in ('pending','processing','failed_transient');

-- Keep the old RPC safe during a migration-first rolling deploy. It creates a
-- generic durable payload because the old caller does not supply deal details;
-- the new worker only uses the batch lease function below.
create or replace function public.claim_notification_delivery(
  target_subscription_id uuid,
  target_thread_id text,
  target_velocity_label text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  insert into public.notification_deliveries (
    subscription_id,
    thread_id,
    velocity_label,
    payload,
    status,
    attempts,
    processing_started_at,
    claim_token
  ) values (
    target_subscription_id,
    target_thread_id,
    target_velocity_label,
    jsonb_build_object(
      'title', upper(target_velocity_label) || ': Deal alert',
      'body', 'Tap to view this deal.',
      'url', '/',
      'tag', target_thread_id || ':' || target_velocity_label,
      'icon', '/icons/app-icon-192.png'
    ),
    'processing',
    1,
    now(),
    gen_random_uuid()
  )
  on conflict (subscription_id, thread_id, velocity_label) do update
    set status = 'processing',
        attempts = notification_deliveries.attempts + 1,
        error_message = null,
        processing_started_at = now(),
        claim_token = gen_random_uuid(),
        updated_at = now()
    where (
      notification_deliveries.status in ('pending', 'failed_transient')
      and notification_deliveries.next_attempt_at <= now()
    ) or (
      notification_deliveries.status = 'processing'
      and (
        notification_deliveries.processing_started_at is null
        or notification_deliveries.processing_started_at <= now() - interval '15 minutes'
      )
    )
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_notification_delivery(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_notification_delivery(uuid, text, text) to service_role;

create function public.claim_notification_deliveries(claim_limit integer default 100)
returns table (
  delivery_id bigint,
  subscription_id uuid,
  thread_id text,
  velocity_label text,
  payload jsonb,
  delivery_attempts integer,
  claim_token uuid,
  next_attempt_at timestamptz,
  endpoint text,
  p256dh text,
  auth text
)
language sql
security definer
set search_path = public
as $$
  with candidates as materialized (
    select delivery.id
    from public.notification_deliveries as delivery
    join public.push_subscriptions as subscription
      on subscription.id = delivery.subscription_id
    where subscription.enabled
      and (
        (
          delivery.status in ('pending', 'failed_transient')
          and delivery.next_attempt_at <= now()
        )
        or (
          delivery.status = 'processing'
          and (
            delivery.processing_started_at is null
            or delivery.processing_started_at <= now() - interval '15 minutes'
          )
        )
      )
    order by delivery.next_attempt_at, delivery.id
    for update of delivery skip locked
    limit least(greatest(coalesce(claim_limit, 100), 0), 500)
  ),
  claimed as (
    update public.notification_deliveries as delivery
    set status = 'processing',
        attempts = delivery.attempts + 1,
        error_message = null,
        processing_started_at = now(),
        claim_token = gen_random_uuid(),
        updated_at = now()
    from candidates
    where delivery.id = candidates.id
    returning
      delivery.id as delivery_id,
      delivery.subscription_id,
      delivery.thread_id,
      delivery.velocity_label,
      delivery.payload,
      delivery.attempts as delivery_attempts,
      delivery.claim_token,
      delivery.next_attempt_at
  )
  select
    claimed.delivery_id,
    claimed.subscription_id,
    claimed.thread_id,
    claimed.velocity_label,
    claimed.payload,
    claimed.delivery_attempts,
    claimed.claim_token,
    claimed.next_attempt_at,
    subscription.endpoint,
    subscription.p256dh,
    subscription.auth
  from claimed
  join public.push_subscriptions as subscription
    on subscription.id = claimed.subscription_id;
$$;

revoke all on function public.claim_notification_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(integer) to service_role;

-- Both the rolling-deploy RPC and the new worker now supply a payload. Remove
-- the bridge default so future producers cannot silently omit delivery data.
alter table public.notification_deliveries
  alter column payload drop default;
