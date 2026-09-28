create or replace function public.preserve_registered_conversations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid := auth.uid();
  v_is_anonymous boolean;
  v_preserved integer;
begin
  if v_owner_id is null then
    raise exception 'Authentication required';
  end if;

  select coalesce(users.is_anonymous, true) into v_is_anonymous
  from auth.users as users where users.id = v_owner_id;
  if v_is_anonymous then
    raise exception 'A registered account is required';
  end if;

  update public.conversations
  set guest_expires_at = null
  where owner_id = v_owner_id and guest_expires_at is not null;
  get diagnostics v_preserved = row_count;
  return v_preserved;
end;
$$;

revoke all on function public.preserve_registered_conversations() from public;
grant execute on function public.preserve_registered_conversations() to authenticated;