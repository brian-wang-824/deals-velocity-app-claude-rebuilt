alter table public.notification_deliveries
  add column if not exists accepted_at timestamptz;

alter table public.notification_deliveries
  drop constraint if exists valid_delivery_status;

alter table public.notification_deliveries
  add constraint valid_delivery_status check (
    status in ('pending','accepted','delivered','failed_transient','failed_permanent')
  );

-- Existing "delivered" rows only represent acceptance by the Web Push service.
-- Keep delivered_at populated for compatibility while recording the accurate state.
update public.notification_deliveries
set status = 'accepted',
    accepted_at = coalesce(accepted_at, delivered_at, updated_at, created_at)
where status = 'delivered';

comment on column public.notification_deliveries.status is
  'pending, accepted by the push service, explicitly device-delivered, or a transient/permanent failure';
comment on column public.notification_deliveries.accepted_at is
  'Time the Web Push service accepted the notification for delivery; not proof the device displayed it';
comment on column public.notification_deliveries.delivered_at is
  'Reserved for explicit device delivery confirmation; retained on legacy rows for compatibility';
