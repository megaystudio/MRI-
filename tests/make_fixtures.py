"""
Creates the shared fixtures used by the JS tests, in /tmp:
  /tmp/licenses.json   test keypair + licences signed exactly like seller_tools/generate_license.py
  /tmp/badfiles/       corrupt / encrypted / scanned / oversized / wrong-type files + 20 distinct CVs
  /tmp/bad_expected.json  what the ORIGINAL backend answers for those files, Demo limits and gated exports
Usage: python3 tests/make_fixtures.py <old-backend-dir>
"""
import base64, datetime, json, os, random, shutil, sys
backend_dir = sys.argv[1]

# ---- licences -------------------------------------------------------------
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
k = Ed25519PrivateKey.generate()
pub = k.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
def make(buyer, plan, issued=None, key=k):
    pb = json.dumps({"buyer": buyer, "plan": plan, "issued": issued or datetime.date.today().isoformat()}, separators=(",", ":")).encode()
    return f"{b64(pb)}.{b64(key.sign(pb))}"
json.dump({"pub": pub, "premium": make("Budi Santoso (Order #123)", "PREMIUM"), "vip": make("Nama Dengan Aksén & Emoji ✓", "VIP"),
           "bad_plan": make("X", "DEMO"), "bad_date": make("X", "PREMIUM", "2026-13-45"), "empty_buyer": make("  ", "PREMIUM"),
           "wrong_key": make("Hacker", "VIP", "2026-01-01", Ed25519PrivateKey.generate())}, open("/tmp/licenses.json", "w"))

# ---- bad files ------------------------------------------------------------
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
d = "/tmp/badfiles"; shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
c = canvas.Canvas(f"{d}/scanned.pdf", pagesize=A4); c.setFillColor(colors.grey); c.rect(50, 500, 400, 200, fill=1); c.line(10, 10, 500, 800); c.save()
c = canvas.Canvas(f"{d}/encrypted.pdf", pagesize=A4, encrypt="secret"); c.drawString(100, 700, "Budi Santoso"); c.save()
open(f"{d}/empty.txt", "wb").close(); open(f"{d}/blank.txt", "w").write("   \n\n  ")
open(f"{d}/corrupt.pdf", "wb").write(os.urandom(2000)); open(f"{d}/fake.docx", "w").write("this is not a zip")
open(f"{d}/huge.txt", "w").write("x " * (5 * 1024 * 1024)); open(f"{d}/notes.rtf", "w").write("{\\rtf1 hi}")
for i in range(20):
    open(f"{d}/limit_{i:02d}.txt", "w").write(f"Kandidat Nomor{chr(65+i)} Uji\nkandidat{i}@limit.test\n08123{i:06d}\nS1 Teknik\nExcel Python 2015 - 2018\n")

# ---- what the original backend does with them -----------------------------
data_dir = "/tmp/bad_pydata"; shutil.rmtree(data_dir, ignore_errors=True)
os.environ["MRI_DATA_DIR"] = data_dir
sys.path.insert(0, backend_dir)
from fastapi.testclient import TestClient
from main import app
cl = TestClient(app)
cl.post("/api/auth/signup", json=dict(workspace_name="WS", full_name="T Person", email="t@example.com", username="tester", password="secret1"))
out = {}
for f in ["scanned.pdf", "encrypted.pdf", "empty.txt", "blank.txt", "corrupt.pdf", "fake.docx", "huge.txt", "notes.rtf"]:
    with open(f"{d}/{f}", "rb") as fh:
        r = cl.post("/api/cv/upload", files={"file": (f, fh)}, data={"source": "x"})
    out[f] = [r.status_code, r.json().get("detail") if r.status_code >= 400 else "OK"]
res = []
for i in range(20):
    with open(f"{d}/limit_{i:02d}.txt", "rb") as fh:
        res.append(cl.post("/api/cv/upload", files={"file": (f"limit_{i:02d}.txt", fh)}, data={"source": "x"}).status_code)
out["limit_statuses"] = res
for i in range(4):
    r = cl.post("/api/vacancies", json=dict(position=f"V{i}")); out[f"vac{i}"] = [r.status_code, r.json().get("detail") if r.status_code >= 400 else "OK"]
r = cl.get("/api/export/candidates.xlsx"); out["export_demo"] = [r.status_code, r.json().get("detail")]
json.dump(out, open("/tmp/bad_expected.json", "w"), ensure_ascii=False, indent=1)
print("fixtures ready")
