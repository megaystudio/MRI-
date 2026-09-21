"""
Parity check: runs the ORIGINAL Python ai_engine (from the old FastAPI
backend) over a corpus of CV texts and screening scenarios and writes the
expected outputs to a JSON file. tests/parity.test.mjs then runs the new
JavaScript engine on the same inputs and requires identical results.

Usage:
    python3 tests/parity_engine.py <path-to-old-backend-dir> <out.json>
"""
import json
import random
import sys
from dataclasses import asdict

backend_dir, out_path = sys.argv[1], sys.argv[2]
sys.path.insert(0, backend_dir)
import ai_engine  # noqa: E402  (original implementation)

# The production Dockerfile runs Python 3.11, where sum() over floats is a
# plain left-to-right addition. Python >= 3.12 switched sum() to compensated
# (Neumaier) summation, which can differ in the last bit and flip a rounding
# tie. Pin the 3.11 behaviour here so the comparison is against what the
# deployed server actually computed.
import functools, operator  # noqa: E402


def _naive_sum(iterable, start=0):
    return functools.reduce(operator.add, iterable, start)


ai_engine.sum = _naive_sum

random.seed(20260920)

HAND_WRITTEN = [
    # Typical Indonesian CV
    """Budi Santoso
Jl. Merdeka No. 10, Jakarta
Email: budi.santoso@example.com | Telp: 081234567890

PENDIDIKAN
S1 Teknik Industri, Universitas Indonesia, 2010 - 2014

PENGALAMAN KERJA
Production Supervisor, PT Contoh Sejahtera 2016 - 2020
Memimpin tim produksi 25 orang, menerapkan Six Sigma dan Lean Manufacturing.
Production Manager | PT Global Industries 2020 - Present
Mengelola Production Planning dan Quality Control.

SERTIFIKASI
Six Sigma Green Belt (2018)
ISO 9001 Lead Auditor 2019
""",
    # Negations, fresh graduate, org activity
    """Siti Rahayu
siti.rahayu@mail.co.id  08129876543

Pendidikan: bukan lulusan SMA favorit, lulus D3 Akuntansi 2019
Organisasi: Himpunan Mahasiswa 2017 - 2018
Panitia Dies Natalis 2018 - 2019
Tidak ada sertifikasi
Sertifikasi: currently pursuing PMP
Skills: Excel, Accounting, komunikasi, teamwork
""",
    # Company names containing skill words, table-like flattened rows
    """Rudi Hartono
rudi@site.org
Electrical Engineer PT SAP Solutions Indonesia 2012 - 2015
Senior Engineer CV Maju Jaya 2015 - 2019
Kepala Divisi, PT Dummy Power Tbk, 2019 - sekarang
SERTIFIKASI DAN STATUS PROFESIONAL
Certification Year
CCNA 2017
""",
    # No name, no contacts
    """curriculum vitae
skills: python, sql, java, javascript
worked 2001 - 2004 as coordinator
""",
    # Multiple degrees, master keyword, phd negation
    """Dr. Ani Wijaya
ani@uni.ac.id
S2 Manajemen (Master of Business) 2012
Bukan doktor, tidak belum S3
Bachelor of Science 2008
Head of HR, PT Sinergi Group 2013 - 2022
Director of People, LLC Nusantara 2022 - present
Recruitment Payroll HRIS Talent Management Labor Law
PHR 2015, SPHR 2018, SHRM 2020
""",
    "",
    "   \n\n  ",
    "Nama Panjang Sekali Untuk Uji Coba Nama Melebihi Batas Lima Kata\nfoo@bar.com",
    "A B\nrecruiter 2010 - 2012 sma smk\nbachelor\n",
    "Ünïcödé Nàme\nEmail ünï@example.com\nS1 Ekonomi\nInc. Corp. LTD. 2015 - 2017 manager\n",
]

