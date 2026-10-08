-- Customers can change a live or queued limit order's price and quantity (PATCH /v1/orders/:id).
alter table orders add column amended_at timestamptz;
