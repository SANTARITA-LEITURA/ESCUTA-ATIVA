import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getFirestore, collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
    query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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
const db = getFirestore(app);

// ================= CONSTANTES / HELPERS =================
const NIVEIS = ["Nível 1", "Nível 2", "Nível 3", "Nível 4", "Iniciante", "Fluente"];
const PESO = { "Ausente": 0, "Nível 1": 1, "Nível 2": 2, "Nível 3": 3, "Nível 4": 4, "Iniciante": 5, "Fluente": 6 };
const CLS = { "Nível 1": "n1", "Nível 2": "n2", "Nível 3": "n3", "Nível 4": "n4", "Iniciante": "ini", "Fluente": "flu", "Ausente": "aus" };
const SERIES_RURAL = ["1º Ano", "2º Ano", "3º Ano", "4º Ano", "5º Ano"];
const MESES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
const ROWS = 10;

const $ = id => document.getElementById(id);
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const detArr = d => (Array.isArray(d?.detalhes) ? d.detalhes : Object.values(d?.detalhes || {})).filter(Boolean);
const isRural = d => String(d?.serie || '').trim() === 'Multisseriada';
const byEnvio = (a, b) => new Date(b.data_envio || 0) - new Date(a.data_envio || 0);
const pct = (v, t) => t > 0 ? (v / t * 100).toFixed(1) : '0.0';
const norm = s => String(s || '').trim().toUpperCase();
window.fecharEl = id => $(id).classList.add('hidden');

function parseData(s) {
    s = String(s || '').trim();
    let dia = '', mes = '', ano = '';
    if (s.includes('/')) [dia, mes, ano] = s.split('/');
    else if (s.includes('-')) [ano, mes, dia] = s.split('-');
    return { dia: String(dia).padStart(2, '0'), mes: String(mes).padStart(2, '0'), ano: String(ano).trim() };
}

function contar(alunos) {
    const c = { total: 0, aval: 0, aus: 0, laudo: 0, cont: Object.fromEntries(NIVEIS.map(n => [n, 0])) };
    alunos.forEach(a => {
        if (a.transferido) return;
        c.total++;
        if (a.laudo) c.laudo++;
        const n = String(a.nivel || '').trim();
        if (n === 'Ausente') c.aus++;
        else if (c.cont[n] !== undefined) { c.aval++; c.cont[n]++; }
    });
    return c;
}

// Alunos ativos da avaliação que passam no filtro de séries (null = todas)
function alunosFiltrados(d, series) {
    const ativos = detArr(d).filter(a => !a.transferido);
    if (!series) return ativos;
    if (isRural(d)) {
        if (series.includes('Multisseriada')) return ativos;
        return ativos.filter(a => series.includes(String(a.serieRural || '').trim()));
    }
    return series.includes(String(d.serie || '').trim()) ? ativos : [];
}

function montarKPIs(containerId, isProf) {
    $(containerId).innerHTML = NIVEIS.map(n => `
        <div class="kpi-card hover-card" onclick="window.abrirModalIntervencao('${n}', ${isProf})" title="Ver alunos">
            <div class="kpi-num pct-${CLS[n]}" id="${isProf ? 'prof' : 'adm'}-${CLS[n]}" style="background:none">0%</div>
            <div class="kpi-label">${n}</div>
        </div>`).join('');
}

function pintarKPIs(prefix, c) {
    $(`${prefix}-total`).innerText = c.aval;
    $(`${prefix}-ausente`).innerText = c.aus;
    $(`${prefix}-laudo`).innerText = c.laudo;
    NIVEIS.forEach(n => $(`${prefix}-${CLS[n]}`).innerText = pct(c.cont[n], c.aval) + '%');
}

function paginacao(containerId, total, atual, fn) {
    const pages = Math.ceil(total / ROWS);
    let h = '';
    if (pages > 1) {
        h += `<button class="page-btn" ${atual === 1 ? 'disabled' : ''} onclick="${fn}(${atual - 1})">«</button>`;
        for (let i = 1; i <= pages; i++) h += `<button class="page-btn ${i === atual ? 'active' : ''}" onclick="${fn}(${i})">${i}</button>`;
        h += `<button class="page-btn" ${atual === pages ? 'disabled' : ''} onclick="${fn}(${atual + 1})">»</button>`;
    }
    $(containerId).innerHTML = h;
}

function gerarPdfDe(el, filename, orientation = 'portrait') {
    return html2pdf().set({
        margin: [10, 10, 10, 10], filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, scrollY: 0, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
    }).from(el).save();
}

// ================= ESTADO =================
let perfil = null;
let turmasCache = [];
let dadosTurma = {};
let avalCache = [];
let todosDadosAdm = [];
let filteredProf = [], filteredAdm = [];
let pageProf = 1, pageAdm = 1;
let modoAvancadoProf = true, nivelAtual = '', tipoCons = 'escola';
window.turmaAtualEdicao = null;

