// sw.js — service worker: 수집 저장 + 5분 미니배치 (명세 §4.4/§4.5/§4.6).
// classic SW [G4] — importScripts 사용 ("type": "module" 금지).
// 순수 로직은 swLogic에 두고 chrome·db 배선은 아래 가드에만 둔다 (node 테스트용).
if (typeof importScripts !== "undefined") importScripts("common.js", "db.js");

const CACHE_CAP = 150 * 2 ** 20;      // [M6] nbr_cache 총량 상한 150MB (해제 후 바이트 기준)
const DAY = 86400000;
const HALF_LIFE_MS = 7 * DAY;         // [M2] 반감기 7일

const swLogic = {
  // [M2] 유효 가중치 — 읽기 시점 감쇠 (쓰기 불필요)
  effectiveWeight(score, lastSeen, now) {
    return score * Math.pow(0.5, (now - lastSeen) / HALF_LIFE_MS);
  },

  // [M2] 점화식: score_new = score_old × 0.5^((T−last_seen)/7일) + Σ ln(1+dwell_ms/1000)
  // 기존 score를 감쇠 없이 누적하는 구현은 오답 (E7이 검증)
  nextScore(prevScore, prevLastSeen, dwellMsList, T) {
    const decayed = prevScore * Math.pow(0.5, (T - prevLastSeen) / HALF_LIFE_MS);
    return decayed + dwellMsList.reduce((s, d) => s + Math.log(1 + d / 1000), 0);
  },

  // w(v) 상위 n 프로필 (동률은 제목순 — 결정적)
  topProfile(rows, now, n = 50) {
    return rows
      .map((r) => ({ title: r.title, w: swLogic.effectiveWeight(r.score, r.last_seen, now),
                     dwell: r.dwell_ms_total || 0 }))   // [M2] 사유 문구 계층 입력
      .sort((a, b) => b.w - a.w || (a.title < b.title ? -1 : 1))
      .slice(0, n);
  },

  // §4.4 추천 집계: score(c) = Σ_v w(v)·sim(v,c) + 0.1·pr_pct(c), 출처 문서당 상한 5,
  // 방문 문서 제외. perSource = [{title, w, nbrs: [[t, sim, pr], ...], source}]
  // reason_title = sim 기여 최대 출처 문서, 그 기여의 sim·source를 행에 기록 [G7]
  scoreCandidates(perSource, visited, n = 20) {
    const acc = new Map();
    for (const v of perSource) {
      let used = 0;
      for (const [title, sim, pr] of v.nbrs) {
        if (visited.has(title)) continue;         // 방문 문서 제외
        if (used >= 5) break;                     // 출처 문서당 후보 상한 5
        used++;
        const contrib = v.w * sim;
        const a = acc.get(title) ||
          { score: 0, pr: 0, best: -1, reason: null, sim: null, source: null };
        a.score += contrib;
        a.pr = Math.max(a.pr, pr);
        if (contrib > a.best) {
          a.best = contrib; a.reason = v.title; a.sim = sim; a.source = v.source;
          a.reasonDwell = v.dwell ?? null;      // [M2] 사유 문구 계층 입력 [G7]
        }
        acc.set(title, a);
      }
    }
    return [...acc.entries()]
      .map(([title, a]) => ({
        title, score: a.score + 0.1 * a.pr,
        sim: a.sim, source: a.source, reason_title: a.reason,
        reason_dwell_ms: a.reasonDwell ?? null,
      }))
      .sort((x, y) => y.score - x.score || (x.title < y.title ? -1 : 1))
      .slice(0, n);                               // [H8] N=20 확정
  },

  // [M3] 사유(출처) 그룹 라운드로빈 — 출처당 상한 5 구조상 상위가 한 출처 파생으로
  // 뭉치는 클럼핑 해소. 그룹 순서 = 그룹 최고 score 순(입력 첫 등장 순 = Map 삽입 순),
  // 그룹 내부 순서 = score 순 유지. 행 내용·개수 불변 — 표시 순서만 바꾼다.
  interleaveBySource(list) {
    const groups = new Map();
    for (const r of list) {
      const k = r.reason_title ?? "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const qs = [...groups.values()];
    const out = [];
    for (let i = 0; out.length < list.length; i++) {
      for (const q of qs) if (i < q.length) out.push(q[i]);
    }
    return out;
  },

  // [M6] LRU: last_used 오래된 순으로 총량이 상한 이하가 될 때까지 퇴출 대상 선정
  pickEvictions(metas, cap) {
    let total = metas.reduce((s, m) => s + m.size_bytes, 0);
    const out = [];
    for (const m of [...metas].sort((a, b) => a.last_used - b.last_used)) {
      if (total <= cap) break;
      out.push(m.shard_id);
      total -= m.size_bytes;
    }
    return out;
  },
};

// ---------- 배선 (browser 전용) ----------
if (typeof chrome !== "undefined" && chrome.runtime) {

  chrome.runtime.onInstalled.addListener(ensureAlarm);
  chrome.runtime.onStartup.addListener(ensureAlarm);

  // [B3·F6·J5] view 메시지: get→processed 검사→put을 단일 readwrite 트랜잭션으로.
  // local_nbr 갱신(§4.6 — 항상 최신 방문 덮어쓰기)도 같은 트랜잭션에서 수행한다.
  // v11 §4.8: 추천 탭(reco_tab.js)의 조회 요청 — content script는 확장 origin의
  // IndexedDB를 직접 읽지 못하므로 메시징으로 제공한다.
  // (§4.9 연관 문서는 v0.5.0부터 본문 링크 직접 수집 — SW 경유 없음)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "get_recommendations") {
      db.txn(["recommendations"], "readonly", (tx) => tx.getAll("recommendations"))
        .then((rows) => sendResponse(rows.sort((a, b) => a.rank - b.rank)))
        .catch(() => sendResponse([]));
      return true;                                  // 비동기 sendResponse 유지
    }
    if (!msg || msg.type !== "view") return;
    db.txn(["events", "local_nbr"], "readwrite", async (tx) => {
      const prev = await tx.get("events", msg.view_id);
      if (prev && prev.processed === 1) return;   // 좀비 view 이중 집계 방지 [B3]
      await tx.put("events", {
        view_id: msg.view_id, ts: msg.ts,
        updated_at: Date.now(),                   // [J5] 고아 view 24h 판정 입력
        title: msg.title, dwell_ms: msg.dwell_ms,
        ended: msg.ended ? 1 : 0, processed: 0,
      });
      if (msg.links && msg.links.length) {
        await tx.put("local_nbr",
          { title: msg.title, links: msg.links, captured_at: Date.now() });
      }
    }).catch((e) => console.warn("view upsert failed:", e));
  });

  chrome.alarms.onAlarm.addListener(async () => {
    await coldStartIfNeeded();                    // [G2·H1·I7] kv.popular 부재 시에만 fetch
    // [B3][F6] 조회→집계→마킹을 단일 트랜잭션에서
    const n = await db.txn(["events", "profile", "kv"], "readwrite", async (tx) => {
      const events = await tx.unprocessedEnded(); // [F6] 조회도 같은 txn — 경합 창 제거
      if (!events.length) return 0;               // E3: 인덱스 조회 1회 후 즉시 종료
      await updateProfile(tx, events);            // [M2] 점화식 — 모든 IDB 접근은 tx 경유
      await markProcessed(tx, events);            // 같은 트랜잭션 — 크래시 시 이중 집계 방지
      await tx.put("kv", { key: "dirty", value: 1 });   // [H2] 마킹과 같은 txn
      return events.length;
    });
    if (!n && !(await db.kvGet("dirty"))) {       // [H2] dirty면 이벤트 0건이어도 복구 진행
      await pruneIfDue();                         // [I5] 조기 종료 경로에서도 prune
      return;
    }
    await prefetchShards();                       // [G10·I3] 선두 manifest fetch→version→purge
    await evictCache();                           // §4.5 LRU 퇴출
    const rebuilt = await rebuildRecommendations();   // [G13·H8·I6] 단일 txn clear 후 재작성
    if (rebuilt) await db.kvDel("dirty");         // [H2·I6] rebuild 완료 후에만 해제
    await pruneIfDue();                           // [I5] 24h에 1회
  });
}

