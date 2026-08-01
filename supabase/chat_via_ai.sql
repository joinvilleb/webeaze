-- Distinguish AI-concierge chat replies from real replies typed by Billy.
-- The chat-assist function marks its own messages via_ai = true; Billy's stay false.
-- This lets the assistant step aside the moment Billy personally jumps into a thread.
--
-- Run this once in the Supabase SQL editor.

alter table public.chat_messages
  add column if not exists via_ai boolean not null default false;