// ================= INICIALIZAÇÃO DA UI =================
(function initUI() {
    const hoje = new Date();
    for (let i = 1; i <= 31; i++) {
        const v = String(i).padStart(2, '0');
        $('sel-dia').innerHTML += `<option value="${v}">${i}</option>`;
    }
    $('sel-dia').value = String(hoje.getDate()).padStart(2, '0');
    $('sel-mes').value = String(hoje.getMonth() + 1).padStart(2, '0');
    $('sel-ano').value = String(hoje.getFullYear());
    $('chk-meses-prof').innerHTML = MESES.map((m, i) =>
        `<label class="chk-label"><input type="checkbox" value="${String(i + 1).padStart(2, '0')}" onchange="window.aplicarFiltrosProf()"> ${m}</label>`).join('');
    $('chk-niveis-avancado').innerHTML = [...NIVEIS, 'Ausente'].map(n =>
        `<label class="chk-label"><input type="checkbox" value="${n}" class="chk-nivel"> ${n}</label>`).join('');
    montarKPIs('kpis-prof', true);
    montarKPIs('kpis-adm', false);
})();

// ================= LOGIN =================
window.login = async () => {
    const msg = $('msg-login');
    msg.innerText = '';
    try {
        await signInWithEmailAndPassword(auth, $('email').value.trim(), $('senha').value);
    } catch {
        msg.innerText = 'Erro no login. Verifique e-mail e senha.';
    }
};

window.logout = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    if (!user) { $('screen-login').classList.add('active'); return; }

    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) throw new Error('Perfil não encontrado. Contate a SME.');
        const data = snap.data();
        if (data.active !== true) throw new Error('Usuário inativo.');
        perfil = { uid: user.uid, ...data };

        if (perfil.role === 'tecnico_sme') {
            $('header-admin').innerText = `Painel Gestor - ${perfil.name}`;
            $('screen-admin').classList.add('active');
            window.carregarAdmin();
        } else if (['professor', 'coordenador'].includes(perfil.role)) {
            if (!perfil.schoolId) throw new Error('Usuário sem escola vinculada.');
            $('screen-app').classList.add('active');
            $('header-user').innerText = `Olá, ${perfil.name} (${perfil.role === 'coordenador' ? 'Coordenação' : 'Professor(a)'})`;
            $('lbl-escola').innerText = perfil.schoolName || '';
            $('tab-turmas').classList.toggle('hidden', perfil.role !== 'coordenador');
            window.mudarAbaProf('nova');
            await window.listarTurmas();
            window.carregarHistoricoProf();
        } else {
            throw new Error('Perfil sem permissão.');
        }
    } catch (e) {
        $('screen-login').classList.add('active');
        $('msg-login').innerText = e.message;
        signOut(auth);
    }
});

window.mudarAbaProf = (aba) => {
    ['nova', 'hist', 'evo', 'turmas'].forEach(a => {
        $(`tab-${a}`).classList.toggle('active', a === aba);
        $(`view-${a}`).classList.toggle('hidden', a !== aba);
    });
    if (aba === 'hist') window.carregarHistoricoProf();
    if (aba === 'evo') window.prepararComparativo();
    if (aba === 'turmas') window.listarTurmas();
};

// ================= TURMAS =================
window.listarTurmas = async () => {
    const snap = await getDocs(query(collection(db, 'turmas'), where('schoolId', '==', perfil.schoolId)));
    turmasCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.ano + a.serie + a.turma).localeCompare(a.ano + b.serie + b.turma));

    $('tabela-turmas').innerHTML = turmasCache.length
        ? turmasCache.map(t => `<tr>
            <td><b>${escH(t.serie)} - ${escH(t.turma)}</b> <small>(${escH(t.ano)})</small></td>
            <td>${(t.alunos || []).length}</td>
            <td><button class="btn-table" onclick="window.editarTurma('${t.id}')">✏️</button>
                <button class="btn-table" onclick="window.excluirTurma('${t.id}')">🗑️</button></td></tr>`).join('')
        : '<tr><td colspan="3">Nenhuma turma cadastrada.</td></tr>';

    const atual = $('sel-turma-cad').value;
    $('sel-turma-cad').innerHTML = '<option value="">Selecione a turma...</option>' +
        turmasCache.map(t => `<option value="${t.id}">${escH(t.serie)} - Turma ${escH(t.turma)} (${escH(t.ano)})</option>`).join('');
    $('sel-turma-cad').value = turmasCache.some(t => t.id === atual) ? atual : '';
    $('msg-sem-turma').classList.toggle('hidden', turmasCache.length > 0);
    window.carregarAlunosTurma();
};

window.salvarTurma = async () => {
    const id = $('cad-turma-id').value;
    const nomes = [...new Set($('cad-alunos').value.split('\n').map(norm).filter(Boolean))];
    if (!nomes.length) return alert('Informe os alunos!');

    const serie = $('cad-serie').value, turma = $('cad-turma').value, ano = $('cad-ano').value;
    if (turmasCache.some(t => t.id !== id && t.serie === serie && t.turma === turma && t.ano === ano))
        return alert('Essa turma já existe!');

    // Mantém laudo/série rural dos alunos que já existiam
    const antigos = id ? (turmasCache.find(t => t.id === id)?.alunos || []) : [];
    const alunos = nomes.map(nome => {
        const a = antigos.find(x => norm(x.nome) === nome);
        return { nome, laudo: !!a?.laudo, serieRural: a?.serieRural || '' };
    });

    const dados = {
        schoolId: perfil.schoolId, schoolName: perfil.schoolName || '',
        serie, turma, ano, alunos, updatedAt: serverTimestamp(), updatedBy: perfil.uid
    };
    try {
        if (id) await updateDoc(doc(db, 'turmas', id), dados);
        else await addDoc(collection(db, 'turmas'), { ...dados, createdAt: serverTimestamp() });
        alert('✅ Turma salva!');
        window.limparFormTurma();
        window.listarTurmas();
    } catch (e) { alert('Erro ao salvar: ' + e.message); }
};

