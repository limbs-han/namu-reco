// db.js — IndexedDB 래퍼 (DB namu_reco, version 1 — 명세 §4.3).
// 플레인 스크립트: sw.js의 importScripts()와 popup의 <script> 양쪽에서 로드.
//
// [F5·G5] db.txn(stores, mode, cb) 계약:
// - 콜백 인자는 원시 IDBTransaction이 아니라 db.js의 tx 래퍼 객체다.
// - 래퍼의 모든 헬퍼는 래퍼가 감싼 그 IDBTransaction에서 요청을 파생시킨다
//   (헬퍼가 내부에서 새 트랜잭션을 여는 구현 금지).
// - 콜백 안에서는 tx에서 파생한 IDB 요청 promise만 await할 수 있다 — fetch·타이머
//   등 IDB 외 promise를 await하면 트랜잭션이 자동 커밋되어 TransactionInactiveError.
// - 콜백 반환값을 트랜잭션 완료 후 돌려준다.

const db = (() => {
  const DAY = 86400000;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("namu_reco", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        const ev = d.createObjectStore("events", { keyPath: "view_id" });  // [B3] view 단위 upsert
        ev.createIndex("processed", "processed");   // ended/processed는 0|1 숫자 [B3]
        ev.createIndex("ts", "ts");
        d.createObjectStore("profile", { keyPath: "title" }).createIndex("score", "score");
        d.createObjectStore("nbr_cache", { keyPath: "shard_id" }).createIndex("last_used", "last_used");
        d.createObjectStore("local_nbr", { keyPath: "title" }).createIndex("captured_at", "captured_at");
        d.createObjectStore("recommendations", { keyPath: "rank" });
        d.createObjectStore("kv", { keyPath: "key" });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  const p = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // 모든 헬퍼는 t(단일 IDBTransaction)에서만 요청 파생 [F5·G5]
  const makeTx = (t) => ({
    get: (s, k) => p(t.objectStore(s).get(k)),
    put: (s, v) => p(t.objectStore(s).put(v)),
    del: (s, k) => p(t.objectStore(s).delete(k)),
    clear: (s) => p(t.objectStore(s).clear()),
    getAll: (s) => p(t.objectStore(s).getAll()),
    count: (s) => p(t.objectStore(s).count()),
    indexGetAll: (s, idx, range) => p(t.objectStore(s).index(idx).getAll(range)),
    // [B3] 처리 대상 = processed=0 이면서 (ended=1 또는 updated_at < now−24h 고아 view)
    // 인덱스 조회 1회(processed=0) 후 JS 필터 — E3 비용 상한과 정합
    async unprocessedEnded(now = Date.now()) {
      const rows = await this.indexGetAll("events", "processed", IDBKeyRange.only(0));
      return rows.filter((e) => e.ended === 1 || e.updated_at < now - 24 * 3600e3);
    },
  });

  return {
    txn(stores, mode, cb) {
      return open().then((d) => new Promise((resolve, reject) => {
        const t = d.transaction(stores, mode);
        let result;
        let cbErr = null;
        t.oncomplete = () => (cbErr ? reject(cbErr) : resolve(result));
        t.onabort = () => reject(cbErr || t.error);
        t.onerror = () => {};                      // 개별 요청 오류는 abort로 수렴
        Promise.resolve(cb(makeTx(t))).then(
          (r) => { result = r; },
          (e) => { cbErr = e; try { t.abort(); } catch (_) { /* 이미 종료 */ } });
      }));
    },

    kvGet(key) {
      return this.txn(["kv"], "readonly", (tx) => tx.get("kv", key)).then((r) => r?.value);
    },
    kvSet(key, value) {
      return this.txn(["kv"], "readwrite", (tx) => tx.put("kv", { key, value }));
    },
    kvDel(key) {
      return this.txn(["kv"], "readwrite", (tx) => tx.del("kv", key));
    },
    profileIsEmpty() {                             // [H1] 콜드스타트 판정 — count 1회
      return this.txn(["profile"], "readonly", (tx) => tx.count("profile")).then((n) => n === 0);
    },

    // [I5·J7] 90일 경과 processed events + 90일 미갱신 local_nbr
    //         + last_seen 90일 경과이고 w(v) < 0.01 인 profile 행 삭제
    prune(days) {
      const now = Date.now();
      const cutoff = now - days * DAY;
      return this.txn(["events", "local_nbr", "profile"], "readwrite", async (tx) => {
        for (const e of await tx.indexGetAll("events", "ts", IDBKeyRange.upperBound(cutoff))) {
          if (e.processed === 1) await tx.del("events", e.view_id);
        }
        for (const r of await tx.indexGetAll("local_nbr", "captured_at",
                                             IDBKeyRange.upperBound(cutoff))) {
          await tx.del("local_nbr", r.title);
        }
        for (const r of await tx.getAll("profile")) {
          const w = r.score * Math.pow(0.5, (now - r.last_seen) / (7 * DAY));
          if (now - r.last_seen > days * DAY && w < 0.01) await tx.del("profile", r.title);
        }
      });
    },
  };
})();

globalThis.db = db;
if (typeof module !== "undefined") {
  module.exports = { db };
}
