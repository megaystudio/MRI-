#!/bin/sh
# Runs the whole automated suite. Needs: Node 20+, Python 3.10+ with
#   pip install fastapi==0.115.0 sqlalchemy==2.0.35 pydantic==2.9.2 python-multipart==0.0.9 httpx pdfplumber python-docx reportlab openpyxl cryptography playwright
# (+ `playwright install chromium`), `npm install` in the project root, and the ORIGINAL backend folder
# (the old mri_web/backend) passed as $1 — it is the reference the port is compared against.
set -e
BACKEND="${1:?usage: tests/run_all.sh <path-to-old-mri_web/backend>}"
cd "$(dirname "$0")/.."
python3 tests/make_fixtures.py "$BACKEND"
python3 tests/parity_engine.py "$BACKEND" /tmp/parity.json
python3 tests/make_test_files.py "$BACKEND" /tmp/cvfiles
python3 tests/make_chrome_pdfs.py "$BACKEND" /tmp/cvfiles
python3 tests/scenario_reference.py "$BACKEND" /tmp/cvfiles /tmp/licenses.json /tmp/scenario
node tests/parity.test.mjs /tmp/parity.json
node tests/files.test.mjs /tmp/cvfiles
node tests/license.test.mjs /tmp/licenses.json
node tests/services.test.mjs /tmp/scenario /tmp/cvfiles /tmp/licenses.json
node tests/extra.test.mjs
node tools/build_sw.mjs
python3 tests/e2e.py "$PWD" /tmp/cvfiles /tmp/licenses.json /tmp/e2e_shots
echo "ALL TESTS PASSED"
