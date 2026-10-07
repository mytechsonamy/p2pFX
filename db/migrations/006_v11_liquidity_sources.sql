-- Product definition v1.1: liquidity sources and principals, fee records, principal executions (bank position on
-- the fill, not on settlement), market orders, liquidity generations and the event log.

-- ---- principals: who carries the economic risk of an order ----

create table principals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('CUSTOMER', 'BANK', 'THIRD_PARTY')),
  name text not null,
  created_at timestamptz not null default now()
);
-- The bank itself (one deployment = one bank). Its ladder (BANK_MM), its bot (BOT_MM) and its Direct deals all
-- belong to it, share its inventory limit and never trade with each other.
insert into principals (id, kind, name) values ('00000000-0000-0000-0000-000000000001', 'BANK', 'Banka');

alter table customers add column principal_id uuid references principals(id);
-- Existing customers become their own principals; the bank's trading account (segment 'bank') the bank's.
do $$
declare r record;
begin
  for r in select id, customer_ref, segment from customers loop
    if r.segment = 'bank' then
      update customers set principal_id = '00000000-0000-0000-0000-000000000001' where id = r.id;
    else
      with p as (insert into principals (kind, name) values ('CUSTOMER', r.customer_ref) returning id)
      update customers set principal_id = (select id from p) where id = r.id;
    end if;
  end loop;
end $$;

-- A customer created without a principal is their own.
create function customers_default_principal() returns trigger language plpgsql as $$
begin
  if new.principal_id is null then
    insert into principals (kind, name) values ('CUSTOMER', new.customer_ref) returning id into new.principal_id;
  end if;
  return new;
end $$;
create trigger customers_principal before insert on customers for each row execute function customers_default_principal();
alter table customers alter column principal_id set not null;

-- ---- orders: source, principal, strategy, generation, type ----

alter table orders add column source text not null default 'CUSTOMER' check (source in ('CUSTOMER', 'BANK_MM', 'BOT_MM'));
alter table orders add column principal_id uuid references principals(id);
alter table orders add column strategy_id text;
alter table orders add column generation_id bigint;
alter table orders add column order_type text not null default 'LIMIT' check (order_type in ('LIMIT', 'MARKET'));
update orders o set principal_id = c.principal_id from customers c where c.id = o.customer_id;
update orders set source = 'BANK_MM', strategy_id = 'bank-ladder' where principal_id = '00000000-0000-0000-0000-000000000001';
alter table orders alter column principal_id set not null;
-- Market orders never rest: they live for one match (IOC).
alter table orders drop constraint orders_validity_check;
alter table orders add constraint orders_validity_check check (validity in ('DAY', 'GTD', 'GTC', 'IOC'));
create index orders_liquidity_idx on orders (pair, source, strategy_id) where status in ('OPEN', 'PARTIAL');

create sequence liquidity_generation_seq;

-- ---- fills: who traded with whom, and the price evidence at execution ----

alter table fills add column buyer_principal_id uuid references principals(id);
alter table fills add column seller_principal_id uuid references principals(id);
alter table fills add column maker_source text;
alter table fills add column taker_source text;
-- C2C: two customers (the only P2P volume). C2B: a customer with the bank's ladder or bot.
alter table fills add column flow text check (flow in ('C2C', 'C2B'));
-- LP bid/ask, the bank's Direct rates and the book generation at the moment of the fill.
alter table fills add column price_evidence jsonb;
-- Settlement status the customers were last told about (each change is announced once).
alter table fills add column notified_status text;
update fills f set
  buyer_principal_id = b.principal_id, seller_principal_id = s.principal_id,
  maker_source = (case when f.maker_order_id = b.id then b.source else s.source end),
  taker_source = (case when f.taker_order_id = b.id then b.source else s.source end),
  flow = (case when b.source = 'CUSTOMER' and s.source = 'CUSTOMER' then 'C2C' else 'C2B' end),
  notified_status = 'LEGACY'
from orders b, orders s where b.id = f.buy_order_id and s.id = f.sell_order_id;
alter table fills alter column buyer_principal_id set not null;
alter table fills alter column seller_principal_id set not null;
alter table fills alter column flow set not null;

