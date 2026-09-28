alter table public.messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_attachments_array'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_attachments_array
      check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 5);
  end if;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'academic-attachments',
  'academic-attachments',
  false,
  10485760,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

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
      and usage.usage_date = (now() at time zone 'Asia/Hebron')::date
  ), 0);
$$;

drop policy if exists "Students upload their own attachments" on storage.objects;
create policy "Students upload their own attachments"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'academic-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Students read their own attachments" on storage.objects;
create policy "Students read their own attachments"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'academic-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Students delete their own attachments" on storage.objects;
create policy "Students delete their own attachments"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'academic-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop function if exists public.save_user_message(uuid, uuid, text, text);
drop function if exists public.save_user_message(uuid, uuid, text, text, jsonb);

create function public.save_user_message(
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
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array' then
    raise exception 'Attachments must be a JSON array';
  end if;
  if jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 5 then
    raise exception 'At most five attachments are allowed';
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

  insert into public.conversations (id, owner_id, title, updated_at)
  values (p_conversation_id, v_owner_id, left(coalesce(nullif(btrim(p_title), ''), 'محادثة جديدة'), 120), now())
  on conflict (id) do update
    set title = excluded.title, updated_at = excluded.updated_at
    where conversations.owner_id = v_owner_id;

  if not found then
    raise exception 'Conversation not found or access denied';
  end if;

  insert into public.messages (id, conversation_id, owner_id, role, content, attachments)
  values (p_message_id, p_conversation_id, v_owner_id, 'user', p_content, coalesce(p_attachments, '[]'::jsonb));

  return query select true, v_used;
end;
$$;

revoke all on function public.save_user_message(uuid, uuid, text, text, jsonb) from public;
revoke all on function public.get_daily_usage() from public;
grant execute on function public.save_user_message(uuid, uuid, text, text, jsonb) to authenticated;
grant execute on function public.get_daily_usage() to authenticated;