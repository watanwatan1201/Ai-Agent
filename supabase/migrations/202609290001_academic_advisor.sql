create table if not exists public.conversations (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'محادثة جديدة',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_usage (
  owner_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  message_count integer not null default 0 check (message_count between 0 and 40),
  primary key (owner_id, usage_date)
);

create index if not exists conversations_owner_updated_idx
  on public.conversations (owner_id, updated_at desc);
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.daily_usage enable row level security;

drop policy if exists "Students read their conversations" on public.conversations;
create policy "Students read their conversations"
  on public.conversations for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists "Students read their messages" on public.messages;
create policy "Students read their messages"
  on public.messages for select to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.conversations
      where conversations.id = messages.conversation_id
        and conversations.owner_id = (select auth.uid())
    )
  );

drop policy if exists "Students read their daily usage" on public.daily_usage;
create policy "Students read their daily usage"
  on public.daily_usage for select to authenticated
  using (owner_id = (select auth.uid()));

grant select on public.conversations, public.messages, public.daily_usage to authenticated;

create or replace function public.get_daily_usage()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select usage.message_count
    from public.daily_usage as usage
    where usage.owner_id = (select auth.uid())
      and usage.usage_date = (now() at time zone 'utc')::date
  ), 0);
$$;

create or replace function public.save_user_message(
  p_conversation_id uuid,
  p_message_id uuid,
  p_content text,
  p_title text
)
returns table (allowed boolean, used integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid := auth.uid();
  v_usage_date date := (now() at time zone 'utc')::date;
  v_used integer;
begin
  if v_owner_id is null then
    raise exception 'Authentication required';
  end if;
  if p_content is null or length(btrim(p_content)) = 0 then
    raise exception 'Message content is required';
  end if;

  insert into public.daily_usage as usage (owner_id, usage_date, message_count)
  values (v_owner_id, v_usage_date, 1)
  on conflict (owner_id, usage_date) do update
    set message_count = usage.message_count + 1
    where usage.message_count < 40
  returning message_count into v_used;

  if v_used is null then
    select usage.message_count into v_used
    from public.daily_usage as usage
    where usage.owner_id = v_owner_id and usage.usage_date = v_usage_date;
    return query select false, coalesce(v_used, 0);
    return;
  end if;

  insert into public.conversations (id, owner_id, title, updated_at)
  values (p_conversation_id, v_owner_id, left(coalesce(nullif(btrim(p_title), ''), 'محادثة جديدة'), 120), now())
  on conflict (id) do update
    set title = excluded.title, updated_at = excluded.updated_at
    where conversations.owner_id = v_owner_id;

  if not found then
    raise exception 'Conversation not found or access denied';
  end if;

  insert into public.messages (id, conversation_id, owner_id, role, content)
  values (p_message_id, p_conversation_id, v_owner_id, 'user', p_content);

  return query select true, v_used;
end;
$$;

revoke all on function public.get_daily_usage() from public;
revoke all on function public.save_user_message(uuid, uuid, text, text) from public;
grant execute on function public.get_daily_usage() to authenticated;
grant execute on function public.save_user_message(uuid, uuid, text, text) to authenticated;