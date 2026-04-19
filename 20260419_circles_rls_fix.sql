create or replace function public.is_circle_owner(target_circle_id uuid, target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.circles c
    where c.id = target_circle_id
      and c.created_by = target_user_id
  );
$$;

create or replace function public.is_active_circle_member(target_circle_id uuid, target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
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
security definer
set search_path = public
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

revoke all on function public.is_circle_owner(uuid, uuid) from public;
revoke all on function public.is_active_circle_member(uuid, uuid) from public;
revoke all on function public.can_join_circle_via_invite(uuid, uuid) from public;
grant execute on function public.is_circle_owner(uuid, uuid) to authenticated;
grant execute on function public.is_active_circle_member(uuid, uuid) to authenticated;
grant execute on function public.can_join_circle_via_invite(uuid, uuid) to authenticated;

drop policy if exists "circles_select_for_members_or_creator" on public.circles;
create policy "circles_select_for_members_or_creator"
on public.circles
for select
to authenticated
using (
  public.is_circle_owner(id, auth.uid())
  or public.is_active_circle_member(id, auth.uid())
);

drop policy if exists "circles_update_for_active_members_or_creator" on public.circles;
create policy "circles_update_for_active_members_or_creator"
on public.circles
for update
to authenticated
using (
  public.is_circle_owner(id, auth.uid())
  or public.is_active_circle_member(id, auth.uid())
)
with check (
  public.is_circle_owner(id, auth.uid())
  or public.is_active_circle_member(id, auth.uid())
);

drop policy if exists "circle_members_select_for_active_members" on public.circle_members;
create policy "circle_members_select_for_active_members"
on public.circle_members
for select
to authenticated
using (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
);

drop policy if exists "circle_members_insert_for_creator_or_joining_user" on public.circle_members;
create policy "circle_members_insert_for_creator_or_joining_user"
on public.circle_members
for insert
to authenticated
with check (
  public.is_circle_owner(circle_id, auth.uid())
  or (
    auth.uid() = user_id
    and public.can_join_circle_via_invite(circle_id, auth.uid())
  )
);

drop policy if exists "circle_members_delete_for_creator_or_self" on public.circle_members;
create policy "circle_members_delete_for_creator_or_self"
on public.circle_members
for delete
to authenticated
using (
  user_id = auth.uid()
  or public.is_circle_owner(circle_id, auth.uid())
);

drop policy if exists "circle_invites_select_for_active_members" on public.circle_invites;
create policy "circle_invites_select_for_active_members"
on public.circle_invites
for select
to authenticated
using (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
);

drop policy if exists "circle_invites_insert_for_active_members" on public.circle_invites;
create policy "circle_invites_insert_for_active_members"
on public.circle_invites
for insert
to authenticated
with check (
  invited_by = auth.uid()
  and (
    public.is_circle_owner(circle_id, auth.uid())
    or public.is_active_circle_member(circle_id, auth.uid())
  )
);

drop policy if exists "circle_invites_delete_for_inviter_or_creator" on public.circle_invites;
create policy "circle_invites_delete_for_inviter_or_creator"
on public.circle_invites
for delete
to authenticated
using (
  invited_by = auth.uid()
  or public.is_circle_owner(circle_id, auth.uid())
);

drop policy if exists "circle_projects_select_for_active_members" on public.circle_projects;
create policy "circle_projects_select_for_active_members"
on public.circle_projects
for select
to authenticated
using (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
);

drop policy if exists "circle_projects_insert_for_active_members" on public.circle_projects;
create policy "circle_projects_insert_for_active_members"
on public.circle_projects
for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    public.is_circle_owner(circle_id, auth.uid())
    or public.is_active_circle_member(circle_id, auth.uid())
  )
);

drop policy if exists "circle_projects_update_for_active_members" on public.circle_projects;
create policy "circle_projects_update_for_active_members"
on public.circle_projects
for update
to authenticated
using (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
)
with check (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
);

drop policy if exists "circle_projects_delete_for_active_members" on public.circle_projects;
create policy "circle_projects_delete_for_active_members"
on public.circle_projects
for delete
to authenticated
using (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
);

drop policy if exists "circle_tasks_select_for_active_members" on public.circle_tasks;
create policy "circle_tasks_select_for_active_members"
on public.circle_tasks
for select
to authenticated
using (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
);

drop policy if exists "circle_tasks_insert_for_active_members" on public.circle_tasks;
create policy "circle_tasks_insert_for_active_members"
on public.circle_tasks
for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    public.is_circle_owner(circle_id, auth.uid())
    or public.is_active_circle_member(circle_id, auth.uid())
  )
);

drop policy if exists "circle_tasks_update_for_active_members" on public.circle_tasks;
create policy "circle_tasks_update_for_active_members"
on public.circle_tasks
for update
to authenticated
using (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
)
with check (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
);

drop policy if exists "circle_tasks_delete_for_active_members" on public.circle_tasks;
create policy "circle_tasks_delete_for_active_members"
on public.circle_tasks
for delete
to authenticated
using (
  public.is_circle_owner(circle_id, auth.uid())
  or public.is_active_circle_member(circle_id, auth.uid())
);
