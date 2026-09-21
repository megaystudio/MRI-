/*
 * MRI Personal Workspace — UI.
 * Classic script (inline onclick handlers use these globals). The "server"
 * is js/services.js, loaded as an ES module at startup: api() below has the
 * same contract the old fetch-based helper had, but it talks to the local
 * IndexedDB database instead of a server.
 */
const content = document.getElementById('content');
const modalOverlay = document.getElementById('modalOverlay');
const modal = document.getElementById('modal');
const toastStack = document.getElementById('toastStack');

let currentUser = null;   // workspace owner profile: { full_name, workspace_name }
let svc = null;           // js/services.js
let bak = null;           // js/backup.js
let drv = null;           // js/drive.js (loaded on demand)
let cfg = null;           // config.js
// NB: dynamic import() inside this classic script resolves relative to js/app.js, hence './x.js' and '../config.js'.

async function api(path, options = {}) {
  return svc.api(path, options);
}

// ------------------------------------------------------------------
// Screens: setup / blocked / fatal / app
// ------------------------------------------------------------------
function showOnly(id) {
  ['setupScreen', 'blockedScreen', 'fatalScreen', 'appShell'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.style.display = s === id ? 'flex' : 'none';
  });
}

function showFatal(title, detail) {
  document.getElementById('fatalTitle').textContent = title;
  document.getElementById('fatalDetail').textContent = detail;
  showOnly('fatalScreen');
}

function showSetup() {
  showOnly('setupScreen');
  const driveBtn = document.getElementById('setupDriveBtn');
  if (driveBtn) driveBtn.style.display = 'none';
  import('./drive.js').then(m => { if (m.isConfigured() && driveBtn) driveBtn.style.display = ''; }).catch(() => {});
}

async function showApp() {
  showOnly('appShell');
  renderUserBadge();
  routes.dashboard();
  initAppWidgets();
  refreshBackupBanner();
}

function renderUserBadge() {
  const el = document.getElementById('userBadge');
  if (!el || !currentUser) return;
  el.innerHTML = `
    <div class="user-badge-name">${esc(currentUser.full_name)}</div>
    <div class="page-desc" style="margin:0 0 4px">${esc(currentUser.workspace_name || '')}</div>
    <div class="user-badge-row">
      <button class="btn-link" onclick="openProfileModal()">Ubah Profil</button>
    </div>`;
}

document.getElementById('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('setupError');
  errBox.style.display = 'none';
  try {
    currentUser = await api('/api/profile/setup', {
      method: 'POST',
      body: JSON.stringify({
        full_name: document.getElementById('setupName').value.trim(),
        workspace_name: document.getElementById('setupWorkspace').value.trim(),
      }),
    });
    bak.requestPersistentStorage();
    toast('Workspace siap. Anda berada di paket Demo.');
    showApp();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

function openProfileModal() {
  openModal(`
    <div class="page-eyebrow">Workspace</div>
    <div class="page-title" style="font-size:18px">Ubah Profil</div>
    <p class="page-desc">Nama Anda tercatat sebagai reviewer pada keputusan HR dan tahapan rekrutmen.</p>
    <div class="form-grid single">
      <div class="field"><label>Nama Lengkap</label><input id="profName" value="${esc(currentUser.full_name)}" /></div>
      <div class="field"><label>Nama Workspace</label><input id="profWorkspace" value="${esc(currentUser.workspace_name || '')}" /></div>
    </div>
    <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="saveProfile()">Simpan</button>
    <p class="field-hint" style="margin-top:12px">MRI Personal Workspace v${esc(cfg.APP_VERSION)}</p>
  `);
}

async function saveProfile() {
  try {
    currentUser = await api('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({ full_name: document.getElementById('profName').value, workspace_name: document.getElementById('profWorkspace').value }),
    });
    renderUserBadge();
    toast('Profil diperbarui.');
    closeModal();
  } catch (e) { toast('Gagal menyimpan: ' + e.message, true); }
}

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------
function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  toastStack.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openModal(html) {
  modal.innerHTML = `<button class="modal-close" onclick="closeModal()">&times;</button>${html}`;
  modalOverlay.classList.add('open');
}
function closeModal() { modalOverlay.classList.remove('open'); modal.innerHTML = ''; }
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOverlay.classList.contains('open')) closeModal(); });

function scoreChipClass(rec) {
  return { STRONG_MATCH: 'strong', POSSIBLE_MATCH: 'possible', WEAK_MATCH: 'weak', NOT_MATCH: 'none' }[rec] || 'none';
}
function triggerBrowserDownload(blob, filename) {
  const link = document.createElement('a');
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

async function downloadFile(url, filenameFallback) {
  try {
    const res = await svc.apiFile(url);
    const filename = res.filename || filenameFallback;
    triggerBrowserDownload(res.blob, filename);
    toast(`Mengunduh ${filename}`);
    if (url.startsWith('/api/export/')) copyExportToDrive(res.blob, filename, res.type);
  } catch (e) {
    toast('Gagal mengunduh: ' + e.message, true);
  }
}

// Optional: keep a copy of every exported report in Drive > "5 File Distribusi".
// Silent when Drive is not connected — never blocks or repeats the download.
async function copyExportToDrive(blob, filename, type) {
  try {
    const m = await import('./drive.js');
    if (!m.prefs.autoDistribute() || !m.isConnected()) return;
    const f = await m.uploadFile('dist', filename, blob, type || 'application/octet-stream', { overwrite: true });
    toast(`Salinan tersimpan di Google Drive › File Distribusi: ${f.name}`);
  } catch (e) {
    toast('Salinan ke Google Drive gagal: ' + e.message, true);
  }
}
function recLabel(rec) {
  return { STRONG_MATCH: 'Strong Match', POSSIBLE_MATCH: 'Possible Match', WEAK_MATCH: 'Weak Match', NOT_MATCH: 'No Match' }[rec] || rec;
}

// ------------------------------------------------------------------
// Kriteria/Requirement dinamis (tambah/hapus baris bebas) — dipakai di
// Job Requirement Engine & Knowledge Center > Kriteria Jabatan, supaya HR
// bisa menambahkan kriteria apa pun yang belum ada di kolom baku (mis.
// usia, domisili, SIM, dll). Kriteria ini dicatat sebagai catatan untuk
// ditinjau manual oleh HR/Recruiter — TIDAK ikut dihitung otomatis oleh
// skor AI Screening, karena datanya bukan sesuatu yang diekstrak dari CV.
function renderCriteriaListEditor(containerId, initialItems = []) {
  const items = [...initialItems];
  const container = document.getElementById(containerId);
  if (!container) return;

  function paint() {
    container.innerHTML = `
      <div id="${containerId}_rows">
        ${items.map((txt, i) => `
          <div class="criteria-row" style="display:flex; gap:6px; align-items:center; margin-bottom:6px">
            <input class="criteria-row-input" data-idx="${i}" value="${esc(txt)}" style="flex:1" />
            <button type="button" class="btn btn-danger btn-xs" onclick="removeCriteriaRow('${containerId}', ${i})">Hapus</button>
          </div>`).join('') || '<p class="page-desc">Belum ada kriteria tambahan.</p>'}
      </div>
      <div style="display:flex; gap:6px; margin-top:6px">
        <input id="${containerId}_new" placeholder="mis. Usia maksimal 35 tahun, SIM A, Berdomisili Tangerang..." style="flex:1" />
        <button type="button" class="btn btn-secondary btn-sm" onclick="addCriteriaRow('${containerId}')">+ Tambah Kriteria</button>
      </div>`;
    container.querySelectorAll('.criteria-row-input').forEach(inp => {
      inp.addEventListener('input', (e) => { items[Number(e.target.dataset.idx)] = e.target.value; });
    });
    const newInput = document.getElementById(`${containerId}_new`);
    if (newInput) newInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCriteriaRow(containerId); }
    });
  }

  window[`__criteria_${containerId}`] = { items, paint };
  paint();
}

function addCriteriaRow(containerId) {
  const state = window[`__criteria_${containerId}`];
  const input = document.getElementById(`${containerId}_new`);
  const val = (input?.value || '').trim();
  if (!val) { toast('Isi kriteria dulu sebelum menambahkan.', true); return; }
  state.items.push(val);
  state.paint();
}

function removeCriteriaRow(containerId, idx) {
  const state = window[`__criteria_${containerId}`];
  state.items.splice(idx, 1);
  state.paint();
}

function getCriteriaListValues(containerId) {
  const state = window[`__criteria_${containerId}`];
  return state ? state.items.filter(x => x && x.trim()) : [];
}
function displayName(name) {
  // No-hallucination rule: never invent a name, show an honest placeholder instead.
  return name ? esc(name) : '<em style="color:var(--text-tertiary)">Nama belum terdeteksi</em>';
}

// ------------------------------------------------------------------
// Navigation
// ------------------------------------------------------------------
const routes = {
  dashboard: renderDashboard,
  intake: renderIntake,
  screening: renderScreening,
  bank: renderBank,
  pool: renderPool,
  vacancies: renderVacancies,
  knowledge: renderKnowledge,
  audit: renderAudit,
  employees: renderEmployees,
  license: renderLicense,
  backup: renderBackup,
  drive: renderDrive,
};

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  routes[btn.dataset.page]();
  refreshBackupBanner();
});

// ------------------------------------------------------------------
// 01. EXECUTIVE DASHBOARD
// ------------------------------------------------------------------
async function renderDashboard() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 01</div>
      <div class="page-title">Executive Recruitment Dashboard</div>
      <div class="page-desc">Ringkasan menyeluruh proses rekrutmen — dari CV masuk hingga hiring — sebagai satu output dari sistem MRI.</div>
    </div>
    <div id="dashBody">Memuat data...</div>`;

  try {
    const [kpi, alignment] = await Promise.all([
      api('/api/dashboard/executive'),
      api('/api/dashboard/ai-hr-alignment'),
    ]);
    const f = kpi.funnel;
    // Transaction-based steps (can exceed unique candidate count — labelled explicitly, v1.1 Sec.20).
    const funnelSteps = [
      ['CV Diterima (unique)', f.cv_received], ['AI Screened (transaksi)', f.ai_screened],
      ['HR Reviewed (transaksi)', f.hr_reviewed], ['Shortlisted / Pass (transaksi)', f.shortlisted],
      ['HR Interview (transaksi)', f.hr_interview], ['Assessment (transaksi)', f.assessment],
      ['User Interview (transaksi)', f.user_interview], ['Offering (transaksi)', f.offering],
      ['Medical (transaksi)', f.medical], ['Hired (transaksi)', f.hired],
    ];
    const maxVal = Math.max(1, ...funnelSteps.map(s => s[1]));
    const uc = kpi.unique_candidates;
    const tx = kpi.transactions;

    document.getElementById('dashBody').innerHTML = `
      <div class="section-title">Unique Candidates <span class="page-desc" style="font-weight:400">— headcount, tidak dobel-hitung meski kandidat sama discreening ke banyak lowongan</span></div>
      <div class="grid grid-4">
        ${kpiCard('Total CV Bank', uc.total_cv_bank)}
        ${kpiCard('Kandidat Discreening', uc.screened)}
        ${kpiCard('Kandidat Direview HR', uc.hr_reviewed)}
        ${kpiCard('Kandidat Hired', uc.hired)}
      </div>

      <div class="section-title" style="margin-top:20px">Screening &amp; Decision Transactions <span class="page-desc" style="font-weight:400">— 1 baris per kandidat × lowongan × event</span></div>
      <div class="grid grid-4">
        ${kpiCard('Screening Transactions', tx.screening_transactions)}
        ${kpiCard('Rata-rata Match Score', kpi.average_ai_match_score)}
        ${kpiCard('HR Pass Rate', kpi.hr_pass_pct + '%')}
        ${kpiCard('HR Reject Rate', kpi.hr_reject_pct + '%')}
        ${kpiCard('Talent Pool Aktif', kpi.talent_pool_active)}
        ${kpiCard('Lowongan Terbuka', kpi.open_vacancy)}
        ${kpiCard('Hire Conversion (dari transaksi)', kpi.hiring_conversion_pct + '%')}
        ${kpiCard('High Match Transactions', kpi.high_match_pct + '%')}
      </div>

      <div class="card" style="margin-top:16px">
        <div class="section-title">Recruitment Funnel <span class="ai-tag" style="text-transform:none">basis: transaksi kecuali ditandai (unique)</span></div>
        <div class="funnel">
          ${funnelSteps.map(([label, val]) => `
            <div class="funnel-row">
              <div class="funnel-label">${label}</div>
              <div class="funnel-bar-track"><div class="funnel-bar-fill" style="width:${(val / maxVal) * 100}%"></div></div>
              <div class="funnel-value">${val}</div>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="section-title">AI ↔ HR Alignment</div>
        <div class="page-desc" style="margin-bottom:10px">${alignment.note}</div>
        ${alignment.total_reviewed
          ? `<div class="grid grid-2">
              ${kpiCard('Alignment', alignment.ai_hr_alignment_pct + '%')}
              ${kpiCard('AI Direvisi HR', alignment.ai_recommendation_overridden_pct + '%')}
             </div>`
          : `<div class="empty-state"><div class="empty-state-icon">·</div>Belum ada keputusan HR untuk dianalisis.</div>`}
      </div>

      <div class="card">
        <div class="section-title">Employee Overview </div>
        <div class="grid grid-4">
          ${kpiCard('Total Employees', kpi.employees.total_employees)}
          ${kpiCard('Active', kpi.employees.active_employees)}
          ${kpiCard('Permanent', kpi.employees.permanent)}
          ${kpiCard('Contract Expiring ≤30d', kpi.employees.contract_expiring_30d)}
        </div>
      </div>

      <div class="card" id="demoModeCard">Memuat status demo...</div>
    `;
    loadDemoModeCard();
  } catch (e) {
    document.getElementById('dashBody').innerHTML = `<div class="empty-state">Gagal memuat dashboard: ${esc(e.message)}</div>`;
  }
}

function kpiCard(label, value) {
  return `<div class="card kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div></div>`;
}

// ------------------------------------------------------------------
// Demo Mode (V1.2 Part I)
// ------------------------------------------------------------------
async function loadDemoModeCard() {
  const card = document.getElementById('demoModeCard');
  if (!card) return;
  const status = await api('/api/demo/status');
  if (status.demo_mode_active) {
    card.innerHTML = `
      <div class="section-title">Data Demo <span class="badge TALENT_POOL">AKTIF</span></div>
      <p class="page-desc">Aplikasi sedang berisi ${status.demo_candidates} kandidat data demo (data fiktif, aman dihapus kapan saja). ${status.real_candidates > 0 ? `Ada juga ${status.real_candidates} kandidat data nyata yang tidak akan tersentuh oleh reset.` : ''}</p>
      <button class="btn btn-danger btn-sm" onclick="resetDemoData()">Reset Demo Data</button>
    `;
  } else {
    card.innerHTML = `
      <div class="section-title">Data Demo</div>
      <p class="page-desc">Coba MRI dengan data contoh yang realistis (kandidat, lowongan, screening, talent pool, dan karyawan) tanpa perlu setup data sendiri.</p>
      <button class="btn btn-primary btn-sm" onclick="seedDemoData()">Load Demo Data</button>
    `;
  }
}

async function seedDemoData() {
  const card = document.getElementById('demoModeCard');
  card.innerHTML = `<div class="page-desc">Menyiapkan data demo (kandidat, lowongan, screening, talent pool, karyawan)...</div>`;
  try {
    const result = await api('/api/demo/seed', { method: 'POST' });
    toast(`Demo data siap: ${result.candidates} kandidat, ${result.vacancies} lowongan, ${result.employees} karyawan.`);
    renderDashboard();
  } catch (e) {
    toast('Gagal memuat demo data: ' + e.message, true);
    loadDemoModeCard();
  }
}

