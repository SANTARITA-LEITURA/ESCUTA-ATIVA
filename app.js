import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, collection, query, where, limit, onSnapshot, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Configuração (cole a do seu projeto) ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyAySEZ4ABzBeOiXGWQdCPI5uF3NC-n6Clg",
  authDomain: "leitura-d9970.firebaseapp.com",
  projectId: "leitura-d9970",
  storageBucket: "leitura-d9970.firebasestorage.app",
  messagingSenderId: "893950828903",
  appId: "G-XF1CC2BQ0W"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Instância secundária: cria contas sem deslogar o técnico
const authSec = getAuth(initializeApp(firebaseConfig, "cadastro"));
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* ---------- Utilidades e constantes ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const fmtData = (d) => (d ? d.split("-").reverse().join("/") : "");

const ROLES = { professor: "Professor", coordenador: "Coordenador", gestor: "Gestor", tecnico_sme: "Técnico SME" };
const LEITURA = ["", "Não leitor", "Leitor de sílabas", "Leitor de palavras", "Leitor de frases",
  "Leitor de texto sem fluência", "Leitor de texto com fluência"];
const ESCRITA = ["Pré-silábico", "Silábico sem valor", "Silábico com valor", "Silábico-alfabético", "Alfabético"];

let uid = null, profile = null;
let avals = [], unsub = null;
let users = [], unsubUsers = null;

function toast(t) {
  const el = $("toast"); el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 3500);
}

$("aLeitura").innerHTML = '<option value="">Selecione</option>' +
  LEITURA.slice(1).map((l, i) => `<option value="${i + 1}">${i + 1} – ${l}</option>`).join("");
$("aEscrita").innerHTML = '<option value="">Selecione</option>' +
  ESCRITA.map((e) => `<option>${e}</option>`).join("");

/* ---------- Conexão ---------- */
function net() {
  const on = navigator.onLine;
  $("netStatus").textContent = on ? "Online" : "Offline";
  $("netStatus").className = "chip " + (on ? "ok" : "warn");
}
addEventListener("online", net); addEventListener("offline", net); net();

/* ---------- Abas ---------- */
function tab(n) {
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === n));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "tab-" + n));
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));

/* ---------- Login ---------- */
$("formLogin").onsubmit = async (e) => {
  e.preventDefault();
  const m = $("loginMsg"); m.className = "msg"; m.textContent = "Entrando…";
  try {
    await signInWithEmailAndPassword(auth, $("lEmail").value.trim(), $("lSenha").value);
    m.textContent = "";
  } catch (err) {
    m.className = "msg err";
    m.textContent = err.code === "auth/network-request-failed" ? "Sem conexão." : "E-mail ou senha inválidos.";
  }
};

$("btnEsqueci").onclick = async () => {
  const em = $("lEmail").value.trim(), m = $("loginMsg");
  if (!em) { m.className = "msg err"; m.textContent = "Informe o e-mail."; return; }
  try {
    await sendPasswordResetEmail(auth, em);
    m.className = "msg ok"; m.textContent = "Se o e-mail estiver cadastrado, você receberá o link.";
  } catch { m.className = "msg err"; m.textContent = "Não foi possível enviar o link."; }
};

$("btnSair").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  if (unsub) { unsub(); unsub = null; }
  if (unsubUsers) { unsubUsers(); unsubUsers = null; }
  avals = []; users = [];
  if (!user) { uid = null; profile = null; show(false); return; }
  const m = $("loginMsg");
  try {
    const s = await getDoc(doc(db, "users", user.uid));
    if (!s.exists() || s.data().active !== true) {
      await signOut(auth);
      m.className = "msg err";
      m.textContent = s.exists() ? "Usuário desativado. Procure a SME." : "Perfil não encontrado. Procure a SME.";
      return;
    }
    uid = user.uid; profile = s.data();
    show(true); subscribe();
    if (profile.role === "tecnico_sme") subscribeUsers();
  } catch (err) {
    console.error(err); await signOut(auth);
    m.className = "msg err"; m.textContent = "Erro ao carregar perfil.";
  }
});

function show(on) {
  $("login").hidden = on; $("app").hidden = !on;
  if (!on) return;
  $("userInfo").textContent = `${profile.name || ""} · ${ROLES[profile.role] || profile.role} · ${profile.schoolName || ""}`;
  $("tabAval").hidden = profile.role === "gestor";
  $("wrapEscola").hidden = profile.role !== "tecnico_sme";
  $("tabUsers").hidden = profile.role !== "tecnico_sme";
  limpaAval();
  tab("painel");
}

