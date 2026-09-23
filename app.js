// app.js
/*
 * Escuta Ativa da Leitura - SME Santa Rita do Araguaia/GO
 * 1) Crie um projeto Firebase, habilite Authentication (E-mail/Senha) e Firestore.
 * 2) Substitua firebaseConfig abaixo.
 * 3) Cadastre usuários no Auth e crie users/{uid} manualmente (console) com role, schoolId, active.
 * 4) Publique estas REGRAS do Firestore (segurança real no servidor):
 *
 * rules_version = '2';
 * service cloud.firestore {
 *   match /databases/{db}/documents {
 *     function me() { return get(/databases/$(db)/documents/users/$(request.auth.uid)).data; }
 *     function ok() { return request.auth != null && me().active == true; }
 *     function role(r) { return ok() && me().role == r; }
 *     function sameSchool(s) { return me().schoolId == s; }
 *     match /users/{uid} {
 *       allow read: if request.auth != null && (request.auth.uid == uid || role('tecnico_sme'));
 *       allow write: if role('tecnico_sme');
 *     }
 *     match /avaliacoes/{id} {
 *       allow read: if role('tecnico_sme')
 *         || ((role('coordenador') || role('gestor')) && sameSchool(resource.data.schoolId))
 *         || (role('professor') && resource.data.createdBy == request.auth.uid);
 *       allow create: if (role('professor') || role('coordenador') || role('tecnico_sme'))
 *         && request.resource.data.createdBy == request.auth.uid
 *         && (role('tecnico_sme') || request.resource.data.schoolId == me().schoolId);
 *       allow update: if (role('tecnico_sme')
 *         || (role('coordenador') && sameSchool(resource.data.schoolId))
 *         || (role('professor') && resource.data.createdBy == request.auth.uid))
 *         && request.resource.data.createdBy == resource.data.createdBy
 *         && request.resource.data.schoolId == resource.data.schoolId;
 *       allow delete: if role('tecnico_sme');
 *     }
 *   }
 * }
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, collection, query, where, limit, onSnapshot, addDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "SUA_API_KEY",
  authDomain: "SEU_PROJETO.firebaseapp.com",
  projectId: "SEU_PROJETO",
  storageBucket: "SEU_PROJETO.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  console.warn("Persistência offline indisponível:", e);
  db = initializeFirestore(app, {});
}

/* ---------- Dados pedagógicos ---------- */
const LEITURA = [
  [1, "Estágio 1: Não leitor"],
  [2, "Estágio 2: Nomeou letras / soletrou"],
  [3, "Estágio 3: Leu palavras silabadas"],
  [4, "Estágio 4: Leu corretamente sem respeitar os elementos prosódicos"],
  [5, "Estágio 5: Leu corretamente, sem fluência"],
  [6, "Estágio 6: Leu corretamente, atribuiu sentido ao texto, fluente"]
];
const ESCRITA = ["Pré-silábico", "Silábico sem valor", "Silábico com valor", "Silábico-alfabético", "Alfabético"];
const SINTESE = { 1: "Não leitor", 2: "Leitor silábico/iniciante", 3: "Leitor sem fluência", 4: "Leitor fluente" };
const sintOf = (e) => (e == 1 ? 1 : e <= 3 ? 2 : e <= 5 ? 3 : 4);
const ROLES = { professor: "Professor", coordenador: "Coordenador pedagógico", gestor: "Gestor", tecnico_sme: "Técnico SME" };
const CAN_WRITE = ["professor", "coordenador", "tecnico_sme"];

const INT_INICIANTE = ["Oficinas de consciência fonológica", "Jogos de rima e aliteração", "Leitura compartilhada diária", "Cantinho da leitura estruturado", "Atendimento em pequenos grupos", "Atendimento individualizado"];
const INT_FLUENCIA = ["Leitura dramática", "Leitura emparelhada", "Análise de pistas contextuais", "Ampliação de repertório vocabular"];