window.editarTurma = (id) => {
    const t = turmasCache.find(x => x.id === id);
    if (!t) return;
    $('cad-turma-id').value = id;
    $('cad-serie').value = t.serie;
    $('cad-turma').value = t.turma;
    $('cad-ano').value = t.ano;
    $('cad-alunos').value = (t.alunos || []).map(a => a.nome).join('\n');
    $('titulo-cad-turma').innerText = 'Editar Turma';
    window.scrollTo(0, 0);
};

window.limparFormTurma = () => {
    $('cad-turma-id').value = '';
    $('cad-alunos').value = '';
    $('titulo-cad-turma').innerText = 'Cadastrar Turma';
};

window.excluirTurma = async (id) => {
    if (!confirm('Excluir esta turma? As avaliações já feitas serão mantidas.')) return;
    try { await deleteDoc(doc(db, 'turmas', id)); window.listarTurmas(); }
    catch (e) { alert('Erro: ' + e.message); }
};

const turmaSelecionada = () => turmasCache.find(x => x.id === $('sel-turma-cad').value);

window.carregarAlunosTurma = () => {
    const t = turmaSelecionada();
    $('lista-alunos').value = t ? (t.alunos || []).map(a => a.nome).join('\n') : '';
};

// ================= AVALIAÇÃO =================
window.iniciarAvaliacao = () => {
    const t = turmaSelecionada();
    if (!t) return alert('Selecione a turma!');
    if (!(t.alunos || []).length) return alert('Turma sem alunos cadastrados.');

    dadosTurma = {
        turmaId: t.id, escola: t.schoolName || perfil.schoolName, serie: t.serie, turma: t.turma,
        rural: t.serie === 'Multisseriada',
        data: `${$('sel-dia').value}/${$('sel-mes').value}/${$('sel-ano').value}`,
        alunos: t.alunos.map(a => ({ nome: a.nome, nivel: '', laudo: !!a.laudo, serieRural: a.serieRural || '', transferido: false }))
    };
    window.renderizarAvaliacao();
    $('area-config').classList.add('hidden');
    $('area-avaliacao').classList.remove('hidden');
};

window.renderizarAvaliacao = () => {
    $('resumo-titulo').innerText = dadosTurma.escola;
    $('resumo-data').innerText = dadosTurma.data;
    $('resumo-sub').innerText = `${dadosTurma.serie} - Turma ${dadosTurma.turma}`;
    const container = $('container-alunos');
    container.innerHTML = '';

    dadosTurma.alunos.forEach((a, idx) => {
        const div = document.createElement('div');
        div.id = `row-${idx}`;
        div.className = 'aluno-row' + (a.transferido ? ' transferido' : '') + (a.laudo ? ' com-laudo' : '')
            + (a.nivel === 'Ausente' ? ' ausente' : a.nivel ? ' avaliado' : '');
        const dis = a.transferido ? 'disabled' : '';
        const selSerie = dadosTurma.rural
            ? `<select onchange="window.updateCampo(${idx}, 'serieRural', this.value)" ${dis}><option value="">Série...</option>
               ${SERIES_RURAL.map(s => `<option ${a.serieRural === s ? 'selected' : ''}>${s}</option>`).join('')}</select>` : '';
        div.innerHTML = `
            <strong>${escH(a.nome)} <span class="tag-laudo">(LAUDO)</span></strong>
            <div class="controls">
                <label class="laudo-chk"><input type="checkbox" onchange="window.toggleLaudo(${idx})" ${a.laudo ? 'checked' : ''} ${dis}> Laudo</label>
                <label class="laudo-chk" style="color:var(--red);"><input type="checkbox" onchange="window.toggleTransferido(${idx})" ${a.transferido ? 'checked' : ''}> Transf.</label>
                ${selSerie}
                <select onchange="window.updateNivel(${idx}, this.value)" ${dis}>
                    <option value="">Avaliar...</option>
                    <option value="Ausente" ${a.nivel === 'Ausente' ? 'selected' : ''}>⚠️ Ausente</option>
                    ${NIVEIS.map(n => `<option ${a.nivel === n ? 'selected' : ''}>${n}</option>`).join('')}
                </select>
            </div>`;
        container.appendChild(div);
    });
    window.atualizarStats();
};

window.toggleLaudo = idx => { dadosTurma.alunos[idx].laudo = !dadosTurma.alunos[idx].laudo; $(`row-${idx}`).classList.toggle('com-laudo'); };
window.toggleTransferido = idx => { const a = dadosTurma.alunos[idx]; a.transferido = !a.transferido; if (a.transferido) a.nivel = ''; window.renderizarAvaliacao(); };
window.updateCampo = (idx, campo, val) => { dadosTurma.alunos[idx][campo] = val; };
window.updateNivel = (idx, val) => {
    dadosTurma.alunos[idx].nivel = val;
    const row = $(`row-${idx}`);
    row.classList.remove('ausente', 'avaliado');
    if (val === 'Ausente') row.classList.add('ausente'); else if (val) row.classList.add('avaliado');
    window.atualizarStats();
};

