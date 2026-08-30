-- WebEaze: storage for files attached to a website form submission ────────────
-- Used by the form-lead edge function. A visitor attaching photos to a quote request or a resume to
-- a job application needs those to reach the client, and an email cannot carry them from an edge
-- function, so the file is stored here and the email links to a signed URL.
--
-- The bucket is PRIVATE. Links in the email are signed and expire after 30 days. A public bucket
-- would mean every resume anyone ever submitted is readable by anyone who can guess a path.
--
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'form-uploads', 'form-uploads', false, 6291456,
  -- image/heif sits alongside image/heic because an iPhone sending a photo straight from the Files
  -- app reports either one, and text/plain because a plain .txt note is harmless and being refused
  -- one is a confusing thing for a customer to hit.
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','image/gif','application/pdf',
        'text/plain','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- No policies are created on purpose. Only the service-role edge function writes here and only it
-- mints signed URLs, so there is no path by which one client could read another's uploads, and no
-- anonymous visitor can list the bucket.
