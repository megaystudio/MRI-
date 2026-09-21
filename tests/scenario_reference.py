"""
Service-level parity harness, Python side.

Runs a scenario (tests/scenario_steps.json, built below) against the ORIGINAL
FastAPI backend using its TestClient and records every response. The Node
side (tests/services.test.mjs) replays the same steps against the new
in-browser services and compares the responses.

Usage: python3 tests/scenario_reference.py <old-backend-dir> <cv-dir> <licenses.json> <out-dir>
"""
import json
import os
import shutil
import sys

backend_dir, cv_dir, lic_path, out_dir = sys.argv[1:5]
os.makedirs(out_dir, exist_ok=True)
data_dir = os.path.join(out_dir, "pydata")
shutil.rmtree(data_dir, ignore_errors=True)
os.environ["MRI_DATA_DIR"] = data_dir
sys.path.insert(0, backend_dir)

import functools, operator  # noqa: E402
import ai_engine  # noqa: E402
ai_engine.sum = lambda it, start=0: functools.reduce(operator.add, it, start)  # Python 3.11 float sum semantics (see parity_engine.py)

import license as license_module  # noqa: E402
LIC = json.load(open(lic_path))
license_module.PUBLIC_KEY_HEX = LIC["pub"]

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402
from openpyxl import Workbook  # noqa: E402

# ------------------------------------------------------------- test files --
def make_xlsx(path, sheet, headers, rows):
    wb = Workbook(); ws = wb.active; ws.title = sheet
    ws.append(headers)
    for r in rows: ws.append(r)
    wb.save(path)

emp_headers = ["Employee Number", "Full Name", "Gender", "Date of Birth", "Phone", "Email", "Address", "Department", "Division", "Position", "Supervisor",
               "Join Date", "Employment Type", "Employment Status", "Contract Start Date", "Contract End Date", "Location", "Work Site", "Education", "Notes"]
emp_rows = [
    ["E-1", "Ani Valid", "Female", "1991-02-03", "0811", "ani@x.com", "Jl A", "Finance", "Acc", "Analyst", "Bos", "2022-01-10", "Permanent", "Active", None, None, "Jakarta", "HO", "S1", "ok"],
    ["E-2", "Beni Kontrak", None, None, None, "beni@x.com", None, "IT", None, "Dev", None, "2023-03-01", "Contract", "Active", "2023-03-01", "2030-01-01", None, None, None, None],
    ["E-1", "Duplikat Nomor", None, None, None, None, None, "IT", None, None, None, None, "Contract", "Active"],
    ["E-3", "", None, None, None, None, None, "IT", None, None, None, None, "Contract", "Active"],
    ["E-4", "Salah Tipe", None, None, None, None, None, "IT", None, None, None, None, "Bogus", "Active"],
    ["E-5", "Salah Tanggal", None, "31/12/2020", None, None, None, "IT", None, None, None, None, "Permanent", "Active"],
    [None] * 20,
    ["E-6", "Status Aneh", None, None, None, None, None, "HR", None, None, None, None, "Permanent", "Zombie"],
]
make_xlsx(os.path.join(out_dir, "employees.xlsx"), "Employees", emp_headers, emp_rows)
make_xlsx(os.path.join(out_dir, "criteria.xlsx"), "Job Criteria",
          ["Title", "Position", "Department", "Job Level", "Min Education", "Min Experience Years", "Technical Skills (comma separated)", "Soft Skills (comma separated)",
           "Certifications Required (comma separated)", "Mandatory Criteria (comma separated)", "Passing Score", "Minimum Score", "Notes"],
          [["QA Lead", "QA Lead", "Quality", "Lead", "S1", 4, "Auditing, Compliance", "Leadership", "ISO 9001", "Bersedia shift, SIM A", 80, 65, "n"],
           ["Production Supervisor - Standard", "Dup", None, None, None, None, None, None, None, None, None, None, None],
           ["", "NoTitle", None, None, None, None, None, None, None, None, None, None, None],
           ["Bad Num", "X", None, None, None, "abc", None, None, None, None, None, None, None]])
