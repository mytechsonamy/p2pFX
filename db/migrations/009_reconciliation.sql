-- Reconciliation: the platform's settlements, bank deals and hedges compared with core banking and the LPs.

create table recon_runs (
  id uuid primary key default gen_random_uuid(),
  -- platform records created in [window_from, window_to) are checked; core banking postings in the same window too
  window_from timestamptz not null,
  window_to timestamptz not null,
  trigger text not null check (trigger in ('SCHEDULED', 'MANUAL')),
  actor text not null,
  status text not null check (status in ('RUNNING', 'CLEAN', 'OPEN_ITEMS', 'BREAKS', 'FAILED')),
  -- whether core banking listed its postings (amounts compared, unknown postings found) or was only asked per key
  core_listing boolean,
  summary jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index recon_runs_started_idx on recon_runs (started_at desc);
-- One run at a time.
create unique index recon_runs_one_running_idx on recon_runs ((true)) where status = 'RUNNING';

create table recon_breaks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references recon_runs(id),
  -- BREAK: the two sides disagree. OPEN_ITEM: a record still unresolved past the grace time, or one that could not be checked.
  severity text not null check (severity in ('BREAK', 'OPEN_ITEM')),
  kind text not null,
  source text not null check (source in ('SETTLEMENT', 'BANK_DEAL', 'HEDGE', 'CORE')),
  -- the platform id (settlement, deal, hedge) or the core banking txnRef
  ref text not null,
  details jsonb not null,
  created_at timestamptz not null default now()
);
create index recon_breaks_run_idx on recon_breaks (run_id, severity);

-- When operations last retried a settlement or a deal: an open record is aged from its creation or this, whichever is
-- later (updated_at moves on every automatic recovery attempt).
alter table settlements add column retried_at timestamptz;
alter table bank_deals add column retried_at timestamptz;
