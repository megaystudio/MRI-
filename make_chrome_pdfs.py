"""
Extra parity corpus: CV-like HTML rendered to PDF by Chromium (a very
different PDF producer than reportlab — per-run positioning, embedded
subset fonts, CSS-drawn backgrounds/borders). Records what the ORIGINAL
pdfplumber pipeline extracts so tests/files.test.mjs can compare.

Usage: python3 tests/make_chrome_pdfs.py <old-backend-dir> <out-dir>   (appends to expected.json)
"""
import json, os, sys
from dataclasses import asdict
backend_dir, out_dir = sys.argv[1], sys.argv[2]
sys.path.insert(0, backend_dir)
import ai_engine
from playwright.sync_api import sync_playwright

BASE_CSS = "body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;margin:0} h1{font-size:20pt;margin:0 0 4px} h2{font-size:12pt;margin:14px 0 4px;text-transform:uppercase;border-bottom:1px solid #444} p{margin:2px 0}"
DOCS = {
 "chrome_single": f"""<style>{BASE_CSS} .wrap{{padding:30px 40px}}</style><div class=wrap><h1>Dewi Lestari</h1><p>dewi.lestari@example.com | 081377788899 | Bandung</p>
<h2>Pendidikan</h2><p>S1 Akuntansi, Universitas Padjadjaran, 2011 - 2015</p>
<h2>Pengalaman Kerja</h2><p><b>Accounting Supervisor</b>, PT Nusantara Makmur, 2016 - 2021</p><p>Menyusun laporan keuangan, Taxation, Budgeting dan Auditing.</p><p><b>Finance Manager</b>, PT Bumi Sejahtera Tbk, 2021 - Present</p>
<h2>Keahlian</h2><p>Accounting, Excel, Financial Analysis, Leadership, Communication</p>
<h2>Sertifikasi</h2><p>Brevet Pajak 2017</p><p>CPA 2019</p></div>""",
 "chrome_twocol": f"""<style>{BASE_CSS} .wrap{{display:flex;gap:60px;padding:30px 40px}} .l{{width:200px}} .r{{width:300px}}</style><div class=wrap><div class=l><h1>Agus Wijaya</h1><p>agus.w@mail.com</p><p>085211122233</p>
<h2>Keahlian</h2><p>Python</p><p>SQL</p><p>Machine Learning</p><p>Data Analysis</p><p>Cloud Computing</p><p>DevOps</p><h2>Pendidikan</h2><p>S1 Informatika</p><p>ITB 2012 - 2016</p></div>
<div class=r><h2>Pengalaman</h2><p><b>Data Engineer</b>, PT Teknologi Maju, 2016 - 2019</p><p><b>Lead Data Scientist</b>, PT Digital Nusantara, 2019 - sekarang</p><h2>Sertifikasi</h2><p>AWS Certified Solutions Architect 2020</p><p>Scrum Master</p></div></div>""",
 "chrome_sidebar": f"""<style>{BASE_CSS} .wrap{{display:flex;min-height:1000px}} .l{{width:200px;background:#dde6f0;padding:30px 16px}} .r{{padding:30px 30px;width:340px}}</style><div class=wrap><div class=l><h1 style="font-size:16pt">Nur Hidayat</h1><p>nur.h@example.org</p><p>082144455566</p><h2>Skills</h2><p>Recruitment</p><p>Payroll</p><p>HRIS</p><p>Labor Law</p></div>
<div class=r><h2>Pendidikan</h2><p>S2 Manajemen SDM, 2014</p><h2>Pengalaman</h2><p><b>HR Manager</b>, PT Sinergi Group, 2015 - 2022</p><p><b>Head of People</b>, PT Karya Bersama, 2022 - Present</p><h2>Sertifikasi</h2><p>PHR 2016</p><p>SPHR 2019</p></div></div>""",
 "chrome_table": f"""<style>{BASE_CSS} table{{border-collapse:collapse;width:100%}} td,th{{border:1px solid #333;padding:4px 6px;text-align:left}} .wrap{{padding:30px 40px}}</style><div class=wrap><h1>Eko Prasetyo</h1><p>eko.p@example.com | 0813 9988 7766</p>
<h2>Pendidikan</h2><p>D3 Teknik Elektro, Politeknik Negeri Bandung, 2007 - 2010</p><h2>Pengalaman</h2>
<table><tr><th>Posisi</th><th>Perusahaan</th><th>Periode</th></tr><tr><td>Electrical Engineer</td><td>PT Dummy Power</td><td>2010 - 2015</td></tr><tr><td>Maintenance Supervisor</td><td>PT Kilang Nusantara</td><td>2015 - 2020</td></tr></table>
<h2>Keahlian</h2><p>PLC, SCADA, AutoCAD, Risk Management</p><h2>Sertifikasi</h2><p>BNSP Ahli K3</p></div>""",
}
records = []
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, html in DOCS.items():
        pg = b.new_page()
        pg.set_content(f"<html><body>{html}</body></html>")
        path = os.path.join(out_dir, f"cv_{name}.pdf")
        pg.pdf(path=path, format="A4", print_background=True)
        pg.close()
        text = ai_engine.extract_text_from_file(path)
        prof = asdict(ai_engine.extract_candidate_profile(text))
        records.append({"file": f"cv_{name}.pdf", "kind": name, "text": text, "profile": prof, "sha256": ai_engine.compute_file_hash(path)})
    b.close()
exp_path = os.path.join(out_dir, "expected.json")
existing = json.load(open(exp_path))
existing = [r for r in existing if not r["kind"].startswith("chrome_")] + records
json.dump(existing, open(exp_path, "w"), ensure_ascii=False, indent=1)
print("added", len(records), "chromium-made PDFs")
