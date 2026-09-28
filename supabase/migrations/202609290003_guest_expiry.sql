create extension if not exists pg_cron with schema pg_catalog;

alter table public.conversations
  add column if not exists guest_expires_at timestamptz;

create index if not exists conversations_guest_expiry_idx
  on public.conversations (guest_expires_at)
  where guest_expires_at is not null;

drop policy if exists "Students read their conversations" on public.conversations;
create policy "Students read their conversations"
  on public.conversations for select to authenticated
  using (
    owner_id = (select auth.uid())
    and (guest_expires_at is null or guest_expires_at > now())
  );

drop policy if exists "Students delete their conversations" on public.conversations;
create policy "Students delete their conversations"
  on public.conversations for delete to authenticated
  using (owner_id = (select auth.uid()));

create or replace function public.save_user_message(
  p_conversation_id uuid,
  p_message_id uuid,
  p_content text,
  p_title text,
  p_attachments jsonb default '[]'::jsonb
)
returns table (allowed boolean, used integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid := auth.uid();
  v_usage_date date := (now() at time zone 'Asia/Hebron')::date;
  v_used integer;
  v_is_anonymous boolean := false;
  v_guest_expires_at timestamptz;
  v_attachment jsonb;
  v_path text;
  v_size bigint;
begin
  if v_owner_id is null then
    raise exception 'Authentication required';
  end if;
  if p_content is null or length(btrim(p_content)) = 0 then
    raise exception 'Message content is required';
  end if;
  if length(p_content) > 8000 then
    raise exception 'Message content exceeds the 8000 character limit';
  end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 5 then
    raise exception 'Attachments must be an array containing at most five files';
  end if;

  select coalesce(users.is_anonymous, false) into v_is_anonymous
  from auth.users as users where users.id = v_owner_id;
  if v_is_anonymous then
    v_guest_expires_at := now() + interval '24 hours';
  end if;

  for v_attachment in select value from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb))
  loop
    v_path := v_attachment->>'path';
    v_size := (v_attachment->>'size')::bigint;
    if v_path is null or split_part(v_path, '/', 1) <> v_owner_id::text then
      raise exception 'Attachment path is not owned by the current user';
    end if;
    if v_size is null or v_size < 0 or v_size > 10485760 then
      raise exception 'Attachment size is invalid';
    end if;
  end loop;

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

  insert into public.conversations (id, owner_id, title, updated_at, guest_expires_at)
  values (
    p_conversation_id,
    v_owner_id,
    left(coalesce(nullif(btrim(p_title), ''), 'محادثة جديدة'), 120),
    now(),
    v_guest_expires_at
  )
  on conflict (id) do update
    set title = excluded.title,
        updated_at = excluded.updated_at,
        guest_expires_at = excluded.guest_expires_at
    where conversations.owner_id = v_owner_id;

  if not found then
    raise exception 'Conversation not found or access denied';
  end if;

  insert into public.messages (id, conversation_id, owner_id, role, content, attachments)
  values (p_message_id, p_conversation_id, v_owner_id, 'user', p_content, coalesce(p_attachments, '[]'::jsonb));

  return query select true, v_used;
end;
$$;

create or replace function public.purge_expired_guest_conversations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.conversations
  where guest_expires_at is not null and guest_expires_at <= now();
  get diagnostics v_deleted = row_count;

  delete from public.daily_usage
  where owner_id in (select users.id from auth.users as users where users.is_anonymous)
    and usage_date < (now() at time zone 'Asia/Hebron')::date;

  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_guest_conversations() from public;

do $$
begin
  if not exists (
    select 1 from cron.job where jobname = 'daleel-expire-guest-chats'
  ) then
    perform cron.schedule(
      'daleel-expire-guest-chats',
      '*/15 * * * *',
      'select public.purge_expired_guest_conversations();'
    );
  end if;
end;
$$;