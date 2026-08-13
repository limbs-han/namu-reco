// relatedBox 순수 로직 검증 — 실행: node --test extension/tests/related_box.test.js
// v11 §4.9: 우측 사이드바 "연관 문서" 위젯. DOM 통합 판정은 실브라우저 E19~E21.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

Object.assign(globalThis, require(path.join(__dirname, "..", "common.js")));
const { relatedBox } = require(path.join(__dirname, "..", "related_box.js"));

// directRows = ':scope > ul > li > a' 직계 구조 질의 결과 (위젯 고유 구조)
const el = (directRows, parent = null) => ({
  parentElement: parent,
  querySelectorAll: () => directRows,
});
const docRows = (n) => Array.from({ length: n }, (_, i) => ({ pathname: `/w/문서${i}` }));

test("사이드바 위젯 발견 — 헤더 앵커의 부모가 직계 UL 행 목록을 가짐", () => {
  const widget = el(docRows(10));
  const anchors = [{ pathname: "/RecentChanges", parentElement: widget }];
  assert.equal(relatedBox.findWidgetBox(anchors), widget);
});

test("회귀: 페이지 전체 래퍼 오인 방지 — 직계 UL 없는 조상은 행을 깊이 품어도 탈락", () => {
  // 상단 메뉴 앵커: 부모(메뉴바)·조부모(페이지 래퍼) 모두 ':scope > ul > li > a' 0건
  // (래퍼는 행을 '깊숙이' 품지만 직계가 아님 — 실DOM에서 통째 clone 사고의 원인)
  const pageWrapper = el([]);
  const menubar = el([], pageWrapper);
  const topMenuAnchor = { pathname: "/RecentChanges", parentElement: menubar };
  assert.equal(relatedBox.findWidgetBox([topMenuAnchor]), null);

  // 상단 메뉴 앵커가 문서 순서상 먼저 와도, 뒤의 진짜 위젯이 선택된다
  const widget = el(docRows(10));
  const sidebarAnchor = { pathname: "/RecentChanges", parentElement: widget };
  assert.equal(relatedBox.findWidgetBox([topMenuAnchor, sidebarAnchor]), widget);
});

test("행 실질 검증 — 3행 미만·비-/w/ 행은 위젯이 아님", () => {
  assert.equal(relatedBox.findWidgetBox(
    [{ pathname: "/RecentChanges", parentElement: el(docRows(2)) }]), null);
  assert.equal(relatedBox.findWidgetBox(
    [{ pathname: "/RecentChanges", parentElement: el([{ pathname: "/board/a" }, { pathname: "/board/b" }, { pathname: "/board/c" }]) }]), null);
  assert.equal(relatedBox.findWidgetBox([{ pathname: "/w/x", parentElement: el(docRows(5)) }]), null);
});

test("[m2] 레이아웃 판정 — 가로 분리(사이드바)면 true, 세로 적층(좁은 창)이면 false", () => {
  assert.equal(relatedBox.isSideBySide({ left: 1000, right: 1300 }, { left: 100, right: 900 }), true);
  assert.equal(relatedBox.isSideBySide({ left: 100, right: 900 }, { left: 100, right: 900 }), false);
  assert.equal(relatedBox.isSideBySide({ left: 100, right: 900 }, { left: 950, right: 1300 }), true);
});

test("행 데이터 — 본문 링크를 자기 제외·상위 10개 {title, href}로", () => {
  const links = ["현재문서", ...Array.from({ length: 15 }, (_, i) => `문서${i}`)];
  const rows = relatedBox.rowData(links, "현재문서");
  assert.equal(rows.length, 10);                             // 상한 10
  assert.ok(!rows.some((r) => r.title === "현재문서"));      // 목차 앵커 유래 자기 링크 제외
  assert.equal(rows[0].title, "문서0");
  assert.equal(rows[0].href, docUrlOf("문서0"));             // [J2] 단일 진실원
  assert.equal(relatedBox.rowData(["C#"], "x")[0].href, "https://namu.wiki/w/C%23");
  assert.deepEqual(relatedBox.rowData([], "x"), []);
});
