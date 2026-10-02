/* Kantong: pembantu sinkron (fungsi murni, tanpa jaringan).
   Dipakai index.html untuk menggabungkan data perangkat ini dengan data di Supabase
   TANPA saling menimpa: kalau dua perangkat sama-sama mencatat, catatan keduanya tetap ada.

   Cara kerja (penggabungan 3 arah):
   - "base"  = ringkasan (sidik jari tiap catatan) saat terakhir kali tersinkron
   - "local" = data di perangkat ini sekarang
   - "remote"= data di server sekarang
   Catatan yang baru hanya di satu sisi dipertahankan; catatan yang dihapus di satu sisi
   (dan tidak diubah di sisi lain) ikut terhapus; kalau keduanya mengubah catatan yang sama,
   versi perangkat ini yang dipakai. */
(function (root) {
  'use strict';

  var COLL = ['tx', 'cats', 'incomeCats', 'wallets', 'motors', 'meters', 'recurring', 'debts', 'svcs'];
  var ORDERED = COLL.filter(function (c) { return c !== 'tx'; }); /* urutan tampil yang bisa diatur pengguna */
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  /* JSON dengan kunci terurut: jsonb di Postgres mengacak urutan kunci, jadi perbandingan harus tidak peduli urutan */
  function canon(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    var ks = Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort();
    return '{' + ks.map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }

  /* sidik jari pendek (cyrb53, 8 karakter base36) */
  function hash(v) {
    var s = canon(v), h1 = 0xdeadbeef, h2 = 0x41c6ce57, i, ch;
    for (i = 0; i < s.length; i++) {
      ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).slice(-8);
  }

  function valid(x) { return x && x.id !== undefined && x.id !== null; }
  function list(doc, c) { return ((doc && doc[c]) || []).filter(valid); }

  /* ringkasan yang disimpan sebagai "base" setelah tiap sinkron berhasil */
  function snapshot(doc) {
    var s = { items: {}, order: {}, budgets: {}, prefs: hash((doc && doc.prefs) || null) };
    COLL.forEach(function (c) {
      var it = {}, ids = [];
      list(doc, c).forEach(function (x) { var id = String(x.id); it[id] = hash(x); ids.push(id); });
      s.items[c] = it;
      if (ORDERED.indexOf(c) >= 0) s.order[c] = ids;
    });
    var b = (doc && doc.budgets) || {};
    Object.keys(b).forEach(function (k) { s.budgets[k] = hash(b[k]); });
    return s;
  }

  /* memutuskan nasib satu catatan: 'L' pakai lokal, 'R' pakai server, null buang */
  function decide(inB, bHash, inL, l, inR, r) {
    if (inL && inR) {
      if (hash(l) === hash(r)) return 'L';
      if (inB && hash(l) === bHash) return 'R'; /* hanya server yang berubah */
      return 'L';                                /* hanya lokal berubah, atau dua-duanya berubah */
    }
    if (inL) { /* tidak ada di server */
      if (!inB) return 'L';                      /* baru dibuat di perangkat ini */
      return hash(l) === bHash ? null : 'L';     /* dihapus di server, kecuali diubah di sini */
    }
    if (inR) { /* tidak ada di lokal */
      if (!inB) return 'R';                      /* baru dibuat di perangkat lain */
      return hash(r) === bHash ? null : 'R';     /* dihapus di sini, kecuali diubah di server */
    }
    return null;
  }

  function sameSeq(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function merge(base, L, R) {
    base = base || {};
    var bItems = base.items || {}, bOrder = base.order || {}, bBudgets = base.budgets || {};
    var out = { v: Math.max(+(L && L.v) || 0, +(R && R.v) || 0) };

    COLL.forEach(function (c) {
      var ll = list(L, c), rl = list(R, c), bi = bItems[c] || {};
      var lm = new Map(), rm = new Map(), keys = [];
      ll.forEach(function (x) { var k = String(x.id); if (!lm.has(k)) { lm.set(k, x); keys.push(k); } });
      rl.forEach(function (x) { var k = String(x.id); if (!rm.has(k)) { rm.set(k, x); if (!lm.has(k)) keys.push(k); } });

      var kept = new Map();
      keys.forEach(function (k) {
        var d = decide(has(bi, k), bi[k], lm.has(k), lm.get(k), rm.has(k), rm.get(k));
        if (d === 'L') kept.set(k, lm.get(k));
        else if (d === 'R') kept.set(k, rm.get(k));
      });

      /* urutan: ikuti sisi yang BENAR-BENAR mengatur ulang; kalau lokal tidak menyentuh urutan, ikuti server */
      var lids = ll.map(function (x) { return String(x.id); }), rids = rl.map(function (x) { return String(x.id); });
      var primary = lids, secondary = rids;
      if (ORDERED.indexOf(c) >= 0 && bOrder[c]) {
        var baseIds = bOrder[c];
        var lSet = new Set(lids), bSet = new Set(baseIds);
        var localMoved = !sameSeq(lids.filter(function (k) { return bSet.has(k); }), baseIds.filter(function (k) { return lSet.has(k); }));
        if (!localMoved) { primary = rids; secondary = lids; }
      }
      var seq = [], seen = new Set();
      primary.concat(secondary).forEach(function (k) { if (kept.has(k) && !seen.has(k)) { seen.add(k); seq.push(kept.get(k)); } });
      out[c] = seq;
    });

    /* anggaran per bulan: objek kunci -> nominal */
    var lb = (L && L.budgets) || {}, rb = (R && R.budgets) || {}, bud = {}, bk = {};
    Object.keys(lb).concat(Object.keys(rb)).forEach(function (k) {
      if (bk[k]) return; bk[k] = 1;
      var d = decide(has(bBudgets, k), bBudgets[k], has(lb, k), lb[k], has(rb, k), rb[k]);
      if (d === 'L') bud[k] = lb[k]; else if (d === 'R') bud[k] = rb[k];
    });
    out.budgets = bud;

    /* pengaturan pengingat: satu blok */
    var lp = L && L.prefs, rp = R && R.prefs;
    if (hash(lp || null) === hash(rp || null)) out.prefs = lp || rp;
    else if (base.prefs != null && hash(lp || null) === base.prefs) out.prefs = rp;
    else out.prefs = lp || rp;

    out.updatedAt = Math.max(+(L && L.updatedAt) || 0, +(R && R.updatedAt) || 0);
    return out;
  }


  /* ---- pulihkan cadangan TANPA menimpa: tambahkan yang belum ada, lewati yang sudah ada ---- */
  function sigTx(x) {
    return [x.date, x.time || '', x.type, Math.round(+x.amount || 0), x.catId, x.walletId,
      String(x.note || '').trim().toLowerCase(), x.transferId ? 'T' : '', x.odo == null ? '' : x.odo, x.meter == null ? '' : x.meter, x.sdk || ''].join('|');
  }
  function nameKey(x) { return String(x.name || '').trim().toLowerCase() + (x.isSavings ? '|s' : '') + (x.isSedekah ? '|d' : ''); }

  /* local = data sekarang, backup = isi cadangan (keduanya sudah dinormalisasi).
     Aturan: id sama -> pakai yang sekarang; kategori/dompet/motor/meteran dengan nama sama -> dianggap sama
     (referensi catatan diarahkan ke yang sudah ada); transaksi dengan isi yang sama persis -> dianggap duplikat. */
  function mergeBackup(local, backup) {
    var out = { v: Math.max(+(local && local.v) || 0, +(backup && backup.v) || 0) };
    var maps = { cats: {}, incomeCats: {}, wallets: {}, motors: {}, meters: {} };
    var added = { tx: 0, other: 0 }, skipped = 0;

    ['cats', 'incomeCats', 'wallets', 'motors', 'meters'].forEach(function (c) {
      var lo = list(local, c), byId = {}, byName = {}, add = [];
      lo.forEach(function (x) { byId[String(x.id)] = 1; var k = nameKey(x); if (k && !has(byName, k)) byName[k] = x.id; });
      list(backup, c).forEach(function (x) {
        var id = String(x.id);
        if (has(byId, id)) return;
        var k = nameKey(x);
        if (k && has(byName, k)) { maps[c][id] = byName[k]; return; }
        add.push(x); byId[id] = 1; if (k) byName[k] = x.id; added.other++;
      });
      out[c] = lo.concat(add);
    });
    function rm(c, id) { return has(maps[c], id) ? maps[c][id] : id; }
    function rmCat(id) { return has(maps.cats, id) ? maps.cats[id] : (has(maps.incomeCats, id) ? maps.incomeCats[id] : id); }

    var lt = list(local, 'tx'), lid = {}, sigIds = {}, txMap = {}, addTx = [];
    var byIdTx = {}, trMap = {}, feeHave = {}; /* trMap: transferId di cadangan -> transferId yang sudah ada di data sekarang */
    lt.forEach(function (x) {
      lid[String(x.id)] = 1; byIdTx[String(x.id)] = x;
      var s = sigTx(x); (sigIds[s] = sigIds[s] || []).push(x.id);
      if (x.feeOf) feeHave[String(x.feeOf)] = 1;
    });
    /* biaya admin (feeOf) diproses paling akhir, supaya sudah tahu transfer mana yang dianggap sama */
    var bl = list(backup, 'tx');
    bl = bl.filter(function (x) { return !x.feeOf; }).concat(bl.filter(function (x) { return !!x.feeOf; }));
    bl.forEach(function (x0) {
      var x = Object.assign({}, x0), id = String(x.id);
      if (lid[id]) { skipped++; return; }
      x.catId = rmCat(x.catId); x.walletId = rm('wallets', x.walletId);
      if (x.motorId) x.motorId = rm('motors', x.motorId);
      if (x.meterId) x.meterId = rm('meters', x.meterId);
      if (x.feeOf) {
        if (has(trMap, x.feeOf)) x.feeOf = trMap[x.feeOf];
        if (feeHave[String(x.feeOf)]) { skipped++; return; } /* perpindahan itu sudah punya biaya admin */
      }
      var s = sigTx(x);
      if (sigIds[s] && sigIds[s].length) {
        var mid = sigIds[s].shift(); txMap[id] = mid; skipped++;
        var mt = byIdTx[String(mid)];
        if (x.transferId && mt && mt.transferId && mt.transferId !== x.transferId) trMap[x.transferId] = mt.transferId;
        return;
      }
      addTx.push(x); lid[id] = 1; added.tx++;
      if (x.feeOf) feeHave[String(x.feeOf)] = 1;
    });
    out.tx = lt.concat(addTx);

    function union(c, fix) {
      var lo = list(local, c), have = {}, add = [];
      lo.forEach(function (x) { have[String(x.id)] = 1; });
      list(backup, c).forEach(function (x0) {
        var id = String(x0.id);
        if (have[id]) return;
        add.push(fix ? fix(Object.assign({}, x0)) : x0); have[id] = 1; added.other++;
      });
      out[c] = lo.concat(add);
    }
    union('recurring', function (r) { r.catId = rmCat(r.catId); r.walletId = rm('wallets', r.walletId); r.toWalletId = rm('wallets', r.toWalletId); return r; });
    union('svcs', function (v) { v.fromW = rm('wallets', v.fromW); v.toW = rm('wallets', v.toW); return v; });
    union('debts', function (d) {
      if (d.txId && has(txMap, d.txId)) d.txId = String(txMap[d.txId]);
      d.pays = (d.pays || []).map(function (p) {
        var q = Object.assign({}, p);
        q.txIds = (p.txIds || []).map(function (t) { return has(txMap, t) ? String(txMap[t]) : t; });
        if (q.w) q.w = rm('wallets', q.w);
        return q;
      });
      return d;
    });

    var bud = Object.assign({}, (backup && backup.budgets) || {}, (local && local.budgets) || {});
    out.budgets = bud;
    out.prefs = (local && local.prefs) || (backup && backup.prefs);
    out.updatedAt = Math.max(+(local && local.updatedAt) || 0, +(backup && backup.updatedAt) || 0);
    return { doc: out, added: added, skipped: skipped };
  }

  /* ================= sinkron PER CATATAN (tabel kantong_rec) =================
     Server menyimpan satu baris per catatan: (coll, id, data, deleted, rev, seq).
     Semua fungsi di bawah murni (tanpa jaringan) supaya bisa diuji.
     - "entri" = satu catatan, satu anggaran (budgets), pengaturan (prefs), atau urutan tampil satu koleksi (order).
     - srv  : apa yang diketahui perangkat ini tentang server: { "coll|id": [rev, hash] }  (hash null = sudah dihapus di server)
     - baris yang dikirim selalu membawa base_rev; server menolak (konflik) kalau rev di server sudah berbeda. */

  function known(coll) { return coll === 'budgets' || coll === 'prefs' || coll === 'order' || COLL.indexOf(coll) >= 0; }
  function kOf(coll, id) { return coll + '|' + id; }

  /* hash isi sebuah baris dari server, sama persis dengan hash entri lokal yang setara */
  function rowHash(r) {
    var d = r.data;
    if (r.coll === 'budgets') return hash(d && d.v !== undefined ? d.v : null);
    if (r.coll === 'order') return hash((d && d.ids) || []);
    return hash(d === undefined ? null : d);
  }

  /* semua entri dari satu dokumen */
  function entries(doc) {
    var e = {};
    COLL.forEach(function (c) {
      var ids = [];
      list(doc, c).forEach(function (x) {
        var id = String(x.id), k = kOf(c, id);
        if (has(e, k)) return; /* id ganda: yang pertama dipakai, sama seperti merge() */
        e[k] = { coll: c, id: id, data: x, h: hash(x) };
        ids.push(id);
      });
      if (ORDERED.indexOf(c) >= 0) e[kOf('order', c)] = { coll: 'order', id: c, data: { ids: ids }, h: hash(ids) };
    });
    var b = (doc && doc.budgets) || {};
    Object.keys(b).forEach(function (k) { e[kOf('budgets', k)] = { coll: 'budgets', id: k, data: { v: b[k] }, h: hash(b[k]) }; });
    if (doc && doc.prefs != null) e[kOf('prefs', 'main')] = { coll: 'prefs', id: 'main', data: doc.prefs, h: hash(doc.prefs) };
    return e;
  }

  /* baris dari server yang BELUM diketahui perangkat ini (rev lebih baru dari yang tercatat di srv).
     Baris milik kita sendiri yang kembali lewat penarikan (rev sama) dibuang, jadi tidak memicu gabung ulang. */
  function freshRows(rows, srv) {
    return (rows || []).filter(function (r) {
      if (!known(r.coll)) return false; /* koleksi dari versi aplikasi yang lebih baru: diabaikan */
      var s = srv && srv[kOf(r.coll, r.id)];
      return !(s && s[0] >= r.rev);
    });
  }

  /* catat baris-baris itu ke srv (mengubah srv di tempat) */
  function absorb(srv, rows) {
    rows.forEach(function (r) { srv[kOf(r.coll, r.id)] = [r.rev, r.deleted ? null : rowHash(r)]; });
    return srv;
  }

  /* dokumen "server" untuk digabung: salinan dokumen lokal + perubahan dari server.
     Yang tidak berubah di server dianggap sama dengan lokal (nasibnya ditentukan merge() lewat base). */
  function applyChanges(L, rows) {
    var R = { v: L && L.v, budgets: Object.assign({}, (L && L.budgets) || {}), prefs: L && L.prefs, updatedAt: L && L.updatedAt };
    var idx = {}, orders = {};
    COLL.forEach(function (c) {
      R[c] = list(L, c).slice();
      var m = new Map(); R[c].forEach(function (x, i) { if (!m.has(String(x.id))) m.set(String(x.id), i); });
      idx[c] = m;
    });
    (rows || []).forEach(function (ch) {
      var c = ch.coll, id = String(ch.id), gone = !!ch.deleted || ch.data == null;
      if (c === 'budgets') { if (gone) delete R.budgets[id]; else if (ch.data.v !== undefined) R.budgets[id] = ch.data.v; return; }
      if (c === 'prefs') { if (!gone) R.prefs = ch.data; return; }
      if (c === 'order') { if (!gone && Array.isArray(ch.data.ids)) orders[id] = ch.data.ids.map(String); return; }
      if (COLL.indexOf(c) < 0) return;
      var arr = R[c], m = idx[c];
      if (gone) { if (m.has(id)) { arr[m.get(id)] = null; m.delete(id); } }
      else if (m.has(id)) arr[m.get(id)] = ch.data;
      else { arr.push(ch.data); m.set(id, arr.length - 1); }
    });
    COLL.forEach(function (c) { R[c] = R[c].filter(function (x) { return x !== null; }); });
    Object.keys(orders).forEach(function (c) {
      if (ORDERED.indexOf(c) < 0) return;
      var byId = new Map(), out = [], seen = new Set();
      R[c].forEach(function (x) { if (!byId.has(String(x.id))) byId.set(String(x.id), x); });
      orders[c].forEach(function (id) { if (byId.has(id) && !seen.has(id)) { seen.add(id); out.push(byId.get(id)); } });
      R[c].forEach(function (x) { var id = String(x.id); if (!seen.has(id)) { seen.add(id); out.push(x); } });
      R[c] = out;
    });
    return R;
  }

  /* perangkat yang sudah terhubung: gabungkan perubahan server ke data lokal (3 arah, lewat merge) */
  function reconcile(base, L, rows) { return merge(base, L, applyChanges(L, rows)); }

  /* baris yang perlu dikirim agar server sama dengan dokumen ini, dibanding yang diketahui di srv */
  function planPush(doc, srv) {
    var e = entries(doc), rows = [];
    Object.keys(e).forEach(function (k) {
      var s = srv[k];
      if (!s || s[1] !== e[k].h) rows.push({ coll: e[k].coll, id: e[k].id, data: e[k].data, deleted: false, base_rev: s ? s[0] : 0, h: e[k].h });
    });
    Object.keys(srv).forEach(function (k) {
      if (has(e, k) || srv[k][1] === null) return; /* masih ada, atau server sudah menandainya terhapus */
      var i = k.indexOf('|');
      rows.push({ coll: k.slice(0, i), id: k.slice(i + 1), data: null, deleted: true, base_rev: srv[k][0], h: null });
    });
    return rows;
  }

  /* kirim baris ke server per 200; srv diperbarui dengan rev baru dari server.
     Kalau ada baris yang ditolak karena rev di server sudah berubah -> lempar {conflict:true} SETELAH semua batch diproses. */
  async function pushAll(push, rows, srv) {
    var conflict = false;
    for (var i = 0; i < rows.length; i += 200) {
      var batch = rows.slice(i, i + 200), hm = {};
      batch.forEach(function (x) { hm[kOf(x.coll, x.id)] = x.h; });
      var d = (await push(batch.map(function (x) { return { coll: x.coll, id: x.id, data: x.data, deleted: x.deleted, base_rev: x.base_rev }; }))) || {};
      (d.applied || []).forEach(function (a) { var k = kOf(a.coll, a.id); srv[k] = [a.rev, has(hm, k) ? hm[k] : null]; });
      if (d.conflicts && d.conflicts.length) conflict = true;
    }
    if (conflict) throw { conflict: true };
  }

  /* satu putaran sinkron untuk perangkat yang SUDAH terhubung ke akun.
     o.meta      : {base, srv, cursor, dirty}  (srv/cursor kosong = perangkat dari protokol lama -> tarik semua)
     o.pull(cur) : Promise<{rows, cursor}>     baris server dengan seq > cur
     o.push(rows): Promise<{applied, conflicts}>
     o.capture() : {doc, seq}                  salinan data lokal sekarang (sudah dinormalisasi)
     o.apply(M)  : menerapkan hasil gabungan ke data lokal (aplikasi menormalisasi lalu menyimpan)
     o.seq()     : penghitung perubahan lokal sekarang (untuk mendeteksi edit saat sinkron berjalan)
     o.canDefer(): true = pengguna sedang mengedit, tunda penerapan perubahan dari server
     o.fullPull  : paksa tarik dari awal (dipakai setelah konflik berulang)
     Hasil: {status:'idle'|'deferred'|'synced', changed, meta?, cursor?}.  Melempar {conflict:true} bila ditolak server. */
  async function linkedSync(o) {
    var m = o.meta || {}, legacy = m.cursor == null || !m.srv;
    var srv = legacy ? {} : Object.assign({}, m.srv);
    var cursor = (legacy || o.fullPull) ? 0 : m.cursor;
    var pulled = await o.pull(cursor);
    var next = Math.max(cursor, +(pulled && pulled.cursor) || 0);
    var fresh = freshRows(pulled && pulled.rows, srv);
    var cap = o.capture(), changed = false;
    if (!fresh.length) {
      if (!m.dirty && !legacy) return { status: 'idle', changed: false, cursor: Math.max(next, m.cursor || 0) };
    } else {
      if (o.canDefer && o.canDefer()) return { status: 'deferred', changed: false };
      absorb(srv, fresh);
      var before = hash(snapshot(cap.doc));
      var M = reconcile(m.base, cap.doc, fresh);
      if (m.dirty) M.updatedAt = Date.now();
      o.apply(M);
      cap = o.capture();
      changed = hash(snapshot(cap.doc)) !== before;
    }
    await pushAll(o.push, planPush(cap.doc, srv), srv);
    return { status: 'synced', changed: changed, wasDirty: !!m.dirty,
      meta: { base: snapshot(cap.doc), srv: srv, cursor: next, dirty: o.seq() !== cap.seq } };
  }

  /* apakah ada isi buatan pengguna (bukan sekadar bawaan aplikasi)? */
  function hasUserData(doc) {
    if (!doc) return false;
    if (list(doc, 'tx').length || list(doc, 'debts').length || list(doc, 'svcs').length || list(doc, 'recurring').length) return true;
    if (Object.keys(doc.budgets || {}).length) return true;
    return list(doc, 'wallets').some(function (w) { return (+w.balance || 0) !== 0 || w.isSavings; });
  }

  root.KantongSync = { canon: canon, hash: hash, snapshot: snapshot, merge: merge, mergeBackup: mergeBackup, hasUserData: hasUserData, COLL: COLL,
    known: known, rowHash: rowHash, entries: entries, freshRows: freshRows, absorb: absorb, applyChanges: applyChanges, reconcile: reconcile, planPush: planPush, pushAll: pushAll, linkedSync: linkedSync };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.KantongSync;
})(typeof window !== 'undefined' ? window : globalThis);