function sugestoes(estagio, ano) {
  if (!estagio) return [];
  const e = +estagio, a = +ano || 0;
  const s = [];
  if (e <= 3) s.push(...INT_INICIANTE);
  else if (e <= 5) s.push(...INT_FLUENCIA);
  else s.push("Ampliação de repertório vocabular", "Leitura dramática");
  s.push("Agrupamentos produtivos");
  if (a >= 3 && e <= 4) s.push("Tutoria pedagógica (defasagem de alfabetização – 3º ao 5º ano)");
  return [...new Set(s)];
}

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 3500); }
function authErr(code) {
  return ({ "auth/invalid-credential": "E-mail ou senha incorretos.", "auth/invalid-email": "E-mail inválido.", "auth/too-many-requests": "Muitas tentativas. Aguarde.", "auth/network-request-failed": "Sem conexão." })[code] || "Não foi possível entrar.";
}

/* ---------- Estado ---------- */
let profile = null, uid = null, registros = [], unsub = null, atual = null;

/* ---------- Rede ---------- */
function net() { const b = $("netStatus"); const on = navigator.onLine; b.textContent = on ? "Online" : "Offline – dados serão sincronizados"; b.classList.toggle("off", !on); }
addEventListener("online", () => { net(); toast("Conexão restabelecida. Sincronizando…"); });
addEventListener("offline", net); net();

/* ---------- Instalação ---------- */
let deferred = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; $("btnInstall").hidden = false; });
$("btnInstall").onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("btnInstall").hidden = true; };
addEventListener("appinstalled", () => { $("btnInstall").hidden = true; toast("Aplicativo instalado!"); });
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
if (isIOS && !standalone && !localStorage.getItem("iosHintOff")) $("iosHint").hidden = false;
$("iosClose").onclick = () => { $("iosHint").hidden = true; localStorage.setItem("iosHintOff", "1"); };

/* ---------- Auth ---------- */
$("formLogin").onsubmit = async (e) => {
  e.preventDefault();
  const m = $("loginMsg"); m.className = "msg"; m.textContent = "Entrando…";
  try { await signInWithEmailAndPassword(auth, $("loginEmail").value.trim(), $("loginPass").value); m.textContent = ""; }
  catch (err) { m.className = "msg err"; m.textContent = authErr(err.code); }
};
$("btnReset").onclick = async () => {
  const em = $("loginEmail").value.trim(), m = $("loginMsg");
  if (!em) { m.className = "msg err"; m.textContent = "Informe o e-mail."; return; }
  try { await sendPasswordResetEmail(auth, em); m.className = "msg ok"; m.textContent = "Enviamos um link de redefinição."; }
  catch (err) { m.className = "msg err"; m.textContent = authErr(err.code); }
};
$("btnLogout").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  if (unsub) { unsub(); unsub = null; }
  if (!user) { profile = null; show(false); return; }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists() || snap.data().active !== true || !ROLES[snap.data().role]) {
      await signOut(auth);
      $("loginMsg").className = "msg err";
      $("loginMsg").textContent = "Perfil inexistente ou inativo. Procure a SME.";
      return;
    }
    uid = user.uid; profile = snap.data();
    show(true); subscribe();
  } catch (err) {
    console.error(err); await signOut(auth);
    $("loginMsg").className = "msg err"; $("loginMsg").textContent = "Erro ao carregar perfil.";
  }
});

function show(logged) {
  $("viewLogin").hidden = logged; $("viewApp").hidden = !logged; $("btnLogout").hidden = !logged;
  if (!logged) return;
  $("uName").textContent = profile.name || profile.email;
  $("uRole").textContent = ROLES[profile.role];
  $("uSchool").textContent = profile.role === "tecnico_sme" ? "Rede municipal" : (profile.schoolName || "");
  const w = CAN_WRITE.includes(profile.role);
  $("tabNova").hidden = !w;
  $("dlgEdit").hidden = !w;
  tab("painel");
}