async function ensureAlarm() {                    // [F7] get-가드 — 톱레벨 무조건 create 금지
  if (!(await chrome.alarms.get("minibatch"))) {
    chrome.alarms.create("minibatch", { periodInMinutes: 5 });
  }
}

async function updateProfile(tx, events) {        // [M2]
  const T = Date.now();
  const byTitle = new Map();
  for (const e of events) {
    if (!byTitle.has(e.title)) byTitle.set(e.title, []);
    byTitle.get(e.title).push(e.dwell_ms);
  }
  for (const [title, dwells] of byTitle) {
    const row = await tx.get("profile", title);
    const score = row
      ? swLogic.nextScore(row.score, row.last_seen, dwells, T)
      : swLogic.nextScore(0, T, dwells, T);
    await tx.put("profile", {
      title, score, last_seen: T,
      // [M2] 원시 체류 무감쇠 누적 — ended 이벤트는 processed 마킹으로 1회만 집계
      dwell_ms_total: ((row && row.dwell_ms_total) || 0) + dwells.reduce((s, d) => s + d, 0),
    });
  }
}

async function markProcessed(tx, events) {
  for (const e of events) await tx.put("events", { ...e, processed: 1 });
}

async function pruneIfDue() {                     // [I5] 90일 삭제 약속을 활동 여부와 분리
  const last = await db.kvGet("last_prune");
  if (last && Date.now() - last < 24 * 3600e3) return;   // kv get 1회 판정 — E3 비용 포함
  await db.prune(90);                             // [J7] events·local_nbr·profile 규칙은 db.js
  await db.kvSet("last_prune", Date.now());
}

