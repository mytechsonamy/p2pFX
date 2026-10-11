-- Fencing for the matching leader. The instance holding the matching advisory lock takes a new epoch when it starts;
-- every write of matching (fills, liquidity generations, order closes) checks it in its own transaction, so an
-- instance that lost the lock (and so the epoch) can never commit a write after another one took over.
create table matching_leader (
  id int primary key check (id = 1),
  epoch bigint not null,
  holder text,
  since timestamptz
);
insert into matching_leader (id, epoch) values (1, 0);