/* ---------- Dados ---------- */
function subscribe() {
  const col = collection(db, "avaliacoes");
  let q;
  if (profile.role === "professor") q = query(col, where("createdBy", "==", uid), limit(1000));
  else if (profile.role === "tecnico_sme") q = query(col, limit(3000));
  else q = query(col, where("schoolId", "==", profile.schoolId), limit(2000));
  unsub = onSnapshot(q, { includeMetadataChanges: true }, (s) => {
    registros = s.docs.map((d) => ({ id: d.id, _pend: d.metadata.hasPendingWrites, ...d.data() }))
      .sort((a, b) => (b.data || "").localeCompare(a.data || ""));
    renderPainel(); renderLista();
  }, (err) => { console.error(err); toast("Erro ao carregar registros (permissão ou conexão)."); });
}

/* ---------- Abas ---------- */
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
function tab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "tab-" + name));
}

/* ---------- Painel ---------- */
["fBimPainel", "fAnoPainel"].forEach((id) => ($(id).onchange = renderPainel));
function renderPainel() {
  const b = $("fBimPainel").value, a = $("fAnoPainel").value;
  const r = registros.filter((x) => (!b || x.bimestre == b) && (!a || x.ano == a));
  const cnt = { 1: 0, 2: 0, 3: 0, 4: 0 };
  r.forEach((x) => x.leitura && cnt[sintOf(x.leitura)]++);
  $("kpis").innerHTML = `<div class="kpi">Avaliações<b>${r.length}</b></div>` +
    [1, 2, 3, 4].map((k) => `<div class="kpi" style="border-left-color:var(--s${k})">${SINTESE[k]}<b>${cnt[k]}</b></div>`).join("");
  const bars = (labels, fn) => {
    const tot = r.length || 1;
    return labels.map((l, i) => { const n = r.filter((x) => fn(x, i)).length; const p = Math.round((n / tot) * 100);
      return `<div class="bar" role="img" aria-label="${esc(l)}: ${n} (${p}%)"><span>${esc(l)}</span><i style="width:${p}%"></i><span>${n}</span></div>`; }).join("");
  };
  $("chartLeitura").innerHTML = bars(LEITURA.map((l) => l[1]), (x, i) => x.leitura == i + 1);
  $("chartEscrita").innerHTML = bars(ESCRITA, (x, i) => x.escrita === ESCRITA[i]);
}

/* ---------- Formulário ---------- */
$("radLeitura").innerHTML = LEITURA.map(([v, t]) => `<label><input type="radio" name="leitura" value="${v}" required> ${esc(t)}</label>`).join("");
$("radEscrita").innerHTML = ESCRITA.map((t) => `<label><input type="radio" name="escrita" value="${esc(t)}" required> ${esc(t)}</label>`).join("");

const FIELDS = ["aluno", "ano", "turma", "bimestre", "regente", "textoUsado", "obsDecod", "obsRitmo", "obsEnton", "obsPausas", "obsPrec", "obsComp",
  "eGrafo", "eSeg", "eOrto", "eEstr", "eDitPal", "eDitFra", "eProd", "intervencao", "devolutiva"];
const radio = (n) => document.querySelector(`input[name="${n}"]:checked`)?.value || "";
const setRadio = (n, v) => document.querySelectorAll(`input[name="${n}"]`).forEach((i) => (i.checked = i.value == v));

