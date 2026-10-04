-- Back office: named operators, change reasons and diffs on configuration versions, confirmations of defaults.

create table ops_users (
  username text primary key,
  display_name text not null,
  -- viewer: read only. editor: change parameters, retry settlements, hedge. admin: editor + manage users.
  role text not null check (role in ('viewer', 'editor', 'admin')),
  -- scrypt$<salt hex>$<hash hex>
  password_hash text not null,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

alter table config add column reason text;
-- Leaf-level changes against the previous version: [{ path, from, to }].
alter table config add column diff jsonb not null default '[]';
-- Set when the version restores an earlier one.
alter table config add column reverted_from int references config(version);

-- An operator confirmed that a shipped default is what the bank wants, without changing it.
create table config_confirmations (
  id bigserial primary key,
  assumption text not null,
  config_version int not null references config(version),
  confirmed_by text not null,
  reason text,
  created_at timestamptz not null default now()
);
create index config_confirmations_key_idx on config_confirmations (assumption);
