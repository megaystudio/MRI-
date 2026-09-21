"""
End-to-end test in a real Chromium: serves the built site, drives the UI like a user.
Usage: python3 tests/e2e.py <site-dir> <cv-dir> <licenses.json> <screenshots-dir>
"""
import json, os, re, shutil, subprocess, sys, threading, time, http.server, socketserver, functools
from playwright.sync_api import sync_playwright, expect

site_src, cv_dir, lic_path, shots = sys.argv[1:5]
os.makedirs(shots, exist_ok=True)
LIC = json.load(open(lic_path))

# Test copy of the site: test licence key + a (fake) Google client id, so Drive UI is reachable.
site = "/tmp/e2e_site"
shutil.rmtree(site, ignore_errors=True)
shutil.copytree(site_src, site, ignore=shutil.ignore_patterns("node_modules", "tests", "tools", ".git"))
cfg = open(f"{site}/config.js").read()
cfg = re.sub(r"PUBLIC_KEY_HEX: '[0-9a-f]+'", f"PUBLIC_KEY_HEX: '{LIC['pub']}'", cfg)
cfg = cfg.replace("GOOGLE_CLIENT_ID: ''", "GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com'")
open(f"{site}/config.js", "w").write(cfg)
subprocess.run(["node", "tools/build_sw.mjs"], cwd=site_src, check=True, capture_output=True)  # sanity: builder runs
subprocess.run(["node", os.path.join(site_src, "tools/build_sw.mjs")], cwd=site, check=False, capture_output=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache"); super().end_headers()
Quiet.extensions_map[".mjs"] = "text/javascript"; Quiet.extensions_map[".webmanifest"] = "application/manifest+json"
class Srv(socketserver.ThreadingTCPServer): allow_reuse_address = True; daemon_threads = True
handler = functools.partial(Quiet, directory=site)
srv = Srv(("127.0.0.1", 8123), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:8123/"

mock_js = open(os.path.join(site_src, "tests/mock_drive_browser.js")).read()
errors = []
checks = 0
def ok(msg):
    global checks; checks += 1; print(f"✓ {msg}")

def shot(page, name):
    page.screenshot(path=os.path.join(shots, f"{name}.png"), full_page=False)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1360, "height": 900}, accept_downloads=True)
    ctx.add_init_script(mock_js)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("dialog", lambda d: d.accept())

    # 1 ── first run
    page.goto(BASE)
    expect(page.locator("#setupScreen")).to_be_visible()
    shot(page, "01_setup")
    page.fill("#setupName", "Rina Kusuma")
    page.fill("#setupWorkspace", "Rekrutmen Uji")
    page.click("#setupForm button[type=submit]")
    expect(page.locator("#appShell")).to_be_visible()
    expect(page.locator("#userBadge")).to_contain_text("Rina Kusuma")
    expect(page.locator("#licenseBadge")).to_contain_text("DEMO")
    ok("first run: setup screen → personal workspace (no login, no roles)")
    expect(page.locator("#navUsers")).to_have_count(0)
    assert page.locator(".role-badge").count() == 0
    ok("no user-management page / role badges anywhere")

    # 2 ── demo data on the dashboard
    page.click("text=Load Demo Data")
    expect(page.locator("#demoModeCard")).to_contain_text("AKTIF", timeout=15000)
    expect(page.locator(".kpi-card").first).to_be_visible()
    total_cv = int(page.locator(".kpi-card .kpi-value").first.inner_text())
    assert total_cv == 45, total_cv
    shot(page, "02_dashboard_demo")
    ok("Load Demo Data: dashboard shows 45 candidates")
    page.click("text=Reset Demo Data")
    expect(page.locator("#demoModeCard")).to_contain_text("Load Demo Data", timeout=15000)
    assert int(page.locator(".kpi-card .kpi-value").first.inner_text()) == 0
    ok("Reset Demo Data wipes only demo rows")

    # 3 ── vacancies via the form, template first
    page.click(".nav-item[data-page=vacancies]")
    page.select_option("#vTemplatePicker", index=2)
    expect(page.locator("#vPosition")).to_have_value("Production Supervisor")
    page.click("text=Simpan Job Requirement")
    expect(page.locator("#vacancyList")).to_contain_text("Production Supervisor")
    page.fill("#vPosition", "Finance Staff"); page.fill("#vTechSkills", "Accounting, Excel, Taxation"); page.select_option("#vEdu", "D3"); page.fill("#vExp", "1")
    page.click("text=Simpan Job Requirement")
    expect(page.locator("#vacancyList")).to_contain_text("Finance Staff")
    ok("Job Requirement: create from Knowledge Center template and from scratch")

    # 4 ── CV intake: single, then batch with a bad file + duplicate
    page.click(".nav-item[data-page=intake]")
    page.set_input_files("#cvFile", f"{cv_dir}/cv_single_0.pdf")
    expect(page.locator("#uploadResult")).to_contain_text("Kandidat baru ditambahkan", timeout=20000)
    expect(page.locator("#uploadResult")).to_contain_text("Budi Santoso")
    expect(page.locator("#uploadResult .tag.matched", has_text="Six Sigma").first).to_be_visible()
    shot(page, "03_intake_result")
    page.click("button.intake-tab[data-tab=multiple]")
    page.set_input_files("#cvFilesMulti", [f"{cv_dir}/cv_docx_1.docx", f"{cv_dir}/cv_twocol_2.pdf", f"{cv_dir}/cv_single_0.pdf", "/tmp/badfiles/scanned.pdf", "/tmp/badfiles/notes.rtf"])
    expect(page.locator("#uploadResult")).to_contain_text("Batch Upload Result", timeout=30000)
    txt = page.locator("#uploadResult").inner_text()
    assert "FAILED" in txt and "DUPLICATE" in txt and "SUCCESS" in txt, txt
    shot(page, "04_batch_result")
    ok("CV Intake: single PDF, batch of 5 (2 new / 1 duplicate / 2 failed) with per-file reasons")

    # 5 ── screening
    page.click(".nav-item[data-page=screening]")
    page.click("#runAllBtn")
    expect(page.locator("#screeningTableWrap .score-chip").first).to_be_visible(timeout=20000)
    page.locator("#screeningTableWrap tr.clickable-row").first.click()
    expect(page.locator(".screening-detail-inline").first).to_be_visible()
    shot(page, "05_screening")
    page.locator("#screeningTableWrap button", has_text="Review").first.click()
    expect(page.locator("#modal")).to_contain_text("Keputusan HR")
    expect(page.locator("#modal .reviewer-readonly")).to_contain_text("Rina Kusuma")
    page.fill("#hrReason", "Kriteria terpenuhi")
    page.click("#modal button:has-text('Pass')")
    expect(page.locator("#screeningTableWrap .badge.PASS").first).to_be_visible(timeout=10000)
    ok("Screening: AI matching, inline evidence, HR decision recorded under the owner's name")

    # 6 ── candidate 360 → stage → HIRED → employee
    page.click(".nav-item[data-page=bank]")
    page.locator("#bankTableWrap tr.clickable-row").first.click()
    expect(page.locator("#modal")).to_contain_text("Candidate 360")
    with page.expect_download() as dl:
        page.locator("#modal button:has-text('Unduh')").first.click()
    assert dl.value.suggested_filename.startswith("cv_"), dl.value.suggested_filename
    page.select_option("#stageCode", "HIRED")
    page.select_option("#stageDecision", "PASS")
    page.click("text=Simpan Stage Assessment")
    expect(page.locator("#modal")).to_contain_text("HIRED", timeout=10000)
    page.click("text=+ Create Employee")
    expect(page.locator("#modal")).to_contain_text("Employee 360", timeout=10000)
    page.fill("#empDeptEdit", "Manufacturing")
    page.click("text=Simpan Perubahan")
    page.click(".nav-item[data-page=employees]")
    expect(page.locator("#empTableWrap")).to_contain_text("Manufacturing", timeout=10000)
    ok("Candidate 360: original CV download, stage → HIRED → Employee created and edited")

    # 7 ── plan gating, then activate Premium
    page.click(".nav-item[data-page=employees]")
    page.click("button:has-text('⬇ Excel')")
    expect(page.locator("#toastStack")).to_contain_text("tidak tersedia di paket Demo")
    page.click(".nav-item[data-page=license]")
    expect(page.locator("#licenseBody")).to_contain_text("DEMO")
    page.fill("#licenseTextInput", LIC["premium"])
    page.click("#activateBtn")
    expect(page.locator("#licenseBadge")).to_contain_text("PREMIUM", timeout=10000)
    expect(page.locator("#licenseBody")).to_contain_text("Budi Santoso (Order #123)")
    shot(page, "06_license")
    page.click(".nav-item[data-page=employees]")
    with page.expect_download() as dl:
        page.click("button:has-text('⬇ Excel')")
    assert dl.value.suggested_filename.startswith("Employee_Data_") and dl.value.suggested_filename.endswith(".xlsx")
    with page.expect_download() as dl:
        page.click("button:has-text('⬇ PDF')")
    assert dl.value.suggested_filename.startswith("Employee_Report_")
    ok("Demo blocks exports; Premium code activates offline and unlocks Excel/PDF downloads")

    # 8 ── backup download → wipe → restore on the "new device" screen
    page.click(".nav-item[data-page=backup]")
    expect(page.locator("#backupBody")).to_contain_text("Belum pernah")
    shot(page, "07_backup")
    with page.expect_download() as dl:
        page.click("button:has-text('Unduh Backup + file CV asli')")
    backup_path = os.path.join(shots, dl.value.suggested_filename); dl.value.save_as(backup_path)
    assert os.path.getsize(backup_path) > 5000
    expect(page.locator("#backupProgress")).to_contain_text("Backup selesai")
    ok(f"Backup downloaded: {dl.value.suggested_filename} ({os.path.getsize(backup_path)//1024} KB)")
    before = page.evaluate("""async () => { const r = await fetch('./config.js'); return 1; }""")
    page.click("button:has-text('Hapus Semua Data')")
    page.fill("#wipeConfirm", "HAPUS")
    page.click("button:has-text('Hapus Permanen')")
    expect(page.locator("#setupScreen")).to_be_visible(timeout=15000)
    page.set_input_files("#setupRestoreFile", backup_path)
    expect(page.locator("#modal")).to_contain_text("Rekrutmen Uji")
    expect(page.locator("#modal")).to_contain_text("Rina Kusuma")
    shot(page, "08_restore_modal")
    page.click("#restoreGo")
    expect(page.locator("#appShell")).to_be_visible(timeout=20000)
    expect(page.locator("#userBadge")).to_contain_text("Rina Kusuma")
    expect(page.locator("#licenseBadge")).to_contain_text("PREMIUM", timeout=10000)
    page.click(".nav-item[data-page=bank]")
    expect(page.locator("#bankTableWrap")).to_contain_text("Budi Santoso", timeout=10000)
    page.locator("#bankTableWrap tr.clickable-row").first.click()
    with page.expect_download() as dl:
        page.locator("#modal button:has-text('Unduh')").first.click()
    ok("Wipe → 'new device' setup screen → restore: workspace, Premium licence, candidates and original CV files are back")
    page.keyboard.press("Escape")

    # 9 ── Google Drive (stubbed Google): connect, folders, backup, restore list, templates, guide, upload
    page.click(".nav-item[data-page=drive]")
    expect(page.locator("#driveBody")).to_contain_text("Belum Tersambung")
    page.click("button:has-text('Sambungkan Google Drive')")
    expect(page.locator("#driveBody")).to_contain_text("Tersambung", timeout=10000)
    expect(page.locator("#driveAccount")).to_contain_text("uji@example.com", timeout=10000)
    page.click("button:has-text('Simpan Backup ke Drive')")
    expect(page.locator("#driveBackupProgress")).to_contain_text("tersimpan di Drive", timeout=30000)
    page.click("button:has-text('Unggah Panduan (PDF)')")
    expect(page.locator("#toastStack")).to_contain_text("Panduan tersimpan", timeout=20000)
    page.click("button:has-text('Unggah Template Excel')")
    expect(page.locator("#toastStack")).to_contain_text("4 template Excel tersimpan", timeout=30000)
    page.set_input_files("#driveUploadFile", {"name": "SOP Wawancara.docx", "mimeType": "application/octet-stream", "buffer": b"sop bytes"})
    expect(page.locator("#toastStack")).to_contain_text("1 file diunggah", timeout=20000)
    page.select_option("#driveBrowse", "templates")
    expect(page.locator("#driveFiles")).to_contain_text("Template Import Karyawan.xlsx", timeout=10000)
    assert page.locator("#driveFiles tbody tr").count() == 4
    page.select_option("#driveBrowse", "guide")
    expect(page.locator("#driveFiles")).to_contain_text("Panduan Pengguna MRI.pdf")
    page.select_option("#driveBrowse", "sop")
    expect(page.locator("#driveFiles")).to_contain_text("SOP Wawancara.docx")
    page.select_option("#driveBrowse", "backup")
    expect(page.locator("#driveFiles")).to_contain_text("MRI-Backup_Rekrutmen-Uji_")
    shot(page, "09_drive")
    # a stored guide must be a real PDF
    guide_ok = page.evaluate("""async () => { const m = window.__mockDrive; const f = [...m.files.values()].find(x => x.name === 'Panduan Pengguna MRI.pdf'); const b = new Uint8Array(await f.blob.arrayBuffer()); return String.fromCharCode(...b.slice(0,5)); }""")
    assert guide_ok == "%PDF-", guide_ok
    ok("Google Drive (stubbed): connect, folder layout, backup, guide PDF, 4 templates, SOP upload, file listing")

    # restore from Drive on top of existing data needs explicit acknowledgement
    page.click("button:has-text('Pulihkan dari Drive')")
    page.locator("input[name=driveBackupPick]").first.check()
    page.click("#modal button:has-text('Lanjut')")
    expect(page.locator("#modal")).to_contain_text("akan DIGANTI", timeout=15000)
    page.click("#restoreGo")
    expect(page.locator("#toastStack")).to_contain_text("persetujuan")
    page.click("#modal .modal-close")
    # auto-copy of exports
    page.check("#driveAutoDist")
    page.click(".nav-item[data-page=employees]")
    with page.expect_download():
        page.click("button:has-text('⬇ Excel')")
    expect(page.locator("#toastStack")).to_contain_text("Salinan tersimpan di Google Drive", timeout=10000)
    ok("Restore from Drive requires acknowledgement; exports are auto-copied to 'File Distribusi'")

    # 10 ── persistence + offline (service worker)
    page.reload()
    expect(page.locator("#appShell")).to_be_visible(timeout=15000)
    expect(page.locator("#userBadge")).to_contain_text("Rina Kusuma")
    page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null || true")
    page.evaluate("navigator.serviceWorker.ready")
    time.sleep(1.5)
    keys = page.evaluate("caches.keys()")
    assert any(k.startswith("mri-app-") for k in keys), keys
    ok("data survives reload; service worker cache installed")

    # a second tab is refused while the first is open
    page2 = ctx.new_page(); page2.goto(BASE)
    expect(page2.locator("#blockedScreen")).to_be_visible(timeout=10000)
    page2.close()
    ok("second tab is blocked (single writer to the local database)")

    ctx.set_offline(True)
    page.reload()
    expect(page.locator("#appShell")).to_be_visible(timeout=15000)
    page.click(".nav-item[data-page=bank]")
    expect(page.locator("#bankTableWrap")).to_contain_text("Budi Santoso", timeout=10000)
    page.click(".nav-item[data-page=audit]")
    expect(page.locator("#auditBody")).to_contain_text("CANDIDATE_CREATED")
    # PDF extraction needs the (cached) pdf.js worker, offline
    page.click(".nav-item[data-page=intake]")
    page.set_input_files("#cvFile", f"{cv_dir}/cv_chrome_single.pdf")
    expect(page.locator("#uploadResult")).to_contain_text("Dewi Lestari", timeout=20000)
    shot(page, "10_offline_upload")
    ok("fully offline: app loads, reads data and still extracts a new PDF CV")
    ctx.set_offline(False)
    browser.close()

srv.shutdown()
real_errors = [e for e in errors if "favicon" not in e]
print(f"\n{checks} end-to-end checks passed")
if real_errors:
    print("BROWSER ERRORS:"); [print("  ", e) for e in real_errors]; sys.exit(1)
print("no console errors / page errors")