window.addExtra = () => {
    const nome = norm($('extra-nome').value);
    if (!nome) return;
    if (dadosTurma.alunos.some(a => norm(a.nome) === nome)) return alert('Aluno já está na lista.');
    dadosTurma.alunos.push({ nome, nivel: '', laudo: false, serieRural: '', transferido: false });
    $('extra-nome').value = '';
    window.renderizarAvaliacao();
};

window.atualizarStats = () => {
    const c = contar(dadosTurma.alunos);
    $('stats-rapido').innerText = `Status: ${c.aval} Avaliados | ${c.aus} Ausentes | ${c.total - c.aval - c.aus} Pendentes`;
};

function resetBotaoFinalizar() {
    const btn = $('btn-finalizar');
    btn.innerText = '🚀 FINALIZAR E SALVAR AVALIAÇÃO';
    btn.disabled = false;
}

window.voltarConfig = () => {
    if (!confirm('Descartar? As avaliações não salvas serão perdidas.')) return;
    $('area-avaliacao').classList.add('hidden');
    $('area-config').classList.remove('hidden');
    dadosTurma = {};
    resetBotaoFinalizar();
};

window.finalizarAvaliacao = async () => {
    const c = contar(dadosTurma.alunos);
    const pend = c.total - c.aval - c.aus;
    if (pend > 0 && !confirm(`${pend} aluno(s) sem avaliação. Salvar mesmo assim?`)) return;

    const btn = $('btn-finalizar');
    btn.innerText = '⏳ Salvando...';
    btn.disabled = true;
    try {
        await addDoc(collection(db, 'avaliacoes'), {
            schoolId: perfil.schoolId, escola: dadosTurma.escola,
            turmaId: dadosTurma.turmaId, serie: dadosTurma.serie, turma: dadosTurma.turma,
            avaliadorUid: perfil.uid, professor: perfil.name,
            data_avaliacao: dadosTurma.data, data_envio: new Date().toISOString(),
            total_alunos: c.total, total_avaliados: c.aval, total_ausentes: c.aus,
            resultados: c.cont, detalhes: dadosTurma.alunos
        });
        // Atualiza a turma: inclui extras, remove transferidos, guarda laudo e série
        await updateDoc(doc(db, 'turmas', dadosTurma.turmaId), {
            alunos: dadosTurma.alunos.filter(a => !a.transferido)
                .map(a => ({ nome: norm(a.nome), laudo: !!a.laudo, serieRural: a.serieRural || '' })),
            updatedAt: serverTimestamp(), updatedBy: perfil.uid
        });
        btn.innerText = '✅ SALVO';
        $('modal-sucesso').classList.remove('hidden');
    } catch (e) {
        alert('Erro ao salvar: ' + e.message);
        btn.innerText = '☁️ Tentar Novamente';
        btn.disabled = false;
    }
};

window.fecharSucessoEVoltar = () => {
    $('modal-sucesso').classList.add('hidden');
    $('area-avaliacao').classList.add('hidden');
    $('area-config').classList.remove('hidden');
    dadosTurma = {};
    resetBotaoFinalizar();
    window.listarTurmas();
    window.carregarHistoricoProf();
};

window.gerarPDF = () => {
    const el = $('area-avaliacao');
    el.querySelectorAll('.no-print').forEach(e => e.style.display = 'none');
    window.scrollTo(0, 0);
    gerarPdfDe(el, `${dadosTurma.escola}_${dadosTurma.serie}_${dadosTurma.turma}.pdf`)
        .then(() => el.querySelectorAll('.no-print').forEach(e => e.style.display = ''));
};

window.compartilharZap = () => {
    const ativos = dadosTurma.alunos.filter(a => !a.transferido && a.nivel);
    let txt = `*${dadosTurma.escola}*\nSérie: ${dadosTurma.serie} ${dadosTurma.turma}\nData: ${dadosTurma.data}\n`
        + `Avaliados: ${ativos.filter(a => a.nivel !== 'Ausente').length}\n\n`;
    ativos.forEach(a => txt += `${a.nivel === 'Ausente' ? '⚠️' : '✅'} ${a.nome}: ${a.nivel}\n`);
    window.open('https://wa.me/?text=' + encodeURIComponent(txt));
};

// ================= HISTÓRICO (PROF/COORD) =================
window.carregarHistoricoProf = async () => {
    try {
        const snap = await getDocs(query(collection(db, 'avaliacoes'), where('schoolId', '==', perfil.schoolId)));
        let all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (perfil.role !== 'coordenador') all = all.filter(d => d.avaliadorUid === perfil.uid);
        avalCache = all.sort(byEnvio);
    } catch (e) {
        console.error(e);
        avalCache = [];
    }
    window.aplicarFiltrosProf();
    window.prepararComparativo();
};

window.aplicarFiltrosProf = () => {
    const fSer = $('prof-filtro-serie').value, fTur = $('prof-filtro-turma').value, fAno = $('prof-ano-filtro').value;
    const meses = [...document.querySelectorAll('#chk-meses-prof input:checked')].map(c => c.value);
    const series = fSer === 'TODAS' ? null : [fSer];
    const todos = [];
    filteredProf = [];

    avalCache.forEach(d => {
        const { mes, ano } = parseData(d.data_avaliacao);
        if (fTur !== 'TODAS' && d.turma !== fTur) return;
        if (meses.length && !meses.includes(mes)) return;
        if (fAno !== 'TODOS' && ano !== fAno) return;
        const alunos = alunosFiltrados(d, series);
        if (!alunos.length) return;
        todos.push(...alunos);
        filteredProf.push({ d, alunos });
    });

    pintarKPIs('prof', contar(todos));
    pageProf = 1;
    renderTableProf();
};

