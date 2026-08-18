// swLogic 순수 로직 검증 — 실행: node --test extension/tests/logic.test.js
// E7(감쇠)·E4(LRU)·§4.4 집계 계약(출처당 상한 5·방문 제외·reason/sim/source [G7])의 로직 레벨.
// 실브라우저 통합 판정은 extension/tests/manual-checklist.html 참조.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

Object.assign(globalThis, require(path.join(__dirname, "..", "common.js")));
const { swLogic, CACHE_CAP } = require(path.join(__dirname, "..", "sw.js"));

const DAY = 86400000;

test("E7 로직: 14일 경과 유효 가중치는 1/4 (0.5^2)", () => {
  const now = Date.now();
  const w = swLogic.effectiveWeight(8, now - 14 * DAY, now);
  assert.ok(Math.abs(w - 2) / 2 < 0.05);          // 허용 오차 ±5%
});

test("[M2] 점화식: 기존 score는 감쇠 후 누적 — 무감쇠 누적은 오답", () => {
  const T = Date.now();
  // 7일 경과 score 8 → 4로 감쇠된 뒤 신규 dwell 1초(ln 2) 가산
  const s = swLogic.nextScore(8, T - 7 * DAY, [1000], T);
  assert.ok(Math.abs(s - (4 + Math.log(2))) < 1e-9);
  // 신규 이벤트 0 기여여도 감쇠는 적용 (8 그대로면 무감쇠 누적 구현)
  assert.ok(Math.abs(swLogic.nextScore(8, T - 7 * DAY, [0], T) - 4) < 1e-9);
});

test("topProfile: w(v) 내림차순 상위 n, 동률은 제목순", () => {
  const now = Date.now();
  const rows = [
    { title: "B", score: 1, last_seen: now },
    { title: "A", score: 1, last_seen: now },
    { title: "C", score: 9, last_seen: now },
  ];
  const top = swLogic.topProfile(rows, now, 2);
  assert.deepEqual(top.map((t) => t.title), ["C", "A"]);
});

test("§4.4 집계: score = Σ w·sim + 0.1·pr_pct, 출처당 상한 5, 방문 제외", () => {
  const nbrs = [["N1", 0.9, 0.5], ["방문한문서", 0.99, 0.9], ["N2", 0.8, 0.2],
                ["N3", 0.7, 0], ["N4", 0.6, 0], ["N5", 0.5, 0], ["N6", 0.99, 0.9]];
  const out = swLogic.scoreCandidates(
    [{ title: "V", w: 2, nbrs, source: "shard" }], new Set(["방문한문서"]));
  // 방문 제외 후 상한 5 → N1..N5 (N6은 잘림)
  assert.deepEqual(out.map((o) => o.title).sort(), ["N1", "N2", "N3", "N4", "N5"].sort());
  const n1 = out.find((o) => o.title === "N1");
  assert.ok(Math.abs(n1.score - (2 * 0.9 + 0.1 * 0.5)) < 1e-9);
  assert.equal(n1.reason_title, "V");
  assert.equal(n1.sim, 0.9);                      // [G7] 기여 sim 기록
  assert.equal(n1.source, "shard");
});

test("[G7] reason_title = sim 기여 최대 출처, 그 기여의 sim·source 기록", () => {
  const out = swLogic.scoreCandidates([
    { title: "V1", w: 1, nbrs: [["C", 0.5, 0]], source: "shard" },
    { title: "V2", w: 3, nbrs: [["C", FALLBACK_SIM, 0]], source: "fallback" },
  ], new Set());
  const c = out.find((o) => o.title === "C");
  assert.equal(c.reason_title, "V2");             // 3×0.4=1.2 > 1×0.5
  assert.equal(c.sim, FALLBACK_SIM);              // E6: 폴백 기여는 sim=0.4 그대로
  assert.equal(c.source, "fallback");
  assert.ok(Math.abs(c.score - (0.5 + 1.2)) < 1e-9);
});

