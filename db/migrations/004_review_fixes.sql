-- Fixes from the external review of c4a79ba.

-- F02: a posting whose outcome is unknown (timeout, lost response) is neither settled nor failed.
alter table settlements drop constraint settlements_status_check;
alter table settlements add constraint settlements_status_check
  check (status in ('PENDING', 'SETTLED', 'FAILED_NEEDS_REVIEW', 'REVERSED', 'UNKNOWN_OUTCOME'));

-- F04 / F16: an order can never be filled beyond its quantity.
alter table orders add constraint orders_filled_qty_check check (filled_qty >= 0 and filled_qty <= qty);

-- F03: a hedge clip is recorded before it is sent (PENDING), with the reference the LP gets.
-- rate is the expected LP price until the execution confirms the real one.
alter table hedges add column status text not null default 'DONE' check (status in ('PENDING', 'DONE', 'REJECTED', 'UNKNOWN'));
alter table hedges add column lp_ref text;
alter table hedges alter column lp_trade_ref drop not null;
create unique index hedges_lp_ref_idx on hedges (lp, lp_ref) where lp_ref is not null;
create unique index hedges_lp_trade_ref_idx on hedges (lp, lp_trade_ref) where lp_trade_ref is not null;
create index hedges_open_idx on hedges (status) where status in ('PENDING', 'UNKNOWN');
