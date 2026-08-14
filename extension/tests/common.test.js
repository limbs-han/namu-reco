// common.js 공용 문구·조사 규칙 검증 — 실행: node --test extension/tests/common.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { josaOf, reasonText, LONG_READ_MS, isHanjaOnly } = require(path.join(__dirname, "..", "common.js"));

test("[UX-01] isHanjaOnly — 전부 한자면 true, 한글·혼합·영문은 false", () => {
  assert.equal(isHanjaOnly("四"), true);
  assert.equal(isHanjaOnly("四足步行"), true);
  assert.equal(isHanjaOnly("새"), false);
  assert.equal(isHanjaOnly("사족보행"), false);
  assert.equal(isHanjaOnly("C#"), false);
  assert.equal(isHanjaOnly(""), false);
});

test("[m1] 조사 일반화 — 받침 판별, 비한글 끝 글자는 병기", () => {
  assert.equal(josaOf("치타", "과", "와"), "와");
  assert.equal(josaOf("대한민국", "과", "와"), "과");
  assert.equal(josaOf("C#", "과", "와"), "과(와)");
  assert.equal(josaOf("사족보행", "을", "를"), "을");
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
