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
