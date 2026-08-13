// relatedBox 순수 로직 검증 — 실행: node --test extension/tests/related_box.test.js
// v11 §4.9: 우측 사이드바 "연관 문서" 위젯. DOM 통합 판정은 실브라우저 E19~E21.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

Object.assign(globalThis, require(path.join(__dirname, "..", "common.js")));
const { relatedBox } = require(path.join(__dirname, "..", "related_box.js"));

const el = (hasRows, parent = null) => ({
  parentElement: parent,
  querySelector: (sel) => (hasRows && sel === "ul li a" ? {} : null),
});

test("사이드바 위젯 발견 — /RecentChanges 앵커에서 UL 행을 가진 조상으로 상승", () => {
  const widget = el(true);
  const mid = el(false, widget);
  const anchors = [
    { pathname: "/RecentChanges", parentElement: mid },      // 상단 메뉴 유사 구조는 행이 없음
  ];
  assert.equal(relatedBox.findWidgetBox(anchors), widget);
});

test("위젯 미발견(행 없는 조상뿐) → null — 조용히 스킵", () => {
  const anchors = [{ pathname: "/RecentChanges", parentElement: el(false, el(false)) }];
  assert.equal(relatedBox.findWidgetBox(anchors), null);
  assert.equal(relatedBox.findWidgetBox([{ pathname: "/w/x", parentElement: el(true) }]), null);
});

test("행 데이터 — 샤드 엔트리 [제목, sim, pct]를 상위 n개 {title, href}로", () => {
  const entries = Array.from({ length: 15 }, (_, i) => [`문서${i}`, 0.9 - i * 0.01, 0.5]);
  const rows = relatedBox.rowData(entries);
  assert.equal(rows.length, 10);                             // 상한 10
  assert.equal(rows[0].title, "문서0");
  assert.equal(rows[0].href, docUrlOf("문서0"));             // [J2] 단일 진실원
  assert.equal(relatedBox.rowData([["C#", 0.9, 0.1]])[0].href, "https://namu.wiki/w/C%23");
  assert.deepEqual(relatedBox.rowData([]), []);
});