async function coldStartIfNeeded() {              // [G2·B2·H1·I7] 콜드스타트 — 미니배치 1회 예외
  if (await db.kvGet("popular")) return;          // 기채움이면 IDB get 1회로 끝 (E3)
  try {
    const res = await fetch(`${SHARD_BASE}/popular.json`);      // [I2]
    if (!res.ok) throw new Error(`popular.json ${res.status}`);
    const popular = await res.json();
    if (await db.profileIsEmpty()) {              // [H1] 재적재는 추천을 건드리지 않는다
      await writeRecommendations(popular.slice(0, 20).map((title, i) => ({
        rank: i + 1, title, score: 0, sim: null,
        source: "popular", reason_title: null, reason_dwell_ms: null, computed_at: Date.now(),
      })));
    }
    await db.kvSet("popular", popular);           // [I7] 커밋 마커는 마지막
  } catch (e) {
    console.warn("cold start deferred:", e);      // 오프라인 설치 등 — 다음 알람이 재시도
  }
}

function writeRecommendations(rows) {             // [G13] clear→put 경로 (콜드스타트 공용)
  return db.txn(["recommendations"], "readwrite", async (tx) => {
    await tx.clear("recommendations");
    for (const r of rows) await tx.put("recommendations", r);
  });
}

// [I4·J6] purge — nbr_cache 전 행 + kv.popular 만. dirty·last_prune 보존,
// manifest_version은 새 값으로 갱신. kv 통째 clear 금지.
function purge(newVersion) {
  return db.txn(["nbr_cache", "kv"], "readwrite", async (tx) => {
    await tx.clear("nbr_cache");
    await tx.del("kv", "popular");
    await tx.put("kv", { key: "manifest_version", value: newVersion });
  });
}

// 샤드 1개 fetch→해제→파싱→nbr_cache 편입. [M6] size_bytes = 해제 직후 바이트.
// 실패는 예외로 던진다 — 격리는 호출측 책임 [G10].
async function fetchShardIntoCache(sid) {
  const res = await fetch(`${SHARD_BASE}/${shardPath(sid)}`);
  if (!res.ok) throw new Error(`shard ${sid}: ${res.status}`);
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const size_bytes = bytes.byteLength;
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  const version = (await db.kvGet("manifest_version")) ?? null;
  const row = { shard_id: sid, payload, version, size_bytes, last_used: Date.now() };
  await db.txn(["nbr_cache"], "readwrite", (tx) => tx.put("nbr_cache", row));
  return row;
}

