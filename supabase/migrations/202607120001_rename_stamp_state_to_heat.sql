-- Preserve notification state when upgrading an existing deployment.
alter table if exists public.deal_stamp_state rename to deal_heat_state;

grant select, insert, update, delete on table public.deal_heat_state to service_role;
