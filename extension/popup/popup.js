// popup.js — §4.7 [J8]: recommendations 전 행을 rank 순으로 표시. 표시·클릭 이상 기능 없음(§0).
(async () => {
  const rows = await db.txn(["recommendations"], "readonly", (tx) => tx.getAll("recommendations"));
  rows.sort((a, b) => a.rank - b.rank);

  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  if (!rows.length) {                 // 설치 직후 첫 알람 전 등
    empty.hidden = false;
    return;
  }
  for (const r of rows) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = r.title;
    // [J2] chrome.tabs.create는 무권한 API — URL 조립은 반드시 common.js docUrlOf
    a.addEventListener("click", () => chrome.tabs.create({ url: docUrlOf(r.title) }));
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = reasonText(r);  // §4.7 [J8] 단일 진실원 — common.js
    li.append(a, why);
    list.append(li);
  }
})();
