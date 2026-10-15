-- Customers can change a live or queued limit order's price and quantity (PATCH /v1/orders/:id).
-- (Was 008_order_amend before 008_lp_execution_stats took that number; `if not exists` keeps a database that applied it under the old name working.)
alter table orders add column if not exists amended_at timestamptz;