make_xlsx(os.path.join(out_dir, "unis.xlsx"), "Universities", ["Name", "Tier", "Accreditation", "Min GPA", "Location", "Notes"],
          [["Universitas Baru", "Tier 3", "B", 2.5, "Solo", None], ["Universitas Indonesia", "Tier 1", "A", 3, "Depok", None], ["Kampus GPA Salah", None, None, "tinggi", None, None], [None, "x", None, None, None, None]])
make_xlsx(os.path.join(out_dir, "questions.xlsx"), "Interview Questions", ["Question Text", "Competency", "Stage Code", "Job Level", "Question Type", "Ideal Answer Notes"],
          [["Apa kelemahan Anda?", "Self Awareness", "HR_INTERVIEW", "Staff", "Behavioral", "jujur"], ["Bagaimana Anda menangani konflik antar anggota tim?", "Leadership", "HR_INTERVIEW", None, None, None], [None, "x", None, None, None, None]])

# -------------------------------------------------------------- the steps --
files = sorted(f for f in os.listdir(cv_dir) if f.startswith("cv_"))
sources = ["Job Portal", "LinkedIn", "Email", "Manual Upload"]

vac_prod = dict(position="Production Supervisor", department="Manufacturing", job_level="Supervisor", location="Tangerang", min_education="S1", min_experience_years=3,
                technical_skills=["Six Sigma", "Production Planning", "Quality Control"], soft_skills=["Leadership", "Communication"], certifications_required=["Six Sigma Green Belt"],
                leadership_required=True, mandatory_criteria=["Bersedia shift"], passing_score=75, minimum_score=60)
vac_fin = dict(position="Finance Staff", department="Finance", min_education="D3", min_experience_years=1, technical_skills=["Accounting", "Excel", "Taxation"],
               soft_skills=["Communication"], certifications_required=[], leadership_required=False, passing_score=70, minimum_score=50)
vac_sales = dict(position="Sales Lead", department="Sales", min_education="S1", min_experience_years=5, technical_skills=["CRM", "Negotiation"], soft_skills=["Leadership"],
                 certifications_required=["PMP"], leadership_required=True, passing_score=72, minimum_score=55)

S = []
def req(m, p, **kw): S.append(dict(kind="req", m=m, p=p, **kw))

req("GET", "/api/license/status", tag="license_before")
req("POST", "/api/license/activate", json={"license_text": LIC["vip"]}, tag="activate_vip")
req("POST", "/api/license/activate", json={"license_text": "abc.def"}, tag="activate_bad", expect_error=True)
req("GET", "/api/license/status", tag="license_after")
req("POST", "/api/vacancies", json=vac_prod, tag="vac1")
req("POST", "/api/vacancies", json=vac_fin, tag="vac2")
req("POST", "/api/vacancies?from_knowledge_id=1", json=vac_sales, tag="vac3_from_template")
req("POST", "/api/vacancies", json=dict(position=" ", passing_score=70), tag="vac_bad_name", expect_error=True)
req("POST", "/api/vacancies", json=dict(position="X", passing_score=40, minimum_score=60), tag="vac_bad_scores", expect_error=True)
req("POST", "/api/vacancies", json=dict(position="X", criteria_weights={"education": 0.5}), tag="vac_bad_weights", expect_error=True)
req("GET", "/api/vacancies", tag="vacancies")
req("GET", "/api/vacancies/1", tag="vacancy1")
for i, f in enumerate(files):
    req("POST", "/api/cv/upload", file=os.path.join(cv_dir, f), form={"source": sources[i % 4]}, tag=f"upload_{f}", expect_error_ok=True)