test("[H8] N=20 절단 + 산출 0건이면 빈 배열(폴백 판단은 호출측)", () => {
  const nbrs = Array.from({ length: 30 }, (_, i) => [`N${i}`, 0.9, 0]);
  // 출처당 상한 5 때문에 출처 6개로 25 후보 생성
  const src = Array.from({ length: 6 }, (_, s) => ({
    title: `V${s}`, w: 1, nbrs: nbrs.slice(s * 5, s * 5 + 5), source: "shard",
  }));
  assert.equal(swLogic.scoreCandidates(src, new Set()).length, 20);
  assert.deepEqual(swLogic.scoreCandidates([], new Set()), []);
});

test("[M2] topProfile은 dwell_ms_total을 dwell로 전달 (부재 시 0)", () => {
  const now = Date.now();
  const top = swLogic.topProfile([
    { title: "A", score: 5, last_seen: now, dwell_ms_total: 421000 },
    { title: "B", score: 1, last_seen: now },
  ], now, 2);
  assert.equal(top[0].dwell, 421000);
  assert.equal(top[1].dwell, 0);
});

test("[M2] reason_dwell_ms = 최대 기여 출처의 누적 체류, dwell 부재는 null", () => {
  const out = swLogic.scoreCandidates([
    { title: "V1", w: 1, dwell: 30000, nbrs: [["C", 0.5, 0]], source: "shard" },
    { title: "V2", w: 3, dwell: 400000, nbrs: [["C", 0.4, 0]], source: "fallback" },
  ], new Set());
  assert.equal(out.find((o) => o.title === "C").reason_dwell_ms, 400000);  // V2가 최대 기여
  const legacy = swLogic.scoreCandidates(
    [{ title: "V", w: 1, nbrs: [["D", 0.5, 0]], source: "shard" }], new Set());
  assert.equal(legacy.find((o) => o.title === "D").reason_dwell_ms, null);
});

test("[M3] 출처 라운드로빈 — 상위가 한 출처 파생 5개로 뭉치지 않는다", () => {
  const list = [
    { title: "a1", reason_title: "A" }, { title: "a2", reason_title: "A" },
    { title: "a3", reason_title: "A" }, { title: "b1", reason_title: "B" },
    { title: "b2", reason_title: "B" }, { title: "c1", reason_title: null },
  ];
  assert.deepEqual(swLogic.interleaveBySource(list).map((r) => r.title),
    ["a1", "b1", "c1", "a2", "b2", "a3"]);
});

test("[M3] 빈 배열·단일 그룹은 순서 그대로", () => {
  assert.deepEqual(swLogic.interleaveBySource([]), []);
  const one = [{ title: "x", reason_title: "A" }, { title: "y", reason_title: "A" }];
  assert.deepEqual(swLogic.interleaveBySource(one).map((r) => r.title), ["x", "y"]);
});

test("[F2] 출처 수 상한 — 상위 K개 출처가 20행을 채우고, 못 채우면 나머지로 이어붙인다", () => {
  // 이력이 쌓이면 출처가 20개를 넘어 행마다 자기 섹션을 갖는다(헤더/행 1.00 붕괴, 리포트 F2).
  const src = (n, per) => Array.from({ length: n }, (_, s) => ({
    title: `V${s}`, w: n - s, dwell: 0, source: "fallback",
    nbrs: Array.from({ length: per }, (_, i) => [`V${s}-N${i}`, 0.4, 0]),
  }));
  const all = swLogic.scoreCandidates(src(8, 5), new Set(), Infinity);
  const list = swLogic.interleaveBySource(all).slice(0, 20);
  assert.equal(list.length, 20);
  assert.ok(new Set(list.map((r) => r.reason_title)).size <= 5, "20행의 출처는 5개 이하");
  // 상위 K가 20행에 미달하면 나머지 출처로 채운다 — 추천 건수 손실 0 [UX-12]
  const thin = swLogic.scoreCandidates(src(8, 2), new Set(), Infinity);
  assert.equal(swLogic.interleaveBySource(thin).length, thin.length);   // 16건 전량 보존
  assert.equal(new Set(swLogic.interleaveBySource(thin).slice(0, 10)
    .map((r) => r.reason_title)).size, 5);   // 앞 10행은 상위 5개 출처에서만
});

