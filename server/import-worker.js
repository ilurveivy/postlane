import { parentPort, workerData } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { readNamespacedXlsx } from './xlsx-fallback.js';
function toSheet(name, matrix) {
  matrix = matrix.filter((row) => row.some((v) => String(v ?? '').trim()));
  if (matrix.length < 2) throw new Error('表格至少需要一行表头和一行数据');
  if (matrix.length > 10001) throw new Error('每个工作表最多支持 10,000 行，请分批导入');
  const columns = matrix[0].map((v, i) => String(v ?? '').trim() || `列${i + 1}`);
  if (columns.length > 50) throw new Error('最多支持 50 列，请移除不需要的列');
  if (new Set(columns).size !== columns.length)
    throw new Error('表头名称不能重复，请修改后重新导入');
  if (columns.some((v) => v.length > 100 || /[{}]/.test(v)))
    throw new Error('表头最长 100 字，且不能包含大括号');
  if (matrix.some((row) => row.some((value) => String(value ?? '').length > 5000)))
    throw new Error('单元格超过 5,000 字符，请缩短后导入；未截断原文');
  return {
    name,
    columns,
    rows: matrix
      .slice(1)
      .map((values) => Object.fromEntries(columns.map((key, i) => [key, String(values[i] ?? '')]))),
  };
}
try {
  const buffer = Buffer.from(workerData.buffer);
  let sheets;
  if (workerData.csv)
    sheets = [
      toSheet(
        '收件人',
        parse(buffer, {
          bom: true,
          skip_empty_lines: true,
          relax_column_count: true,
          max_record_size: 250000,
        }),
      ),
    ];
  else {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer);
    } catch {
      sheets = (await readNamespacedXlsx(buffer)).map((s) => toSheet(s.name, s.matrix));
    }
    if (!sheets) {
      if (workbook.worksheets.length > 20) throw new Error('最多支持 20 个工作表');
      sheets = workbook.worksheets
        .filter((s) => s.actualRowCount > 1)
        .map((sheet) => {
          if (sheet.rowCount > 10001 || sheet.columnCount > 50)
            throw new Error('表格超过 10,000 行或 50 列限制');
          const matrix = [];
          sheet.eachRow({ includeEmpty: true }, (row) => {
            const values = [];
            for (let i = 1; i <= sheet.columnCount; i++) values.push(row.getCell(i).text);
            matrix.push(values);
          });
          return toSheet(sheet.name, matrix);
        });
      if (!sheets.length) throw new Error('没有找到包含数据的工作表');
    }
  }
  parentPort.postMessage({ sheets });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
