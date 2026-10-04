-- P2P FX exchange: core schema. One database per bank deployment.

create table customers (
  id uuid primary key default gen_random_uuid(),
  customer_ref text not null unique,
  segment text not null default 'default',
  locale text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Versioned bank configuration (pairs, commission, tax, balance mode, hours, limits, branding).
create table config (
  version serial primary key,
  data jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  seq bigserial not null unique,
  customer_id uuid not null references customers(id),
  pair text not null,
  side text not null check (side in ('BUY', 'SELL')),
  book_price numeric(24, 8) not null,
  -- quantities in minor units of the base currency
  qty bigint not null check (qty > 0),
  filled_qty bigint not null default 0,
  validity text not null check (validity in ('DAY', 'GTD', 'GTC')),
  expires_at timestamptz not null,
  fx_account_id text not null,
  try_account_id text not null,
  -- block mode: one hold for the life of the order
  hold_id text,
  status text not null check (status in ('NEW', 'QUEUED', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')),
  cancel_reason text,
  -- commission and tax confirmed by the customer at entry
  pricing jsonb not null,
  config_version int not null references config(version),
  balance_mode text not null,
  -- value at book price, quote minor units (for daily limits)
  notional bigint not null,
  idempotency_key text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, idempotency_key)
);
create index orders_customer_idx on orders (customer_id, created_at desc);
create index orders_live_idx on orders (pair, seq) where status in ('OPEN', 'PARTIAL');
create index orders_expiry_idx on orders (expires_at) where status in ('OPEN', 'PARTIAL', 'QUEUED');

create table fills (
  id uuid primary key default gen_random_uuid(),
  seq bigserial not null unique,
  pair text not null,
  maker_order_id uuid not null references orders(id),
  taker_order_id uuid not null references orders(id),
  buy_order_id uuid not null references orders(id),
  sell_order_id uuid not null references orders(id),
  book_price numeric(24, 8) not null,
  qty bigint not null,
  notional bigint not null,
  buyer_effective_price numeric(24, 8) not null,
  seller_effective_price numeric(24, 8) not null,
  buyer_commission bigint not null,
  seller_commission bigint not null,
  buyer_tax bigint not null,
  seller_tax bigint not null,
  -- what the buyer paid and the seller received, quote minor units
  buyer_total bigint not null,
  seller_total bigint not null,
  config_version int not null references config(version),
  created_at timestamptz not null default now()
);
create index fills_buy_idx on fills (buy_order_id);
create index fills_sell_idx on fills (sell_order_id);
create index fills_created_idx on fills (created_at);

-- Two bank FX transactions per fill: BANK_BUY (from seller) and BANK_SELL (to buyer).
create table settlements (
  id uuid primary key default gen_random_uuid(),
  fill_id uuid not null references fills(id),
  leg text not null check (leg in ('BANK_BUY', 'BANK_SELL')),
  idempotency_key text not null unique,
  hold_ids text[] not null default '{}',
  core_txn_ref text,
  receipt_ref text,
  reversal_ref text,
  status text not null check (status in ('PENDING', 'SETTLED', 'FAILED_NEEDS_REVIEW', 'REVERSED')),
  attempts int not null default 0,
  retry_round int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fill_id, leg)
);
create index settlements_status_idx on settlements (status) where status <> 'SETTLED';

create table audit_log (
  id bigserial primary key,
  actor text not null,
  action text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- Append-only: block updates and deletes.
create function audit_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_append_only();
