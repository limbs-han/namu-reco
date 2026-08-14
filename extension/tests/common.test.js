// common.js 공용 문구·조사 규칙 검증 — 실행: node --test extension/tests/common.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { josaOf, reasonText, LONG_READ_MS, isHanjaOnly, docPathOf, docUrlOf,
        presentableRows, softNavigate } = require(path.join(__dirname, "..", "common.js"));

test("[UX-10] docPathOf — 상대 경로 단일 진실원, docUrlOf는 그 합성", () => {
  assert.equal(docPathOf("C#"), "/w/C%23");
  assert.equal(docPathOf("A/B"), "/w/A/B");
  assert.equal(docUrlOf("C#"), "https://namu.wiki" + docPathOf("C#"));
});

test("[UX-01] isHanjaOnly — 전부 한자면 true, 한글·혼합·영문은 false", () => {
  assert.equal(isHanjaOnly("四"), true);
  assert.equal(isHanjaOnly("四足步行"), true);
  assert.equal(isHanjaOnly("새"), false);
  assert.equal(isHanjaOnly("사족보행"), false);
  assert.equal(isHanjaOnly("C#"), false);
  assert.equal(isHanjaOnly(""), false);
});

test("[UX-A3] presentableRows — rank 정렬 + 한자 전용 제외 (구버전 저장분 렌더 시점 정화)", () => {
  const rows = [
    { rank: 3, title: "四" }, { rank: 1, title: "새" },
    { rank: 4, title: "치타" }, { rank: 2, title: "步" },
  ];
  assert.deepEqual(presentableRows(rows).map((r) => r.title), ["새", "치타"]);
});

test("[m1] 조사 일반화 — 받침 판별, 비한글 끝 글자는 병기", () => {
  assert.equal(josaOf("치타", "과", "와"), "와");
  assert.equal(josaOf("대한민국", "과", "와"), "과");
  assert.equal(josaOf("C#", "과", "와"), "와(과)");   // [UX-B1] 명세 정본 — 과(와)가 아니라 와(과)
  assert.equal(josaOf("사족보행", "을", "를"), "을");
});

// [UX-B6] softNavigate용 가짜 브라우저 환경 — pushState·popstate·MutationObserver·타이머 기록
function fakeEnv(hasApp) {
  const calls = { push: [], dispatched: [], href: null };
  let moCb = null, timerCb = null;
  const w = {
    history: { pushState: (s, t, p) => calls.push.push(p) },
    PopStateEvent: class { constructor(type) { this.type = type; } },
    dispatchEvent: (e) => calls.dispatched.push(e.type),
    MutationObserver: class {
      constructor(cb) { moCb = cb; }
      observe() {}
      disconnect() {}
    },
    setTimeout: (cb) => { timerCb = cb; },
    location: { set href(v) { calls.href = v; } },
  };
  const d = { getElementById: (id) => (id === "app" && hasApp ? {} : null) };
  return { w, d, calls, mutate: () => moCb && moCb(), fireTimer: () => timerCb && timerCb() };
}

test("[UX-B6] softNavigate — #app 없으면 false(하드 유지), 있으면 pushState+popstate 후 true", () => {
  const none = fakeEnv(false);
  assert.equal(softNavigate("/w/X", none.w, none.d), false);
  assert.equal(none.calls.push.length, 0);
  const env = fakeEnv(true);
  assert.equal(softNavigate("/w/X", env.w, env.d), true);
  assert.deepEqual(env.calls.push, ["/w/X"]);
  assert.deepEqual(env.calls.dispatched, ["popstate"]);
});

test("[UX-B6] softNavigate 데드맨 — 변이 없으면 하드 폴백, 변이 있으면 잔류", () => {
  const dead = fakeEnv(true);
  softNavigate("/w/X", dead.w, dead.d);
  dead.fireTimer();                              // 변이 0 → 라우터 침묵
  assert.equal(dead.calls.href, "/w/X");
  const alive = fakeEnv(true);
  softNavigate("/w/X", alive.w, alive.d);
  alive.mutate();                                // 라우터가 렌더 시작
  alive.fireTimer();
  assert.equal(alive.calls.href, null);
});

test("[UX-06] 사유 문구 — 출처×체류 4분면 + popular, 과장 표현 금지", () => {
  assert.equal(reasonText({ reason_title: "치타", source: "shard", reason_dwell_ms: LONG_READ_MS }),
               "오래 읽은 「치타」와 가까운 문서");
  assert.equal(reasonText({ reason_title: "대한민국", source: "shard", reason_dwell_ms: 1000 }),
               "「대한민국」과 가까운 문서");
  assert.equal(reasonText({ reason_title: "김치", source: "fallback", reason_dwell_ms: LONG_READ_MS }),
               "오래 읽은 「김치」에서 이어지는 문서");
  assert.equal(reasonText({ reason_title: "사족보행", source: "fallback" }),
               "「사족보행」에서 이어지는 문서");   // 구버전 행(dwell 미상) 폴백 포함
  assert.equal(reasonText({ reason_title: null, source: "popular" }), "인기 문서");
  assert.equal(reasonText({ reason_title: null, source: "shard" }), "");
});