async function resetDemoData() {
  if (!confirm('Hapus seluruh data demo? Data nyata (jika ada) tidak akan terpengaruh.')) return;
  try {
    const result = await api('/api/demo/reset', { method: 'POST' });
    toast(`Demo data dihapus: ${result.candidates_deleted} kandidat, ${result.vacancies_deleted} lowongan, ${result.employees_deleted} karyawan.`);
    renderDashboard();
  } catch (e) {
    toast('Gagal reset demo data: ' + e.message, true);
  }
}

// ------------------------------------------------------------------
// 10. PAKET & UPGRADE (Demo / Premium / VIP — Web V2)
// ------------------------------------------------------------------
async function renderLicense() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 10</div>
      <div class="page-title">Paket &amp; Upgrade</div>
      <div class="page-desc">Cek status paket workspace Anda, dan upgrade ke Premium/VIP dengan kode aktivasi dari penjual. Kode diverifikasi di perangkat ini tanpa internet.</div>
    </div>
    <div id="licenseBody">Memuat status...</div>`;

  try {
    const status = await api('/api/license/status');
    renderLicenseBody(status);
  } catch (e) {
    document.getElementById('licenseBody').innerHTML = `<div class="empty-state">Gagal memuat status paket: ${esc(e.message)}</div>`;
  }
}

function fmtLimit(n) { return (n === null || n === undefined) ? 'Unlimited' : n; }

function usageBar(used, max) {
  if (max === null || max === undefined) return `<div class="page-desc">${used} terpakai (Unlimited)</div>`;
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return `<div class="page-desc">${used} / ${max} terpakai</div>
          <div class="funnel-bar-track" style="margin-top:4px"><div class="funnel-bar-fill" style="width:${pct}%"></div></div>`;
}

function renderLicenseBody(status) {
  const body = document.getElementById('licenseBody');
  const L = status.limits, U = status.usage;
  const planBadgeClass = status.plan === 'DEMO' ? 'HOLD' : 'PASS';

  const planCard = `
    <div class="card">
      <div class="section-title">Status Paket <span class="badge ${planBadgeClass}">${esc(status.plan_label).toUpperCase()}</span></div>
      ${status.license_invalid ? '<p class=\"page-desc\" style=\"color:var(--accent-coral)\">Kode aktivasi yang tersimpan tidak lolos verifikasi (rusak atau bukan dari penjual ini), sehingga paket kembali ke Demo. Masukkan kode aktivasi yang valid.</p>' : ''}
      ${status.plan !== 'DEMO' ? `<p class="page-desc">
          Diaktifkan untuk: <strong>${esc(status.buyer_name || '-')}</strong><br/>
          Tanggal terbit kode: ${esc(status.license_issued_date || '-')}<br/>
          Diaktifkan pada: ${status.activated_at ? new Date(status.activated_at).toLocaleString('id-ID') : '-'}
        </p>` : `<p class="page-desc">Workspace Anda berjalan di paket Demo (gratis). Upgrade ke Premium/VIP untuk membuka limit &amp; fitur lebih lengkap.</p>`}

      <div class="form-grid" style="margin-top:10px">
        <div>
          <div class="section-title" style="font-size:13px">Kandidat nyata</div>
          ${usageBar(U.real_candidates, L.max_candidates)}
        </div>
        <div>
          <div class="section-title" style="font-size:13px">Lowongan (Job Requirement)</div>
          ${usageBar(U.job_requirements, L.max_job_requirements)}
        </div>
      </div>
      <p class="page-desc" style="margin-top:10px">
        Export laporan (Excel/PDF): ${L.export_reports ? '<span class="badge PASS">Tersedia</span>' : '<span class="badge REJECT">Tidak tersedia di paket ini</span>'}<br/>
        Analitik lanjutan (AI &amp; alignment): ${L.advanced_analytics ? '<span class="badge PASS">Tersedia</span>' : '<span class="badge REJECT">Tidak tersedia di paket ini</span>'}
      </p>
    </div>`;

  const upgradeCard = status.plan === 'VIP' ? '' : `
    <div class="card">
      <div class="section-title">Upgrade ke Premium / VIP</div>
      <p class="page-desc">Tempel kode aktivasi yang kamu terima dari penjual di bawah ini, atau unggah sebagai file .lic / .txt. Kode ini disimpan di workspace ini dan ikut ter-backup.</p>
      <div class="field">
        <label>Kode Aktivasi</label>
        <textarea id="licenseTextInput" rows="4" placeholder="Tempel kode aktivasi Premium/VIP di sini..."></textarea>
      </div>
      <div class="field">
        <label>Atau unggah file kode aktivasi</label>
        <input type="file" id="licenseFileInput" accept=".lic,.txt" />
      </div>
      <button class="btn btn-primary btn-sm" id="activateBtn" onclick="activateLicense()">Aktivasi Kode</button>
    </div>`;

  body.innerHTML = planCard + upgradeCard;

  const fileInput = document.getElementById('licenseFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      document.getElementById('licenseTextInput').value = text.trim();
    });
  }
}

async function activateLicense() {
  const textInput = document.getElementById('licenseTextInput');
  const btn = document.getElementById('activateBtn');
  const license_text = textInput.value.trim();
  if (!license_text) {
    toast('Tempel atau unggah kode aktivasi terlebih dahulu.', true);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Memverifikasi...';
  try {
    const result = await api('/api/license/activate', { method: 'POST', body: JSON.stringify({ license_text }) });
    toast(`${result.plan} aktif untuk ${result.buyer_name}.`);
    refreshLicenseBadge();
    renderLicense();
  } catch (e) {
    toast('Aktivasi gagal: ' + e.message, true);
    btn.disabled = false;
    btn.textContent = 'Aktivasi Kode';
  }
}

async function refreshLicenseBadge() {
  const badge = document.getElementById('licenseBadge');
  if (!badge) return;
  try {
    const status = await api('/api/license/status');
    const cls = status.plan === 'DEMO' ? 'HOLD' : 'PASS';
    badge.innerHTML = `<span class="badge ${cls}" style="margin-top:6px; display:inline-block">${esc(status.plan_label).toUpperCase()}</span>`;
  } catch (e) { /* non-fatal */ }
}

// ------------------------------------------------------------------
// 02. CV INTAKE
// ------------------------------------------------------------------
function renderIntake() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 02</div>
      <div class="page-title">CV Intake</div>
      <div class="page-desc">Unggah CV satu per satu, banyak sekaligus, atau seluruh folder. Sistem otomatis mengekstrak profil kandidat, mendeteksi duplikasi, dan menyimpannya ke CV Bank.</div>
    </div>
    <div class="filter-bar" style="margin-bottom:0">
      <button class="btn btn-secondary btn-sm intake-tab active" data-tab="single">Single Upload</button>
      <button class="btn btn-secondary btn-sm intake-tab" data-tab="multiple">Multiple Files</button>
      <button class="btn btn-secondary btn-sm intake-tab" data-tab="folder">Batch Upload Folder</button>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="form-grid">
        <div class="field">
          <label>Sumber CV</label>
          <select id="cvSource">
            <option>Job Portal</option><option>LinkedIn</option><option>Company Website</option>
            <option>Email</option><option>Employee Referral</option><option>Recruitment Agency</option>
            <option>Walk-in</option><option>Internal Candidate</option><option>Job Fair</option>
            <option selected>Manual Upload</option><option>Historical CV</option>
          </select>
        </div>
      </div>

      <div id="tab-single">
        <div class="upload-drop" id="uploadDrop" style="margin-top:14px">
          <input type="file" id="cvFile" accept=".pdf,.docx,.txt" style="display:none" />
          <div><strong>Klik untuk pilih file</strong> atau seret CV ke sini (.pdf / .docx / .txt)</div>
        </div>
      </div>

      <div id="tab-multiple" style="display:none">
        <div class="upload-drop" id="uploadDropMulti" style="margin-top:14px">
          <input type="file" id="cvFilesMulti" accept=".pdf,.docx,.txt" multiple style="display:none" />
          <div><strong>Klik untuk pilih beberapa file CV sekaligus</strong> (.pdf / .docx / .txt)</div>
        </div>
      </div>

      <div id="tab-folder" style="display:none">
        <div class="upload-drop" id="uploadDropFolder" style="margin-top:14px">
          <input type="file" id="cvFilesFolder" webkitdirectory directory multiple style="display:none" />
          <div><strong>Klik untuk pilih folder berisi CV</strong><br><span class="page-desc">Semua file .pdf/.docx/.txt dalam folder akan diproses; format lain otomatis dilaporkan gagal.</span></div>
        </div>
        <p class="field-hint">Fitur folder-select mengandalkan dukungan browser (Chrome/Edge). Jika browser tidak mendukung, gunakan tab "Multiple Files".</p>
      </div>

      <div id="uploadResult" style="margin-top:16px"></div>
    </div>`;

  document.querySelectorAll('.intake-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.intake-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['single', 'multiple', 'folder'].forEach(t => {
        document.getElementById(`tab-${t}`).style.display = t === btn.dataset.tab ? 'block' : 'none';
      });
      document.getElementById('uploadResult').innerHTML = '';
    });
  });

  const drop = document.getElementById('uploadDrop');
  const fileInput = document.getElementById('cvFile');
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleUpload(fileInput.files[0]); });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--accent-blue)'; });
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.style.borderColor = 'var(--border)';
    if (e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]);
  });

  const dropMulti = document.getElementById('uploadDropMulti');
  const filesMultiInput = document.getElementById('cvFilesMulti');
  dropMulti.addEventListener('click', () => filesMultiInput.click());
  filesMultiInput.addEventListener('change', () => { if (filesMultiInput.files.length) handleBatchUpload(Array.from(filesMultiInput.files)); });

  const dropFolder = document.getElementById('uploadDropFolder');
  const filesFolderInput = document.getElementById('cvFilesFolder');
  dropFolder.addEventListener('click', () => filesFolderInput.click());
  filesFolderInput.addEventListener('change', () => { if (filesFolderInput.files.length) handleBatchUpload(Array.from(filesFolderInput.files)); });
}

async function handleUpload(file) {
  const resultBox = document.getElementById('uploadResult');
  resultBox.innerHTML = `<div class="page-desc">Mengekstrak CV dengan AI Engine...</div>`;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('source', document.getElementById('cvSource').value);
  try {
    const res = await api('/api/cv/upload', { method: 'POST', body: fd });
    const c = res.candidate;
    const dupLabel = { file_hash: 'file identik', email: 'email sama', phone: 'no. HP sama' }[res.duplicate_signal] || '';
    resultBox.innerHTML = `
      <div class="card" style="background:var(--surface-raised)">
        <div class="section-title">${res.duplicate_detected ? `Kandidat sudah ada di CV Bank (cocok via ${dupLabel})` : 'Kandidat baru ditambahkan ke CV Bank'}</div>
        <p><strong>${displayName(c.name)}</strong> — ${esc(c.email || 'email tidak terdeteksi')} · ${esc(c.phone || 'no. HP tidak terdeteksi')}</p>
        <p class="page-desc">Pendidikan tertinggi: ${esc(c.highest_education || '-')} · Pengalaman: ${c.total_experience_years || 0} tahun · Total CV terunggah untuk kandidat ini: ${res.upload_count_for_candidate}</p>
        <div class="section-title" style="font-size:12.5px; margin-top:10px">Keahlian Terdeteksi (ekstraksi umum, tidak tergantung lowongan aktif)</div>
        <div class="tag-list">${(res.extraction.skills_found || []).map(s => `<span class="tag matched">${esc(s)}</span>`).join('') || '<span class="page-desc">Tidak ada keahlian dari pustaka umum yang terdeteksi.</span>'}</div>
        <div class="section-title" style="font-size:12.5px; margin-top:10px">Sertifikasi Terdeteksi</div>
        <div class="tag-list">${(res.extraction.certifications_found || []).map(s => `<span class="tag matched">${esc(s)}</span>`).join('') || '<span class="page-desc">Tidak ada sertifikasi terdeteksi.</span>'}</div>
        <div class="subtle-divider"></div>
        <button class="btn btn-primary btn-sm" onclick="openCandidateModal(${c.id})">Lihat Candidate 360</button>
      </div>`;
    toast('CV berhasil diproses AI Engine (ekstraksi umum, tidak bergantung pada lowongan aktif).');
  } catch (e) {
    resultBox.innerHTML = `<div class="empty-state">Gagal memproses CV: ${esc(e.message)}</div>`;
  }
}

// ------------------------------------------------------------------
// Batch / Folder Upload (V1.2 Part A)
// ------------------------------------------------------------------
async function handleBatchUpload(files) {
  const resultBox = document.getElementById('uploadResult');
  const source = document.getElementById('cvSource').value;
  const startedAt = performance.now();

  resultBox.innerHTML = `
    <div class="card" style="background:var(--surface-raised)">
      <div class="section-title">Memproses ${files.length} file...</div>
      <div class="funnel-bar-track" style="height:14px; margin:10px 0"><div class="funnel-bar-fill" id="batchProgressBar" style="width:0%"></div></div>
      <div class="page-desc" id="batchProgressText">0 / ${files.length}</div>
    </div>`;

  let batchId;
  try {
    const start = await api(`/api/batch-upload/start?total_files=${files.length}&source=${encodeURIComponent(source)}`, { method: 'POST' });
    batchId = start.batch_id;
  } catch (e) {
    resultBox.innerHTML = `<div class="empty-state">Gagal memulai batch: ${esc(e.message)}</div>`;
    return;
  }

  const fileResults = [];
  for (let i = 0; i < files.length; i++) {
    const fd = new FormData();
    fd.append('file', files[i]);
    try {
      const r = await api(`/api/batch-upload/${batchId}/file`, { method: 'POST', body: fd });
      fileResults.push(r);
    } catch (e) {
      fileResults.push({ filename: files[i].name, status: 'FAILED', reason: e.message });
    }
    const pct = Math.round(((i + 1) / files.length) * 100);
    const bar = document.getElementById('batchProgressBar');
    const txt = document.getElementById('batchProgressText');
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = `${i + 1} / ${files.length}`;
  }

  const durationSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  try {
    await api(`/api/batch-upload/${batchId}/finish?duration_seconds=${durationSeconds}`, { method: 'POST' });
  } catch (e) { /* non-fatal for display purposes */ }

  const summary = await api(`/api/batch-upload/${batchId}`);
  renderBatchResult(summary);
  toast(`Batch selesai: ${summary.new_candidates} kandidat baru, ${summary.duplicate} duplikat, ${summary.failed} gagal.`);
}