// [G10·I3·J1] prefetchShards — 절대 예외를 전파하지 않는다.
async function prefetchShards() {
  try {
    let manifest = null;
    try {                                         // [I3] 선두: manifest fetch
      const res = await fetch(`${SHARD_BASE}/manifest.json`);
      if (res.ok) manifest = await res.json();
      else console.warn("manifest fetch failed:", res.status);
    } catch (e) {
      console.warn("manifest fetch failed:", e);  // 격리 — version 비교 생략, 기존 캐시로 진행
    }
    if (manifest) {
      const stored = await db.kvGet("manifest_version");
      if (stored === undefined) {
        await db.kvSet("manifest_version", manifest.version);   // [J6] 최초 부재 — purge 생략
      } else if (stored !== manifest.version) {
        await purge(manifest.version);            // [I4]
      }
      // [F4] namespaces 런타임 대조 — 불일치는 기록만, 동작은 계속
      if (JSON.stringify([...manifest.namespaces].sort()) !==
          JSON.stringify([...NAMESPACES].sort())) {
        console.error("NAMESPACES 불일치: gold", manifest.namespaces, "≠ 확장", NAMESPACES);
      }
    }
    // [J1] fetch 대상 = w(v) 상위 50 프로필 제목의 샤드 중 nbr_cache 부재분 (중복 제거)
    const rows = await db.txn(["profile"], "readonly", (tx) => tx.getAll("profile"));
    const top = swLogic.topProfile(rows, Date.now(), 50);
    for (const sid of new Set(top.map((v) => shardIdOf(v.title)))) {
      try {                                       // [G10] 샤드 단위 독립 격리
        const have = await db.txn(["nbr_cache"], "readonly", (tx) => tx.get("nbr_cache", sid));
        if (have) continue;
        await fetchShardIntoCache(sid);           // [M6] size_bytes 정의 포함
      } catch (e) {
        console.warn("shard failed:", sid, e);    // 실패 샤드는 기록하지 않고 다음으로
      }
    }
  } catch (e) {
    console.warn("prefetchShards isolated:", e);  // rebuild·prune 도달 보장 [G10]
  }
}

function evictCache() {                           // [M6] 총량 150MB 초과 시 LRU 퇴출
  return db.txn(["nbr_cache"], "readwrite", async (tx) => {
    const metas = await tx.getAll("nbr_cache");
    for (const sid of swLogic.pickEvictions(metas, CACHE_CAP)) {
      await tx.del("nbr_cache", sid);
    }
  });
}

// [G13·H8·I6·J11·J1] rebuild — 단일 txn에서 조회·집계·clear·재작성까지 수행.
// 후보: w(v) 상위 50 프로필 문서의 이웃 합집합(샤드 → 없으면 local_nbr 폴백 [F2]),
// 방문 문서(profile 보유 제목) 제외. 샤드 조회 시 last_used 갱신 (§4.5).
function rebuildRecommendations() {
  return db.txn(["profile", "nbr_cache", "local_nbr", "recommendations", "kv"], "readwrite",
    async (tx) => {
      const now = Date.now();
      const rows = await tx.getAll("profile");
      const top = swLogic.topProfile(rows, now, 50);
      const visited = new Set(rows.map((r) => r.title));   // 방문 판정 = profile 보유 제목
      const perSource = [];
      for (const v of top) {
        const sid = shardIdOf(v.title);
        const shard = await tx.get("nbr_cache", sid);
        let nbrs = null;
        let source = "shard";
        if (shard) {
          shard.last_used = now;                  // 샤드 조회 시마다 last_used 갱신 §4.5
          await tx.put("nbr_cache", shard);
          nbrs = shard.payload[v.title] || null;
        }
        if (!nbrs) {                              // §4.6 링크 폴백
          const local = await tx.get("local_nbr", v.title);
          if (local && local.links.length) {
            nbrs = local.links.map((t) => [t, FALLBACK_SIM, 0]);   // sim=0.4 고정, pr_pct=0 [F2]
            source = "fallback";
          }
        }
        if (!nbrs) continue;                      // 어디에도 없으면 기여 0으로 조용히 skip
        perSource.push({ title: v.title, w: v.w, dwell: v.dwell, nbrs, source });
      }
      const list = swLogic.interleaveBySource(swLogic.scoreCandidates(perSource, visited, 20));
      if (!list.length) {                         // [H8] 산출 0건 → popular 폴백
        const popular = (await tx.get("kv", "popular"))?.value;
        if (!popular) return false;               // [I6] clear 없이 스킵 — dirty 유지
        await tx.clear("recommendations");
        for (const [i, title] of popular.slice(0, 20).entries()) {
          await tx.put("recommendations", {
            rank: i + 1, title, score: 0, sim: null,
            source: "popular", reason_title: null, reason_dwell_ms: null, computed_at: now,
          });
        }
        return true;
      }
      await tx.clear("recommendations");          // [G13] 유령 행 제거
      for (const [i, r] of list.entries()) {      // [J11] 1..N−1건이면 있는 만큼만
        await tx.put("recommendations", { rank: i + 1, ...r, computed_at: now });
      }
      return true;
    });
}

globalThis.swLogic = swLogic;
if (typeof module !== "undefined") {
  module.exports = { swLogic, CACHE_CAP };
}
