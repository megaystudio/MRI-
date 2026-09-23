/*
 * MRI — reporting layer (browser port of backend/reports.py):
 *   openpyxl  -> ExcelJS      (Excel export / templates / import reading)
 *   reportlab -> jsPDF + autoTable (PDF reports)
 * Everything is generated locally; no data leaves the browser.
 */
import { getExcelJS, getJsPDF } from './vendor.js';

export const BRAND_NAME = 'MRI — Megay Recruitment Intelligent';
export const BRAND_FOOTER = 'Powered by Megay Studio';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const cellStr = (v) => (v === null || v === undefined ? '' : String(v));

// ------------------------------------------------------------------ Excel ---

async function newWorkbook() {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MRI Personal Workspace';
  wb.created = new Date();
  return wb;
}

function fillSheet(ws, headers, rows) {
  ws.addRow(headers);
  const head = ws.getRow(1);
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2631' } };
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
  });
  for (const r of rows) ws.addRow(r.map(v => (v === undefined ? null : v)));
  headers.forEach((h, i) => {
    let max = String(h).length;
    for (const r of rows) if (r[i] !== null && r[i] !== undefined) max = Math.max(max, String(r[i]).length);
    ws.getColumn(i + 1).width = Math.min(max + 3, 50);
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

async function toBytes(wb) {
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf);
}

export async function buildExcel(sheetTitle, headers, rows) {
  const wb = await newWorkbook();
  const ws = wb.addWorksheet(sheetTitle.slice(0, 31));
  fillSheet(ws, headers, rows);
  return toBytes(wb);
}

export async function buildExcelTemplate(sheetTitle, headers, exampleRow, notes = null) {
  const wb = await newWorkbook();
  const ws = wb.addWorksheet(sheetTitle.slice(0, 31));
  fillSheet(ws, headers, [exampleRow]);
  for (let c = 1; c <= headers.length; c++) ws.getCell(2, c).font = { italic: true, color: { argb: 'FF888888' } };
  if (notes) {
    const nws = wb.addWorksheet('Petunjuk');
    notes.forEach((line, i) => { nws.getCell(i + 1, 1).value = line; });
    nws.getColumn(1).width = 90;
  }
  return toBytes(wb);
}

function normalizeCell(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  if (typeof v === 'object') {
    if ('result' in v) return normalizeCell(v.result);
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if ('text' in v) return normalizeCell(v.text);
    if ('error' in v) return String(v.error);
    return String(v);
  }
  return v;
}

/**
 * Template workbook with several sheets: sheets = [{title, headers, example, validations?:[{col, list}]}].
 * `validations` adds Excel drop-down lists to a column (1-based col) for rows 2..1000.
 * `notes` becomes a 'Petunjuk' sheet; `refSheet` = {title, columns:[{header, values:[...]}]} becomes a read-only reference sheet.
 */
export async function buildMultiSheetTemplate(sheets, notes = null, refSheet = null) {
  const wb = await newWorkbook();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.title.slice(0, 31));
    fillSheet(ws, sh.headers, [sh.example]);
    for (let c = 1; c <= sh.headers.length; c++) ws.getCell(2, c).font = { italic: true, color: { argb: 'FF888888' } };
    for (const v of sh.validations || []) {
      for (let r = 2; r <= 1000; r++) {
        ws.getCell(r, v.col).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${v.list.join(',')}"`] };
      }
    }
  }
  if (notes) {
    const nws = wb.addWorksheet('Petunjuk');
    notes.forEach((line, i) => { nws.getCell(i + 1, 1).value = line; });
    nws.getColumn(1).width = 90;
  }
  if (refSheet) {
    const rws = wb.addWorksheet(refSheet.title.slice(0, 31));
    const cols = refSheet.columns;
    rws.addRow(cols.map(c => c.header));
    rws.getRow(1).eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2631' } };
      cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    });
    const maxLen = Math.max(0, ...cols.map(c => c.values.length));
    for (let i = 0; i < maxLen; i++) rws.addRow(cols.map(c => (i < c.values.length ? c.values[i] : null)));
    cols.forEach((c, i) => { rws.getColumn(i + 1).width = Math.min(Math.max(c.header.length, ...c.values.map(v => String(v).length), 10) + 3, 40); });
    rws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return toBytes(wb);
}

/** Reads every sheet of an .xlsx: Map(sheetName -> [{row, cells}]) from row 2 on (row 1 = headers), blank rows skipped. */
export async function readWorkbookSheets(arrayBuffer, width) {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arrayBuffer);
  const out = new Map();
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber < 2) return;
      const cells = [];
      for (let i = 1; i <= width; i++) cells.push(normalizeCell(row.getCell(i).value));
      rows.push({ row: rowNumber, cells });
    });
    out.set(ws.name, rows);
  }
  return out;
}

/**
 * Reads an .xlsx into {rows:[{row:<excel row number>, cells:[...]}]} starting
 * from row 2 (row 1 = headers). Blank rows are skipped. Uses the sheet named
 * `preferredSheet` when present, otherwise the first sheet.
 */
export async function readWorkbookRows(arrayBuffer, preferredSheet, width) {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arrayBuffer);
  const ws = wb.getWorksheet(preferredSheet) || wb.worksheets[0];
  if (!ws) throw new Error('Workbook tidak memiliki sheet.');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber < 2) return;
    const cells = [];
    for (let i = 1; i <= width; i++) cells.push(normalizeCell(row.getCell(i).value));
    rows.push({ row: rowNumber, cells });
  });
  return rows;
}

// -------------------------------------------------------------------- PDF ---

/** jsPDF's built-in fonts only cover Windows-1252; replace anything else. */
export function pdfSafe(v) {
  return cellStr(v).replace(/[^\u0009\u000A\u0020-\u007E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC\u2122]/g, '?');
}

export async function buildPdfReport(reportTitle, headers, rows, { reportPeriod = 'Seluruh Data', generatedBy = 'System' } = {}) {
  const jsPDF = await getJsPDF();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const stamp = fmtNow();

  const drawChrome = (pageNo) => {
    doc.setTextColor(0);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text(pdfSafe(BRAND_NAME), 20, 15);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(pdfSafe(reportTitle), 20, 21);
    doc.text(pdfSafe(`Periode: ${reportPeriod}`), 20, 26);
    doc.text(`Dibuat: ${stamp}`, pageW - 20, 15, { align: 'right' });
    doc.text(pdfSafe(`Oleh: ${generatedBy}`), pageW - 20, 21, { align: 'right' });
    doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(128);
    doc.text(BRAND_FOOTER, pageW / 2, pageH - 12, { align: 'center' });
    doc.text(`Halaman ${pageNo}`, pageW - 20, pageH - 12, { align: 'right' });
    doc.setTextColor(0);
  };

  // Big centred title on the first page (reportlab "Title" style), table below it.
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  doc.text(pdfSafe(reportTitle), pageW / 2, 40, { align: 'center' });

  doc.autoTable({
    head: [headers.map(pdfSafe)],
    body: rows.map(r => r.map(v => (v === null || v === undefined ? '-' : pdfSafe(v)))),
    startY: 46,
    margin: { top: 32, bottom: 18, left: 15, right: 15 },
    styles: { fontSize: 7.5, cellPadding: 1.6, lineColor: [128, 128, 128], lineWidth: 0.1, valign: 'top', overflow: 'linebreak' },
    headStyles: { fillColor: [30, 38, 49], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: [244, 246, 248] },
    didDrawPage: (data) => drawChrome(data.pageNumber),
  });
  return new Uint8Array(doc.output('arraybuffer'));
}