-- One fee record per customer side of a fill, with the fee policy (configuration version) it was charged under.
create table fee_records (
  id bigserial primary key,
  fill_id uuid not null references fills(id),
  side text not null check (side in ('BUY', 'SELL')),
  leg text not null check (leg in ('BANK_BUY', 'BANK_SELL')),
  currency text not null,
  fee_mode text not null check (fee_mode in ('PIPS', 'BPS')),
  -- PIPS: commission per unit (quote currency); BPS: the fraction of the book price
  fee_rate numeric(24, 12) not null,
  fee_amount bigint not null,
  policy_version int not null references config(version),
  created_at timestamptz not null default now(),
  unique (fill_id, side)
);
insert into fee_records (fill_id, side, leg, currency, fee_mode, fee_rate, fee_amount, policy_version)
select f.id, x.side, x.leg, right(f.pair, 3), 'PIPS', x.rate, x.amount, f.config_version
  from fills f
  join orders b on b.id = f.buy_order_id join orders s on s.id = f.sell_order_id
  cross join lateral (values
    ('BUY', 'BANK_SELL', (b.pricing->>'commissionPerUnit')::numeric / 1e8, f.buyer_commission, b.source),
    ('SELL', 'BANK_BUY', (s.pricing->>'commissionPerUnit')::numeric / 1e8, f.seller_commission, s.source)) as x(side, leg, rate, amount, source)
 where x.source = 'CUSTOMER';

-- ---- principal executions: every trade where the bank is principal, the source of its position ----

create table principal_executions (
  id uuid primary key default gen_random_uuid(),
  seq bigserial not null unique,
  -- BOARD: a fill with the bank's ladder or bot. DIRECT: a Bank Direct deal.
  channel text not null check (channel in ('BOARD', 'DIRECT')),
  ref_id uuid not null,
  pair text not null,
  source text not null check (source in ('BANK_MM', 'BOT_MM', 'BANK_DIRECT')),
  -- the bank's side
  bank_side text not null check (bank_side in ('BUY', 'SELL')),
  qty bigint not null check (qty > 0),
  price numeric(24, 8) not null,
  -- signed base minor units: + the bank bought
  position_delta bigint not null,
  reference jsonb,
  config_version int references config(version),
  created_at timestamptz not null default now(),
  unique (channel, ref_id)
);
create index principal_executions_pair_idx on principal_executions (pair, seq);
-- History: bank-side fills and settled Direct deals become executions.
insert into principal_executions (channel, ref_id, pair, source, bank_side, qty, price, position_delta, config_version, created_at)
select 'BOARD', f.id, f.pair, case when b.principal_id = '00000000-0000-0000-0000-000000000001' then b.source else s.source end,
       case when b.principal_id = '00000000-0000-0000-0000-000000000001' then 'BUY' else 'SELL' end,
       f.qty, f.book_price,
       case when b.principal_id = '00000000-0000-0000-0000-000000000001' then f.qty else -f.qty end,
       f.config_version, f.created_at
  from fills f join orders b on b.id = f.buy_order_id join orders s on s.id = f.sell_order_id
 where (b.principal_id = '00000000-0000-0000-0000-000000000001') <> (s.principal_id = '00000000-0000-0000-0000-000000000001');
insert into principal_executions (channel, ref_id, pair, source, bank_side, qty, price, position_delta, created_at)
select 'DIRECT', d.id, d.pair, 'BANK_DIRECT', case d.side when 'BUY' then 'SELL' else 'BUY' end, d.qty, d.rate,
       case d.side when 'BUY' then -d.qty else d.qty end, d.created_at
  from bank_deals d where d.status in ('SETTLED', 'FAILED_NEEDS_REVIEW');

-- ---- Direct: margins are in pips now (1 bip = 100 pips) ----

alter table bank_quotes rename column margin_bips to margin_pips;
update bank_quotes set margin_pips = margin_pips * 100;

-- ---- the event log ----

create table events (
  id bigserial primary key,
  event_id uuid not null unique default gen_random_uuid(),
  type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  aggregate_version int not null,
  pair text,
  -- per pair, in sequencer order
  pair_seq bigint,
  correlation_id text,
  causation_id text,
  config_version int,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (aggregate_type, aggregate_id, aggregate_version)
);
create index events_pair_idx on events (pair, pair_seq);
create trigger events_no_update before update or delete on events for each row execute function audit_log_append_only();

create table pair_sequences (
  pair text primary key,
  seq bigint not null default 0
);
