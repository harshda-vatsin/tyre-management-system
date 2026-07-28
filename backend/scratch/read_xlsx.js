const ExcelJS = require('exceljs');

function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text) return v.text;
    if (v.result !== undefined) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return JSON.stringify(v).slice(0, 40);
  }
  return String(v);
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('C:\\Users\\Harshda\\Downloads\\Tyre MIS Sample.xlsx');
  wb.eachSheet((sheet) => {
    console.log(`\n=== Sheet: ${sheet.name} | rows: ${sheet.rowCount} | cols: ${sheet.columnCount} ===`);
    const maxRows = Math.min(sheet.rowCount, 6);
    for (let r = 1; r <= maxRows; r++) {
      const row = sheet.getRow(r);
      const values = [];
      for (let c = 1; c <= sheet.columnCount; c++) {
        values.push(cellText(row.getCell(c)));
      }
      console.log(r, '|', values.filter((v, i, arr) => v !== '' || i === arr.length - 1).join(' | '));
    }
  });
})().catch((e) => console.error('ERROR', e.message));
