-- LP execution quality: the price the clip was sent at, the worst price accepted, how long the LP took and
-- why it rejected. `if not exists`: another branch may already have added expected_rate.
alter table hedges add column if not exists expected_rate numeric(24, 8);
alter table hedges add column if not exists limit_rate numeric(24, 8);
alter table hedges add column if not exists latency_ms integer;
alter table hedges add column if not exists reject_reason text;
