// recoTab 순수 로직 검증 — 실행: node --test extension/tests/reco_tab.test.js
// v11 §4.8: 상단 메뉴 "추천 문서" 드롭다운. DOM 통합 판정은 실브라우저 E15~E18.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

Object.assign(globalThis, require(path.join(__dirname, "..", "common.js")));
const { recoTab } = require(path.join(__dirname, "..", "reco_tab.js"));

test("메뉴 컨테이너 발견 — a.pathname === /RecentChanges 기준, 난독화 클래스 무관", () => {
  const bar = { name: "menubar" };
  const anchors = [
    { pathname: "/w/문서", parentElement: { name: "본문" } },
    { pathname: "/RecentChanges", parentElement: bar },
    { pathname: "/RecentDiscuss", parentElement: bar },
  ];
  assert.equal(recoTab.findMenuContainer(anchors), bar);
  assert.equal(recoTab.findMenuContainer([{ pathname: "/w/x", parentElement: {} }]), null);
  assert.equal(recoTab.findMenuContainer([]), null);   // 미발견 → null (조용히 스킵)
});

test("메뉴 컨테이너 발견 — /RecentChanges 부재 시 /RecentDiscuss 폴백", () => {
  const bar = { name: "menubar" };
  assert.equal(recoTab.findMenuContainer([
    { pathname: "/RecentDiscuss", parentElement: bar },
  ]), bar);
});

test("사유 문구 — §4.7 [J8] 규칙 재사용", () => {
  assert.equal(recoTab.reasonText({ reason_title: "하츠네 미쿠" }),
               "「하츠네 미쿠」를 오래 읽으셔서");
  assert.equal(recoTab.reasonText({ reason_title: null, source: "popular" }), "인기 문서");
  assert.equal(recoTab.reasonText({ reason_title: null, source: "shard" }), "");
});

test("다크 테마 판별 — body 배경 밝기 기준", () => {
  assert.equal(recoTab.isDarkBg("rgb(255, 255, 255)"), false);
  assert.equal(recoTab.isDarkBg("rgb(24, 26, 27)"), true);
  assert.equal(recoTab.isDarkBg("rgba(0, 0, 0, 0)"), false);  // 투명 = 판별 불가 → 라이트 기본
  assert.equal(recoTab.isDarkBg(""), false);
});

test("항목 href는 docUrlOf 단일 진실원 [J2] — C# 류 제목 안전", () => {
  assert.equal(recoTab.itemHref("C#"), "https://namu.wiki/w/C%23");
  assert.equal(recoTab.itemHref("A/B"), "https://namu.wiki/w/A/B");
});