function renderBatchResult(summary) {
  const resultBox = document.getElementById('uploadResult');
  resultBox.innerHTML = `
    <div class="card" style="background:var(--surface-raised)">
      <div class="section-title">Batch Upload Result <span class="page-desc" style="font-weight:400">#${summary.batch_id}</span></div>
      <div class="grid grid-4" style="margin:10px 0">
        ${kpiCard('Total File', summary.total_files)}
        ${kpiCard('Berhasil', summary.new_candidates)}
        ${kpiCard('Duplicate', summary.duplicate)}
        ${kpiCard('Gagal', summary.failed)}
      </div>
      <p class="page-desc">Durasi proses: ${summary.duration_seconds ?? '-'} detik · Diunggah oleh: ${esc(summary.uploaded_by)}</p>
      <div class="table-wrap" style="margin-top:10px">
        <table>
          <thead><tr><th>File</th><th>Status</th><th>Keterangan</th><th></th></tr></thead>
          <tbody>
            ${summary.files.map(f => `
              <tr>
                <td>${esc(f.filename)}</td>
                <td><span class="badge ${f.status === 'SUCCESS' ? 'PASS' : f.status === 'DUPLICATE' ? 'TALENT_POOL' : 'REJECT'}">${f.status}</span></td>
                <td class="page-desc">${esc(f.reason || (f.candidate_name ? `Kandidat: ${f.candidate_name}` : '-'))}</td>
                <td>${f.candidate_id ? `<button class="btn btn-secondary btn-sm" onclick="openCandidateModal(${f.candidate_id})">Lihat</button>` : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ------------------------------------------------------------------
// 03. SCREENING CENTER
// ------------------------------------------------------------------
async function renderScreening() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 03</div>
      <div class="page-title">Screening Center</div>
      <div class="page-desc">Halaman operasional utama HR: jalankan AI matching terhadap lowongan, lalu tinjau dan putuskan.</div>
    </div>
    <div id="screeningBody">Memuat...</div>`;

  const vacancies = await api('/api/vacancies');
  if (!vacancies.length) {
    document.getElementById('screeningBody').innerHTML = `<div class="empty-state"><div class="empty-state-icon">·</div>Belum ada Job Requirement. Buat lowongan dulu di Modul 06.</div>`;
    return;
  }
  document.getElementById('screeningBody').innerHTML = `
    <div class="filter-bar">
      <select id="vacancySelect">${vacancies.map(v => `<option value="${v.id}">${esc(v.position)} — ${esc(v.department || '')}</option>`).join('')}</select>
      <button class="btn btn-secondary btn-sm" id="runAllBtn">Screen Semua Kandidat CV Bank</button>
      <button class="btn btn-secondary btn-sm" id="exportScreeningXlsxBtn">⬇ Excel</button>
      <button class="btn btn-secondary btn-sm" id="exportScreeningPdfBtn">⬇ PDF</button>
    </div>
    <div id="screeningTableWrap">Memuat data screening...</div>`;

  const select = document.getElementById('vacancySelect');
  select.addEventListener('change', () => loadScreeningTable(select.value));
  document.getElementById('runAllBtn').addEventListener('click', () => runAllScreenings(select.value));
  document.getElementById('exportScreeningXlsxBtn').addEventListener('click', () =>
    downloadFile(`/api/export/screening/${select.value}.xlsx`, 'Screening_Report.xlsx'));
  document.getElementById('exportScreeningPdfBtn').addEventListener('click', () =>
    downloadFile(`/api/export/screening/${select.value}.pdf`, 'Screening_Report.pdf'));
  loadScreeningTable(select.value);
}

async function loadScreeningTable(vacancyId) {
  const wrap = document.getElementById('screeningTableWrap');
  const data = await api(`/api/screening-center/${vacancyId}`);
  if (!data.candidates.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">·</div>Belum ada kandidat yang di-screening untuk lowongan ini. Klik "Screen Semua Kandidat CV Bank".</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="grid grid-3" style="margin-bottom:16px">
      ${kpiCard('Total Discreening', data.summary.total_cv)}
      ${kpiCard('High Match', data.summary.high_match)}
      ${kpiCard('Perlu Review', data.summary.review)}
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th></th><th>Rank</th><th>Kandidat</th><th>Match Score</th><th>Rekomendasi AI</th><th>Status HR</th><th></th></tr></thead>
        <tbody>
          ${data.candidates.map(c => `
            <tr class="clickable-row" onclick="toggleScreeningDetail(${c.screening_id})">
              <td><span id="chevron_${c.screening_id}" class="expand-chevron">▸</span></td>
              <td>${c.rank}</td>
              <td>${displayName(c.candidate_name)}</td>
              <td><span class="score-chip ${scoreChipClass(c.recommendation)}">${c.match_score}</span></td>
              <td>${recLabel(c.recommendation)}</td>
              <td><span class="badge ${c.hr_status}">${c.hr_status.replace('_', ' ')}</span></td>
              <td><button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openScreeningModal(${c.screening_id})">Review</button></td>
            </tr>
            <tr id="detail_${c.screening_id}" class="screening-detail-row" style="display:none">
              <td colspan="7">${renderScreeningDetailInline(c)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

const CRITERIA_LABELS = { education: 'Pendidikan', experience: 'Pengalaman', technical_skills: 'Keahlian Teknis', soft_skills: 'Soft Skill', leadership: 'Kepemimpinan', certification: 'Sertifikasi' };

function renderScreeningDetailInline(c) {
  return `
    <div class="screening-detail-inline">
      <div class="section-title" style="font-size:13px">Skor per Kriteria <span class="ai-tag">AI · confidence ${c.confidence}</span></div>
      ${Object.entries(c.criteria_scores).map(([k, v]) => `
        <div class="criteria-row">
          <div class="criteria-name">${CRITERIA_LABELS[k] || k}</div>
          <div class="criteria-track"><div class="criteria-fill" style="width:${v}%"></div></div>
          <div class="criteria-score">${v}</div>
        </div>`).join('') || '<p class="page-desc">Tidak ada rincian skor.</p>'}

      <div class="grid grid-2" style="margin-top:10px">
        <div>
          <div class="section-title" style="font-size:13px">Matched Criteria</div>
          <div class="tag-list">${(c.matched_criteria.length ? c.matched_criteria : ['-']).map(m => `<span class="tag matched">${esc(m)}</span>`).join('')}</div>
        </div>
        <div>
          <div class="section-title" style="font-size:13px">Missing Criteria</div>
          <div class="tag-list">${(c.missing_criteria.length ? c.missing_criteria : ['Tidak ada']).map(m => `<span class="tag missing">${esc(m)}</span>`).join('')}</div>
        </div>
      </div>

      <div class="section-title" style="font-size:13px; margin-top:10px">AI Summary</div>
      <p class="page-desc">${esc(c.summary || '-')}</p>
      <div class="section-title" style="font-size:13px">Gap Analysis</div>
      <p class="page-desc">${esc(c.gap_analysis || '-')}</p>
    </div>`;
}

function toggleScreeningDetail(screeningId) {
  const row = document.getElementById(`detail_${screeningId}`);
  const chevron = document.getElementById(`chevron_${screeningId}`);
  const isOpen = row.style.display !== 'none';
  row.style.display = isOpen ? 'none' : 'table-row';
  chevron.textContent = isOpen ? '▸' : '▾';
}

async function runAllScreenings(vacancyId) {
  const btn = document.getElementById('runAllBtn');
  btn.disabled = true; btn.textContent = 'Menjalankan AI Matching...';
  try {
    const candidates = await api('/api/candidates');
    const existing = await api(`/api/screening-center/${vacancyId}`);
    const alreadyScreened = new Set(existing.candidates.map(c => c.candidate_id));
    let count = 0;
    for (const c of candidates) {
      if (alreadyScreened.has(c.id)) continue;
      await api('/api/screening/run', { method: 'POST', body: JSON.stringify({ candidate_id: c.id, vacancy_id: Number(vacancyId) }) });
      count++;
    }
    toast(`${count} kandidat baru selesai di-screening AI.`);
    loadScreeningTable(vacancyId);
  } catch (e) {
    toast('Gagal menjalankan screening: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Screen Semua Kandidat CV Bank';
  }
}

async function openScreeningModal(screeningId) {
  const s = await api(`/api/screening/${screeningId}`);
  const criteriaLabels = { education: 'Pendidikan', experience: 'Pengalaman', technical_skills: 'Keahlian Teknis', soft_skills: 'Soft Skill', leadership: 'Kepemimpinan', certification: 'Sertifikasi' };

  openModal(`
    <div class="page-eyebrow">Detail Screening</div>
    <div class="page-title" style="font-size:19px">${esc(s.candidate.name)} → ${esc(s.vacancy_position)}</div>
    <div style="margin:10px 0"><span class="score-chip ${scoreChipClass(s.recommendation)}">${s.overall_score}</span> <span class="ai-tag">AI · confidence ${s.confidence}</span></div>

    <div class="section-title" style="margin-top:16px">Skor per Kriteria</div>
    ${Object.entries(s.criteria_scores).map(([k, v]) => `
      <div class="criteria-row">
        <div class="criteria-name">${criteriaLabels[k] || k}</div>
        <div class="criteria-track"><div class="criteria-fill" style="width:${v}%"></div></div>
        <div class="criteria-score">${v}</div>
      </div>`).join('')}

    <div class="section-title">Matched Criteria</div>
    <div class="tag-list">${(s.matched_criteria.length ? s.matched_criteria : ['-']).map(m => `<span class="tag matched">${esc(m)}</span>`).join('')}</div>

    <div class="section-title" style="margin-top:14px">Missing Criteria</div>
    <div class="tag-list">${(s.missing_criteria.length ? s.missing_criteria : ['Tidak ada']).map(m => `<span class="tag missing">${esc(m)}</span>`).join('')}</div>

    <div class="section-title" style="margin-top:14px">AI Summary &amp; Gap Analysis</div>
    <p class="page-desc">${esc(s.summary)}</p>
    <p class="page-desc">${esc(s.gap_analysis)}</p>

    <div class="subtle-divider"></div>
    <div class="section-title">Keputusan HR <span class="hr-tag">Human Decision</span></div>
    ${s.hr_decision ? `
      <p class="page-desc">Keputusan tersimpan: <span class="badge ${s.hr_decision.decision}">${s.hr_decision.decision}</span> — ${esc(s.hr_decision.reason)} oleh ${esc(s.hr_decision.reviewer)}</p>
    ` : ''}
    <div class="form-grid single">
      <div class="field"><label>Alasan</label><input id="hrReason" placeholder="mis. Keahlian teknis sesuai kebutuhan" value="${s.hr_decision ? esc(s.hr_decision.reason) : ''}" /></div>
      <div class="field"><label>Catatan (opsional)</label><textarea id="hrRemarks">${s.hr_decision ? esc(s.hr_decision.remarks || '') : ''}</textarea></div>
      <div class="field"><label>Reviewer</label><div class="reviewer-readonly">🔒 ${esc(currentUser.full_name)}</div></div>
    </div>
        <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="submitDecision(${s.id}, 'PASS')">Pass</button>
      <button class="btn btn-violet btn-sm" onclick="submitDecision(${s.id}, 'TALENT_POOL')">Talent Pool</button>
      <button class="btn btn-warn btn-sm" onclick="submitDecision(${s.id}, 'HOLD')">Hold</button>
      <button class="btn btn-danger btn-sm" onclick="submitDecision(${s.id}, 'REJECT')">Reject</button>
    </div>
  `);
}

async function submitDecision(screeningId, decision) {
  const reason = document.getElementById('hrReason').value.trim();
  const remarks = document.getElementById('hrRemarks').value.trim();
  if (!reason) { toast('Isi Alasan dulu.', true); return; }
  try {
    // The reviewer is never sent from the UI — the services always record the workspace owner.
    await api('/api/hr-decision', { method: 'POST', body: JSON.stringify({ screening_id: screeningId, decision, reason, remarks }) });
    toast('Keputusan HR tersimpan.');
    closeModal();
    const select = document.getElementById('vacancySelect');
    if (select) loadScreeningTable(select.value);
  } catch (e) {
    toast('Gagal menyimpan keputusan: ' + e.message, true);
  }
}

// ------------------------------------------------------------------
// 04. CV BANK & SEARCH
// ------------------------------------------------------------------
async function renderBank() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 04</div>
      <div class="page-title">CV Bank &amp; Candidate Search</div>
      <div class="page-desc">Seluruh kandidat yang pernah masuk ke sistem — termasuk yang pernah ditolak — tersimpan di sini untuk digunakan kembali di lowongan mendatang.</div>
    </div>
    <div class="filter-bar">
      <input id="searchQ" placeholder="Cari nama..." />
      <input id="searchMinExp" type="number" placeholder="Min. pengalaman (thn)" style="width:170px" />
      <select id="searchEdu">
        <option value="">Semua Pendidikan</option>
        <option>SMA/SMK</option><option>D3</option><option>S1</option><option>S2</option><option>S3</option>
      </select>
      <button class="btn btn-secondary btn-sm" id="searchBtn">Cari</button>
      <button class="btn btn-secondary btn-sm" onclick="downloadFile('/api/export/candidates.xlsx', 'CV_Bank.xlsx')">⬇ Export Excel</button>
    </div>
    <div id="bankTableWrap">Memuat...</div>`;

  document.getElementById('searchBtn').addEventListener('click', loadBank);
  loadBank();
}

async function loadBank() {
  const q = document.getElementById('searchQ').value.trim();
  const minExp = document.getElementById('searchMinExp').value;
  const edu = document.getElementById('searchEdu').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (minExp) params.set('min_experience', minExp);
  if (edu) params.set('education', edu);
  const candidates = await api('/api/candidates?' + params.toString());
  const wrap = document.getElementById('bankTableWrap');
  if (!candidates.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">·</div>Belum ada kandidat di CV Bank. Unggah CV di Modul 02.</div>`;
    return;
  }
  wrap.innerHTML = `<div class="card table-wrap">
    <table>
      <thead><tr><th>Nama</th><th>Pendidikan</th><th>Pengalaman</th><th>Sumber</th><th>Keahlian</th><th></th></tr></thead>
      <tbody>
        ${candidates.map(c => `
          <tr class="clickable-row" onclick="openCandidateModal(${c.id})">
            <td><strong>${displayName(c.name)}</strong><br><span class="page-desc">${esc(c.email || '-')}</span></td>
            <td>${esc(c.highest_education || '-')}</td>
            <td>${c.total_experience_years || 0} thn</td>
            <td>${esc(c.source || '-')}</td>
            <td><div class="tag-list">${(c.skills.slice(0, 3)).map(s => `<span class="tag">${esc(s)}</span>`).join('')}${c.skills.length > 3 ? `<span class="tag">+${c.skills.length - 3}</span>` : ''}</div></td>
            <td><button class="btn btn-secondary btn-sm">Detail</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

async function openCandidateModal(candidateId) {
  const [data, vacancies, stageConfigs] = await Promise.all([
    api(`/api/candidates/${candidateId}`), api('/api/vacancies'), api('/api/stage-config'),
  ]);
  const p = data.profile;
  const hasHiredStage = data.recruitment_journey.some(j => j.stage_code === 'HIRED');

  openModal(`
    <div class="page-eyebrow">Candidate 360</div>
    <div class="page-title" style="font-size:19px">${displayName(p.name)}</div>
    <p class="page-desc">${esc(p.email || '-')} · ${esc(p.phone || '-')} · Sumber: ${esc(p.source || '-')}</p>

    <div class="section-title" style="margin-top:10px">File CV Terunggah <span class="page-desc" style="font-weight:400">(${data.cvs.length} file)</span></div>
    ${data.cvs.length ? data.cvs.map(cv => `
      <div class="list-item-chip">
        <span>${esc(cv.filename)} <span class="page-desc">· diunggah ${new Date(cv.uploaded_at).toLocaleDateString('id-ID')} · ${esc(cv.source || '-')}</span></span>
        <button class="btn btn-secondary btn-xs" onclick="downloadFile('/api/cv/${cv.id}/download', 'CV')">⬇ Unduh</button>
      </div>`).join('') : '<div class="page-desc">Tidak ada file tersimpan.</div>'}

    ${hasHiredStage ? `
    <div class="card" style="background:var(--accent-teal-dim); border-color:var(--accent-teal); margin-top:12px">
      <div class="section-title" style="color:var(--accent-teal)">Kandidat sudah mencapai tahap HIRED</div>
      <p class="page-desc">Buat record Employee untuk melanjutkan pengelolaan data karyawan di Employee Data Center.</p>
      <button class="btn btn-primary btn-sm" onclick="createEmployeeFromCandidateModal(${candidateId})">+ Create Employee</button>
    </div>` : ''}

    <div class="section-title" style="margin-top:14px">Jalankan AI Screening Baru</div>
    <div style="display:flex; gap:8px">
      <select id="modalVacancySelect" style="flex:1; background:var(--surface-raised); border:1px solid var(--border); color:var(--text-primary); border-radius:6px; padding:8px;">
        ${vacancies.map(v => `<option value="${v.id}">${esc(v.position)}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" onclick="runScreeningFromModal(${candidateId})">Screen</button>
    </div>
    <p class="field-hint">Screening baru terhadap vacancy lain TIDAK menimpa skor screening sebelumnya — setiap kombinasi kandidat×vacancy tersimpan sebagai transaksi terpisah.</p>

    <div class="section-title" style="margin-top:16px">Riwayat Screening <span class="ai-tag">${data.screening_history.length} transaksi</span></div>
    ${data.screening_history.length ? data.screening_history.map(s => `
      <div class="list-item-chip">
        <span>${esc(s.vacancy_position)} <span class="page-desc">· ${new Date(s.processed_at).toLocaleDateString('id-ID')}</span></span>
        <span><span class="score-chip ${scoreChipClass(s.recommendation)}">${s.overall_score}</span> ${s.hr_decision ? `<span class="badge ${s.hr_decision.decision}">${s.hr_decision.decision}</span>` : '<span class="badge PENDING_REVIEW">PENDING</span>'}</span>
      </div>`).join('') : '<div class="page-desc">Belum pernah di-screening.</div>'}

    <div class="section-title" style="margin-top:16px">Recruitment Journey</div>
    ${data.recruitment_journey.length ? data.recruitment_journey.map(j => `
      <div class="list-item-chip">
        <span>${esc(j.stage_code)} — ${esc(j.vacancy_position || '')}${j.overall_score !== null ? ` · skor ${j.overall_score}` : ''}</span>
        <span>${j.decision ? `<span class="badge ${j.decision}">${j.decision}</span>` : `<span class="badge PENDING_REVIEW">${esc(j.status)}</span>`}</span>
      </div>
    `).join('') : '<div class="page-desc">Belum ada tahapan rekrutmen tercatat.</div>'}

    <div class="section-title" style="margin-top:16px">Catat Stage Assessment Baru <span class="hr-tag">Human Input</span></div>
    <div class="form-grid single">
      <div class="field"><label>Vacancy</label>
        <select id="stageVacancy">${vacancies.map(v => `<option value="${v.id}">${esc(v.position)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Stage</label>
        <select id="stageCode" onchange="refreshStageQuestionBank()">
          ${stageConfigs.filter(s => s.stage_code !== 'CV_SCREENING').map(s => `<option value="${s.stage_code}" data-assess="${s.assessment_required}" data-decision="${s.decision_required}">${esc(s.stage_name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Kriteria Penilaian (nama:skor, pisahkan koma — mis. Communication:85, Leadership:90)</label>
        <input id="stageCriteria" placeholder="Communication:85, Leadership:90, Problem Solving:80" />
      </div>
      <div class="field">
        <label>Evidence (opsional, format sama: nama:catatan)
          <button type="button" class="btn btn-ghost btn-xs" style="margin-left:6px" onclick="openQuestionBankPicker()">📚 Import dari Bank Pertanyaan</button>
        </label>
        <textarea id="stageEvidence" placeholder="Communication:Menjawab studi kasus dengan runtut"></textarea>
      </div>
      <div class="field"><label>Reason</label><input id="stageReason" placeholder="mis. Kandidat menunjukkan kepemimpinan kuat" /></div>
      <div class="field"><label>Remarks (opsional)</label><textarea id="stageRemarks"></textarea></div>
      <div class="field"><label>Reviewer</label><div class="reviewer-readonly">🔒 ${esc(currentUser.full_name)}</div></div>
      <div class="field"><label>Keputusan HR</label>
        <select id="stageDecision"><option value="PASS">PASS</option><option value="HOLD">HOLD</option><option value="REJECT">REJECT</option></select>
      </div>
    </div>
    <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="submitStageAssessment(${candidateId})">Simpan Stage Assessment</button>
    <p class="field-hint">Reviewer tercatat otomatis atas nama pemilik workspace (lihat Ubah Profil) — tidak diketik manual (audit trail per-stage).</p>

    <div class="section-title" style="margin-top:16px">Keahlian &amp; Sertifikasi <span class="page-desc" style="font-weight:400">(ekstraksi umum CV, bukan hasil matching vacancy)</span></div>
    <div class="tag-list">${p.skills.map(s => `<span class="tag matched">${esc(s)}</span>`).join('') || '<span class="page-desc">-</span>'}</div>
    <div class="tag-list" style="margin-top:6px">${p.certifications.map(s => `<span class="tag">${esc(s)}</span>`).join('') || ''}</div>
  `);
}

async function refreshStageQuestionBank() {
  // no-op hook kept for future live-filtering; question bank picker re-queries on open
}

async function openQuestionBankPicker() {
  const stageCode = document.getElementById('stageCode')?.value || '';
  let questions = [];
  try {
    questions = await api(`/api/knowledge/interview-questions?stage_code=${encodeURIComponent(stageCode)}`);
  } catch (e) {
    toast('Gagal memuat bank pertanyaan: ' + e.message, true);
    return;
  }
  const listHtml = questions.length ? questions.map(q => `
    <label class="qbank-item">
      <input type="checkbox" value="${q.id}" data-text="${esc(q.question_text)}" />
      <div>
        <div class="qbank-text">${esc(q.question_text)}</div>
        <div class="page-desc">${esc(q.competency || '-')} · ${esc(q.question_type || '-')} · dipakai ${q.times_used}x</div>
      </div>
    </label>`).join('') : '<p class="page-desc">Belum ada pertanyaan untuk stage ini di Knowledge Center.</p>';

  openModal(`
    <div class="page-eyebrow">Knowledge Center</div>
    <div class="page-title" style="font-size:18px">Import Pertanyaan Interview</div>
    <p class="page-desc">Pilih pertanyaan yang dipakai di sesi ini — teks akan ditambahkan ke kolom Evidence sebagai checklist.</p>
    <div id="qbankList" style="max-height:340px; overflow:auto; margin-top:10px">${listHtml}</div>
    <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="applyPickedQuestions()">Tambahkan ke Evidence</button>
  `);
}

async function applyPickedQuestions() {
  const checked = Array.from(document.querySelectorAll('#qbankList input[type=checkbox]:checked'));
  const evidenceField = document.getElementById('stageEvidence');
  const lines = checked.map(cb => `${cb.dataset.text}:-`);
  if (evidenceField) {
    evidenceField.value = [evidenceField.value.trim(), ...lines].filter(Boolean).join(', ');
  }
  for (const cb of checked) {
    api(`/api/knowledge/interview-questions/${cb.value}/mark-used`, { method: 'POST' }).catch(() => {});
  }
  toast(`${checked.length} pertanyaan ditambahkan.`);
  closeModal();
}

async function submitStageAssessment(candidateId) {
  const vacancy_id = Number(document.getElementById('stageVacancy').value);
  const stage_code = document.getElementById('stageCode').value;
  const reason = document.getElementById('stageReason').value.trim();
  const remarks = document.getElementById('stageRemarks').value.trim();
  const decision = document.getElementById('stageDecision').value;

  const parsePairs = (raw) => {
    const out = {};
    raw.split(',').forEach(pair => {
      const [k, v] = pair.split(':');
      if (k && v !== undefined && k.trim()) out[k.trim()] = isNaN(Number(v.trim())) ? v.trim() : Number(v.trim());
    });
    return out;
  };
  const criteria_scores = parsePairs(document.getElementById('stageCriteria').value.trim());
  const evidence = parsePairs(document.getElementById('stageEvidence').value.trim());

  try {
    // The reviewer is never sent from the UI — the services always record the workspace owner.
    const result = await api('/api/recruitment-stage', {
      method: 'POST',
      body: JSON.stringify({ candidate_id: candidateId, vacancy_id, stage_code, criteria_scores, evidence, reason, remarks, decision }),
    });
    toast(`Stage assessment tersimpan — skor rata-rata ${result.overall_score ?? '-'}.`);
    openCandidateModal(candidateId);
  } catch (e) {
    toast('Gagal menyimpan stage assessment: ' + e.message, true);
  }
}

async function runScreeningFromModal(candidateId) {
  const vacancyId = document.getElementById('modalVacancySelect').value;
  try {
    const result = await api('/api/screening/run', { method: 'POST', body: JSON.stringify({ candidate_id: candidateId, vacancy_id: Number(vacancyId) }) });
    toast(`Screening selesai — skor ${result.overall_score}`);
    openScreeningModal(result.id);
  } catch (e) {
    toast('Gagal menjalankan screening: ' + e.message, true);
  }
}

// ------------------------------------------------------------------
// 05. TALENT POOL
// ------------------------------------------------------------------
async function renderPool() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 05</div>
      <div class="page-title">Talent Pool</div>
      <div class="page-desc">Subset kandidat pilihan HR dari CV Bank untuk potensi rekrutmen di masa depan. Bisa diaktifkan ulang (re-match) terhadap lowongan baru.</div>
    </div>
    <div class="filter-bar" style="justify-content:flex-end">
      <button class="btn btn-secondary btn-sm" onclick="downloadFile('/api/export/talent-pool.xlsx', 'Talent_Pool.xlsx')">⬇ Export Excel</button>
    </div>
    <div id="poolBody">Memuat...</div>`;

  const [pool, vacancies] = await Promise.all([api('/api/talent-pool'), api('/api/vacancies')]);
  const wrap = document.getElementById('poolBody');
  if (!pool.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">·</div>Talent Pool masih kosong. Kandidat masuk ke sini saat HR memilih keputusan "Talent Pool" di Screening Center.</div>`;
    return;
  }
  wrap.innerHTML = `<div class="card table-wrap">
    <table>
      <thead><tr><th>Kandidat</th><th>Status</th><th>Usia (hari)</th><th>Catatan</th><th>Re-match ke Lowongan</th></tr></thead>
      <tbody>
        ${pool.map(p => `
          <tr>
            <td><a class="link" onclick="openCandidateModal(${p.candidate_id})">${displayName(p.candidate_name)}</a></td>
            <td><span class="badge ${p.status}">${p.status}</span></td>
            <td>${p.aging_days}</td>
            <td class="page-desc">${esc(p.notes || '-')}</td>
            <td>
              <div style="display:flex; gap:6px">
                <select id="reactivateVacancy-${p.candidate_id}" style="background:var(--surface-raised); border:1px solid var(--border); color:var(--text-primary); border-radius:6px; padding:6px; font-size:12px;">
                  ${vacancies.map(v => `<option value="${v.id}">${esc(v.position)}</option>`).join('')}
                </select>
                <button class="btn btn-violet btn-sm" onclick="reactivateCandidate(${p.candidate_id})">Re-match</button>
              </div>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

async function reactivateCandidate(candidateId) {
  const vacancyId = document.getElementById(`reactivateVacancy-${candidateId}`).value;
  try {
    const result = await api('/api/talent-pool/reactivate', { method: 'POST', body: JSON.stringify({ candidate_id: candidateId, vacancy_id: Number(vacancyId) }) });
    toast(`Kandidat di-reactivate, skor baru: ${result.overall_score}`);
    renderPool();
  } catch (e) {
    toast('Gagal reactivate: ' + e.message, true);
  }
}

// ------------------------------------------------------------------
// 06. JOB REQUIREMENT
// ------------------------------------------------------------------
async function renderVacancies() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 06</div>
      <div class="page-title">Job Requirement Engine</div>
      <div class="page-desc">Setiap lowongan memiliki profil kriteria terstruktur dan bobot yang bisa dikonfigurasi — dasar bagi AI matching.</div>
    </div>
    <div class="two-col">
      <div id="vacancyList">Memuat daftar lowongan...</div>
      <div class="card">
        <div class="section-title">Buat Job Requirement Baru</div>
        <div class="field">
          <label>📚 Mulai dari Template Knowledge Center (opsional)</label>
          <select id="vTemplatePicker" onchange="applyKnowledgeTemplate()">
            <option value="">— Mulai dari kosong —</option>
          </select>
        </div>
        <div class="form-grid single">
          <div class="field"><label>Posisi</label><input id="vPosition" placeholder="mis. Production Supervisor" /></div>
          <div class="field"><label>Departemen</label><input id="vDept" placeholder="mis. Manufacturing" /></div>
          <div class="field"><label>Level</label><input id="vLevel" placeholder="mis. Staff / Supervisor / Manager" /></div>
          <div class="field"><label>Lokasi</label><input id="vLocation" placeholder="mis. Tangerang" /></div>
          <div class="field"><label>Pendidikan Minimum</label>
            <select id="vEdu"><option>SMA/SMK</option><option>D3</option><option selected>S1</option><option>S2</option><option>S3</option></select>
          </div>
          <div class="field"><label>Pengalaman Minimum (tahun)</label><input id="vExp" type="number" value="2" /></div>
          <div class="field"><label>Keahlian Teknis (pisahkan koma)</label><input id="vTechSkills" placeholder="mis. Six Sigma, SAP, Production Planning" /></div>
          <div class="field"><label>Soft Skill (pisahkan koma)</label><input id="vSoftSkills" placeholder="mis. Leadership, Communication" /></div>
          <div class="field"><label>Sertifikasi Wajib (pisahkan koma)</label><input id="vCerts" placeholder="mis. Six Sigma Green Belt" /></div>
          <div class="field"><label><input type="checkbox" id="vLeadership" style="width:auto"/> Membutuhkan pengalaman kepemimpinan</label></div>
          <div class="field">
            <label>Kriteria/Requirement Tambahan
              <button type="button" class="btn btn-ghost btn-xs" style="margin-left:6px" onclick="openUniversityPickerForVacancy()">🎓 Tambah dari Daftar Universitas</button>
            </label>
            <p class="page-desc" style="margin:2px 0 6px">Untuk kriteria yang belum ada di kolom manapun di atas — mis. usia, domisili, SIM, status pernikahan, dll. Dicatat sebagai catatan untuk ditinjau HR/Recruiter secara manual, <strong>tidak dinilai otomatis oleh AI</strong>. Untuk kriteria berbasis atribut yang dilindungi hukum (agama, ras, suku, dsb.), pastikan sesuai UU Ketenagakerjaan Pasal 5-6 — hanya dipakai bila memang ada dasar kualifikasi pekerjaan yang sah.</p>
            <div id="vMandatoryEditor"></div>
          </div>
          <div class="field"><label>Passing Score</label><input id="vPassScore" type="number" value="75" /></div>
          <div class="field"><label>Minimum Score</label><input id="vMinScore" type="number" value="60" /></div>
        </div>
        <button class="btn btn-primary btn-sm" style="margin-top:14px" onclick="createVacancy()">Simpan Job Requirement</button>
      </div>
    </div>`;
  loadVacancyList();
  loadKnowledgeTemplatesForVacancy();
  renderCriteriaListEditor('vMandatoryEditor', []);
}

let knowledgeTemplatesCache = [];
let selectedKnowledgeTemplateId = null;

async function loadKnowledgeTemplatesForVacancy() {
  try {
    knowledgeTemplatesCache = await api('/api/knowledge/job-criteria');
    const sel = document.getElementById('vTemplatePicker');
    if (sel) {
      sel.innerHTML = '<option value="">— Mulai dari kosong —</option>' +
        knowledgeTemplatesCache.map(t => `<option value="${t.id}">${esc(t.title)} (dipakai ${t.times_used}x)</option>`).join('');
    }
  } catch (e) { /* non-fatal */ }
}

function applyKnowledgeTemplate() {
  const id = Number(document.getElementById('vTemplatePicker').value);
  selectedKnowledgeTemplateId = id || null;
  if (!id) return;
  const t = knowledgeTemplatesCache.find(x => x.id === id);
  if (!t) return;
  document.getElementById('vPosition').value = t.position || '';
  document.getElementById('vDept').value = t.department || '';
  document.getElementById('vLevel').value = t.job_level || '';
  document.getElementById('vEdu').value = t.min_education || 'S1';
  document.getElementById('vExp').value = t.min_experience_years || 0;
  document.getElementById('vTechSkills').value = (t.technical_skills || []).join(', ');
  document.getElementById('vSoftSkills').value = (t.soft_skills || []).join(', ');
  document.getElementById('vCerts').value = (t.certifications_required || []).join(', ');
  document.getElementById('vLeadership').checked = !!t.leadership_required;
  renderCriteriaListEditor('vMandatoryEditor', t.mandatory_criteria || []);
  document.getElementById('vPassScore').value = t.passing_score || 75;
  document.getElementById('vMinScore').value = t.minimum_score || 60;
  toast(`Form diisi dari template "${t.title}". Sesuaikan bila perlu, lalu simpan.`);
}

async function openUniversityPickerForVacancy() {
  let unis = [];
  try { unis = await api('/api/knowledge/universities'); } catch (e) { toast('Gagal memuat daftar universitas.', true); return; }
  openModal(`
    <div class="page-eyebrow">Knowledge Center</div>
    <div class="page-title" style="font-size:18px">Pilih dari Daftar Universitas &amp; IPK Minimum</div>
    <div id="uniPickList" style="max-height:340px; overflow:auto; margin-top:10px">
      ${unis.map(u => `
        <label class="qbank-item">
          <input type="checkbox" value="${u.id}" data-text="Lulusan dari ${esc(u.name)} (${esc(u.tier || '-')}, IPK ≥ ${u.min_gpa ?? '-'})" />
          <div>
            <div class="qbank-text">${esc(u.name)}</div>
            <div class="page-desc">${esc(u.tier || '-')} · ${esc(u.accreditation || '-')} · Min. IPK ${u.min_gpa ?? '-'}</div>
          </div>
        </label>`).join('') || '<p class="page-desc">Belum ada data di Knowledge Center.</p>'}
    </div>
    <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="applyPickedUniversities()">Tambahkan ke Kriteria Wajib</button>
  `);
}

function applyPickedUniversities() {
  const checked = Array.from(document.querySelectorAll('#uniPickList input[type=checkbox]:checked'));
  const state = window['__criteria_vMandatoryEditor'];
  checked.forEach(cb => state.items.push(cb.dataset.text));
  state.paint();
  toast(`${checked.length} kriteria universitas ditambahkan.`);
  closeModal();
}

async function loadVacancyList() {
  const vacancies = await api('/api/vacancies');
  document.getElementById('vacancyList').innerHTML = vacancies.length ? vacancies.map(v => `
    <div class="card">
      <div class="section-title">${esc(v.position)} <span class="badge ${v.status === 'OPEN' ? 'PASS' : 'HOLD'}">${v.status}</span></div>
      <p class="page-desc">${esc(v.department || '-')} · ${esc(v.job_level || '-')} · ${esc(v.location || '-')}</p>
      <p class="page-desc">Min. pendidikan: ${esc(v.min_education || '-')} · Min. pengalaman: ${v.min_experience_years} thn · Passing score: ${v.passing_score}</p>
      <div class="tag-list">${(v.technical_skills || []).map(s => `<span class="tag">${esc(s)}</span>`).join('')}</div>
    </div>`).join('') : `<div class="empty-state"><div class="empty-state-icon">·</div>Belum ada Job Requirement.</div>`;
}

async function createVacancy() {
  const payload = {
    position: document.getElementById('vPosition').value.trim(),
    department: document.getElementById('vDept').value.trim(),
    job_level: document.getElementById('vLevel').value.trim(),
    location: document.getElementById('vLocation').value.trim(),
    min_education: document.getElementById('vEdu').value,
    min_experience_years: Number(document.getElementById('vExp').value || 0),
    technical_skills: document.getElementById('vTechSkills').value.split(',').map(s => s.trim()).filter(Boolean),
    soft_skills: document.getElementById('vSoftSkills').value.split(',').map(s => s.trim()).filter(Boolean),
    certifications_required: document.getElementById('vCerts').value.split(',').map(s => s.trim()).filter(Boolean),
    leadership_required: document.getElementById('vLeadership').checked,
    mandatory_criteria: getCriteriaListValues('vMandatoryEditor'),
    passing_score: Number(document.getElementById('vPassScore').value || 75),
    minimum_score: Number(document.getElementById('vMinScore').value || 60),
  };
  if (!payload.position) { toast('Nama posisi wajib diisi.', true); return; }
  try {
    const qs = selectedKnowledgeTemplateId ? `?from_knowledge_id=${selectedKnowledgeTemplateId}` : '';
    await api(`/api/vacancies${qs}`, { method: 'POST', body: JSON.stringify(payload) });
    toast('Job Requirement tersimpan.');
    document.getElementById('vPosition').value = '';
    selectedKnowledgeTemplateId = null;
    renderCriteriaListEditor('vMandatoryEditor', []);
    loadVacancyList();
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, true);
  }
}

// ------------------------------------------------------------------
// 07. AUDIT TRAIL
// ------------------------------------------------------------------
async function renderAudit() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 07</div>
      <div class="page-title">Audit Trail</div>
      <div class="page-desc">Setiap keputusan manusia dan pemrosesan AI dicatat: siapa, kapan, apa, dan mengapa.</div>
    </div>
    <div id="auditBody">Memuat...</div>`;
  const entries = await api('/api/audit-trail');
  document.getElementById('auditBody').innerHTML = entries.length ? `<div class="card table-wrap">
    <table>
      <thead><tr><th>Waktu</th><th>Entitas</th><th>Aksi</th><th>Oleh</th><th>Alasan</th></tr></thead>
      <tbody>
        ${entries.map(e => `
          <tr>
            <td class="page-desc">${new Date(e.when).toLocaleString('id-ID')}</td>
            <td>${esc(e.entity_type)} #${e.entity_id}</td>
            <td>${e.who === 'AI_ENGINE' ? `<span class="ai-tag">${esc(e.action)}</span>` : `<span class="hr-tag">${esc(e.action)}</span>`}</td>
            <td>${esc(e.who)}</td>
            <td class="page-desc">${esc(e.why || '-')}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>` : `<div class="empty-state"><div class="empty-state-icon">·</div>Belum ada aktivitas tercatat.</div>`;
}

// ------------------------------------------------------------------
// 09. EMPLOYEE DATA CENTER (V1.2 Part D)
// ------------------------------------------------------------------

async function createEmployeeFromCandidateModal(candidateId) {
  try {
    const result = await api('/api/employees/from-candidate', {
      method: 'POST',
      body: JSON.stringify({ candidate_id: candidateId }),
    });
    if (result.already_existed) {
      toast('Employee sudah pernah dibuat untuk kandidat ini — membuka data yang ada.');
    } else {
      toast('Employee berhasil dibuat. Lengkapi detail di Employee Data Center.');
    }
    closeModal();
    openEmployeeModal(result.employee.id);
  } catch (e) {
    toast('Gagal membuat Employee: ' + e.message, true);
  }
}

async function renderEmployees() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 09</div>
      <div class="page-title">Employee Data Center</div>
      <div class="page-desc">Kelola data karyawan setelah kandidat dinyatakan Hired. Modul ini terpisah secara logis dari CV Bank — Candidate ≠ Employee.</div>
    </div>
    <div id="empKpiRow">Memuat...</div>

    <div class="card" style="margin-top:16px">
      <div class="section-title">Import Data Karyawan (Excel)</div>
      <p class="page-desc">Untuk memasukkan data karyawan yang sudah ada sebelumnya (tidak harus berasal dari proses rekrutmen MRI).</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="downloadFile('/api/employees/import-template.xlsx', 'MRI_Employee_Import_Template.xlsx')">⬇ Download Template</button>
        <input type="file" id="empImportFile" accept=".xlsx" style="display:none" />
        <button class="btn btn-primary btn-sm" onclick="document.getElementById('empImportFile').click()">⬆ Upload &amp; Import Excel</button>
      </div>
      <div id="empImportResult" style="margin-top:12px"></div>
    </div>

    <div class="filter-bar" style="margin-top:16px">
      <input id="empSearchQ" placeholder="Cari nama..." />
      <input id="empDept" placeholder="Departemen" style="width:160px" />
      <select id="empType"><option value="">Semua Tipe</option></select>
      <select id="empStatus"><option value="">Semua Status</option></select>
      <button class="btn btn-secondary btn-sm" id="empSearchBtn">Cari</button>
      <button class="btn btn-secondary btn-sm" onclick="downloadFile('/api/export/employees.xlsx', 'Employee_Data.xlsx')">⬇ Excel</button>
      <button class="btn btn-secondary btn-sm" onclick="downloadFile('/api/export/employees.pdf', 'Employee_Report.pdf')">⬇ PDF</button>
    </div>
    <div id="empTableWrap">Memuat...</div>`;

  document.getElementById('empImportFile').addEventListener('change', (e) => {
    if (e.target.files[0]) handleEmployeeImport(e.target.files[0]);
  });

  const [kpi, options] = await Promise.all([api('/api/dashboard/employee'), api('/api/employee-options')]);
  document.getElementById('empKpiRow').innerHTML = `
    <div class="grid grid-4">
      ${kpiCard('Total Employees', kpi.total_employees)}
      ${kpiCard('Active', kpi.active_employees)}
      ${kpiCard('Contract Expiring ≤7d', kpi.contract_expiring_critical_7d)}
      ${kpiCard('Contract Expiring 8-30d', kpi.contract_expiring_warning_30d)}
    </div>`;

  const typeSelect = document.getElementById('empType');
  options.employment_type.forEach(t => typeSelect.insertAdjacentHTML('beforeend', `<option value="${esc(t)}">${esc(t)}</option>`));
  const statusSelect = document.getElementById('empStatus');
  options.employment_status.forEach(s => statusSelect.insertAdjacentHTML('beforeend', `<option value="${esc(s)}">${esc(s)}</option>`));

  document.getElementById('empSearchBtn').addEventListener('click', () => loadEmployeeTable(1));
  loadEmployeeTable(1);
}

async function handleEmployeeImport(file) {
  const resultBox = document.getElementById('empImportResult');
  resultBox.innerHTML = `<div class="page-desc">Memproses file Excel...</div>`;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await api('/api/employees/import', { method: 'POST', body: fd });
    resultBox.innerHTML = `
      <div class="card" style="background:var(--surface-raised)">
        <div class="section-title">Hasil Import</div>
        <div class="grid grid-4" style="margin:10px 0">
          ${kpiCard('Total Baris', res.total_rows)}
          ${kpiCard('Valid', res.valid)}
          ${kpiCard('Duplicate', res.duplicate)}
          ${kpiCard('Invalid', res.invalid)}
        </div>
        ${res.errors.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Baris</th><th>Status</th><th>Keterangan</th></tr></thead>
            <tbody>
              ${res.errors.map(e => `
                <tr><td>${e.row}</td><td><span class="badge ${e.status === 'DUPLICATE' ? 'TALENT_POOL' : 'REJECT'}">${e.status}</span></td><td class="page-desc">${esc(e.reason)}</td></tr>
              `).join('')}
            </tbody>
          </table>
        </div>` : '<p class="page-desc">Semua baris berhasil diimport tanpa error.</p>'}
      </div>`;
    toast(`Import selesai: ${res.imported_count} karyawan baru ditambahkan.`);
    loadEmployeeTable(1);
  } catch (e) {
    resultBox.innerHTML = `<div class="empty-state">Gagal import: ${esc(e.message)}</div>`;
  }
}

async function loadEmployeeTable(page) {
  const params = new URLSearchParams({ page, page_size: 20 });
  const q = document.getElementById('empSearchQ').value.trim();
  const dept = document.getElementById('empDept').value.trim();
  const type = document.getElementById('empType').value;
  const status = document.getElementById('empStatus').value;
  if (q) params.set('q', q);
  if (dept) params.set('department', dept);
  if (type) params.set('employment_type', type);
  if (status) params.set('employment_status', status);

  const data = await api('/api/employees?' + params.toString());
  const wrap = document.getElementById('empTableWrap');
  if (!data.employees.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">·</div>Belum ada Employee. Employee dibuat dari Candidate 360 setelah kandidat mencapai tahap HIRED.</div>`;
    return;
  }
  wrap.innerHTML = `<div class="card table-wrap">
    <table>
      <thead><tr><th>Nama</th><th>Departemen</th><th>Posisi</th><th>Tipe</th><th>Status</th><th>Kontrak Berakhir</th><th></th></tr></thead>
      <tbody>
        ${data.employees.map(e => `
          <tr class="clickable-row" onclick="openEmployeeModal(${e.id})">
            <td><strong>${displayName(e.full_name)}</strong><br><span class="page-desc">${esc(e.employee_number || '-')}</span></td>
            <td>${esc(e.department || '-')}</td>
            <td>${esc(e.position || '-')}</td>
            <td>${esc(e.employment_type || '-')}</td>
            <td><span class="badge ${e.employment_status === 'Active' ? 'ACTIVE' : 'HOLD'}">${esc(e.employment_status || '-')}</span></td>
            <td>${e.contract_end_date ? `${esc(e.contract_end_date)} ${e.contract_days_remaining !== null ? `<span class="page-desc">(${e.contract_days_remaining}d)</span>` : ''}` : '-'}</td>
            <td><button class="btn btn-secondary btn-sm">Detail</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="page-desc" style="margin-top:8px">Menampilkan ${data.employees.length} dari ${data.total} employee.</p>
  </div>`;
}

async function openEmployeeModal(employeeId) {
  const [detail, options] = await Promise.all([api(`/api/employees/${employeeId}`), api('/api/employee-options')]);
  const e = detail.employee;

  openModal(`
    <div class="page-eyebrow">Employee 360</div>
    <div class="page-title" style="font-size:19px">${displayName(e.full_name)}</div>
    <p class="page-desc">${esc(e.employee_number || 'Belum ada No. Karyawan')} · ${esc(e.email || '-')} · ${esc(e.phone || '-')}</p>

    <div class="section-title" style="margin-top:14px">Profile &amp; Employment</div>
    <div class="form-grid">
      <div class="field"><label>No. Karyawan</label><input id="empNumber" value="${esc(e.employee_number || '')}" /></div>
      <div class="field"><label>Nama Lengkap</label><input id="empName" value="${esc(e.full_name || '')}" /></div>
      <div class="field"><label>Departemen</label><input id="empDeptEdit" value="${esc(e.department || '')}" /></div>
      <div class="field"><label>Divisi</label><input id="empDivision" value="${esc(e.division || '')}" /></div>
      <div class="field"><label>Posisi</label><input id="empPosition" value="${esc(e.position || '')}" /></div>
      <div class="field"><label>Supervisor</label><input id="empSupervisor" value="${esc(e.supervisor || '')}" /></div>
      <div class="field"><label>Tipe Karyawan</label>
        <select id="empTypeEdit">${options.employment_type.map(t => `<option ${t === e.employment_type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Status Karyawan</label>
        <select id="empStatusEdit">${options.employment_status.map(s => `<option ${s === e.employment_status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Tanggal Join</label><input type="date" id="empJoinDate" value="${esc(e.join_date || '')}" /></div>
      <div class="field"><label>Lokasi</label><input id="empLocation" value="${esc(e.location || '')}" /></div>
      <div class="field"><label>Kontrak Mulai</label><input type="date" id="empContractStart" value="${esc(e.contract_start_date || '')}" /></div>
      <div class="field"><label>Kontrak Berakhir</label><input type="date" id="empContractEnd" value="${esc(e.contract_end_date || '')}" /></div>
    </div>
    <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="saveEmployeeEdit(${e.id})">Simpan Perubahan</button>
    <button class="btn btn-danger btn-sm" style="margin-top:12px; margin-left:8px" onclick="confirmDeleteEmployee(${e.id}, '${esc(e.full_name).replace(/'/g, "\\'")}')">Hapus Employee</button>

    <div class="section-title" style="margin-top:18px">Recruitment History <span class="page-desc" style="font-weight:400">— read-only, dari Candidate 360</span></div>
    <p class="page-desc">Asal kandidat: <a class="link" onclick="closeModal(); openCandidateModal(${e.candidate_id})">${displayName(detail.recruitment_history.candidate_name)} (Candidate #${e.candidate_id})</a></p>
    ${detail.recruitment_history.screenings.map(s => `
      <div class="list-item-chip"><span>${esc(s.vacancy_position)}</span><span><span class="score-chip ${scoreChipClass(s.recommendation)}">${s.overall_score}</span> ${s.hr_decision ? `<span class="badge ${s.hr_decision}">${s.hr_decision}</span>` : ''}</span></div>
    `).join('')}
    ${detail.recruitment_history.stages.map(s => `
      <div class="list-item-chip"><span>${esc(s.stage_code)}</span><span>${s.decision ? `<span class="badge ${s.decision}">${s.decision}</span>` : `<span class="badge PENDING_REVIEW">${esc(s.status)}</span>`}</span></div>
    `).join('')}

    <div class="section-title" style="margin-top:18px">Audit History</div>
    ${detail.audit_history.length ? detail.audit_history.map(a => `
      <div class="list-item-chip"><span class="hr-tag">${esc(a.action)}</span><span class="page-desc">${esc(a.who)} · ${new Date(a.when).toLocaleString('id-ID')}</span></div>
    `).join('') : '<div class="page-desc">Belum ada aktivitas.</div>'}
  `);
}

async function saveEmployeeEdit(employeeId) {
  const payload = {
    employee_number: document.getElementById('empNumber').value.trim(),
    full_name: document.getElementById('empName').value.trim(),
    department: document.getElementById('empDeptEdit').value.trim(),
    division: document.getElementById('empDivision').value.trim(),
    position: document.getElementById('empPosition').value.trim(),
    supervisor: document.getElementById('empSupervisor').value.trim(),
    employment_type: document.getElementById('empTypeEdit').value,
    employment_status: document.getElementById('empStatusEdit').value,
    join_date: document.getElementById('empJoinDate').value || null,
    location: document.getElementById('empLocation').value.trim(),
    contract_start_date: document.getElementById('empContractStart').value || null,
    contract_end_date: document.getElementById('empContractEnd').value || null,
  };
  try {
    const result = await api(`/api/employees/${employeeId}`, { method: 'PUT', body: JSON.stringify(payload) });
    toast(`Tersimpan — ${result.changed_fields} field berubah.`);
    closeModal();
    renderEmployees();
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, true);
  }
}

function confirmDeleteEmployee(employeeId, fullName) {
  openModal(`
    <div class="page-eyebrow">Konfirmasi</div>
    <div class="page-title" style="font-size:18px">Hapus data Employee?</div>
    <p class="page-desc" style="margin-top:8px">
      Anda akan menghapus data Employee <strong>${esc(fullName)}</strong>. Riwayat rekrutmen
      (Candidate, Screening, Recruitment Stage) <strong>tidak</strong> ikut terhapus dan tetap
      tersimpan sebagai arsip. Tindakan ini tidak bisa dibatalkan dari dalam aplikasi.
    </p>
    <div style="display:flex; gap:8px; margin-top:16px">
      <button class="btn btn-danger btn-sm" onclick="doDeleteEmployee(${employeeId})">Ya, Hapus</button>
      <button class="btn btn-secondary btn-sm" onclick="closeModal()">Batal</button>
    </div>
  `);
}

async function doDeleteEmployee(employeeId) {
  try {
    await api(`/api/employees/${employeeId}`, { method: 'DELETE' });
    toast('Data Employee dihapus.');
    closeModal();
    renderEmployees();
  } catch (e) {
    toast('Gagal menghapus: ' + e.message, true);
  }
}

// ------------------------------------------------------------------
// 08. KNOWLEDGE CENTER (V1.3)
// ------------------------------------------------------------------
let knowledgeTab = 'criteria';

async function renderKnowledge() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 08</div>
      <div class="page-title">Knowledge Center</div>
      <div class="page-desc">Library kriteria jabatan, daftar universitas &amp; IPK minimum, dan bank pertanyaan interview — dibuat sekali, dipakai berulang lintas lowongan.</div>
    </div>
    <div class="tab-bar">
      <button class="tab-btn ${knowledgeTab === 'criteria' ? 'active' : ''}" onclick="switchKnowledgeTab('criteria')">Kriteria Jabatan</button>
      <button class="tab-btn ${knowledgeTab === 'university' ? 'active' : ''}" onclick="switchKnowledgeTab('university')">Universitas &amp; IPK Minimum</button>
      <button class="tab-btn ${knowledgeTab === 'question' ? 'active' : ''}" onclick="switchKnowledgeTab('question')">Bank Pertanyaan Interview</button>
    </div>
    <div id="knowledgeBody">Memuat...</div>`;
  loadKnowledgeTab();
}

function switchKnowledgeTab(tab) { knowledgeTab = tab; renderKnowledge(); }

async function loadKnowledgeTab() {
  const body = document.getElementById('knowledgeBody');
  if (knowledgeTab === 'criteria') return loadKnowledgeCriteriaTab(body);
  if (knowledgeTab === 'university') return loadKnowledgeUniversityTab(body);
  return loadKnowledgeQuestionTab(body);
}

async function loadKnowledgeCriteriaTab(body) {
  const items = await api('/api/knowledge/job-criteria');
  body.innerHTML = `
        <div class="card" style="margin-bottom:14px">
      <div class="section-title">Tambah Template Kriteria Jabatan</div>
      <div class="form-grid single">
        <div class="field"><label>Judul Template</label><input id="kcTitle" placeholder="mis. Production Supervisor - Standard" /></div>
        <div class="field"><label>Posisi</label><input id="kcPosition" placeholder="mis. Production Supervisor" /></div>
        <div class="field"><label>Departemen</label><input id="kcDept" placeholder="mis. Manufacturing" /></div>
        <div class="field"><label>Level</label><input id="kcLevel" placeholder="mis. Supervisor" /></div>
        <div class="field"><label>Pendidikan Minimum</label>
          <select id="kcEdu"><option>SMA/SMK</option><option>D3</option><option selected>S1</option><option>S2</option><option>S3</option></select>
        </div>
        <div class="field"><label>Pengalaman Minimum (tahun)</label><input id="kcExp" type="number" value="2" /></div>
        <div class="field"><label>Keahlian Teknis (pisahkan koma)</label><input id="kcTech" placeholder="mis. Six Sigma, Production Planning" /></div>
        <div class="field"><label>Soft Skill (pisahkan koma)</label><input id="kcSoft" placeholder="mis. Leadership, Communication" /></div>
        <div class="field"><label>Sertifikasi (pisahkan koma)</label><input id="kcCert" placeholder="mis. Six Sigma Green Belt" /></div>
        <div class="field">
          <label>Kriteria/Requirement Tambahan</label>
          <p class="page-desc" style="margin:2px 0 6px">Untuk kriteria yang belum ada di kolom manapun di atas — mis. usia, domisili, SIM, dll. Bersifat catatan untuk ditinjau manual, tidak dinilai otomatis oleh AI. Hati-hati dengan kriteria berbasis atribut yang dilindungi hukum (agama, ras, dsb.) — lihat UU Ketenagakerjaan Pasal 5-6.</p>
          <div id="kcMandatoryEditor"></div>
        </div>
        <div class="field"><label>Passing Score</label><input id="kcPass" type="number" value="75" /></div>
        <div class="field"><label>Minimum Score</label><input id="kcMin" type="number" value="60" /></div>
        <div class="field"><label>Catatan</label><textarea id="kcNotes" placeholder="Catatan penggunaan template ini"></textarea></div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="createKnowledgeCriteria()">Simpan Template</button>
    </div>
    ${importCard('job-criteria', 'Template Kriteria Jabatan')}
    <div class="grid grid-2">
      ${items.length ? items.map(t => `
        <div class="card">
          <div class="section-title">${esc(t.title)} <span class="ai-tag">dipakai ${t.times_used}x</span></div>
          <p class="page-desc">${esc(t.position)} · ${esc(t.department || '-')} · ${esc(t.job_level || '-')}</p>
          <p class="page-desc">Min. pendidikan: ${esc(t.min_education || '-')} · Min. pengalaman: ${t.min_experience_years} thn</p>
          <div class="tag-list">${(t.technical_skills || []).map(s => `<span class="tag">${esc(s)}</span>`).join('')}</div>
          ${(t.mandatory_criteria || []).length ? `<div class="tag-list" style="margin-top:6px">${t.mandatory_criteria.map(c => `<span class="tag" style="background:var(--surface-raised)">${esc(c)}</span>`).join('')}</div>` : ''}
          <button class="btn btn-danger btn-xs" style="margin-top:10px" onclick="deactivateKnowledgeCriteria(${t.id})">Nonaktifkan</button>
        </div>`).join('') : '<div class="empty-state"><div class="empty-state-icon">·</div>Belum ada template kriteria jabatan.</div>'}
    </div>`;
  renderCriteriaListEditor('kcMandatoryEditor', []);
  wireImportCard('job-criteria');
}

function importCard(typeSlug, label) {
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="section-title">Import ${esc(label)} dari Excel</div>
      <p class="page-desc">Untuk menambahkan banyak data sekaligus dari file eksternal.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="downloadFile('/api/knowledge/${typeSlug}/import-template.xlsx', 'MRI_${typeSlug}_Template.xlsx')">⬇ Download Template</button>
        <input type="file" id="import_${typeSlug}_file" accept=".xlsx" style="display:none" />
        <button class="btn btn-primary btn-sm" onclick="document.getElementById('import_${typeSlug}_file').click()">⬆ Upload &amp; Import Excel</button>
      </div>
      <div id="import_${typeSlug}_result" style="margin-top:10px"></div>
    </div>`;
}

function wireImportCard(typeSlug) {
  const fileInput = document.getElementById(`import_${typeSlug}_file`);
  if (fileInput) fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleKnowledgeImport(typeSlug, e.target.files[0]);
  });
}

async function handleKnowledgeImport(typeSlug, file) {
  const resultBox = document.getElementById(`import_${typeSlug}_result`);
  resultBox.innerHTML = `<div class="page-desc">Memproses file Excel...</div>`;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await api(`/api/knowledge/${typeSlug}/import`, { method: 'POST', body: fd });
    resultBox.innerHTML = `
      <div class="card" style="background:var(--surface-raised)">
        <div class="grid grid-4" style="margin:6px 0">
          ${kpiCard('Total Baris', res.total_rows)}
          ${kpiCard('Valid', res.valid)}
          ${kpiCard('Duplicate', res.duplicate)}
          ${kpiCard('Invalid', res.invalid)}
        </div>
        ${res.errors.length ? `<div class="table-wrap"><table><thead><tr><th>Baris</th><th>Status</th><th>Keterangan</th></tr></thead><tbody>
          ${res.errors.map(e => `<tr><td>${e.row}</td><td><span class="badge ${e.status === 'DUPLICATE' ? 'TALENT_POOL' : 'REJECT'}">${e.status}</span></td><td class="page-desc">${esc(e.reason)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="page-desc">Semua baris berhasil diimport tanpa error.</p>'}
      </div>`;
    toast(`Import selesai: ${res.imported_count} data baru ditambahkan.`);
    renderKnowledge();
  } catch (e) {
    resultBox.innerHTML = `<div class="empty-state">Gagal import: ${esc(e.message)}</div>`;
  }
}

async function createKnowledgeCriteria() {
  const payload = {
    title: document.getElementById('kcTitle').value.trim(),
    position: document.getElementById('kcPosition').value.trim(),
    department: document.getElementById('kcDept').value.trim(),
    job_level: document.getElementById('kcLevel').value.trim(),
    min_education: document.getElementById('kcEdu').value,
    min_experience_years: Number(document.getElementById('kcExp').value || 0),
    technical_skills: document.getElementById('kcTech').value.split(',').map(s => s.trim()).filter(Boolean),
    soft_skills: document.getElementById('kcSoft').value.split(',').map(s => s.trim()).filter(Boolean),
    certifications_required: document.getElementById('kcCert').value.split(',').map(s => s.trim()).filter(Boolean),
    mandatory_criteria: getCriteriaListValues('kcMandatoryEditor'),
    passing_score: Number(document.getElementById('kcPass').value || 75),
    minimum_score: Number(document.getElementById('kcMin').value || 60),
    notes: document.getElementById('kcNotes').value.trim(),
  };
  if (!payload.title || !payload.position) { toast('Judul template & posisi wajib diisi.', true); return; }
  try {
    await api('/api/knowledge/job-criteria', { method: 'POST', body: JSON.stringify(payload) });
    toast('Template kriteria jabatan tersimpan.');
    renderKnowledge();
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, true);
  }
}

async function deactivateKnowledgeCriteria(id) {
  try {
    await api(`/api/knowledge/job-criteria/${id}`, { method: 'DELETE' });
    toast('Template dinonaktifkan.');
    renderKnowledge();
  } catch (e) {
    toast('Gagal: ' + e.message, true);
  }
}

async function loadKnowledgeUniversityTab(body) {
  const items = await api('/api/knowledge/universities');
  body.innerHTML = `
        <div class="card" style="margin-bottom:14px">
      <div class="section-title">Tambah Universitas</div>
      <div class="form-grid single">
        <div class="field"><label>Nama Universitas</label><input id="uniName" placeholder="mis. Universitas Indonesia" /></div>
        <div class="field"><label>Tier</label><input id="uniTier" placeholder="mis. Tier 1" /></div>
        <div class="field"><label>Akreditasi</label><input id="uniAkred" placeholder="mis. Unggul / A / B" /></div>
        <div class="field"><label>IPK Minimum</label><input id="uniGpa" type="number" step="0.01" placeholder="mis. 3.00" /></div>
        <div class="field"><label>Lokasi</label><input id="uniLoc" placeholder="mis. Jakarta" /></div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="createKnowledgeUniversity()">Simpan Universitas</button>
    </div>
    ${importCard('universities', 'Daftar Universitas')}
    <table class="data-table">
      <thead><tr><th>Nama Universitas</th><th>Tier</th><th>Akreditasi</th><th>IPK Min.</th><th>Lokasi</th><th></th></tr></thead>
      <tbody>
        ${items.length ? items.map(u => `
          <tr>
            <td>${esc(u.name)}</td><td>${esc(u.tier || '-')}</td><td>${esc(u.accreditation || '-')}</td>
            <td>${u.min_gpa ?? '-'}</td><td>${esc(u.location || '-')}</td>
            <td><button class="btn btn-danger btn-xs" onclick="deactivateKnowledgeUniversity(${u.id})">Nonaktifkan</button></td>
          </tr>`).join('') : `<tr><td colspan="6" class="page-desc">Belum ada data universitas.</td></tr>`}
      </tbody>
    </table>`;
  wireImportCard('universities');
}

async function createKnowledgeUniversity() {
  const payload = {
    name: document.getElementById('uniName').value.trim(),
    tier: document.getElementById('uniTier').value.trim(),
    accreditation: document.getElementById('uniAkred').value.trim(),
    min_gpa: document.getElementById('uniGpa').value ? Number(document.getElementById('uniGpa').value) : null,
    location: document.getElementById('uniLoc').value.trim(),
  };
  if (!payload.name) { toast('Nama universitas wajib diisi.', true); return; }
  try {
    await api('/api/knowledge/universities', { method: 'POST', body: JSON.stringify(payload) });
    toast('Universitas ditambahkan.');
    renderKnowledge();
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, true);
  }
}

async function deactivateKnowledgeUniversity(id) {
  try {
    await api(`/api/knowledge/universities/${id}`, { method: 'DELETE' });
    toast('Universitas dinonaktifkan.');
    renderKnowledge();
  } catch (e) {
    toast('Gagal: ' + e.message, true);
  }
}

async function loadKnowledgeQuestionTab(body) {
  const items = await api('/api/knowledge/interview-questions');
  body.innerHTML = `
        <div class="card" style="margin-bottom:14px">
      <div class="section-title">Tambah Pertanyaan Interview</div>
      <div class="form-grid single">
        <div class="field"><label>Pertanyaan</label><textarea id="qText" placeholder="mis. Ceritakan pengalaman Anda memimpin tim..."></textarea></div>
        <div class="field"><label>Kompetensi</label><input id="qCompetency" placeholder="mis. Leadership" /></div>
        <div class="field"><label>Stage Disarankan</label>
          <select id="qStage"><option value="HR_INTERVIEW">HR Interview</option><option value="USER_INTERVIEW">User Interview</option><option value="ASSESSMENT">Assessment</option></select>
        </div>
        <div class="field"><label>Level Jabatan</label><input id="qLevel" placeholder="mis. Staff / Supervisor / Manager" /></div>
        <div class="field"><label>Tipe</label>
          <select id="qType"><option>Behavioral</option><option>Technical</option><option>Situational</option></select>
        </div>
        <div class="field"><label>Catatan Jawaban Ideal</label><textarea id="qNotes"></textarea></div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="createKnowledgeQuestion()">Simpan Pertanyaan</button>
    </div>
    ${importCard('interview-questions', 'Bank Pertanyaan Interview')}
    <div class="grid grid-2">
      ${items.length ? items.map(q => `
        <div class="card">
          <div class="section-title" style="font-size:14px">${esc(q.question_text)}</div>
          <p class="page-desc">${esc(q.competency || '-')} · ${esc(q.stage_code || '-')} · ${esc(q.question_type || '-')} · dipakai ${q.times_used}x</p>
          ${q.ideal_answer_notes ? `<p class="page-desc"><em>Catatan: ${esc(q.ideal_answer_notes)}</em></p>` : ''}
          <button class="btn btn-danger btn-xs" style="margin-top:6px" onclick="deactivateKnowledgeQuestion(${q.id})">Nonaktifkan</button>
        </div>`).join('') : '<div class="empty-state"><div class="empty-state-icon">·</div>Belum ada pertanyaan di bank interview.</div>'}
    </div>`;
  wireImportCard('interview-questions');
}

async function createKnowledgeQuestion() {
  const payload = {
    question_text: document.getElementById('qText').value.trim(),
    competency: document.getElementById('qCompetency').value.trim(),
    stage_code: document.getElementById('qStage').value,
    job_level: document.getElementById('qLevel').value.trim(),
    question_type: document.getElementById('qType').value,
    ideal_answer_notes: document.getElementById('qNotes').value.trim(),
  };
  if (!payload.question_text) { toast('Teks pertanyaan wajib diisi.', true); return; }
  try {
    await api('/api/knowledge/interview-questions', { method: 'POST', body: JSON.stringify(payload) });
    toast('Pertanyaan ditambahkan ke bank interview.');
    renderKnowledge();
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, true);
  }
}

async function deactivateKnowledgeQuestion(id) {
  try {
    await api(`/api/knowledge/interview-questions/${id}`, { method: 'DELETE' });
    toast('Pertanyaan dinonaktifkan.');
    renderKnowledge();
  } catch (e) {
    toast('Gagal: ' + e.message, true);
  }
}


// ------------------------------------------------------------------
// Backup reminder banner
// ------------------------------------------------------------------
function refreshBackupBanner() {
  const el = document.getElementById('backupBanner');
  if (!el || !bak) return;
  const st = bak.backupStatus();
  if (!st.has_data || (st.days_since !== null && st.days_since < 7)) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.innerHTML = `<span>⚠ Data Anda hanya tersimpan di browser ini. ${st.days_since === null ? 'Belum pernah dibackup.' : `Backup terakhir ${st.days_since} hari lalu.`}</span>
    <button class="btn btn-secondary btn-xs" onclick="openPage('backup')">Backup sekarang</button>`;
}

function openPage(page) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  routes[page]();
}

// ------------------------------------------------------------------
// 11. DATA & BACKUP
// ------------------------------------------------------------------
function fmtBytes(n) {
  if (n === null || n === undefined) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

async function renderBackup() {
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 11</div>
      <div class="page-title">Data &amp; Backup</div>
      <div class="page-desc">Data Anda tersimpan di browser perangkat ini. Backup adalah satu-satunya cara memindahkan data ke perangkat lain dan melindunginya bila data browser terhapus.</div>
    </div>
    <div id="backupBody">Memuat...</div>`;

  const [info, st] = [await bak.storageInfo(), bak.backupStatus()];
  const dm = await api('/api/demo/status');
  const persistBadge = info.persisted === true ? '<span class="badge PASS">Persisten</span>'
    : info.persisted === false ? '<span class="badge HOLD">Belum persisten</span>' : '<span class="badge PENDING_REVIEW">Tidak diketahui</span>';
  const lastText = st.last_backup_at
    ? `${new Date(st.last_backup_at).toLocaleString('id-ID')} (${st.days_since} hari lalu)` : 'Belum pernah';

  document.getElementById('backupBody').innerHTML = `
    <div class="card">
      <div class="section-title">Status Penyimpanan ${persistBadge}</div>
      <div class="grid grid-4" style="margin:10px 0">
        ${kpiCard('Kandidat', dm.demo_candidates + dm.real_candidates)}
        ${kpiCard('File CV asli', info.files ? info.files.count : '-')}
        ${kpiCard('Ukuran file CV', fmtBytes(info.files ? info.files.bytes : null))}
        ${kpiCard('Penyimpanan terpakai', fmtBytes(info.usage))}
      </div>
      <p class="page-desc">Backup terakhir: <strong>${esc(lastText)}</strong> · Kuota browser untuk situs ini: ${esc(fmtBytes(info.quota))}</p>
      ${info.persisted === false ? `<p class="page-desc">Browser boleh menghapus data situs ini saat penyimpanan perangkat penuh. Minta penyimpanan persisten agar tidak dihapus otomatis.
        <button class="btn btn-secondary btn-xs" onclick="askPersistent()">Aktifkan penyimpanan persisten</button></p>` : ''}
      <p class="page-desc">Safari di iPhone/Mac dapat menghapus data situs yang lama tidak dibuka — jangan mengandalkan browser sebagai satu-satunya salinan.</p>
    </div>

    <div class="card">
      <div class="section-title">Buat Backup</div>
      <p class="page-desc">File .zip berisi seluruh data workspace (profil, lisensi, kandidat, lowongan, screening, keputusan, karyawan, dll). Simpan di tempat aman — isinya data pribadi kandidat.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="doBackupDownload(true)">⬇ Unduh Backup + file CV asli</button>
        <button class="btn btn-secondary btn-sm" onclick="doBackupDownload(false)">⬇ Unduh Backup tanpa file CV (lebih kecil)</button>
      </div>
      <div id="backupProgress" class="page-desc" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <div class="section-title">Pulihkan / Pindah Perangkat</div>
      <p class="page-desc">Pilih file backup .zip dari MRI. <strong>Seluruh data di perangkat ini akan diganti</strong> dengan isi backup (termasuk lisensi). Untuk pindah perangkat: buat backup di perangkat lama, lalu pulihkan di sini pada perangkat baru.</p>
      <input type="file" id="restoreFile" accept=".zip" style="display:none" />
      <button class="btn btn-secondary btn-sm" onclick="document.getElementById('restoreFile').click()">⬆ Pilih File Backup…</button>
    </div>

    <div class="card">
      <div class="section-title" style="color:var(--accent-coral)">Zona Berbahaya</div>
      <p class="page-desc">Menghapus seluruh workspace dari browser ini (kandidat, CV, lowongan, profil, lisensi). Tidak bisa dibatalkan kecuali Anda punya backup.</p>
      <button class="btn btn-danger btn-sm" onclick="openWipeModal()">Hapus Semua Data…</button>
    </div>`;

  document.getElementById('restoreFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) promptRestore(await f.arrayBuffer(), f.name);
  });
}

async function askPersistent() {
  const granted = await bak.requestPersistentStorage();
  toast(granted ? 'Penyimpanan persisten aktif.' : 'Browser tidak memberi izin penyimpanan persisten (biasanya karena situs jarang dipakai). Tetap lakukan backup rutin.', !granted);
  renderBackup();
}

async function doBackupDownload(includeFiles) {
  const box = document.getElementById('backupProgress');
  try {
    box.textContent = 'Menyiapkan backup...';
    const { blob, filename, size, manifest } = await bak.createBackup({
      includeFiles,
      onProgress: (p) => { box.textContent = p.phase === 'files' ? `Mengemas file CV ${p.done}/${p.total}...` : 'Mengompres...'; },
    });
    triggerBrowserDownload(blob, filename);
    bak.markBackupDone();
    box.textContent = `Backup selesai: ${filename} (${fmtBytes(size)}, ${manifest.cv_file_count} file CV). Simpan file ini di tempat aman.`;
    refreshBackupBanner();
    toast('Backup diunduh.');
  } catch (e) {
    box.textContent = '';
    toast('Backup gagal: ' + e.message, true);
  }
}

/** Shared restore flow (file, Drive, or first-run screen): inspect → confirm → replace → reload. */
async function promptRestore(arrayBuffer, sourceLabel) {
  let manifest;
  try { manifest = await bak.inspectBackup(arrayBuffer); } catch (e) { toast(e.message, true); return; }
  const dm = svc.DB.isOpen() ? await api('/api/demo/status') : { demo_candidates: 0, real_candidates: 0 };
  const hasCurrent = (dm.demo_candidates + dm.real_candidates) > 0 || !!(await api('/api/profile'));
  const c = manifest.counts || {};
  openModal(`
    <div class="page-eyebrow">Pulihkan Backup</div>
    <div class="page-title" style="font-size:18px">${esc(manifest.workspace_name || 'Workspace')}</div>
    <p class="page-desc">Sumber: ${esc(sourceLabel)} · dibuat ${new Date(manifest.created_at).toLocaleString('id-ID')} oleh ${esc(manifest.owner || '-')} · MRI v${esc(manifest.app_version || '?')}</p>
    <div class="grid grid-4" style="margin:10px 0">
      ${kpiCard('Kandidat', c.candidates || 0)}
      ${kpiCard('Lowongan', c.job_requirements || 0)}
      ${kpiCard('Karyawan', c.employees || 0)}
      ${kpiCard('File CV asli', manifest.cv_file_count || 0)}
    </div>
    ${hasCurrent ? `<div class="card" style="background:var(--accent-coral-dim); border-color:var(--accent-coral)">
      <strong>Data yang ada di perangkat ini akan DIGANTI seluruhnya</strong> dan tidak bisa dikembalikan. Pastikan Anda sudah punya backupnya.
      <label style="display:flex; gap:8px; margin-top:10px; align-items:center"><input type="checkbox" id="restoreAck" style="width:auto" /> Saya paham dan ingin mengganti data di perangkat ini.</label>
    </div>` : ''}
    <div id="restoreProgress" class="page-desc" style="margin-top:8px"></div>
    <button class="btn btn-primary btn-sm" id="restoreGo" style="margin-top:12px" onclick="doRestore()">Pulihkan Sekarang</button>
  `);
  window.__restoreBuffer = arrayBuffer;
  window.__restoreNeedsAck = hasCurrent;
}

async function doRestore() {
  if (window.__restoreNeedsAck && !document.getElementById('restoreAck').checked) { toast('Centang persetujuan terlebih dulu.', true); return; }
  const btn = document.getElementById('restoreGo');
  const box = document.getElementById('restoreProgress');
  btn.disabled = true;
  try {
    const res = await bak.restoreBackup(window.__restoreBuffer, {
      onProgress: (p) => { box.textContent = p.phase === 'files' ? `Memulihkan file CV ${p.done}/${p.total}...` : 'Menulis data...'; },
    });
    window.__restoreBuffer = null;
    bak.markBackupDone();
    box.textContent = `Selesai: ${res.restored_files} file CV dipulihkan. Memuat ulang...`;
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    btn.disabled = false;
    box.textContent = '';
    toast('Pemulihan gagal: ' + e.message, true);
  }
}

function openWipeModal() {
  openModal(`
    <div class="page-eyebrow">Konfirmasi</div>
    <div class="page-title" style="font-size:18px">Hapus SEMUA data workspace?</div>
    <p class="page-desc" style="margin-top:8px">Seluruh kandidat, file CV, lowongan, karyawan, profil, dan lisensi di browser ini akan dihapus permanen. Ketik <strong>HAPUS</strong> untuk melanjutkan.</p>
    <div class="field"><input id="wipeConfirm" placeholder="HAPUS" /></div>
    <div style="display:flex; gap:8px; margin-top:12px">
      <button class="btn btn-danger btn-sm" onclick="doWipe()">Hapus Permanen</button>
      <button class="btn btn-secondary btn-sm" onclick="closeModal()">Batal</button>
    </div>`);
}

async function doWipe() {
  if (document.getElementById('wipeConfirm').value.trim() !== 'HAPUS') { toast('Ketik HAPUS untuk konfirmasi.', true); return; }
  try {
    await bak.wipeWorkspace();
    toast('Semua data dihapus. Memuat ulang...');
    setTimeout(() => location.reload(), 700);
  } catch (e) { toast('Gagal menghapus: ' + e.message, true); }
}

// ------------------------------------------------------------------
// 12. GOOGLE DRIVE
// ------------------------------------------------------------------
const DRIVE_FOLDER_LABELS = { guide: '1 Panduan', templates: '2 Template Excel', backup: '3 Backup Data', sop: '4 Manual & SOP', dist: '5 File Distribusi' };
let driveBrowseFolder = 'backup';

async function getDrive() {
  if (!drv) drv = await import('./drive.js');
  return drv;
}

/** Runs a Drive action: makes sure a token exists FIRST (popup needs the click), reports errors as toasts. */
async function driveAction(fn, { rerender = true } = {}) {
  const d = await getDrive();
  try {
    await d.ensureToken();
    const r = await fn(d);
    return r;
  } catch (e) {
    toast(e.message, true);
    if (e.auth && rerender) renderDrive();
  }
}

async function renderDrive() {
  const d = await getDrive();
  content.innerHTML = `<div class="page-header">
      <div class="page-eyebrow">Modul 12</div>
      <div class="page-title">Google Drive</div>
      <div class="page-desc">Drive Anda adalah tempat penyimpanan file: backup, template Excel, panduan, manual/SOP, dan file yang ingin dibagikan. MRI hanya bisa melihat file yang dibuatnya sendiri — bukan seluruh isi Drive Anda.</div>
    </div>
    <div id="driveBody"></div>`;
  const body = document.getElementById('driveBody');

  if (!d.isConfigured()) {
    body.innerHTML = `
      <div class="card">
        <div class="section-title">Langkah Awal: Google Client ID</div>
        <p class="page-desc">Untuk menyambungkan Drive, aplikasi ini memerlukan <strong>OAuth Client ID</strong> (gratis, tanpa kartu kredit). Penjual bisa mengisinya di <code>config.js</code> sehingga semua pengguna langsung bisa memakai Drive; atau Anda bisa membuat sendiri:</p>
        <ol class="page-desc" style="line-height:1.7; margin-left:18px">
          <li>Buka <a class="link" href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a>, buat proyek baru.</li>
          <li>APIs &amp; Services → Library → aktifkan <strong>Google Drive API</strong>.</li>
          <li>OAuth consent screen → External → isi nama aplikasi &amp; email → tambahkan scope <code>.../auth/drive.file</code> → Publish app (atau tambahkan email Anda sebagai Test user).</li>
          <li>Credentials → Create credentials → <strong>OAuth client ID</strong> → Web application → Authorized JavaScript origins: <code>${esc(location.origin)}</code></li>
          <li>Salin Client ID (berakhiran <code>.apps.googleusercontent.com</code>) dan tempel di bawah.</li>
        </ol>
        <div class="field"><label>Google Client ID</label><input id="driveClientId" placeholder="1234567890-abc123.apps.googleusercontent.com" /></div>
        <button class="btn btn-primary btn-sm" onclick="saveDriveClientId()">Simpan Client ID</button>
      </div>`;
    return;
  }

  if (!d.isConnected()) {
    body.innerHTML = `
      <div class="card">
        <div class="section-title">Belum Tersambung</div>
        <p class="page-desc">Klik tombol di bawah, pilih akun Google Anda, lalu izinkan akses. Izin yang diminta hanya <em>“melihat dan mengelola file yang dibuat/dibuka aplikasi ini”</em>. Jika muncul jendela pop-up terblokir, izinkan pop-up untuk situs ini.</p>
        <button class="btn btn-primary btn-sm" onclick="connectDrive()">Sambungkan Google Drive</button>
        <button class="btn btn-ghost btn-sm" onclick="changeDriveClientId()">Ganti Client ID</button>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div class="card">
      <div class="section-title">Tersambung <span class="badge PASS">AKTIF</span></div>
      <p class="page-desc" id="driveAccount">Memeriksa akun...</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="setupDriveFolders()">Siapkan / Buka Folder MRI di Drive</button>
        <button class="btn btn-ghost btn-sm" onclick="disconnectDrive()">Putuskan</button>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="section-title">Backup Data</div>
        <p class="page-desc">Simpan backup ke folder “3 Backup Data”, atau pulihkan dari sana (mis. saat pindah perangkat).</p>
        <label class="page-desc" style="display:flex; gap:6px; align-items:center"><input type="checkbox" id="driveBackupFiles" style="width:auto" checked /> Sertakan file CV asli</label>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px">
          <button class="btn btn-primary btn-sm" onclick="backupToDrive()">☁ Simpan Backup ke Drive</button>
          <button class="btn btn-secondary btn-sm" onclick="openDriveRestore()">Pulihkan dari Drive…</button>
        </div>
        <div id="driveBackupProgress" class="page-desc" style="margin-top:8px"></div>
      </div>

      <div class="card">
        <div class="section-title">Panduan &amp; Template</div>
        <p class="page-desc">Unggah User Guide (PDF) dan 4 template Excel (karyawan, kriteria jabatan, universitas, bank pertanyaan) ke Drive Anda. File dengan nama sama akan diperbarui, bukan digandakan.</p>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" onclick="uploadGuideToDrive()">Unggah Panduan (PDF)</button>
          <button class="btn btn-secondary btn-sm" onclick="uploadTemplatesToDrive()">Unggah Template Excel</button>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Manual/SOP &amp; File Distribusi</div>
        <p class="page-desc">Unggah dokumen Anda sendiri (SOP, manual, formulir) atau file yang akan dibagikan ke pihak lain.</p>
        <div class="field"><select id="driveUploadFolder"><option value="sop">4 Manual &amp; SOP</option><option value="dist">5 File Distribusi</option></select></div>
        <input type="file" id="driveUploadFile" multiple style="display:none" />
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('driveUploadFile').click()">⬆ Pilih File & Unggah…</button>
      </div>

      <div class="card">
        <div class="section-title">Salinan Otomatis Laporan</div>
        <p class="page-desc">Setiap kali Anda mengekspor laporan (Excel/PDF), simpan juga salinannya di “5 File Distribusi” lalu bagikan lewat tautan Drive. Hanya berjalan saat Drive sedang tersambung.</p>
        <label class="page-desc" style="display:flex; gap:6px; align-items:center"><input type="checkbox" id="driveAutoDist" style="width:auto" ${d.prefs.autoDistribute() ? 'checked' : ''} /> Aktifkan salinan otomatis</label>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Isi Folder</div>
      <div class="filter-bar" style="margin-bottom:8px">
        <select id="driveBrowse">${Object.entries(DRIVE_FOLDER_LABELS).map(([k, v]) => `<option value="${k}" ${k === driveBrowseFolder ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <button class="btn btn-secondary btn-sm" onclick="loadDriveFolder()">Muat Ulang</button>
      </div>
      <div id="driveFiles" class="page-desc">Memuat...</div>
    </div>`;

  document.getElementById('driveAutoDist').addEventListener('change', (e) => { d.prefs.setAutoDistribute(e.target.checked); toast(e.target.checked ? 'Salinan otomatis aktif.' : 'Salinan otomatis dimatikan.'); });
  document.getElementById('driveBrowse').addEventListener('change', (e) => { driveBrowseFolder = e.target.value; loadDriveFolder(); });
  document.getElementById('driveUploadFile').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files); e.target.value = '';
    if (files.length) uploadUserFilesToDrive(files);
  });
  d.accountInfo().then(a => { const el = document.getElementById('driveAccount'); if (el) el.textContent = a ? `Akun: ${a.displayName || ''} <${a.emailAddress || ''}>` : 'Akun Google tersambung.'; });
  loadDriveFolder();
}

function saveDriveClientId() {
  const v = document.getElementById('driveClientId').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('Client ID tidak valid — harus berakhiran .apps.googleusercontent.com', true); return; }
  drv.setClientId(v);
  toast('Client ID tersimpan.');
  renderDrive();
}

function changeDriveClientId() {
  drv.setClientId('');
  renderDrive();
}

async function connectDrive() {
  const d = await getDrive();
  try {
    await d.connect({ prompt: '' });
    toast('Google Drive tersambung.');
    renderDrive();
  } catch (e) { toast(e.message, true); }
}

async function disconnectDrive() {
  const d = await getDrive();
  d.disconnect();
  toast('Koneksi Google Drive diputus.');
  renderDrive();
}

async function setupDriveFolders() {
  await driveAction(async (d) => {
    const f = await d.ensureFolders();
    toast('Folder MRI siap di Google Drive.');
    window.open(`https://drive.google.com/drive/folders/${f.root}`, '_blank', 'noopener');
  });
}

async function loadDriveFolder() {
  const box = document.getElementById('driveFiles');
  if (!box) return;
  box.textContent = 'Memuat...';
  const files = await driveAction(async (d) => {
    const folders = await d.ensureFolders();
    return d.listFolder(folders[driveBrowseFolder]);
  }, { rerender: false });
  if (!files) { box.textContent = 'Tidak bisa memuat isi folder.'; return; }
  box.innerHTML = files.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Nama</th><th>Ukuran</th><th>Diubah</th><th></th></tr></thead>
      <tbody>${files.map(f => `<tr>
        <td>${esc(f.name)}</td><td>${f.size ? fmtBytes(Number(f.size)) : '-'}</td>
        <td class="page-desc">${f.modifiedTime ? new Date(f.modifiedTime).toLocaleString('id-ID') : '-'}</td>
        <td>${f.webViewLink ? `<a class="btn btn-secondary btn-xs" href="${esc(f.webViewLink)}" target="_blank" rel="noopener">Buka / Bagikan</a>` : ''}
            <button class="btn btn-danger btn-xs" onclick="deleteDriveFile('${esc(f.id)}', '${esc(f.name).replace(/'/g, "\\'")}')">Hapus</button></td>
      </tr>`).join('')}</tbody></table></div>` : 'Folder ini masih kosong.';
}

async function deleteDriveFile(id, name) {
  if (!confirm(`Hapus "${name}" dari Google Drive? File dipindah/dihapus dari Drive Anda.`)) return;
  await driveAction(async (d) => { await d.deleteFile(id); toast('File dihapus dari Drive.'); loadDriveFolder(); });
}

async function backupToDrive() {
  const box = document.getElementById('driveBackupProgress');
  const includeFiles = document.getElementById('driveBackupFiles').checked;
  let done = false;
  await driveAction(async (d) => {
    box.textContent = 'Menyiapkan backup...';
    const { blob, filename, size } = await bak.createBackup({ includeFiles, onProgress: (p) => { box.textContent = p.phase === 'files' ? `Mengemas file CV ${p.done}/${p.total}...` : 'Mengompres...'; } });
    box.textContent = `Mengunggah ${filename} (${fmtBytes(size)}) ke Google Drive...`;
    const f = await d.uploadFile('backup', filename, blob, 'application/zip');
    bak.markBackupDone();
    refreshBackupBanner();
    box.textContent = `Selesai: ${f.name} tersimpan di Drive › 3 Backup Data.`;
    toast('Backup tersimpan di Google Drive.');
    done = true;
    loadDriveFolder();
  });
  if (!done) box.textContent = '';
}

async function openDriveRestore() {
  await driveAction(async (d) => {
    const folders = await d.ensureFolders();
    const files = (await d.listFolder(folders.backup)).filter(f => /\.zip$/i.test(f.name));
    if (!files.length) { toast('Belum ada file backup (.zip) di Drive › 3 Backup Data.', true); return; }
    openModal(`
      <div class="page-eyebrow">Google Drive</div>
      <div class="page-title" style="font-size:18px">Pilih Backup untuk Dipulihkan</div>
      <div style="max-height:320px; overflow:auto; margin-top:10px">
        ${files.map(f => `<label class="qbank-item"><input type="radio" name="driveBackupPick" value="${esc(f.id)}" data-name="${esc(f.name)}" style="width:auto" />
          <div><div class="qbank-text">${esc(f.name)}</div><div class="page-desc">${f.size ? fmtBytes(Number(f.size)) : ''} · ${f.modifiedTime ? new Date(f.modifiedTime).toLocaleString('id-ID') : ''}</div></div></label>`).join('')}
      </div>
      <div id="driveRestoreProgress" class="page-desc" style="margin-top:8px"></div>
      <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="pickDriveBackup()">Lanjut</button>`);
  });
}

async function pickDriveBackup() {
  const sel = document.querySelector('input[name="driveBackupPick"]:checked');
  if (!sel) { toast('Pilih salah satu backup.', true); return; }
  const box = document.getElementById('driveRestoreProgress');
  await driveAction(async (d) => {
    box.textContent = 'Mengunduh dari Google Drive...';
    const blob = await d.downloadFile(sel.value);
    promptRestore(await blob.arrayBuffer(), `Google Drive › ${sel.dataset.name}`);
  });
}

async function uploadGuideToDrive() {
  await driveAction(async (d) => {
    toast('Membuat panduan...');
    const { buildGuidePdf } = await import('./guide.js');
    const bytes = await buildGuidePdf();
    const f = await d.uploadFile('guide', 'Panduan Pengguna MRI.pdf', new Blob([bytes], { type: 'application/pdf' }), 'application/pdf', { overwrite: true });
    toast('Panduan tersimpan di Drive › 1 Panduan.');
    if (driveBrowseFolder === 'guide') loadDriveFolder();
    return f;
  });
}

async function uploadTemplatesToDrive() {
  await driveAction(async (d) => {
    const items = [
      ['/api/employees/import-template.xlsx', 'Template Import Karyawan.xlsx'],
      ['/api/knowledge/job-criteria/import-template.xlsx', 'Template Kriteria Jabatan.xlsx'],
      ['/api/knowledge/universities/import-template.xlsx', 'Template Daftar Universitas.xlsx'],
      ['/api/knowledge/interview-questions/import-template.xlsx', 'Template Bank Pertanyaan Interview.xlsx'],
    ];
    for (const [url, name] of items) {
      const res = await svc.apiFile(url);
      await d.uploadFile('templates', name, res.blob, res.type, { overwrite: true });
    }
    toast('4 template Excel tersimpan di Drive › 2 Template Excel.');
    if (driveBrowseFolder === 'templates') loadDriveFolder();
  });
}

async function uploadUserFilesToDrive(files) {
  const folder = document.getElementById('driveUploadFolder').value;
  await driveAction(async (d) => {
    let ok = 0;
    for (const f of files) {
      try { await d.uploadFile(folder, f.name, f, f.type || 'application/octet-stream', { overwrite: true }); ok++; }
      catch (e) { toast(`${f.name}: ${e.message}`, true); if (e.auth) break; }
    }
    if (ok) toast(`${ok} file diunggah ke Drive › ${DRIVE_FOLDER_LABELS[folder]}.`);
    driveBrowseFolder = folder;
    const sel = document.getElementById('driveBrowse'); if (sel) sel.value = folder;
    loadDriveFolder();
  });
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
function initAppWidgets() {
  refreshLicenseBadge();
  (async () => {
    try {
      const status = await api('/api/demo/status');
      const badge = document.getElementById('demoModeBadge');
      if (badge) badge.innerHTML = status.demo_mode_active ? `<span class="badge TALENT_POOL" style="margin-top:6px; display:inline-block">DEMO DATA AKTIF</span>` : '';
    } catch (e) { /* non-fatal */ }
  })();
}

// Only one tab may open the workspace at a time — two tabs writing to the same
// local database would silently overwrite each other's changes.
function acquireWorkspaceLock() {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request('mri-workspace-main', { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return undefined; }
      resolve(true);
      return new Promise(() => {}); // hold for the lifetime of this tab
    });
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (nw) nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Versi baru MRI tersedia — muat ulang halaman (F5) untuk memakainya.');
      });
    });
  }).catch(() => { /* offline cache is optional */ });
}

async function bootstrap() {
  try {
    cfg = (await import('../config.js')).CONFIG;
    document.title = cfg.APP_NAME;
  } catch (e) {
    showFatal('Aplikasi gagal dimuat', 'Berkas aplikasi tidak lengkap. Muat ulang halaman; bila berulang, hubungi penjual. Detail: ' + e.message);
    return;
  }
  if (!(await acquireWorkspaceLock())) { showOnly('blockedScreen'); return; }
  try {
    if (!window.indexedDB) throw new Error('Browser ini tidak mendukung penyimpanan lokal (IndexedDB).');
    svc = await import('./services.js');
    bak = await import('./backup.js');
    svc.DB.onVersionChange(() => location.reload());
    await svc.openWorkspace();
  } catch (e) {
    showFatal('Penyimpanan lokal tidak tersedia',
      'MRI menyimpan data di browser Anda. Penyimpanan ini tidak bisa dibuka — biasanya karena mode Private/Incognito atau pengaturan privasi yang memblokir data situs. Buka di jendela biasa lalu muat ulang. Detail: ' + e.message);
    return;
  }
  currentUser = await api('/api/profile');
  registerServiceWorker();
  if (currentUser) { bak.requestPersistentStorage(); showApp(); } else showSetup();
}

async function setupRestoreFromFile(file) {
  if (file) promptRestore(await file.arrayBuffer(), file.name);
}

async function setupRestoreFromDrive() {
  const d = await getDrive();
  try {
    await d.connect({ prompt: '' });
    await openDriveRestore();
  } catch (e) { toast(e.message, true); }
}

bootstrap();