/* ---------- Avaliações ---------- */
function subscribe() {
  const c = collection(db, "avaliacoes");
  const q = profile.role === "tecnico_sme" ? query(c, limit(3000))
    : profile.role === "professor" ? query(c, where("createdBy", "==", uid), limit(3000))
    : query(c, where("schoolId", "==", profile.schoolId), limit(3000));
  unsub = onSnapshot(q, (s) => {
    avals = s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.data || "").localeCompare(a.data || ""));
    renderAval();
  }, (err) => { console.error(err); toast("Erro ao carregar avaliações."); });
}

const canEdit = (a) => profile.role === "tecnico_sme"
  || (profile.role === "coordenador" && a.schoolId === profile.schoolId)
  || (profile.role === "professor" && a.createdBy === uid);

["fBusca", "fAno", "fBim", "fDev"].forEach((i) => ($(i).oninput = renderAval));

function renderAval() {
  const t = $("fBusca").value.toLowerCase().trim(), an = $("fAno").value, bi = $("fBim").value, dv = $("fDev").value;
  const list = avals.filter((a) =>
    (!t || (a.aluno || "").toLowerCase().includes(t) || (a.schoolName || "").toLowerCase().includes(t)) &&
    (!an || a.ano == an) && (!bi || a.bimestre == bi) &&
    (!dv || (dv === "ok") === !!a.devEntregue));
  const n = list.length, pct = (x) => (n ? Math.round((x * 100) / n) + "%" : "-");
  const alf = list.filter((a) => a.escrita === "Alfabético").length;
  const flu = list.filter((a) => a.leitura >= 5).length;
  const pend = list.filter((a) => !a.devEntregue).length;

  $("stats").innerHTML = [["Avaliações", n], ["Escrita alfabética", pct(alf)],
    ["Leitura de texto (5–6)", pct(flu)], ["Devolutivas pendentes", pend]]
    .map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join("");

  $("barras").innerHTML = "<h2>Hipóteses de escrita</h2>" + ESCRITA.map((e) => {
    const c = list.filter((a) => a.escrita === e).length;
    return `<div class="bar"><span>${e}</span><div><i style="width:${n ? (c * 100) / n : 0}%"></i></div><b>${c}</b></div>`;
  }).join("");

  $("countAval").textContent = `${n} avaliação(ões)`;
  $("listaAval").innerHTML = list.map((a) => `<li class="item ${a.devEntregue ? "" : "pend"}" data-id="${esc(a.id)}" ${canEdit(a) ? 'tabindex="0"' : ""}>
    <div><strong>${esc(a.aluno)}</strong> <span class="chip">${a.ano}º ano · ${a.bimestre}º bim</span>
      <div class="muted small">${esc(fmtData(a.data))} · ${esc(a.schoolName || "")}${a.profName ? " · " + esc(a.profName) : ""}</div>
      <div class="small">Leitura: ${a.leitura} – ${esc(LEITURA[a.leitura] || "")} · Escrita: ${esc(a.escrita)}</div></div>
    <span class="small">${a.devEntregue ? "✅ Devolutiva" : "⏳ Pendente"}</span></li>`).join("")
    || '<li class="muted">Nenhuma avaliação.</li>';
}

function abrirAval(e) {
  const li = e.target.closest(".item[tabindex]"); if (!li) return;
  const a = avals.find((x) => x.id === li.dataset.id);
  if (a && canEdit(a)) editAval(a);
}
$("listaAval").addEventListener("click", abrirAval);
$("listaAval").addEventListener("keydown", (e) => { if (e.key === "Enter") abrirAval(e); });

function limpaAval() {
  $("formAval").reset(); $("aId").value = ""; $("aData").value = hoje();
  $("avalFormTitle").textContent = "Nova avaliação"; $("avalMsg").textContent = "";
  $("aSchoolId").disabled = $("aSchoolName").disabled = false;
}
$("btnAvalCancel").onclick = limpaAval;

