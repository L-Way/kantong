/* Pengaturan Supabase untuk Kantong.
   Isi dua baris di bawah dari dashboard Supabase: Project Settings > API (atau tombol "Connect").
   - supabaseUrl : "Project URL", contoh https://abcdefghij.supabase.co
   - supabaseKey : kunci "publishable" (sb_publishable_...) atau "anon" (eyJ...). BOLEH ada di sini
                   karena memang dirancang publik; data tetap terlindungi aturan RLS di database.
                   JANGAN pernah menaruh kunci "secret" atau "service_role" di sini.
   Kalau dibiarkan kosong, Kantong tetap jalan seperti biasa: data hanya di perangkat ini. */
window.KANTONG_CONFIG = {
  supabaseUrl: 'https://ozgpcqyfylybnocsgnhq.supabase.co',
  supabaseKey: 'sb_publishable_Y6QA_lzV1cRsxDLkUF-U2Q_OcPcgbZq',
  /* pustaka klien Supabase (dimuat sekali lalu disimpan service worker supaya tetap jalan offline) */
  supabaseLib: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
};