FRAG_NAMES = ["Budi Santoso", "Dewi Lestari", "Agus Wijaya", "Nur Hidayat", "Rina Marlina", "Eko Prasetyo", "X"]
FRAG_CONTACT = [
    "Email: {n}@example.com", "hp 0812{d}", "+62 8{d}", "Telp 08{d}", "no.hp: 6281{d}", "",
]
FRAG_EDU = [
    "S1 Teknik Industri 2010 - 2014", "S2 Manajemen 2015", "D3 Akuntansi", "SMA Negeri 1 Jakarta 2006",
    "Bachelor of Engineering, B.Eng 2011", "Master of Science", "Doktor Ekonomi", "Bukan lulusan S2",
    "belum lulus S1", "Diploma Teknik", "high school graduate", "Sarjana Hukum", "lulusan SMK",
]
FRAG_EXP = [
    "Production Supervisor, PT Contoh Sejahtera {a} - {b}",
    "Finance Staff | PT Maju Bersama {a} - {b}",
    "Manager Operasional – CV Sentosa {a} – {b}",
    "Engineer PT Global Tbk {a} - Present",
    "Koordinator Lapangan {a} - sekarang",
    "Head of Sales, Inc. Alpha {a} — {b}",
    "Staff Admin {a}-{b}",
    "Organisasi Himpunan Mahasiswa {a} - {b}",
    "Panitia Kegiatan Kampus {a} - {b}",
    "Lulus Universitas Diponegoro {a} - {b}",
    "Volunteer Relawan {a} - {b}",
    "Relawan Banjir {a} - {b}",
    "Team Lead SAP Consultant PT SAP Indonesia {a} - {b}",
]
FRAG_SKILL = [
    "Skills: Six Sigma, Lean Manufacturing, SAP, Kaizen", "Menguasai Excel, SQL, Power BI dan Tableau",
    "Python Java JavaScript", "Leadership, Communication, Teamwork", "kepemimpinan dan komunikasi",
    "Quality Control Quality Assurance Supply Chain", "Procurement, Inventory Management, 5S, TPM",
    "Recruitment, Payroll, HRIS", "PT SAP Solutions", "CV Excel Indah", "negosiasi dan public speaking",
    "Digital Marketing SEO CRM Salesforce", "Accounting Taxation Budgeting Auditing",
]
FRAG_CERT = [
    "Six Sigma Green Belt 2018", "ISO 9001 Lead Auditor 2019", "PMP", "Certified Scrum Master (CSM) 2020",
    "Tidak ada sertifikasi", "No certification yet", "Sertifikasi: BNSP Ahli K3", "SERTIFIKASI DAN LISENSI",
    "Certification Year", "AWS Certified Solutions Architect 2021", "sedang menempuh CISSP",
    "TOEFL 550 (2019)", "Brevet A dan Brevet B", "Sertifikat pelatihan manajemen proyek 2016",
    "in progress: CCNA", "Certified Public Accountant program at PT Audit Group", "Certificate of Excellence 2015",
]
FRAG_NOISE = [
    "", "", "Objective: seeking a challenging role", "Referensi tersedia atas permintaan", "Alamat: Jl. Sudirman 45",
    "References: none", "Bahasa: Indonesia, English", "Hobi: membaca", "Lahir 12 Mei 1990",
]


def rnd_doc():
    lines = []
    if random.random() < 0.85:
        lines.append(random.choice(FRAG_NAMES))
    if random.random() < 0.8:
        c = random.choice(FRAG_CONTACT)
        lines.append(c.format(n=random.choice(["budi", "siti.n", "a_b"]), d=random.randint(10000000, 99999999)))
    for _ in range(random.randint(0, 3)):
        lines.append(random.choice(FRAG_EDU))
    for _ in range(random.randint(0, 4)):
        a = random.randint(1998, 2022)
        b = a + random.randint(0, 8)
        lines.append(random.choice(FRAG_EXP).format(a=a, b=b))
    for _ in range(random.randint(0, 3)):
        lines.append(random.choice(FRAG_SKILL))
    for _ in range(random.randint(0, 3)):
        lines.append(random.choice(FRAG_CERT))
    for _ in range(random.randint(0, 3)):
        lines.append(random.choice(FRAG_NOISE))
    random.shuffle(lines) if random.random() < 0.5 else None
    sep = random.choice(["\n", "\n\n", "\r\n"])
    return sep.join(lines)


texts = HAND_WRITTEN + [rnd_doc() for _ in range(1500)]

extraction = []
for t in texts:
    prof = ai_engine.extract_candidate_profile(t)
    extraction.append(asdict(prof))

EDUS = [None, "SMA/SMK", "D3", "S1", "S2", "S3"]
SKILL_POOL = ["Six Sigma", "Excel", "SAP", "Leadership", "communication", "Python", "SQL", "Accounting", "kaizen", "Teamwork"]
CERT_POOL = ["Six Sigma Green Belt", "PMP", "ISO 9001", "CCNA", "K3"]


def rnd_candidate():
    return {
        "highest_education": random.choice(EDUS),
        "total_experience_years": (random.choice([0.0, 0.5, 1.0, 2.0, 2.5, 3.0, 4.5, 6.0, 8.0, 12.0, 15.5]) or 0),  # same normalisation as main.candidate_to_scoring_dict
        "skills": random.sample(SKILL_POOL, random.randint(0, 6)),
        "certifications": random.sample(CERT_POOL, random.randint(0, 3)),
        "has_leadership_experience": random.random() < 0.4,
    }


def rnd_vacancy():
    v = {
        "position": random.choice(["Production Supervisor", "Finance Staff", "HR Recruiter", "IT Support"]),
        "min_education": random.choice(EDUS),
        "min_experience_years": random.choice([0.0, 1.0, 2.0, 3.0, 5.0, 7.5]),
        "technical_skills": random.sample(SKILL_POOL, random.randint(0, 4)),
        "soft_skills": random.sample(["Leadership", "Communication", "Teamwork", "negotiation"], random.randint(0, 3)),
        "leadership_required": random.random() < 0.4,
        "certifications_required": random.sample(CERT_POOL, random.randint(0, 2)),
        "mandatory_criteria": [],
        "criteria_weights": random.choice([{}, {}, {"education": 0.3, "experience": 0.3, "technical_skills": 0.2, "soft_skills": 0.1, "leadership": 0.05, "certification": 0.05},
                                            {"skills": 0.5, "education": 0.2}]),
        "minimum_score": random.choice([40.0, 50.0, 60.0]),
        "passing_score": random.choice([65.0, 70.0, 75.0, 80.0]),
    }
    return v


screening = []
for _ in range(2500):
    c, v = rnd_candidate(), rnd_vacancy()
    screening.append({"candidate": c, "vacancy": v, "expected": ai_engine.screen_candidate(c, v)})

json.dump({"texts": texts, "extraction": extraction, "screening": screening}, open(out_path, "w"), ensure_ascii=False)
print(f"wrote {len(texts)} texts, {len(screening)} screening scenarios -> {out_path}")