function editAval(a) {
  limpaAval();
  $("aId").value = a.id; $("avalFormTitle").textContent = "Editar avaliação";
  $("aAluno").value = a.aluno || ""; $("aData").value = a.data || "";
  $("aAno").value = a.ano || ""; $("aBim").value = a.bimestre || "";
  $("aLeitura").value = a.leitura || ""; $("aEscrita").value = a.escrita || "";
  $("aSchoolId").value = a.schoolId || ""; $("aSchoolName").value = a.schoolName || "";
  $("aSchoolId").disabled = $("aSchoolName").disabled = true; // escola é imutável
  $("aInterv").value = a.intervencao || ""; $("aDevol").value = a.devolutiva || "";
  $("aDevEntregue").checked = !!a.devEntregue;
  tab("avaliacao"); $("aAluno").focus();
}

$("formAval").onsubmit = (e) => {
  e.preventDefault();
  const m = $("avalMsg"); m.className = "msg err";
  if (profile.role === "gestor") { m.textContent = "Perfil somente leitura."; return; }
  const id = $("aId").value, isTec = profile.role === "tecnico_sme";
  const d = {
    aluno: $("aAluno").value.trim(), ano: +$("aAno").value, bimestre: +$("aBim").value,
    data: $("aData").value, leitura: +$("aLeitura").value, escrita: $("aEscrita").value,
    intervencao: $("aInterv").value.trim(), devolutiva: $("aDevol").value.trim(),
    devEntregue: $("aDevEntregue").checked, updatedBy: uid, updatedAt: serverTimestamp()
  };
  const miss = [];
  if (!d.aluno) miss.push("aluno"); if (!d.data) miss.push("data");
  if (!d.ano) miss.push("ano"); if (!d.bimestre) miss.push("bimestre");
  if (!d.leitura) miss.push("leitura"); if (!d.escrita) miss.push("escrita");
  const sId = isTec ? $("aSchoolId").value.trim() : profile.schoolId;
  const sName = isTec ? $("aSchoolName").value.trim() : profile.schoolName;
  if (!id && (!sId || !sName)) miss.push("escola");
  if (miss.length) { m.textContent = "Preencha: " + miss.join(", ") + "."; return; }

  // Sem await: com cache offline a gravação é local e sincroniza depois
  const p = id
    ? updateDoc(doc(db, "avaliacoes", id), d)
    : setDoc(doc(collection(db, "avaliacoes")), {
        ...d, schoolId: sId, schoolName: sName, profName: profile.name || "",
        createdBy: uid, createdAt: serverTimestamp()
      });
  p.catch((err) => {
    console.error(err);
    toast(err.code === "permission-denied" ? "Permissão negada ao salvar." : "Erro ao salvar: " + err.code);
  });
  toast(navigator.onLine ? "Avaliação salva." : "Salva no aparelho; sincroniza ao reconectar.");
  limpaAval(); tab("painel");
};

/* ---------- Gestão de usuários (Técnico SME) ---------- */
function subscribeUsers() {
  unsubUsers = onSnapshot(collection(db, "users"), (s) => {
    users = s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "pt-BR"));
    renderUsers();
  }, (err) => { console.error(err); toast("Erro ao carregar usuários."); });
}

function limpaUser() {
  $("formUser").reset(); $("uId").value = ""; $("uAtivo").checked = true;
  $("uEmail").readOnly = false; $("wrapSenha").hidden = false;
  $("userFormTitle").textContent = "Novo usuário"; $("userMsg").textContent = "";
}
$("btnUserCancel").onclick = limpaUser;

function editUser(u) {
  limpaUser();
  $("uId").value = u.id; $("userFormTitle").textContent = "Editar usuário";
  $("uNome").value = u.name || ""; $("uEmail").value = u.email || ""; $("uEmail").readOnly = true;
  $("uPerfil").value = u.role || ""; $("uSchoolId").value = u.schoolId || "";
  $("uSchoolName").value = u.schoolName || ""; $("uAtivo").checked = u.active === true;
  $("wrapSenha").hidden = true; $("uNome").focus();
}

const USER_ERR = {
  "auth/email-already-in-use": "Este e-mail já possui conta. Se já existir um perfil, edite-o na lista abaixo.",
  "auth/invalid-email": "E-mail inválido.",
  "auth/weak-password": "Senha fraca (mínimo 6 caracteres).",
  "auth/operation-not-allowed": "Ative o provedor E-mail/Senha no Firebase Authentication.",
  "auth/network-request-failed": "Sem conexão.",
  "permission-denied": "Permissão negada pelas regras do Firestore."
};

