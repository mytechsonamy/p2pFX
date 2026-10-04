-- Bank dealing: the bank's own FX desk (prices from liquidity providers, segment margins, positions).

-- Aggregated LP prices sampled over time (price history).
create table price_ticks (
  id bigserial primary key,
  pair text not null,
  bid numeric(24, 8) not null,
  ask numeric(24, 8) not null,
  at timestamptz not null default now()
);
create index price_ticks_pair_idx on price_ticks (pair, at);

-- Firm quotes given to customers; executable once until they expire.
create table bank_quotes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  pair text not null,
  -- the customer's side
  side text not null check (side in ('BUY', 'SELL')),
  qty bigint not null check (qty > 0),
  rate numeric(24, 8) not null,
  -- best LP price the rate was built on
  lp_rate numeric(24, 8) not null,
  segment text not null,
  margin_bips int not null,
  notional bigint not null,
  tax bigint not null,
  total bigint not null,
  status text not null check (status in ('OPEN', 'EXECUTED')),
  expires_at timestamptz not null,
  config_version int not null references config(version),
  created_at timestamptz not null default now()
);

-- Executed deals between a customer and the bank: one core banking FX transaction each.
create table bank_deals (
  id uuid primary key default gen_random_uuid(),
  seq bigserial not null unique,
  quote_id uuid not null unique references bank_quotes(id),
  customer_id uuid not null references customers(id),
  pair text not null,
  side text not null check (side in ('BUY', 'SELL')),
  qty bigint not null,
  rate numeric(24, 8) not null,
  lp_rate numeric(24, 8) not null,
  notional bigint not null,
  tax bigint not null,
  total bigint not null,
  -- the bank's margin over the LP price, quote minor units
  margin bigint not null,
  fx_account_id text not null,
  try_account_id text not null,
  status text not null check (status in ('PENDING', 'SETTLED', 'REJECTED', 'FAILED_NEEDS_REVIEW')),
  core_txn_ref text,
  receipt_ref text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bank_deals_customer_idx on bank_deals (customer_id, seq desc);

-- The bank's trades with liquidity providers to cover its position.
create table hedges (
  id uuid primary key default gen_random_uuid(),
  seq bigserial not null unique,
  pair text not null,
  -- the bank's side with the LP
  side text not null check (side in ('BUY', 'SELL')),
  qty bigint not null,
  rate numeric(24, 8) not null,
  lp text not null,
  lp_trade_ref text not null,
  -- clips of one hedge decision share a batch
  batch_id uuid not null,
  reason text not null check (reason in ('AUTO', 'MANUAL')),
  actor text not null,
  created_at timestamptz not null default now()
);
