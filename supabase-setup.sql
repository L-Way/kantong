-- =====================================================================
-- Kantong: penyiapan database Supabase (jalankan SEKALI)
-- Cara: dashboard Supabase > SQL Editor > New query > tempel semua isi file ini > Run.
-- Aman dijalankan ulang (tidak menghapus data).
-- =====================================================================

-- 1) Satu baris per pengguna: seluruh catatan Kantong disimpan sebagai satu dokumen JSON.
create table if not exists public.kantong_data (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  data              jsonb   not null,
  rev               bigint  not null default 1,   -- naik 1 tiap simpan; dipakai mencegah dua perangkat saling menimpa
  client_updated_at bigint  not null default 0,   -- waktu (ms) perubahan terakhir menurut aplikasi
  updated_at        timestamptz not null default now(),
  constraint kantong_data_size check (octet_length(data::text) < 8 * 1024 * 1024)
);

-- 2) Keamanan: tiap pengguna HANYA bisa membaca/menulis barisnya sendiri.
alter table public.kantong_data enable row level security;

drop policy if exists kantong_select_own on public.kantong_data;
drop policy if exists kantong_insert_own on public.kantong_data;
drop policy if exists kantong_update_own on public.kantong_data;
drop policy if exists kantong_delete_own on public.kantong_data;

create policy kantong_select_own on public.kantong_data
  for select to authenticated using ((select auth.uid()) = user_id);
create policy kantong_insert_own on public.kantong_data
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy kantong_update_own on public.kantong_data
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy kantong_delete_own on public.kantong_data
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Pengunjung yang belum masuk tidak boleh menyentuh tabel ini sama sekali.
revoke all on public.kantong_data from anon;
grant select, insert, update, delete on public.kantong_data to authenticated;

-- 3) Penanda waktu server otomatis tiap kali baris diubah.
create or replace function public.kantong_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists kantong_touch on public.kantong_data;
create trigger kantong_touch
  before update on public.kantong_data
  for each row execute function public.kantong_touch();

-- 4) Realtime: perubahan dari satu perangkat langsung sampai ke perangkat lain.
do $$
begin
  alter publication supabase_realtime add table public.kantong_data;
exception
  when duplicate_object then null;   -- sudah terdaftar
  when undefined_object then null;   -- publikasi realtime tidak ada; sinkron tetap jalan lewat pengecekan berkala
end;
$$;