$("formUser").onsubmit = async (e) => {
  e.preventDefault();
  const m = $("userMsg"); m.className = "msg err";
  if (profile?.role !== "tecnico_sme") { m.textContent = "Acesso restrito ao Técnico SME."; return; }
  const id = $("uId").value, name = $("uNome").value.trim(), email = $("uEmail").value.trim().toLowerCase();
  const pass = $("uSenha").value, role = $("uPerfil").value, active = $("uAtivo").checked;
  let schoolId = $("uSchoolId").value.trim(), schoolName = $("uSchoolName").value.trim();

  const miss = [];
  if (!name) miss.push("nome"); if (!email) miss.push("e-mail"); if (!role) miss.push("perfil");
  if (!id && pass.length < 6) miss.push("senha (mín. 6)");
  if (role && role !== "tecnico_sme" && (!schoolId || !schoolName)) miss.push("escola");
  if (miss.length) { m.textContent = "Preencha: " + miss.join(", ") + "."; return; }
  if (role === "tecnico_sme" && !schoolId) { schoolId = "sme"; schoolName = schoolName || "Secretaria Municipal de Educação"; }
  if (id === uid && (role !== "tecnico_sme" || !active)) { m.textContent = "Você não pode remover seu próprio acesso de Técnico SME."; return; }
  if (!navigator.onLine) { m.textContent = "Gestão de usuários requer conexão."; return; }

  const data = { name, email, role, schoolId, schoolName, active, updatedAt: serverTimestamp(), updatedBy: uid };
  try {
    m.className = "msg"; m.textContent = "Salvando…";
    if (id) {
      await updateDoc(doc(db, "users", id), data);
    } else {
      const cred = await createUserWithEmailAndPassword(authSec, email, pass);
      await setDoc(doc(db, "users", cred.user.uid), { ...data, createdAt: serverTimestamp(), createdBy: uid });
      await signOut(authSec);
    }
    toast(id ? "Usuário atualizado." : "Usuário criado. Informe a senha provisória a ele.");
    limpaUser();
  } catch (err) {
    console.error(err); m.className = "msg err";
    m.textContent = USER_ERR[err.code] || "Erro ao salvar (" + (err.code || "desconhecido") + ").";
  }
};

["fUserBusca", "fUserRole"].forEach((i) => ($(i).oninput = renderUsers));

function renderUsers() {
  const t = $("fUserBusca").value.toLowerCase().trim(), r = $("fUserRole").value;
  const list = users.filter((u) => (!r || u.role === r) &&
    (!t || [u.name, u.email, u.schoolName].some((v) => (v || "").toLowerCase().includes(t))));
  $("countUsers").textContent = `${list.length} usuário(s)`;
  $("listaUsers").innerHTML = list.map((u) => `<li class="item ${u.active ? "" : "inativo"}" data-id="${esc(u.id)}">
    <div><strong>${esc(u.name || "(sem nome)")}</strong> <span class="chip">${esc(ROLES[u.role] || u.role)}</span>
      <div class="muted small">${esc(u.email)} · ${esc(u.schoolName || "-")}</div>
      <div class="small">${u.active ? "✅ Ativo" : "⛔ Inativo"}</div></div>
    <div class="u-acts">
      <button class="btn btn-light" data-act="edit">Editar</button>
      <button class="btn btn-light" data-act="reset">Redefinir senha</button>
      ${u.id !== uid ? `<button class="btn btn-light" data-act="toggle">${u.active ? "Desativar" : "Ativar"}</button>` : ""}
    </div></li>`).join("") || '<li class="muted">Nenhum usuário.</li>';
}

$("listaUsers").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const u = users.find((x) => x.id === b.closest(".item").dataset.id); if (!u) return;
  try {
    if (b.dataset.act === "edit") editUser(u);
    else if (b.dataset.act === "reset") {
      if (!confirm(`Enviar link de redefinição de senha para ${u.email}?`)) return;
      await sendPasswordResetEmail(auth, u.email); toast("Link enviado para " + u.email);
    } else if (b.dataset.act === "toggle") {
      if (!confirm(`${u.active ? "Desativar" : "Ativar"} ${u.name}?`)) return;
      await updateDoc(doc(db, "users", u.id), { active: !u.active, updatedAt: serverTimestamp(), updatedBy: uid });
      toast(u.active ? "Usuário desativado." : "Usuário ativado.");
    }
  } catch (err) { console.error(err); toast(USER_ERR[err.code] || "Erro: " + err.code); }
});
