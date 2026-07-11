-- Projects created with "Automatically expose new tables" disabled do not
-- necessarily apply Supabase's usual service_role default privileges. The
-- notification Edge Function is the only database client and needs explicit
-- access; anon and authenticated remain revoked by the preceding migration.
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.push_subscriptions to service_role;
grant select, insert, update, delete on table public.deal_stamp_state to service_role;
grant select, insert, update, delete on table public.notification_deliveries to service_role;
grant usage, select on sequence public.notification_deliveries_id_seq to service_role;

