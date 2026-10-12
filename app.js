import { seed } from "./content.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const viewNames = ["home", "existing", "analysis", "proposals", "recommendations"];
const records = structuredClone(seed);
let cloud = null;
let editor = null;
let refreshTimer;
let serverInitialized = false;
let activeFilter = "all";
let pendingCollection = "proposals";
let pendingRecordId = null;
let toastTimer;
let autosaveTimer;
let autosavePromise = Promise.resolve();

function allowed(action) { return !!editor && !editor.mustChangePin && (editor.role === "admin" || editor.permissions?.[action] === true); }
function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function notify(message) {
  const toast = $("#toast"); toast.textContent = message; toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 3300);
}
function recordId(item, prefix = "item") { return String(item.id ?? item.chapter ?? `${prefix}-${crypto.randomUUID()}`).replace(/[^a-zA-Z0-9_-]/g, "-"); }

function studyImage(url, label) {
  if (!url) return "";
  return `<img class="study-photo" src="${escapeHTML(url)}" alt="${escapeHTML(label)}" loading="lazy">`;
}
function proposalImages(item) {
  const additional = (item.additionalPhotos || []).filter(Boolean);
  if (!item.currentPhotoUrl && !item.proposedRenderUrl && !additional.length) return "";
  return `<div class="study-image-grid">
    ${item.currentPhotoUrl ? `<figure>${studyImage(item.currentPhotoUrl, item.title + " · الوضع القائم")}<figcaption>الوضع القائم</figcaption></figure>` : ""}
    ${item.proposedRenderUrl ? `<figure>${studyImage(item.proposedRenderUrl, item.title + " · المقترح")}<figcaption>التصور المقترح</figcaption></figure>` : ""}
    ${additional.map((url, i) => `<figure>${studyImage(url, item.title + " · صورة إضافية " + (i + 1))}<figcaption>صورة داعمة ${i + 1}</figcaption></figure>`).join("")}
  </div>`;
}
function render() {
  $("#metrics").innerHTML = records.metrics.map((m, i) => `<article class="metric-card"><span class="eyebrow">مؤشر 0${i + 1}</span><div class="metric-value">${escapeHTML(m.value)}</div><h3>${escapeHTML(m.title)}</h3><p>${escapeHTML(m.detail)}</p></article>`).join("");
  $("#objectives").innerHTML = records.objectives.map(item => `<li>${escapeHTML(item)}</li>`).join("");
  $("#stages").innerHTML = records.stages.map((s, i) => `<article class="stage-card"><span class="stage-no">0${i + 1}</span><h3>${escapeHTML(s.title)}</h3><p>${escapeHTML(s.text)}</p><time>${escapeHTML(s.date)}</time></article>`).join("");
  $("#study-team").innerHTML = (records.team || []).map(member => `<article class="analysis-card"><h3>${escapeHTML(member.name)}</h3><p>${escapeHTML(member.role || "")}</p><small>${escapeHTML(member.discipline || member.institution || "")}</small></article>`).join("");
  $("#stations").innerHTML = records.stations.map(s => {
    const observations = (records.observations || []).filter(o => String(o.stationId) === String(s.id));
    const detail = [...(s.observations || []), ...(s.criticalIssues || [])].map(line => `<li>${escapeHTML(line)}</li>`).join("");
    return `<article class="station-card"><div class="station-head"><span class="station-index">محطة رصد ${String(s.stationNumber || s.id).padStart(2, "0")}</span><span class="live-dot"></span></div><h3>${escapeHTML(s.title)}</h3>${(allowed("edit") || allowed("delete")) ? `<div class="editor-actions">${allowed("edit") ? `<button class="icon-button" data-edit="stations:${escapeHTML(s.id)}">تعديل</button>` : ""}${allowed("delete") ? `<button class="icon-button" data-delete="stations:${escapeHTML(s.id)}">حذف</button>` : ""}</div>` : ""}${studyImage(s.photoUrl, s.title)}<p>${escapeHTML(s.finding || s.description || "")}</p><div class="station-counts"><span>${escapeHTML(s.notes)} ملاحظات رصد</span><span>${escapeHTML(s.issues)} مشكلات حرجة</span></div>${detail ? `<details><summary>تفاصيل الرصد والتحديات</summary><ul>${detail}</ul><p>${escapeHTML(s.fieldNotes || "")}</p></details>` : ""}${observations.map(o => `<div class="observation"><strong>${escapeHTML(o.title)}</strong><p>${escapeHTML(o.description)}</p>${attachmentLinks(o)}${allowed("delete") ? `<button class="icon-button" data-delete="observations:${escapeHTML(o.id)}">حذف الملاحظة</button>` : ""}</div>`).join("")}</article>`;
  }).join("");
  $("#analyses").innerHTML = records.analyses.map(a => `<article class="analysis-card"><span class="chapter">${escapeHTML(a.chapter)} · فصل تحليلي</span><h3>${escapeHTML(a.title)}</h3><p>${escapeHTML(a.detail || a.description || "")}</p>${(allowed("edit") || allowed("delete")) ? `<div class="editor-actions">${allowed("edit") ? `<button class="icon-button" data-edit="analyses:${escapeHTML(a.id || a.chapter)}">تعديل</button>` : ""}${allowed("delete") ? `<button class="icon-button" data-delete="analyses:${escapeHTML(a.id || a.chapter)}">حذف</button>` : ""}</div>` : ""}</article>`).join("");
  $("#proposals").innerHTML = records.proposals.map(p => `<article class="proposal-card"><span class="category">${escapeHTML(p.category || "مقترح تطويري")}</span><span class="station-index"> · البند ${escapeHTML(p.id)}</span><h3>${escapeHTML(p.title)}</h3><div class="location">${escapeHTML(p.location || "نطاق الدراسة")}</div><p>${escapeHTML(p.description || "")}</p>${proposalImages(p)}${p.challenge ? `<details><summary>التحدي والأثر المتوقع</summary><p><b>التحدي:</b> ${escapeHTML(p.challenge)}</p><p><b>الأثر:</b> ${escapeHTML(p.impact || "")}</p></details>` : ""}${attachmentLinks(p)}${(allowed("edit") || allowed("delete")) ? `<div class="editor-actions">${allowed("edit") ? `<button class="icon-button" data-edit="proposals:${escapeHTML(p.id)}">تعديل</button>` : ""}${allowed("delete") ? `<button class="icon-button" data-delete="proposals:${escapeHTML(p.id)}">حذف</button>` : ""}</div>` : ""}</article>`).join("");
  $("#gallery").innerHTML = (records.gallery || []).map(item => {
    const image = item.attachments?.find(file => file.type?.startsWith("image/"));
    const imageMarkup = image ? `<img src="${escapeHTML(image.url)}" alt="${escapeHTML(item.title)}" loading="lazy">` : `<div class="gallery-visual ${escapeHTML(item.style || "visual-grid")}" role="img" aria-label="تصور توضيحي: ${escapeHTML(item.title)}"></div>`;
    return `<article class="gallery-card">${imageMarkup}<div class="gallery-caption"><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.caption || item.location || "توثيق ميداني · وادي عدي")}</p>${(allowed("edit") || allowed("delete")) ? `<div class="editor-actions">${allowed("edit") ? `<button class="icon-button" data-edit="gallery:${escapeHTML(item.id)}">تعديل</button>` : ""}${allowed("delete") ? `<button class="icon-button" data-delete="gallery:${escapeHTML(item.id)}">حذف</button>` : ""}</div>` : ""}</div></article>`;
  }).join("");
  $("#roadmap").innerHTML = records.roadmap.map(r => `<article class="roadmap-card"><span class="period">${escapeHTML(r.period)}</span><h3>${escapeHTML(r.title)}</h3><ul>${(r.items || []).map(item => `<li>${escapeHTML(item)}</li>`).join("")}</ul>${(allowed("edit") || allowed("delete")) ? `<div class="editor-actions">${allowed("edit") ? `<button class="icon-button" data-edit="roadmap:${escapeHTML(r.id)}">تعديل</button>` : ""}${allowed("delete") ? `<button class="icon-button" data-delete="roadmap:${escapeHTML(r.id)}">حذف</button>` : ""}</div>` : ""}</article>`).join("");
  const recs = records.recommendations.filter(r => activeFilter === "all" || r.priority === activeFilter);
  $("#recommendations").innerHTML = recs.map(r => `<article class="recommendation-card"><div><span class="priority" data-level="${escapeHTML(r.priority)}">${escapeHTML(r.priority)}</span><div class="station-index">البند ${escapeHTML(r.id)}</div></div><div><h3>${escapeHTML(r.title)}</h3><p>${escapeHTML(r.text || r.description || "")}</p>${attachmentLinks(r)}${allowed("edit") ? `<button class="icon-button" data-edit="recommendations:${escapeHTML(r.id)}">تعديل</button>` : ""}${allowed("delete") ? `<button class="icon-button" data-delete="recommendations:${escapeHTML(r.id)}">حذف</button>` : ""}</div></article>`).join("");
  $("#source-maps").innerHTML = (records.maps || []).map(m => `<article class="analysis-card"><span class="chapter">${escapeHTML(m.category)}</span><h3>${escapeHTML(m.title)}</h3><p>${escapeHTML(m.description)}</p><small>${escapeHTML(m.scale || "")}</small></article>`).join("");
  $("#source-cases").innerHTML = (records.problemSolutionCases || []).map(c => `<article class="proposal-card"><h3>${escapeHTML(c.title)}</h3><p>${escapeHTML(c.location)}</p><details><summary>المشكلة والتحليل والحل</summary><p><b>الوضع القائم:</b> ${escapeHTML(c.currentStatus)}</p><p><b>المشكلة:</b> ${escapeHTML(c.problem)}</p><p><b>التحليل:</b> ${escapeHTML(c.analysis)}</p><p><b>الفرصة:</b> ${escapeHTML(c.opportunity)}</p><p><b>الحل المقترح:</b> ${escapeHTML(c.proposedSolution)}</p><p><b>الأثر:</b> ${escapeHTML(c.expectedImpact)}</p></details></article>`).join("");
  const stationSelect = $("#record-form [name=stationId]");
  stationSelect.innerHTML = `<option value="">اختر المحطة عند إضافة ملاحظة</option>${records.stations.map(s => `<option value="${escapeHTML(s.id)}">محطة ${String(s.stationNumber || s.id).padStart(2, "0")} · ${escapeHTML(s.title)}</option>`).join("")}`;
  $$(".editor-only").forEach(el => el.classList.toggle("hidden", !allowed("create")));
  $("#members-open").classList.toggle("hidden", !allowed("manage_members"));
  $("#change-pin-open").classList.toggle("hidden", !editor);
  $("#login-open").classList.toggle("hidden", Boolean(editor)); $("#logout").classList.toggle("hidden", !editor);
  $("#role-label").textContent = editor ? `فريق العمل · ${editor.displayName || editor.username}` : "زائر · اطلاع فقط";
}

