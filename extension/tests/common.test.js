// common.js 공용 문구·조사 규칙 검증 — 실행: node --test extension/tests/common.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { josaOf, reasonText, LONG_READ_MS, isHanjaOnly, docPathOf, docUrlOf,
        presentableRows, softNavigate, fmtDwell, groupRows, pendingViewTitles } = require(path.join(__dirname, "..", "common.js"));

test("[G1] groupRows — 사유 문자열 키, 첫 등장 순 그룹, 그룹 내 rank 순 유지", () => {
  const mk = (rank, title, reason, source) => ({ rank, title, source,
    reason_title: reason, reason_dwell_ms: null });
  const rows = [   // 라운드로빈 산출 형태 (rank 순)
    mk(1, "뱀", "사족보행", "fallback"),
    mk(2, "배추", "김치", "shard"),
    mk(3, "대한민국", null, "popular"),
    mk(4, "에뮤", "사족보행", "fallback"),
    mk(5, "깍두기", "김치", "shard"),
  ];
  const gs = groupRows(rows);
  assert.deepEqual(gs.map((g) => g.header),
    ["「사족보행」에서 이어지는 문서", "「김치」와 가까운 문서", "인기 문서"]);
  assert.deepEqual(gs[0].rows.map((r) => r.title), ["뱀", "에뮤"]);
  assert.deepEqual(gs[1].rows.map((r) => r.title), ["배추", "깍두기"]);
  // 빈 사유(비정상 행)는 "" 그룹 — 렌더가 헤더 없이 표시
  assert.deepEqual(groupRows([mk(1, "X", null, "shard")])[0].header, "");
});

test("[F1] groupRows — 그룹 순서는 남은 행의 최고 score 순 (서빙 시점 제외 후 재계산)", () => {
  // rank는 라운드로빈 위치라 점수 순이 아니다. 1위 그룹의 1라운드 행이 제외되면
  // 첫 등장 rank 기준 정렬은 그 그룹을 맨 끝으로 보낸다 — 리포트 F1 (4/4 재현).
  const mk = (rank, title, reason, score) => ({ rank, title, score, source: "shard",
    reason_title: reason, reason_dwell_ms: null });
  const rows = [                     // 라운드로빈 산출 형태 (rank 순, score는 그룹 내 내림차순)
    mk(1, "식스팩", "근육", 9),     mk(2, "넓은등근", "성대", 8),  mk(3, "Go", "Objective-C", 7),
    mk(4, "큰볼기근", "근육", 8.5), mk(5, "척추기립근", "성대", 3), mk(6, "Forth", "Objective-C", 2),
  ];
  const after = rows.filter((r) => r.title !== "식스팩");   // presentableRows가 1라운드 행을 걷어낸 상태
  assert.deepEqual(groupRows(after).map((g) => g.rows[0].title),
    ["큰볼기근", "넓은등근", "Go"]);   // 「근육」 남은 최고점 8.5 > 8 > 7 → 여전히 1위 (버그는 꼬리로 보냈다)
  // 무손상 입력의 순서는 불변 (기존 동작 보존)
  assert.deepEqual(groupRows(rows).map((g) => g.rows[0].title), ["식스팩", "넓은등근", "Go"]);
});

test("[F2] groupRows — 상위 5섹션은 사유 유지, 6번째부터 「그 외 추천」 병합", () => {
  const mk = (rank, title, reason, score) => ({ rank, title, score, source: "shard",
    reason_title: reason, reason_dwell_ms: null });
  // 실기 결함 케이스(v0.6.4 1차 롤백 원인): 구버전 저장분 = 전 섹션 1행.
  // "1행 섹션 전부 병합" 규칙은 목록 전체를 「그 외 추천」 하나로 통일해 버렸다.
  const singles = Array.from({ length: 19 }, (_, i) => mk(i + 1, `T${i}`, `R${i}`, 19 - i));
  const gs = groupRows(singles);
  assert.equal(gs.length, 6);                                   // 5 + 병합 1
  assert.deepEqual(gs.slice(0, 5).map((g) => g.header),         // 상위 5개는 사유 유지
    ["「R0」와(과) 가까운 문서", "「R1」와(과) 가까운 문서", "「R2」와(과) 가까운 문서",
     "「R3」와(과) 가까운 문서", "「R4」와(과) 가까운 문서"]);   // 비한글 끝 = 병기 [B1]
  assert.equal(gs[5].header, "그 외 추천");
  assert.equal(gs[5].rows.length, 14);                          // 건수 손실 0
  // 섹션 6개 이하는 병합하지 않는다 — 하나 합쳐봤자 사유만 잃는다
  assert.equal(groupRows(singles.slice(0, 6)).filter((g) => g.header === "그 외 추천").length, 0);
  // 다행(多行) 섹션 혼재 시에도 상한은 섹션 수 기준
  const mixed = groupRows([
    mk(1, "A1", "가", 9), mk(2, "B1", "나", 8), mk(3, "C1", "다", 7), mk(4, "A2", "가", 6),
  ]);
  assert.deepEqual(mixed.map((g) => g.header),
    ["「가」와 가까운 문서", "「나」와 가까운 문서", "「다」와 가까운 문서"]);   // 3섹션 — 병합 없음
});

