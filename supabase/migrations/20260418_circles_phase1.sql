create extension if not exists pgcrypto;

create table if not exists public.circles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.circle_members (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  status text not null default 'active' check (status in ('pending', 'active')),
  joined_at timestamptz not null default now(),
  unique (circle_id, user_id)
);

create table if not exists public.circle_invites (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  invited_by uuid not null references auth.users(id),
  invite_code text not null unique,
  invited_email text,
  accepted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

create table if not exists public.circle_projects (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'active',
  notes text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  last_updated timestamptz not null default now()
);

create table if not exists public.circle_tasks (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  project_id uuid references public.circle_projects(id) on delete set null,
  title text not null,
  notes text,
  due_date date,
  created_by uuid not null references auth.users(id),
  completed boolean not null default false,
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists circles_created_by_idx on public.circles (created_by);
create index if not exists circle_members_circle_id_idx on public.circle_members (circle_id);
create index if not exists circle_members_user_id_idx on public.circle_members (user_id);
create index if not exists circle_invites_circle_id_idx on public.circle_invites (circle_id);
create index if not exists circle_invites_code_idx on public.circle_invites (invite_code);
create index if not exists circle_projects_circle_id_idx on public.circle_projects (circle_id);
create index if not exists circle_tasks_circle_id_idx on public.circle_tasks (circle_id);
create index if not exists circle_tasks_project_id_idx on public.circle_tasks (project_id);

create or replace function public.is_active_circle_member(target_circle_id uuid, target_user_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.circle_members cm
    where cm.circle_id = target_circle_id
      and cm.user_id = target_user_id
      and cm.status = 'active'
  );
$$;

create or replace function public.can_join_circle_via_invite(target_circle_id uuid, target_user_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.circle_invites ci
    where ci.circle_id = target_circle_id
      and ci.accepted_at is null
      and ci.expires_at > now()
      and (
        ci.invited_email is null
        or lower(ci.invited_email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
      )
  );
$$;

create or replace function public.enforce_circle_member_cap()
returns trigger
language plpgsql
as $$
declare
  active_member_count integer;
begin
  if new.status <> 'active' then
    return new;
  end if;

  select count(*)
  into active_member_count
  from public.circle_members cm
  where cm.circle_id = new.circle_id
    and cm.status = 'active'
    and cm.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

  if active_member_count >= 5 then
    raise exception 'Circle member limit reached. A circle can have at most 5 active members.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_circle_member_cap_on_insert_or_update on public.circle_members;
create trigger enforce_circle_member_cap_on_insert_or_update
before insert or update of status, circle_id
on public.circle_members
for each row
execute function public.enforce_circle_member_cap();

create or replace function public.touch_circle_project_last_updated()
returns trigger
language plpgsql
as $$
begin
  new.last_updated = now();
  return new;
end;
$$;

drop trigger if exists touch_circle_project_last_updated on public.circle_projects;
create trigger touch_circle_project_last_updated
before update on public.circle_projects
for each row
execute function public.touch_circle_project_last_updated();

create or replace function public.get_circle_invite_by_code(target_invite_code text)
returns table (
  id uuid,
  circle_id uuid,
  invited_by uuid,
  invite_code text,
  invited_email text,
  accepted_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    ci.id,
    ci.circle_id,
    ci.invited_by,
    ci.invite_code,
    ci.invited_email,
    ci.accepted_at,
    ci.expires_at,
    ci.created_at
  from public.circle_invites ci
  where ci.invite_code = target_invite_code
    and ci.accepted_at is null
    and ci.expires_at > now()
  limit 1;
$$;

revoke all on function public.get_circle_invite_by_code(text) from public;
grant execute on function public.get_circle_invite_by_code(text) to anon, authenticated;

alter table public.circles enable row level security;
alter table public.circle_members enable row level security;
alter table public.circle_invites enable row level security;
alter table public.circle_projects enable row level security;
alter table public.circle_tasks enable row level security;

create policy "circles_select_for_members_or_creator"
on public.circles
for select
to authenticated
using (
  created_by = auth.uid()
  or public.is_active_circle_member(id, auth.uid())
);

create policy "circles_insert_by_creator"
on public.circles
for insert
to authenticated
with check (created_by = auth.uid());

create policy "circles_update_for_active_members_or_creator"
on public.circles
for update
to authenticated
using (
  created_by = auth.uid()
  or public.is_active_circle_member(id, auth.uid())
)
with check (
  created_by = auth.uid()
  or public.is_active_circle_member(id, auth.uid())
);

create policy "circle_members_select_for_active_members"
on public.circle_members
for select
to authenticated
using (
  exists (
    select 1
    from public.circle_members cm
    where cm.circle_id = circle_members.circle_id
      and cm.user_id = auth.uid()
      and cm.status = 'active'
  )
  or exists (
    select 1
    from public.circles c
    where c.id = circle_members.circle_id
      and c.created_by = auth.uid()
  )
);

create policy "circle_members_insert_for_creator_or_joining_user"
on public.circle_members
for insert
to authenticated
with check (
  (
    auth.uid() = user_id
    and (
      exists (
        select 1
        from public.circles c
        where c.id = circle_id
          and c.created_by = auth.uid()
      )
      or public.can_join_circle_via_invite(circle_id, auth.uid())
    )
  )
  or exists (
    select 1
    from public.circles c
    where c.id = circle_id
      and c.created_by = auth.uid()
  )
);

create policy "circle_members_delete_for_creator_or_self"
on public.circle_members
for delete
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.circles c
    where c.id = circle_members.circle_id
      and c.created_by = auth.uid()
  )
);

create policy "circle_invites_select_for_active_members"
on public.circle_invites
for select
to authenticated
using (
  public.is_active_circle_member(circle_id, auth.uid())
  or exists (
    select 1
    from public.circles c
    where c.id = circle_invites.circle_id
      and c.created_by = auth.uid()
  )
);

create policy "circle_invites_insert_for_active_members"
on public.circle_invites
for insert
to authenticated
with check (
  invited_by = auth.uid()
  and public.is_active_circle_member(circle_id, auth.uid())
);

create policy "circle_invites_delete_for_inviter_or_creator"
on public.circle_invites
for delete
to authenticated
using (
  invited_by = auth.uid()
  or exists (
    select 1
    from public.circles c
    where c.id = circle_invites.circle_id
      and c.created_by = auth.uid()
  )
);

create policy "circle_projects_select_for_active_members"
on public.circle_projects
for select
to authenticated
using (public.is_active_circle_member(circle_id, auth.uid()));

create policy "circle_projects_insert_for_active_members"
on public.circle_projects
for insert
to authenticated
with check (
  public.is_active_circle_member(circle_id, auth.uid())
  and created_by = auth.uid()
);

create policy "circle_projects_update_for_active_members"
on public.circle_projects
for update
to authenticated
using (public.is_active_circle_member(circle_id, auth.uid()))
with check (public.is_active_circle_member(circle_id, auth.uid()));

create policy "circle_projects_delete_for_active_members"
on public.circle_projects
for delete
to authenticated
using (public.is_active_circle_member(circle_id, auth.uid()));

create policy "circle_tasks_select_for_active_members"
on public.circle_tasks
for select
to authenticated
using (public.is_active_circle_member(circle_id, auth.uid()));

create policy "circle_tasks_insert_for_active_members"
on public.circle_tasks
for insert
to authenticated
with check (
  public.is_active_circle_member(circle_id, auth.uid())
  and created_by = auth.uid()
);

create policy "circle_tasks_update_for_active_members"
on public.circle_tasks
for update
to authenticated
using (public.is_active_circle_member(circle_id, auth.uid()))
with check (public.is_active_circle_member(circle_id, auth.uid()));

create policy "circle_tasks_delete_for_active_members"
on public.circle_tasks
for delete
to authenticated
using (public.is_active_circle_member(circle_id, auth.uid()));