function attachmentLinks(item) {
  if (!Array.isArray(item.attachments) || !item.attachments.length) return "";
  return `<div class="attachments">${item.attachments.map(file => `<a href="${escapeHTML(file.url)}" target="_blank" rel="noreferrer">📎 ${escapeHTML(file.name || "مرفق")}</a>`).join("")}</div>`;
}

function setView(name) {
  if (!viewNames.includes(name)) return;
  $$(".view").forEach(el => el.classList.toggle("active", el.id === `view-${name}`));
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.view === name));
  history.replaceState(null, "", `#${name}`); window.scrollTo({ top: 0, behavior: "smooth" });
}

const collectionKeys = ["proposals", "recommendations", "stations", "analyses", "roadmap", "observations", "gallery"];
async function request(path, options = {}) {
  const response = await fetch(`/api/${path}`, { credentials: "same-origin", ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "تعذر الاتصال بالخادم.");
  return result;
}
const jsonOptions = (method, data) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
async function refreshRecords() {
  const data = await request("records");
  serverInitialized = data.initialized;
  if (data.initialized) {
    for (const key of collectionKeys) records[key] = data.records[key] || [];
  }
  render();
}
async function initCloud() {
  try {
    const status = await request("status");
    cloud = true;
    $("#sync-status").innerHTML = status.ready ? "<i></i> متصل · حفظ مباشر" : "<i></i> البيانات ظاهرة · تهيئة الأدمن مطلوبة";
    $("#sync-status").classList.toggle("connected", status.ready);
    await refreshRecords();
    editor = (await request("me")).user;
    render();
    if (editor?.mustChangePin) $("#change-pin-dialog").showModal();
    if (editor && !editor.mustChangePin && !serverInitialized) await seedFromBackup();
    refreshTimer = setInterval(() => refreshRecords().catch(console.error), 15000);
  } catch (error) {
    console.error(error);
    cloud = null;
    $("#sync-status").innerHTML = "<i></i> بيانات النسخة الاحتياطية · الخادم غير متصل";
  }
}
async function seedFromBackup() {
  const data = Object.fromEntries(collectionKeys.filter(key => key !== "observations").map(key => [key, seed[key]]));
  try { await request("seed", jsonOptions("POST", { records: data })); await refreshRecords(); }
  catch (error) { if (!String(error.message).includes("موجودة")) notify(`تعذر استيراد الدراسة: ${error.message}`); }
}
async function writeRecord(collectionKey, item) {
  if (!cloud || !allowed(item._existing ? "edit" : "create")) throw new Error("لا تملك صلاحية حفظ السجل.");
  const { _existing, ...data } = item;
  await request(`records/${collectionKey}/${encodeURIComponent(data.id)}`, jsonOptions("PUT", data));
}
async function deleteRecord(collectionKey, id) {
  if (!allowed("delete")) throw new Error("لا تملك صلاحية الحذف.");
  await request(`records/${collectionKey}/${encodeURIComponent(id)}`, { method: "DELETE" });
  records[collectionKey] = records[collectionKey].filter(item => String(item.id) !== String(id));
  render(); notify("حُذف السجل.");
}
function bind() {
  $$(".nav-item").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  $$('[data-jump]').forEach(button => button.addEventListener("click", () => setView(button.dataset.jump)));
  $("#login-open").addEventListener("click", () => cloud ? $("#auth-dialog").showModal() : notify("الخادم غير متصل بعد."));
  $("#login-close").addEventListener("click", () => $("#auth-dialog").close());
  $("#logout").addEventListener("click", async () => { await request("logout", { method: "POST" }); editor = null; render(); });
  $("#login-form").addEventListener("submit", async event => {
    event.preventDefault(); $("#login-error").textContent = "";
    const form = event.currentTarget;
    try {
      const result = await request("login", jsonOptions("POST", { username: form.elements.username.value, pin: form.elements.pin.value }));
      editor = result.user; form.reset(); $("#auth-dialog").close(); render();
      if (editor.mustChangePin) $("#change-pin-dialog").showModal();
      else if (!serverInitialized) await seedFromBackup();
      notify(`مرحبًا ${editor.displayName}`);
    } catch (error) { $("#login-error").textContent = error.message; }
  });
  $("#change-pin-open").addEventListener("click", () => $("#change-pin-dialog").showModal());
  $("#change-pin-close").addEventListener("click", () => { if (!editor?.mustChangePin) $("#change-pin-dialog").close(); });
  $("#change-pin-form").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget;
    $("#change-pin-error").textContent = "";
    if (form.elements.newPin.value !== form.elements.repeatPin.value) return $("#change-pin-error").textContent = "الرمز الجديد غير متطابق.";
    try {
      await request("change-pin", jsonOptions("POST", { oldPin: form.elements.oldPin.value, newPin: form.elements.newPin.value }));
      editor.mustChangePin = false; form.reset(); $("#change-pin-dialog").close(); render();
      if (!serverInitialized) await seedFromBackup(); notify("تغيّر الرمز بنجاح.");
    } catch (error) { $("#change-pin-error").textContent = error.message; }
  });
  $("#members-open").addEventListener("click", async () => { $("#members-dialog").showModal(); await renderMembers(); });
  $("#members-close").addEventListener("click", () => $("#members-dialog").close());
  $("#member-form").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget; $("#members-error").textContent = "";
    const data = new FormData(form);
    const permissions = Object.fromEntries(["create", "edit", "delete", "upload", "manage_members"].map(key => [key, data.has(key)]));
    try {
      await request("members", jsonOptions("POST", { username: data.get("username"), displayName: data.get("displayName"), pin: "1234", role: data.get("role"), permissions }));
      form.reset(); await renderMembers(); notify("أُضيف العضو برمز أولي 1234. يلزمه تغييره عند الدخول.");
    } catch (error) { $("#members-error").textContent = error.message; }
  });
  $("#members-list").addEventListener("click", async event => {
    const button = event.target.closest("[data-member]"); if (!button) return;
    const row = button.closest("[data-member-row]");
    const permissions = Object.fromEntries(["create", "edit", "delete", "upload", "manage_members"].map(key => [key, row.querySelector(`[name=${key}]`).checked]));
    try {
      await request(`members/${button.dataset.member}`, jsonOptions("PATCH", { role: row.querySelector("[name=role]").value, active: row.querySelector("[name=active]").checked, permissions }));
      await renderMembers(); notify("حُفظت صلاحيات العضو.");
    } catch (error) { $("#members-error").textContent = error.message; }
  });
  $$(".filter").forEach(button => button.addEventListener("click", () => { activeFilter = button.dataset.filter; $$(".filter").forEach(item => item.classList.toggle("active", item === button)); render(); }));
  $("#add-station").addEventListener("click", () => openRecord("stations", "محطة ميدانية"));
  $("#add-analysis").addEventListener("click", () => openRecord("analyses", "تحليل"));
  $("#add-roadmap").addEventListener("click", () => openRecord("roadmap", "مرحلة تنفيذ"));
  $("#add-proposal").addEventListener("click", () => openRecord("proposals", "مقترح معماري"));
  $("#add-recommendation").addEventListener("click", () => openRecord("recommendations", "توصية قطاعية"));
  $("#add-observation").addEventListener("click", () => openRecord("observations", "ملاحظة ميدانية"));
  $("#add-gallery").addEventListener("click", () => openRecord("gallery", "صورة أو مخطط"));
  $("#backup").addEventListener("click", exportBackup);
  $("#compare-slider").addEventListener("input", event => $(".compare-box").style.setProperty("--split", `${event.target.value}%`));
  $("#record-close").addEventListener("click", () => $("#record-dialog").close());
  $("#record-form").addEventListener("submit", submitRecord);
  $("#record-form").addEventListener("input", scheduleAutosave);
  $("#record-form").addEventListener("change", scheduleAutosave);
  document.addEventListener("click", async event => {
    const edit = event.target.closest("[data-edit]");
    if (edit && allowed("edit")) {
      const [key, id] = edit.dataset.edit.split(":");
      const item = records[key].find(entry => String(entry.id) === id);
      if (item) openRecord(key, ({ proposals: "مقترح معماري", recommendations: "توصية قطاعية", stations: "محطة ميدانية", analyses: "تحليل", roadmap: "مرحلة تنفيذ", gallery: "صورة أو مخطط" })[key] || "ملاحظة ميدانية", item);
      return;
    }
    const button = event.target.closest("[data-delete]"); if (!button || !allowed("delete")) return;
    const [key, id] = button.dataset.delete.split(":");
    if (confirm("هل تريد حذف هذا السجل من مساحة وادي عدي؟")) {
      try { await deleteRecord(key, id); } catch (error) { notify(error.message); }
    }
  });
  window.addEventListener("hashchange", () => setView(location.hash.slice(1) || "home"));
  const initial = location.hash.slice(1); if (viewNames.includes(initial)) setView(initial);
}
async function renderMembers() {
  const { members } = await request("members");
  const check = (m, key) => `<label class="inline-check"><input type="checkbox" name="${key}" ${m.permissions?.[key] ? "checked" : ""}>${({ create: "إضافة", edit: "تعديل", delete: "حذف", upload: "رفع", manage_members: "إدارة الأعضاء" })[key]}</label>`;
  $("#members-list").innerHTML = members.map(m => `<div class="member-row" data-member-row><strong>${escapeHTML(m.displayName)}</strong><small>${escapeHTML(m.username)}</small><select name="role"><option value="member" ${m.role === "member" ? "selected" : ""}>عضو</option><option value="admin" ${m.role === "admin" ? "selected" : ""}>أدمن</option></select><div class="permissions">${["create", "edit", "delete", "upload", "manage_members"].map(key => check(m, key)).join("")}</div><label class="inline-check"><input type="checkbox" name="active" ${m.active ? "checked" : ""}>نشط</label><button class="button button-dark" data-member="${escapeHTML(m.id)}">حفظ الصلاحيات</button></div>`).join("");
}
function exportBackup() {
  const payload = { exportedAt: new Date().toISOString(), project: "wadi-adai", data: records };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `wadi-adai-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  notify("تم تنزيل نسخة احتياطية من البيانات المعروضة.");
}
function openRecord(key, label, item = null) {
  if (!allowed(item ? "edit" : "create")) return notify("لا تملك صلاحية هذه العملية.");
  if (!cloud) return notify("الخادم غير متصل.");
  clearTimeout(autosaveTimer); pendingCollection = key; pendingRecordId = item?.id ?? null;
  $("#draft-status").textContent = "";
  $("#record-kicker").textContent = label;
  $("#record-title").textContent = `${item ? "تعديل" : "إضافة"} ${label}`;
  const form = $("#record-form"); form.reset();
  if (item) {
    form.elements.title.value = item.title || "";
    form.elements.category.value = item.category || "";
    form.elements.location.value = item.caption || item.location || "";
    form.elements.priority.value = item.priority || "";
    form.elements.stationId.value = item.stationId || "";
    form.elements.description.value = item.description || item.text || item.finding || item.detail || (item.items || []).join("\n") || "";
    form.elements.challenge.value = item.challenge || "";
    form.elements.impact.value = item.impact || "";
  }
  form.elements.attachments.disabled = !allowed("upload");
  $("#record-dialog").showModal();
}
function formItem(form, key = pendingCollection, id = pendingRecordId) {
  const data = new FormData(form), recordId = id || `${key}-${crypto.randomUUID()}`;
  const existing = records[key].find(entry => String(entry.id) === String(recordId));
  const item = { ...existing, id: recordId, title: String(data.get("title") || "").trim(),
    category: String(data.get("category") || "").trim(), location: String(data.get("location") || "").trim(),
    description: String(data.get("description") || "").trim(), priority: String(data.get("priority") || "متوسط المدى").trim(),
    challenge: String(data.get("challenge") || "").trim(), impact: String(data.get("impact") || "").trim(),
    stationId: String(data.get("stationId") || "").trim(), createdAt: existing?.createdAt || new Date().toISOString(),
    _existing: !!existing };
  if (key === "stations") item.finding = item.description;
  if (key === "analyses") item.detail = item.description;
  if (key === "roadmap") { item.period = item.location; item.items = item.description.split("\n").map(x => x.trim()).filter(Boolean); }
  if (key === "gallery") item.caption = item.location;
  if (key === "recommendations") item.text = item.description;
  return item;
}
function upsertLocal(key, item) {
  const existing = records[key].some(entry => String(entry.id) === String(item.id));
  records[key] = existing ? records[key].map(entry => String(entry.id) === String(item.id) ? item : entry) : [...records[key], item];
  render();
}
function scheduleAutosave() {
  clearTimeout(autosaveTimer); const form = $("#record-form");
  if (!cloud || !allowed("edit") || !allowed(pendingRecordId ? "edit" : "create") || !form.elements.title.value.trim() || !form.elements.description.value.trim()) return;
  $("#draft-status").textContent = "جارٍ الحفظ التلقائي…";
  autosaveTimer = setTimeout(() => {
    const key = pendingCollection, item = formItem(form, key); pendingRecordId = item.id;
    autosavePromise = writeRecord(key, item).then(() => { delete item._existing; upsertLocal(key, item); $("#draft-status").textContent = "حُفظ النص تلقائيًا · الملفات تُرفع عند الضغط على حفظ"; })
      .catch(error => { $("#draft-status").textContent = `تعذر الحفظ: ${error.message}`; });
  }, 900);
}
async function submitRecord(event) {
  event.preventDefault(); clearTimeout(autosaveTimer); await autosavePromise;
  const key = pendingCollection, item = formItem(event.currentTarget, key); pendingRecordId = item.id;
  try {
    const files = [...event.currentTarget.elements.attachments.files];
    if (files.length && !allowed("upload")) throw new Error("لا تملك صلاحية رفع الملفات.");
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) throw new Error("الملف أكبر من 10 ميجابايت.");
      const result = await request("uploads", { method: "POST", headers: { "content-type": file.type, "x-file-name": encodeURIComponent(file.name) }, body: file });
      item.attachments = [...(item.attachments || []), result.file];
    }
    await writeRecord(key, item); delete item._existing; upsertLocal(key, item);
    $("#record-dialog").close(); event.currentTarget.reset(); pendingRecordId = null;
    $("#draft-status").textContent = ""; notify("حُفظ السجل والملفات.");
  } catch (error) { notify(`لم يُحفظ السجل: ${error.message}`); }
}
bind(); render(); initCloud();