const podeEditar = d => perfil.role === 'coordenador' || d.avaliadorUid === perfil.uid;

function renderTableProf() {
    const page = filteredProf.slice((pageProf - 1) * ROWS, pageProf * ROWS);
    $('tabela-prof').innerHTML = page.length ? page.map(({ d }) => `<tr>
        <td>${escH(d.escola)}<br><small>${escH(d.serie)} - ${escH(d.turma)}</small></td>
        <td>${escH(d.data_avaliacao)}</td>
        <td>${escH(d.professor)}</td>
        <td><button class="btn-table" onclick="window.abrirModalTurma('${d.id}', false)">🔍</button>
            ${podeEditar(d) ? `<button class="btn-table" onclick="window.excluirAvaliacao('${d.id}')">🗑️</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="4">Nenhum dado encontrado.</td></tr>';
    paginacao('paginacao-prof', filteredProf.length, pageProf, 'window.mudarPaginaProf');
}
window.mudarPaginaProf = p => { pageProf = p; renderTableProf(); };

window.excluirAvaliacao = async (id) => {
    if (!confirm('EXCLUIR esta avaliação? Não é possível desfazer.')) return;
    try {
        await deleteDoc(doc(db, 'avaliacoes', id));
        alert('✅ Excluída!');
        perfil.role === 'tecnico_sme' ? window.carregarAdmin() : window.carregarHistoricoProf();
    } catch (e) { alert('Erro ao excluir: ' + e.message); }
};

// ================= MODAL DETALHES / EDIÇÃO =================
window.abrirModalTurma = (id, isAdmin) => {
    const item = (isAdmin ? todosDadosAdm : avalCache).find(d => d.id === id);
    if (!item) return;
    window.turmaAtualEdicao = JSON.parse(JSON.stringify(item));
    window.turmaAtualEdicao.detalhes = detArr(item);
    const editavel = !isAdmin && podeEditar(item);
    $('modal-titulo').innerText = `${item.escola} | ${item.serie} ${item.turma}`;
    window.renderizarTabelaModal(editavel);
    $('modal-footer').classList.toggle('hidden', !editavel);
    $('modal-detalhes').classList.remove('hidden');
};

window.renderizarTabelaModal = (editavel) => {
    const t = window.turmaAtualEdicao, rural = isRural(t);
    let h = `<div class="info-box"><b>Data:</b> ` + (editavel
        ? `<input type="text" value="${escH(t.data_avaliacao)}" oninput="window.turmaAtualEdicao.data_avaliacao=this.value" maxlength="10" style="width:120px;margin:0 0 0 8px;padding:6px;">`
        : escH(t.data_avaliacao)) + ` &nbsp; <b>Avaliador(a):</b> ${escH(t.professor)}</div>`;
    h += `<table class="modal-table"><thead><tr><th>Aluno</th>${rural ? '<th>Série</th>' : ''}<th>Laudo</th><th>Transf.</th><th>Avaliação</th></tr></thead><tbody>`;

    t.detalhes.forEach((a, i) => {
        const ref = `window.turmaAtualEdicao.detalhes[${i}]`;
        const dis = a.transferido ? 'disabled' : '';
        if (editavel) {
            h += `<tr class="${a.transferido ? 'transferido' : ''}"><td><b>${escH(a.nome)}</b></td>
                ${rural ? `<td><select onchange="${ref}.serieRural=this.value" ${dis}><option value="">-</option>${SERIES_RURAL.map(s => `<option ${a.serieRural === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>` : ''}
                <td><input type="checkbox" style="width:auto" onchange="${ref}.laudo=this.checked" ${a.laudo ? 'checked' : ''} ${dis}></td>
                <td><input type="checkbox" style="width:auto" onchange="${ref}.transferido=this.checked; if(this.checked) ${ref}.nivel=''; window.renderizarTabelaModal(true)" ${a.transferido ? 'checked' : ''}></td>
                <td><select onchange="${ref}.nivel=this.value" ${dis}><option value="">- Sem nota -</option>
                    ${['Ausente', ...NIVEIS].map(n => `<option ${a.nivel === n ? 'selected' : ''}>${n}</option>`).join('')}</select></td></tr>`;
        } else {
            h += `<tr class="${a.transferido ? 'transferido' : ''}"><td>${escH(a.nome)}</td>${rural ? `<td>${escH(a.serieRural || '-')}</td>` : ''}
                <td>${a.laudo ? '<span style="color:var(--purple)">Sim</span>' : 'Não'}</td><td>${a.transferido ? 'Sim' : 'Não'}</td>
                <td>${a.nivel ? `<span class="nivel-tag nivel-tag-${CLS[a.nivel] || 'vazio'}">${escH(a.nivel)}</span>` : '-'}</td></tr>`;
        }
    });
    h += '</tbody></table>';
    $('modal-body').innerHTML = h;
};

window.salvarEdicaoModal = async () => {
    const btn = $('btn-salvar-modal');
    btn.innerText = '⏳ Salvando...';
    const t = window.turmaAtualEdicao, c = contar(t.detalhes);
    try {
        await updateDoc(doc(db, 'avaliacoes', t.id), {
            data_avaliacao: t.data_avaliacao, detalhes: t.detalhes,
            total_alunos: c.total, total_avaliados: c.aval, total_ausentes: c.aus, resultados: c.cont,
            editadoPor: perfil.uid, editadoEm: new Date().toISOString()
        });
        alert('✅ Alterações salvas!');
        window.fecharModal();
        window.carregarHistoricoProf();
    } catch (e) { alert('Erro ao salvar: ' + e.message); }
    finally { btn.innerText = '💾 SALVAR ALTERAÇÕES'; }
};

window.fecharModal = () => { $('modal-detalhes').classList.add('hidden'); window.turmaAtualEdicao = null; };

// ================= RELATÓRIOS POR NÍVEL =================
function htmlListaNiveis(lista, niveis, idDoc) {
    let corpo = '';
    lista.forEach(({ d, alunos }) => {
        const sel = alunos.filter(a => niveis.includes(String(a.nivel || '').trim()));
        if (!sel.length) return;
        corpo += `<div class="relatorio-grupo-card">
            <div class="relatorio-grupo-header"><span class="grupo-titulo">🏫 ${escH(d.escola)} | ${escH(d.serie)} ${escH(d.turma)}</span>
            <span class="grupo-meta">${escH(d.data_avaliacao)} • ${sel.length} aluno(s)</span></div>
            <ul style="margin:0;padding:10px 15px 10px 35px;">
            ${sel.map(a => `<li style="padding:6px 0;border-bottom:1px dashed #eee;">${escH(a.nome)}
                ${niveis.length > 1 ? `<span class="nivel-tag nivel-tag-${CLS[a.nivel]}">${escH(a.nivel)}</span>` : ''}
                ${a.laudo ? '<b style="color:var(--purple);font-size:0.8rem">[Laudo]</b>' : ''}
                ${isRural(d) && a.serieRural ? `<span style="color:var(--gray)"> - ${escH(a.serieRural)}</span>` : ''}</li>`).join('')}
            </ul></div>`;
    });
    if (!corpo) return null;
    return `<div id="${idDoc}" style="padding:20px;background:white;">
        <div class="pdf-consolidado-header"><h2>Relatório de Intervenção Pedagógica</h2>
        <p class="pdf-subtitulo">Níveis: <b>${niveis.join(' | ')}</b> • Gerado em ${new Date().toLocaleDateString('pt-BR')}</p></div>${corpo}</div>`;
}

window.abrirModalIntervencao = (nivel, isProf) => {
    nivelAtual = nivel;
    const h = htmlListaNiveis(isProf ? filteredProf : filteredAdm, [nivel], 'documento-pdf');
    $('conteudo-pdf-intervencao').innerHTML = h || `<div class="vazio">Nenhum aluno em <b>${nivel}</b> com os filtros atuais.</div>`;
    $('modal-interv-btn-print').classList.toggle('hidden', !h);
    $('modal-intervencao').classList.remove('hidden');
};

window.imprimirIntervencao = () => gerarPdfDe($('documento-pdf'), `Intervencao_${nivelAtual}.pdf`);

window.abrirModalRelatorioAvancado = (isProf) => {
    modoAvancadoProf = isProf;
    document.querySelectorAll('.chk-nivel').forEach(c => c.checked = false);
    $('conteudo-pdf-avancado').innerHTML = '';
    $('btn-print-avancado').classList.add('hidden');
    $('modal-relatorio-avancado').classList.remove('hidden');
};

window.gerarVisualizacaoRelatorioAvancado = () => {
    const niveis = [...document.querySelectorAll('.chk-nivel:checked')].map(c => c.value);
    if (!niveis.length) return alert('Selecione pelo menos um nível.');
    const h = htmlListaNiveis(modoAvancadoProf ? filteredProf : filteredAdm, niveis, 'documento-pdf-avancado');
    $('conteudo-pdf-avancado').innerHTML = h || '<div class="vazio">Nenhum aluno encontrado para os níveis selecionados.</div>';
    $('btn-print-avancado').classList.toggle('hidden', !h);
};

window.imprimirRelatorioAvancado = () => gerarPdfDe($('documento-pdf-avancado'), 'Relatorio_Niveis.pdf');

// ================= EVOLUÇÃO =================
const chaveTurma = d => d.turmaId || `${d.escola}|${d.serie}|${d.turma}`;

window.prepararComparativo = () => {
    const sel = $('filtro-evo-turma');
    const mapa = new Map();
    avalCache.forEach(d => { if (!mapa.has(chaveTurma(d))) mapa.set(chaveTurma(d), `${d.serie} - Turma ${d.turma}`); });
    sel.innerHTML = mapa.size
        ? '<option value="">Selecione a Turma...</option>' + [...mapa].sort((a, b) => a[1].localeCompare(b[1]))
            .map(([k, l]) => `<option value="${escH(k)}">${escH(l)}</option>`).join('')
        : '<option value="">Nenhuma avaliação encontrada</option>';
};

window.gerarRelatorioEvolucao = () => {
    const key = $('filtro-evo-turma').value;
    if (!key) return alert('Selecione uma turma.');
    const avs = avalCache.filter(d => chaveTurma(d) === key).sort(byEnvio);
    $('resultado-evo').classList.remove('hidden');
    if (avs.length < 2) {
        $('evo-info').innerText = '';
        $('tabela-evo').innerHTML = "<tr><td colspan='4'>Precisa de pelo menos 2 avaliações.</td></tr>";
        return;
    }
    const [atual, anterior] = avs;
    $('evo-info').innerText = `Comparando: ${atual.data_avaliacao} vs ${anterior.data_avaliacao}`;
    const ant = detArr(anterior);
    $('tabela-evo').innerHTML = detArr(atual).filter(a => !a.transferido).map(a => {
        const old = ant.find(x => norm(x.nome) === norm(a.nome));
        const nA = a.nivel || '-', nB = old ? (old.nivel || '-') : 'Novo';
        let badge = '<span class="badge badge-same">➖ Manteve</span>';
        if (!old) badge = '<span class="badge" style="background:#e3f2fd;color:#1565C0">🆕 Novo</span>';
        else if (PESO[nA] !== undefined && PESO[nB] !== undefined) {
            if (PESO[nA] > PESO[nB]) badge = '<span class="badge badge-up">⬆️ Evoluiu</span>';
            else if (PESO[nA] < PESO[nB]) badge = '<span class="badge badge-down">⬇️ Regrediu</span>';
        }
        return `<tr><td>${escH(a.nome)}</td><td>${escH(nB)}</td><td><b>${escH(nA)}</b></td><td>${badge}</td></tr>`;
    }).join('');
};

// ================= ADMIN (TÉCNICO SME) =================
window.carregarAdmin = async () => {
    try {
        const snap = await getDocs(collection(db, 'avaliacoes'));
        todosDadosAdm = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byEnvio);
        const atual = $('filtro-escola').value;
        const escolas = [...new Set(todosDadosAdm.map(d => String(d.escola || '').trim()).filter(Boolean))].sort();
        $('filtro-escola').innerHTML = '<option value="TODAS">Todas as Escolas</option>' +
            escolas.map(e => `<option value="${escH(e)}">${escH(e)}</option>`).join('');
        if (escolas.includes(atual)) $('filtro-escola').value = atual;
        window.aplicarFiltros();
    } catch (e) {
        console.error(e);
        $('tabela-envios').innerHTML = "<tr><td colspan='6'>Erro de conexão com o banco.</td></tr>";
    }
};

window.aplicarFiltros = () => {
    const fEsc = $('filtro-escola').value, fMes = $('adm-mes-ini').value, fAno = $('adm-ano-ini').value;
    const series = [...document.querySelectorAll('#chk-series input:checked')].map(c => c.value);
    const todos = [];
    filteredAdm = [];

    todosDadosAdm.forEach(d => {
        if (fEsc !== 'TODAS' && String(d.escola || '').trim() !== fEsc) return;
        const { mes, ano } = parseData(d.data_avaliacao);
        if (fMes !== 'TODOS' && mes !== fMes) return;
        if (fAno !== 'TODOS' && ano !== fAno) return;
        const alunos = alunosFiltrados(d, series);
        if (!alunos.length) return;
        todos.push(...alunos);
        filteredAdm.push({ d, alunos });
    });

    pintarKPIs('adm', contar(todos));
    pageAdm = 1;
    renderTableAdm();
};

function renderTableAdm() {
    const page = filteredAdm.slice((pageAdm - 1) * ROWS, pageAdm * ROWS);
    $('tabela-envios').innerHTML = page.length ? page.map(({ d, alunos }) => {
        const c = contar(alunos);
        return `<tr><td>${escH(d.escola)}</td><td>${escH(d.serie)} ${escH(d.turma)}</td><td>${escH(d.data_avaliacao)}</td>
            <td>${escH(d.professor)}</td><td>${c.aval ? pct(c.cont['Fluente'], c.aval) + '%' : '-'}</td>
            <td><button class="btn-table" onclick="window.abrirModalTurma('${d.id}', true)">🔍</button>
                <button class="btn-table" onclick="window.excluirAvaliacao('${d.id}')">🗑️</button></td></tr>`;
    }).join('') : "<tr><td colspan='6'>Sem dados.</td></tr>";
    paginacao('paginacao-adm', filteredAdm.length, pageAdm, 'window.mudarPaginaAdm');
}
window.mudarPaginaAdm = p => { pageAdm = p; renderTableAdm(); };

// ================= RELATÓRIOS CONSOLIDADOS =================
const COLS = [...NIVEIS, 'Ausente'];

function tabelaPercentuais(rows) {
    const cel = (v, t, cls) => `<td class="pct-cell ${v ? 'pct-' + cls : 'pct-zero'}">${v ? pct(v, t) + '%' : '-'}<br><small>${v}</small></td>`;
    return `<table class="tabela-percentuais"><thead><tr><th>#</th><th class="col-nome">Nome</th>
        ${COLS.map(n => `<th class="th-${CLS[n]}">${n}</th>`).join('')}<th class="col-total">Total</th><th>Média</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr><td><span class="ranking-pos ${i < 3 ? 'top-' + (i + 1) : ''}">${i + 1}</span></td>
            <td class="col-nome">${escH(r.nome)}</td>
            ${NIVEIS.map(n => cel(r.c.cont[n], r.c.aval, CLS[n])).join('')}
            ${cel(r.c.aus, r.c.total, 'aus')}
            <td class="col-total">${r.c.total}</td><td><b>${r.media.toFixed(2)}</b></td></tr>`).join('')}
        </tbody></table>`;
}

function mediaPonderada(c) {
    return c.aval ? NIVEIS.reduce((s, n) => s + c.cont[n] * PESO[n], 0) / c.aval : 0;
}

window.abrirModalRelatorioConsolidado = (tipo) => {
    tipoCons = tipo;
    $('modal-cons-titulo').innerText = `📑 Relatório Consolidado - Por ${tipo[0].toUpperCase() + tipo.slice(1)}`;
    $('filtro-aluno-extra').classList.toggle('hidden', tipo !== 'aluno');
    $('filtro-cons-nivel').value = 'TODOS';
    window.gerarVisualizacaoConsolidado();
    $('modal-relatorio-consolidado').classList.remove('hidden');
};

window.gerarVisualizacaoConsolidado = () => {
    const filtros = `Escola: ${$('filtro-escola').value} • Mês: ${$('adm-mes-ini').value} • Ano: ${$('adm-ano-ini').value} • Séries: `
        + [...document.querySelectorAll('#chk-series input:checked')].map(c => c.value).join(', ');
    let h = `<div id="documento-pdf-consolidado" style="padding:15px;background:white;">
        <div class="pdf-consolidado-header"><h2>Relatório Consolidado - Por ${tipoCons[0].toUpperCase() + tipoCons.slice(1)}</h2>
        <p class="pdf-subtitulo">Gerado em ${new Date().toLocaleDateString('pt-BR')}</p><div class="pdf-filtros">${escH(filtros)}</div></div>`;

    if (!filteredAdm.length) {
        $('conteudo-pdf-consolidado').innerHTML = '<div class="vazio">Nenhum dado com os filtros atuais.</div>';
        $('btn-print-consolidado').classList.add('hidden');
        return;
    }

    if (tipoCons === 'aluno') {
        // Último nível de cada aluno
        const mapa = new Map();
        filteredAdm.forEach(({ d, alunos }) => alunos.forEach(a => {
            const k = `${d.schoolId}|${norm(a.nome)}`, ant = mapa.get(k);
            if (!ant || new Date(d.data_envio) > new Date(ant.envio)) mapa.set(k, {
                nome: a.nome, escola: d.escola, nivel: a.nivel || '', laudo: a.laudo,
                turma: `${isRural(d) && a.serieRural ? a.serieRural : d.serie} ${d.turma}`,
                data: d.data_avaliacao, envio: d.data_envio
            });
        }));
        const fN = $('filtro-cons-nivel').value;
        const rows = [...mapa.values()].filter(r => fN === 'TODOS' || r.nivel === fN)
            .sort((a, b) => (PESO[b.nivel] ?? -1) - (PESO[a.nivel] ?? -1) || a.nome.localeCompare(b.nome));
        h += `<p><b>${rows.length}</b> aluno(s) (último nível registrado)</p>
            <table class="tabela-alunos-consolidado"><thead><tr><th>#</th><th>Aluno</th><th>Escola</th><th>Turma</th><th>Data</th><th>Nível</th></tr></thead><tbody>
            ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${escH(r.nome)} ${r.laudo ? '<b style="color:var(--purple)">[Laudo]</b>' : ''}</td>
                <td>${escH(r.escola)}</td><td>${escH(r.turma)}</td><td>${escH(r.data)}</td>
                <td><span class="nivel-tag nivel-tag-${CLS[r.nivel] || 'vazio'}">${escH(r.nivel || 'Sem nota')}</span></td></tr>`).join('')}
            </tbody></table>`;
    } else {
        const grupos = new Map(), todos = [];
        filteredAdm.forEach(({ d, alunos }) => {
            const k = tipoCons === 'escola' ? d.escola : `${d.escola} | ${d.serie} ${d.turma}`;
            if (!grupos.has(k)) grupos.set(k, []);
            grupos.get(k).push(...alunos);
            todos.push(...alunos);
        });
        const rows = [...grupos].map(([nome, al]) => { const c = contar(al); return { nome, c, media: mediaPonderada(c) }; })
            .sort((a, b) => b.media - a.media);
        const g = contar(todos);
        h += `<div class="relatorio-resumo-geral"><h4>📊 Resumo Geral (${g.total} alunos • ${g.aval} avaliados • ${g.aus} ausentes)</h4>
            ${tabelaPercentuais([{ nome: 'REDE / FILTRO ATUAL', c: g, media: mediaPonderada(g) }])}</div>
            ${tabelaPercentuais(rows)}
            <p style="font-size:0.8rem;color:#777;margin-top:10px;">% dos níveis sobre avaliados; % de ausentes sobre o total. Média: Nível 1 = 1 ... Fluente = 6.</p>`;
    }
    $('conteudo-pdf-consolidado').innerHTML = h + '</div>';
    $('btn-print-consolidado').classList.remove('hidden');
};

window.imprimirRelatorioConsolidado = () =>
    gerarPdfDe($('documento-pdf-consolidado'), `Consolidado_${tipoCons}.pdf`, tipoCons === 'aluno' ? 'portrait' : 'landscape');
