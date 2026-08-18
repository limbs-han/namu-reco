// popup.js — §4.7 [J8]: recommendations 전 행을 rank 순으로 표시. 표시·클릭 이상 기능 없음(§0).
(async () => {
  // [UX-A3] 렌더 시점 정화 + [E24-M1] 방금 떠난 문서·열람 중 문서 제외 — sw 경로와 같은 관문.
  // (현재 탭 문서 제외는 없음 — 팝업은 새 탭 의미론, tabs 권한 미보유)
  const fetchRows = () => db.txn(["recommendations", "events"], "readonly", async (tx) =>
    presentableRows(await tx.getAll("recommendations"),
      pendingViewTitles(await tx.indexGetAll("events", "processed", IDBKeyRange.only(0)),
                        Date.now())));

  // [G3] 뮤트·해제는 sw 경유(kv 갱신 + 즉시 재계산) — 완료 응답 후 목록·해제 UI 재렌더
  const sendAndRefresh = (type, title) =>
    chrome.runtime.sendMessage({ type, title }, async () => {
      if (chrome.runtime.lastError) return;
      renderList(await fetchRows());
      renderMuted();
    });

  const renderList = (rows) => {
    const list = document.getElementById("list");
    list.replaceChildren();
    document.getElementById("empty").hidden = !!rows.length;   // 설치 직후 첫 알람 전 등
    // [G1·B3] 출처별 섹션 — 사유는 그룹 헤더 1회(reasonText 단일 진실원 [J8]),
    // 행은 문서 글리프+제목 (드롭다운과 시각 언어 통일, 번호 제거)
    for (const g of groupRows(rows)) {
      if (g.header) {
        const h = document.createElement("div");
        h.className = "ghead";
        const label = document.createElement("span");
        label.textContent = g.header;
        h.append(label);
        if (g.topic) {                             // [G3] 병합·인기 섹션(topic null)엔 미표시
          const mute = document.createElement("button");
          mute.textContent = "−";
          mute.title = "이 주제 관심 없음 — 관련 문서를 다시 읽을 때까지 추천에서 제외";
          mute.addEventListener("click", () => sendAndRefresh("mute_topic", g.topic));
          h.append(mute);
        }
        list.append(h);
      }
      const ul = document.createElement("ul");
      for (const r of g.rows) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        const ih = document.createElement("span");
        ih.innerHTML = DOC_GLYPH;                  // currentColor — 링크색 상속
        const icon = ih.firstChild;
        icon.setAttribute("width", "14");
        icon.setAttribute("height", "14");
        a.append(icon, document.createTextNode(r.title));
        // [J2] chrome.tabs.create는 무권한 API — URL 조립은 반드시 common.js docUrlOf
        a.addEventListener("click", () => chrome.tabs.create({ url: docUrlOf(r.title) }));
        li.append(a);
        ul.append(li);
      }
      list.append(ul);
    }
  };

  // [G3] 관심 없음 처리한 주제 — kv 직독(팝업은 확장 origin), 해제는 sw 경유
  const renderMuted = async () => {
    const groups = (await db.txn(["kv"], "readonly", (tx) => tx.get("kv", "muted")))?.value || [];
    const box = document.getElementById("muted");
    const ul = document.getElementById("muted-rows");
    box.hidden = !groups.length;
    ul.replaceChildren();
    for (const g of groups) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = g.members.length > 1
        ? `「${g.members[0]}」 외 ${g.members.length - 1}건` : `「${g.members[0]}」`;
      const undo = document.createElement("button");
      undo.textContent = "해제";
      undo.addEventListener("click", () => sendAndRefresh("unmute_topic", g.members[0]));
      li.append(label, undo);
      ul.append(li);
    }
  };

  renderList(await fetchRows());
  renderMuted();

  // [§7] 디버그 — profile 직독 (dwell 경계 실측용, SW 무경유. 팝업은 확장 origin)
  const prof = await db.txn(["profile"], "readonly", (tx) => tx.getAll("profile"));
  prof.sort((a, b) => (b.dwell_ms_total || 0) - (a.dwell_ms_total || 0));
  const dbg = document.getElementById("debug-rows");
  for (const p of prof) {
    const li = document.createElement("li");
    li.textContent = `${p.title} — ${fmtDwell(p.dwell_ms_total || 0)}` +
      ((p.dwell_ms_total || 0) >= LONG_READ_MS ? " · 오래 읽음" : "");
    dbg.append(li);
  }
})();