test("[G2] reasonText — 클러스터 행은 「대표」 등과 가까운 문서, 오래 읽음은 대표 dwell 기준", () => {
  const base = { title: "전완근", source: "shard", reason_title: "근육",
    reason_dwell_ms: 30000, reason_rep: "식스팩", reason_rep_dwell_ms: null };
  assert.equal(reasonText(base), "「식스팩」 등과 가까운 문서");
  assert.equal(reasonText({ ...base, reason_rep_dwell_ms: LONG_READ_MS }),
    "오래 읽은 「식스팩」 등과 가까운 문서");
  // 폴백(이어지는) 행도 클러스터에선 "가까운" — sim=0.4로 그래프 유사도에 계상되므로 증명 가능,
  // 역방향("등에서 이어지는")은 shard 행에 실제 링크가 없을 수 있어 과장
  assert.equal(reasonText({ ...base, source: "fallback" }), "「식스팩」 등과 가까운 문서");
  // reason_rep 없는 구버전 저장분·단독 출처는 현행 문구 그대로
  assert.equal(reasonText({ ...base, reason_rep: null }), "「근육」과 가까운 문서");
});

test("[G2] groupRows — 같은 클러스터 행은 한 섹션", () => {
  const mk = (rank, title, reason, rep, score) => ({ rank, title, score, source: "shard",
    reason_title: reason, reason_rep: rep, reason_rep_dwell_ms: null, reason_dwell_ms: null });
  const gs = groupRows([
    mk(1, "전완근", "근육", "식스팩", 9), mk(2, "복근", "식스팩", "식스팩", 8),
    mk(3, "배추", "김치", null, 7),
  ]);
  assert.deepEqual(gs.map((g) => [g.header, g.rows.length]),
    [["「식스팩」 등과 가까운 문서", 2], ["「김치」와 가까운 문서", 1]]);
});

test("[G3] groupRows — topic 필드: 뮤트 대상(대표 제목), 병합·인기·빈 사유는 null", () => {
  const mk = (rank, title, reason, rep, score, source = "shard") => ({ rank, title, score, source,
    reason_title: reason, reason_rep: rep, reason_rep_dwell_ms: null, reason_dwell_ms: null });
  const gs = groupRows([
    mk(1, "전완근", "근육", "식스팩", 9), mk(2, "배추", "김치", null, 8),
    mk(3, "대한민국", null, null, 7, "popular"),
  ]);
  assert.deepEqual(gs.map((g) => g.topic), ["식스팩", "김치", null]);   // 클러스터는 대표가 뮤트 키
  // 「그 외 추천」 병합 섹션은 여러 출처 묶음 — 뮤트 대상 아님
  const singles = Array.from({ length: 7 }, (_, i) => mk(i + 1, `T${i}`, `R${i}`, null, 7 - i));
  const merged = groupRows(singles).find((g) => g.header === "그 외 추천");
  assert.equal(merged.topic, null);
});

test("[§7] fmtDwell — 분·초 표기 (dwell 경계 실측용 디버그)", () => {
  assert.equal(fmtDwell(288000), "4분 48초");
  assert.equal(fmtDwell(0), "0분 0초");
  assert.equal(fmtDwell(LONG_READ_MS), "3분 0초");
});

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

test("[E24-M1] presentableRows — 문자열·배열 exclude로 제외, 미지정·null이면 전량", () => {
  const rows = [{ rank: 1, title: "성대" }, { rank: 2, title: "코볼" }];
  assert.deepEqual(presentableRows(rows, "성대").map((r) => r.title), ["코볼"]);
  assert.deepEqual(presentableRows(rows, ["성대", "코볼"]), []);   // 배열(미처리 view 제목들)
  assert.deepEqual(presentableRows(rows).map((r) => r.title), ["성대", "코볼"]);
  assert.deepEqual(presentableRows(rows, null).map((r) => r.title), ["성대", "코볼"]);
});

test("[E24-M1+] pendingViewTitles — 최근 미처리 view만, 집계 완료·고아(stale)는 제외", () => {
  const now = 3600e3;
  const evs = [
    { title: "성대", processed: 0, updated_at: now - 60e3 },        // 방금 떠남 → 포함
    { title: "코볼", processed: 1, updated_at: now - 60e3 },        // 집계 완료 → 제외
    { title: "보행", processed: 0, updated_at: now - 11 * 60e3 },   // 고아/stale → 제외 (추천 구멍 방지)
  ];
  assert.deepEqual(pendingViewTitles(evs, now), ["성대"]);
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