test("[G2] clusterSources — 출처끼리 이웃이면 같은 클러스터, 대표 = 최고 가중치", () => {
  const src = (title, w, dwell, nbrTitles) => ({ title, w, dwell, source: "shard",
    nbrs: nbrTitles.map((t) => [t, 0.5, 0]) });
  const c = swLogic.clusterSources([
    src("근육", 3, 300000, ["식스팩", "단백질"]),     // 식스팩이 출처이자 이웃 → 병합
    src("식스팩", 5, 60000, ["복근"]),
    src("큰볼기근", 2, 0, ["근육"]),                  // 근육을 이웃으로 → 같은 클러스터 (방향 무관)
    src("김치", 1, 0, ["배추"]),                      // 고립 — 클러스터 없음
  ]);
  assert.deepEqual(c.get("근육"), { rep: "식스팩", dwell: 60000 });   // w 5 > 3 > 2
  assert.deepEqual(c.get("큰볼기근"), c.get("근육"));
  assert.equal(c.has("김치"), false);                 // 단독 출처는 병합 대상 아님
});

test("[G2] 클러스터 행은 라운드로빈에서 한 출처로 계상 — 키 = reason_rep 우선", () => {
  const r = (t, reason, rep) => ({ title: t, reason_title: reason, reason_rep: rep ?? null });
  assert.deepEqual(swLogic.interleaveBySource([
    r("a1", "근육", "식스팩"), r("a2", "식스팩", "식스팩"),   // 같은 클러스터 = 한 그룹
    r("b1", "김치", null),
  ]).map((x) => x.title), ["a1", "b1", "a2"]);
});

test("[UX-02] scoreCandidates — 한자 전용 후보는 소스 불문 제외, 상한 5 슬롯 미소모", () => {
  const nbrs = [["四", 0.99, 0.9], ["N1", 0.9, 0], ["N2", 0.8, 0],
                ["N3", 0.7, 0], ["N4", 0.6, 0], ["N5", 0.5, 0]];
  const out = swLogic.scoreCandidates(
    [{ title: "사족보행", w: 2, dwell: 0, nbrs, source: "shard" }], new Set());
  // 四 제외 + 슬롯 미소모 → N1..N5 다섯 개 전부 살아남는다
  assert.deepEqual(out.map((o) => o.title).sort(), ["N1", "N2", "N3", "N4", "N5"].sort());
});

test("[UX-12] 절단 전 라운드로빈 — 출처 5개면 상위 5개가 전부 다른 출처", () => {
  // 최약 출처 V4의 후보도 그룹으로 살아남아야 한다 (v0.6.0은 top-20 선절단으로 소실)
  const src = Array.from({ length: 5 }, (_, s) => ({
    title: `V${s}`, w: 5 - s, dwell: 0, source: "fallback",
    nbrs: Array.from({ length: 5 }, (_, i) => [`V${s}-N${i}`, 0.4, 0]),
  }));
  const all = swLogic.scoreCandidates(src, new Set(), Infinity);
  assert.equal(all.length, 25);                       // 절단 없음 — 5×5 전부
  const list = swLogic.interleaveBySource(all).slice(0, 20);
  assert.equal(new Set(list.slice(0, 5).map((r) => r.reason_title)).size, 5);
  assert.equal(list.length, 20);                      // [H8] 저장 계약은 절단으로 유지
});

test("E4 로직: LRU 퇴출 — last_used 오래된 순, 상한 이하까지만", () => {
  const metas = [
    { shard_id: 1, size_bytes: 60, last_used: 300 },
    { shard_id: 2, size_bytes: 60, last_used: 100 },   // 최고령
    { shard_id: 3, size_bytes: 60, last_used: 200 },
  ];
  assert.deepEqual(swLogic.pickEvictions(metas, 130), [2]);     // 180→120 ≤ 130, 초과 퇴출 없음
  assert.deepEqual(swLogic.pickEvictions(metas, 100), [2, 3]);  // 두 개 퇴출해야 60 ≤ 100
  assert.deepEqual(swLogic.pickEvictions(metas, 200), []);
  assert.equal(CACHE_CAP, 150 * 2 ** 20);         // [M6] 150MB
});
