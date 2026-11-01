create table if not exists public.clients (
  client_key text primary key,
  name text not null,
  business_name text not null,
  email text not null default '',
  phone text not null default '',
  gstin text not null default '',
  status text not null default 'Pending',
  document_checklist jsonb not null default '[]'::jsonb,
  ca_id text,
  upload_token text,
  due_day_of_month integer not null default 5 check (due_day_of_month between 1 and 31),
  auto_remind boolean not null default true,
  last_reminder_sent timestamptz
);

alter table public.clients add column if not exists client_key text;
alter table public.clients add column if not exists name text not null default '';
alter table public.clients add column if not exists business_name text not null default '';
alter table public.clients add column if not exists email text not null default '';
alter table public.clients add column if not exists phone text not null default '';
alter table public.clients add column if not exists gstin text not null default '';
alter table public.clients add column if not exists status text not null default 'Pending';
alter table public.clients add column if not exists document_checklist jsonb not null default '[]'::jsonb;
alter table public.clients add column if not exists ca_id text;
alter table public.clients add column if not exists upload_token text;
alter table public.clients add column if not exists due_day_of_month integer not null default 5;
alter table public.clients add column if not exists auto_remind boolean not null default true;
alter table public.clients add column if not exists last_reminder_sent timestamptz;
update public.clients set upload_token = gen_random_uuid()::text where upload_token is null or trim(upload_token) = '';
alter table public.clients alter column upload_token set default gen_random_uuid()::text;
alter table public.clients alter column upload_token set not null;

do $$
declare
  id_type text;
begin
  select data_type into id_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'clients' and column_name = 'id';

  if id_type = 'uuid' then
    alter table public.clients alter column id set default gen_random_uuid();
    update public.clients set client_key = id::text where client_key is null;
  elsif id_type in ('text', 'character varying') then
    alter table public.clients alter column id set default gen_random_uuid()::text;
    update public.clients set client_key = id::text where client_key is null;
  end if;
end $$;

create unique index if not exists clients_client_key_key on public.clients (client_key);
create unique index if not exists clients_upload_token_key on public.clients (upload_token);
alter table public.clients alter column client_key set not null;

create table if not exists public.app_state (
  key text primary key,
  value jsonb not null
);

create table if not exists public.authorized_tenants (
  email text primary key check (email = lower(trim(email))),
  practice_name text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.authorized_tenants add column if not exists email text;
alter table public.authorized_tenants add column if not exists practice_name text not null default '';
alter table public.authorized_tenants add column if not exists is_active boolean not null default true;
alter table public.authorized_tenants add column if not exists created_at timestamptz not null default now();

create table if not exists public.practice_settings (
  ca_id text primary key,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_logs (
  id text primary key,
  ca_id text,
  email text not null default '',
  event_type text not null,
  action text not null default '',
  client_id text,
  client_name text not null default 'System',
  details text not null default '',
  created_at timestamptz not null default now()
);

alter table public.activity_logs add column if not exists ca_id text;
alter table public.activity_logs add column if not exists id text;
alter table public.activity_logs add column if not exists email text not null default '';
alter table public.activity_logs add column if not exists event_type text not null default 'ACTIVITY';
alter table public.activity_logs add column if not exists action text not null default '';
alter table public.activity_logs add column if not exists client_id text;
alter table public.activity_logs add column if not exists client_name text not null default 'System';
alter table public.activity_logs add column if not exists details text not null default '';
alter table public.activity_logs add column if not exists created_at timestamptz not null default now();

create index if not exists clients_ca_status_idx on public.clients (ca_id, status);
create index if not exists activity_logs_ca_created_idx on public.activity_logs (ca_id, created_at desc);

alter table public.clients enable row level security;
alter table public.app_state enable row level security;
alter table public.authorized_tenants enable row level security;
alter table public.practice_settings enable row level security;
alter table public.activity_logs enable row level security;

grant all on table public.clients, public.app_state, public.authorized_tenants, public.practice_settings, public.activity_logs to service_role;