let autoText = ""; // último texto gerado automaticamente
function atualizaSugestoes() {
  const e = radio("leitura"), a = $("ano").value;
  document.querySelectorAll(".sint-row span").forEach((s) => s.classList.toggle("on", e && s.dataset.s == sintOf(+e)));
  const list = sugestoes(e, a);
  $("sugBox").innerHTML = list.length ? `<strong>Sugestões para ${esc(SINTESE[sintOf(+e)])}:</strong><ul>${list.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : "";
  const ta = $("intervencao"), txt = list.map((s) => "• " + s).join("\n");
  // Só preenche se vazio ou se ainda contém exatamente o texto automático anterior (não editado)
  if (list.length && (ta.value.trim() === "" || ta.value === autoText)) { ta.value = txt; autoText = txt; }
}
$("radLeitura").addEventListener("change", atualizaSugestoes);
$("ano").addEventListener("change", atualizaSugestoes);
$("btnAddSug").onclick = () => {
  const ta = $("intervencao"), list = sugestoes(radio("leitura"), $("ano").value);
  if (!list.length) return toast("Selecione o estágio de leitura.");
  const novos = list.filter((s) => !ta.value.includes(s));
  if (!novos.length) return toast("Todas as sugestões já constam no texto.");
  ta.value = (ta.value.trim() ? ta.value.replace(/\s+$/, "") + "\n" : "") + novos.map((s) => "• " + s).join("\n");
  autoText = ""; ta.focus();
};

function limpaForm() {
  $("formAval").reset(); $("avalId").value = ""; autoText = ""; atual = null;
  $("dataAval").value = new Date().toLocaleDateString("sv-SE");
  $("formTitle").textContent = "Nova avaliação"; $("formMsg").textContent = "";
  atualizaSugestoes();
}
$("btnCancel").onclick = limpaForm;
limpaForm();

$("formAval").onsubmit = async (e) => {
  e.preventDefault();
  const m = $("formMsg"); m.className = "msg";
  if (!CAN_WRITE.includes(profile?.role)) { m.className = "msg err"; m.textContent = "Seu perfil não permite registrar."; return; }
  const miss = [];
  if (!$("aluno").value.trim()) miss.push("nome"); if (!$("ano").value) miss.push("ano");
  if (!$("bimestre").value) miss.push("bimestre"); if (!$("dataAval").value) miss.push("data");
  if (!radio("leitura")) miss.push("estágio de leitura"); if (!radio("escrita")) miss.push("hipótese de escrita");
  if (miss.length) { m.className = "msg err"; m.textContent = "Preencha: " + miss.join(", ") + "."; return; }

  const d = {};
  FIELDS.forEach((f) => (d[f] = $(f).value.trim()));
  d.ano = +d.ano; d.bimestre = +d.bimestre; d.data = $("dataAval").value;
  d.leitura = +radio("leitura"); d.escrita = radio("escrita"); d.sintese = SINTESE[sintOf(d.leitura)];
  d.devEntregue = $("devEntregue").checked;
  d.updatedAt = serverTimestamp(); d.updatedBy = uid;

  const id = $("avalId").value;
  try {
    const p = id
      ? updateDoc(doc(db, "avaliacoes", id), { ...d, createdBy: atual.createdBy, schoolId: atual.schoolId })
      : addDoc(collection(db, "avaliacoes"), { ...d, createdBy: uid, createdByName: profile.name || "", schoolId: profile.schoolId || "", schoolName: profile.schoolName || "", createdAt: serverTimestamp() });
    // Offline: a promessa só resolve ao sincronizar; o cache local já contém o registro.
    if (!navigator.onLine) { toast("Salvo no dispositivo. Será sincronizado ao reconectar."); p.catch((er) => toast("Falha ao sincronizar: " + er.code)); }
    else await p;
    m.className = "msg ok"; m.textContent = "Avaliação salva.";
    toast("Avaliação salva com sucesso."); limpaForm(); tab("lista");
  } catch (err) { console.error(err); m.className = "msg err"; m.textContent = "Erro ao salvar (" + (err.code || "desconhecido") + ")."; }
};

function editar(r) {
  limpaForm(); atual = r;
  $("avalId").value = r.id; $("formTitle").textContent = "Editar avaliação";
  FIELDS.forEach((f) => ($(f).value = r[f] ?? ""));
  $("dataAval").value = r.data || ""; setRadio("leitura", r.leitura); setRadio("escrita", r.escrita);
  $("devEntregue").checked = !!r.devEntregue;
  autoText = ""; atualizaSugestoes(); // intervenção existente é preservada
  tab("nova"); $("aluno").focus();
}

/* ---------- Lista ---------- */
["fBusca", "fBim", "fAno", "fEst"].forEach((id) => ($(id).oninput = renderLista));
function filtrados() {
  const t = $("fBusca").value.toLowerCase().trim(), b = $("fBim").value, a = $("fAno").value, s = $("fEst").value;
  return registros.filter((x) => (!t || (x.aluno || "").toLowerCase().includes(t)) && (!b || x.bimestre == b) && (!a || x.ano == a) && (!s || x.leitura == s));
}
function renderLista() {
  const r = filtrados();
  $("countList").textContent = `${r.length} registro(s)`;
  $("lista").innerHTML = r.map((x) => `<li class="item" tabindex="0" role="button" data-id="${x.id}" data-s="${sintOf(x.leitura)}">
    <div><strong>${esc(x.aluno)}</strong><div class="muted small">${x.ano}º ano ${esc(x.turma)} · ${x.bimestre}º bim · ${esc(x.data)}${profile.role !== "professor" ? " · " + esc(x.createdByName) : ""}</div>
    ${x._pend ? '<span class="pend">⏳ Aguardando sincronização</span>' : ""}</div>
    <div class="small" style="text-align:right">E${x.leitura}<br>${esc(x.escrita)}${x.devEntregue ? "<br>✅ Devolutiva" : ""}</div></li>`).join("") || '<li class="muted">Nenhum registro.</li>';
}
const abrirItem = (el) => { const r = registros.find((x) => x.id === el.dataset.id); if (r) detalhe(r); };
$("lista").addEventListener("click", (e) => { const li = e.target.closest(".item"); if (li) abrirItem(li); });
$("lista").addEventListener("keydown", (e) => { const li = e.target.closest(".item"); if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); abrirItem(li); } });

/* ---------- Detalhe ---------- */
const LABELS = { turma: "Turma", regente: "Professor(a) regente", textoUsado: "Texto utilizado", obsDecod: "Decodificação", obsRitmo: "Ritmo", obsEnton: "Entonação", obsPausas: "Pausas", obsPrec: "Precisão", obsComp: "Compreensão", eGrafo: "Relação grafofonêmica", eSeg: "Segmentação", eOrto: "Ortografia", eEstr: "Estrutura textual", eDitPal: "Ditado de palavras", eDitFra: "Ditado de frases", eProd: "Produção textual adaptada", intervencao: "Intervenções", devolutiva: "Devolutiva" };
function detalhe(r) {
  atual = r;
  $("dlgTitle").textContent = r.aluno;
  const rows = [["Escola", r.schoolName], ["Ano/Bimestre/Data", `${r.ano}º ano · ${r.bimestre}º bim · ${r.data}`],
    ["Leitura", LEITURA[r.leitura - 1]?.[1]], ["Síntese", r.sintese], ["Escrita", r.escrita],
    ...Object.entries(LABELS).map(([k, l]) => [l, r[k]]), ["Devolutiva realizada", r.devEntregue ? "Sim" : "Não"]];
  $("dlgContent").innerHTML = "<dl>" + rows.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") + "</dl>";
  $("dlg").showModal();
}
$("dlgClose").onclick = () => $("dlg").close();
$("dlgPrint").onclick = () => print();
$("dlgEdit").onclick = () => { $("dlg").close(); editar(atual); };

/* ---------- CSV ---------- */
$("btnCsv").onclick = () => {
  const cols = ["schoolName", "aluno", "ano", "turma", "bimestre", "data", "leitura", "sintese", "escrita", ...Object.keys(LABELS), "devEntregue", "createdByName"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "\ufeff" + [cols.join(";"), ...filtrados().map((r) => cols.map((c) => q(r[c])).join(";"))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `escuta-ativa-${new Date().toLocaleDateString("sv-SE")}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
