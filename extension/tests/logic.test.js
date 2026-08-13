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

test("연관 문서 폴백 [v11 §4.9]: local_nbr 링크 → 엔트리 (자기 제외·10개·FALLBACK_SIM)", () => {
  const links = ["자기자신", ...Array.from({ length: 15 }, (_, i) => `링크${i}`)];
  const out = swLogic.localToEntries(links, "자기자신");
  assert.equal(out.length, 10);
  assert.ok(!out.some(([t]) => t === "자기자신"));
  assert.deepEqual(out[0], ["링크0", FALLBACK_SIM, 0]);   // §4.6과 동일 의미론
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