req("POST", "/api/cv/upload", file=os.path.join(out_dir, "employees.xlsx"), form={"source": "x"}, tag="upload_bad_ext", expect_error=True)
req("GET", "/api/candidates", tag="candidates_all")
req("GET", "/api/candidates?q=budi", tag="candidates_q")
req("GET", "/api/candidates?min_experience=9", tag="candidates_exp")
req("GET", "/api/candidates?education=S1", tag="candidates_edu")
req("GET", "/api/candidates?skill=excel", tag="candidates_skill")
req("GET", "/api/candidates?source=LinkedIn", tag="candidates_source")
S.append(dict(kind="macro_screen_all"))
req("GET", "/api/screening-center/1", tag="center1")
req("GET", "/api/screening-center/2", tag="center2")
req("GET", "/api/screening-center/3", tag="center3")
req("GET", "/api/screening/1", tag="screening1")
req("GET", "/api/candidates/1", tag="candidate360_1")
S.append(dict(kind="macro_decide"))
req("GET", "/api/talent-pool", tag="pool")
req("POST", "/api/talent-pool/reactivate", json={"candidate_id": 1, "vacancy_id": 2}, tag="reactivate")
req("GET", "/api/talent-pool?status=REACTIVATED", tag="pool_reactivated")
req("GET", "/api/stage-config", tag="stage_config")
req("POST", "/api/recruitment-stage", json=dict(candidate_id=1, vacancy_id=1, stage_code="HR_INTERVIEW", criteria_scores={"Communication": 85, "Leadership": 90.5}, evidence={"Communication": "baik"}, reason="ok", decision="PASS"), tag="stage_hr")
req("POST", "/api/recruitment-stage", json=dict(candidate_id=1, vacancy_id=1, stage_code="HR_INTERVIEW", criteria_scores={}, decision="PASS"), tag="stage_missing_scores", expect_error=True)
req("POST", "/api/recruitment-stage", json=dict(candidate_id=1, vacancy_id=1, stage_code="ASSESSMENT", criteria_scores={"T": 70}), tag="stage_missing_decision", expect_error=True)
req("POST", "/api/recruitment-stage", json=dict(candidate_id=1, vacancy_id=1, stage_code="NOPE", criteria_scores={"T": 70}, decision="PASS"), tag="stage_unknown", expect_error=True)
req("POST", "/api/recruitment-stage", json=dict(candidate_id=1, vacancy_id=1, stage_code="ASSESSMENT", criteria_scores={"Tech": 80, "Case": 60}, decision="HOLD"), tag="stage_assess")
req("POST", "/api/recruitment-stage", json=dict(candidate_id=1, vacancy_id=1, stage_code="HIRED", status="COMPLETED"), tag="stage_hired")
req("GET", "/api/recruitment-stage/1", tag="stages_of_1")
req("POST", "/api/employees/from-candidate", json=dict(candidate_id=1, department="Manufacturing", employment_type="Contract", contract_end_date="2030-06-30", join_date="2026-01-05"), tag="emp_from_cand")
req("POST", "/api/employees/from-candidate", json=dict(candidate_id=1), tag="emp_from_cand_again")
req("POST", "/api/employees/from-candidate", json=dict(candidate_id=2), tag="emp_not_hired", expect_error=True)
req("POST", "/api/employees/import", file=os.path.join(out_dir, "employees.xlsx"), tag="emp_import")
req("GET", "/api/employees?page_size=50", tag="employees")
req("GET", "/api/employees?q=ani", tag="employees_q")
req("GET", "/api/employees?employment_type=Contract", tag="employees_type")
req("PUT", "/api/employees/1", json=dict(division="Prod", position="Supervisor", notes="hi", supervisor="Andi"), tag="emp_update")
req("GET", "/api/employees/1", tag="emp360")
req("GET", "/api/employee-options", tag="emp_options")
req("GET", "/api/dashboard/employee", tag="emp_dashboard")
req("GET", "/api/knowledge/job-criteria", tag="kc_criteria")
req("POST", "/api/knowledge/job-criteria/import", file=os.path.join(out_dir, "criteria.xlsx"), tag="kc_criteria_import")
req("POST", "/api/knowledge/job-criteria", json=dict(title="T1", position="P1", technical_skills=["A"]), tag="kc_criteria_create")
req("DELETE", "/api/knowledge/job-criteria/2", tag="kc_criteria_deactivate")
req("GET", "/api/knowledge/job-criteria", tag="kc_criteria_after")
req("GET", "/api/knowledge/universities?q=universitas", tag="kc_unis")
req("POST", "/api/knowledge/universities/import", file=os.path.join(out_dir, "unis.xlsx"), tag="kc_unis_import")
req("POST", "/api/knowledge/universities", json=dict(name="Universitas Baru"), tag="kc_uni_dup", expect_error=True)
req("GET", "/api/knowledge/interview-questions?stage_code=HR_INTERVIEW", tag="kc_questions")
req("POST", "/api/knowledge/interview-questions/import", file=os.path.join(out_dir, "questions.xlsx"), tag="kc_questions_import")
req("POST", "/api/knowledge/interview-questions/1/mark-used", tag="kc_question_used")
req("GET", "/api/knowledge/interview-questions", tag="kc_questions_after")
req("GET", "/api/dashboard/executive", tag="dashboard")
req("GET", "/api/dashboard/ai-hr-alignment", tag="alignment")
req("GET", "/api/batch-upload", tag="batches_none")
req("POST", "/api/demo/seed", tag="demo_seed")
req("GET", "/api/demo/status", tag="demo_status")
req("GET", "/api/dashboard/executive", tag="dashboard_with_demo_shape", shape_only=True)
req("POST", "/api/demo/seed", tag="demo_seed_again", expect_error=True)
req("POST", "/api/demo/reset", tag="demo_reset")
req("GET", "/api/demo/status", tag="demo_status_after")
req("GET", "/api/dashboard/executive", tag="dashboard_after_reset")
req("GET", "/api/audit-trail?limit=1000", tag="audit", audit=True)

