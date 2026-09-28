alter table public.messages
  add column if not exists is_out_of_scope boolean not null default false,
  add column if not exists reply_to uuid references public.messages (id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_reply_to_assistant_only'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_reply_to_assistant_only
      check (reply_to is null or role = 'assistant');
  end if;
end;
$$;

create unique index if not exists messages_one_reply_per_user_message_idx
  on public.messages (reply_to)
  where reply_to is not null;