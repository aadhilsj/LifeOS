alter table public.circle_tasks
add column if not exists assigned_to uuid;

create index if not exists circle_tasks_assigned_to_idx
on public.circle_tasks (assigned_to);