json.dump(S, open(os.path.join(out_dir, "steps.json"), "w"))

# ------------------------------------------------------------- execution --
client = TestClient(app)
r = client.post("/api/auth/signup", json=dict(workspace_name="WS", full_name="Tester Person", email="t@example.com", username="tester", password="secret1"))
assert r.status_code == 200, r.text

obs = {}
def call(step):
    m, p = step["m"], step["p"]
    kwargs = {}
    fh = None
    if "json" in step: kwargs["json"] = step["json"]
    if "file" in step:
        fh = open(step["file"], "rb")
        kwargs["files"] = {"file": (os.path.basename(step["file"]), fh)}
        if "form" in step: kwargs["data"] = step["form"]
    try:
        resp = client.request(m, p, **kwargs)
    finally:
        if fh: fh.close()
    try: body = resp.json()
    except Exception: body = None
    return resp.status_code, body

for step in S:
    if step["kind"] == "macro_screen_all":
        cands = client.get("/api/candidates").json()
        ids = sorted(c["id"] for c in cands)
        results = []
        for vid in (1, 2, 3):
            for cid in ids:
                sc, b = call(dict(m="POST", p="/api/screening/run", json=dict(candidate_id=cid, vacancy_id=vid)))
                results.append([cid, vid, sc, b])
        obs["screen_all"] = {"status": 200, "body": results}
    elif step["kind"] == "macro_decide":
        plan = [(1, "PASS", "kuat"), (2, "TALENT_POOL", "simpan"), (3, "REJECT", "kurang"), (4, "HOLD", "tunggu"), (5, "PASS", "ok"), (6, "TALENT_POOL", "pool")]
        results = []
        for sid, dec, reason in plan:
            sc, b = call(dict(m="POST", p="/api/hr-decision", json=dict(screening_id=sid, decision=dec, reason=reason, remarks="r")))
            results.append([sid, dec, sc, b])
        sc, b = call(dict(m="POST", p="/api/hr-decision", json=dict(screening_id=1, decision="MAYBE", reason="x")))
        results.append([1, "MAYBE", sc, b])
        obs["decide"] = {"status": 200, "body": results}
    else:
        sc, body = call(step)
        obs[step["tag"]] = {"status": sc, "body": body}

json.dump(obs, open(os.path.join(out_dir, "expected_obs.json"), "w"), ensure_ascii=False)
n_cand = len(client.get("/api/candidates").json())
print(f"reference run done: {len(obs)} observations, {n_cand} candidates -> {out_dir}")
