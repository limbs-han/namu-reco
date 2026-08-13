// common.js 공용 문구·조사 규칙 검증 — 실행: node --test extension/tests/common.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { eulReul, reasonText, LONG_READ_MS } = require(path.join(__dirname, "..", "common.js"));

test("[m1] 목적격 조사 — 받침 유무 판별, 비한글 끝 글자는 병기", () => {
  assert.equal(eulReul("대한민국"), "을");
  assert.equal(eulReul("사족보행"), "을");
  assert.equal(eulReul("하츠네 미쿠"), "를");
  assert.equal(eulReul("C#"), "을(를)");
});

test("[M2] 사유 문구 계층 — 3분 이상만 '오래', 미만·미상(구버전 행)은 '읽으셔서'", () => {
  assert.equal(reasonText({ reason_title: "대한민국", reason_dwell_ms: LONG_READ_MS }),
               "「대한민국」을 오래 읽으셔서");
  assert.equal(reasonText({ reason_title: "하츠네 미쿠", reason_dwell_ms: 25000 }),
               "「하츠네 미쿠」를 읽으셔서");
  assert.equal(reasonText({ reason_title: "김치" }), "「김치」를 읽으셔서");
  assert.equal(reasonText({ reason_title: null, source: "popular" }), "인기 문서");
  assert.equal(reasonText({ reason_title: null, source: "shard" }), "");
});
