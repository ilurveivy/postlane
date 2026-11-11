import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import path from 'node:path';

const array = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const text = (value) =>
  typeof value === 'object' && value !== null ? text(value['#text'] ?? '') : String(value ?? '');
const richText = (value) =>
  value?.r
    ? array(value.r)
        .map((r) => text(r.t))
        .join('')
    : text(value?.t);

// Some spreadsheet exporters namespace every tag (x:workbook, x:sheet, ...).
// ExcelJS cannot read those workbooks; resolve OOXML relationships and cached cell values directly.
export async function readNamespacedXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    htmlEntities: true,
  });
  async function xml(name, optional = false) {
    const file = zip.file(name);
    if (!file) {
      if (optional) return {};
      throw Error('Excel 缺少工作表结构');
    }
    const source = await file.async('string');
    if (source.length > 16 * 1024 * 1024 || /<!DOCTYPE/i.test(source))
      throw Error('Excel 内容过大或包含不支持的 XML 定义');
    return parser.parse(source);
  }
  const workbook = (await xml('xl/workbook.xml')).workbook;
  const sheets = array(workbook?.sheets?.sheet);
  if (!sheets.length || sheets.length > 20) throw Error('Excel 需要包含 1–20 个工作表');
  const relationships = array(
    (await xml('xl/_rels/workbook.xml.rels')).Relationships?.Relationship,
  );
  const shared = array((await xml('xl/sharedStrings.xml', true)).sst?.si).map(richText);
  const result = [];
  for (const sheet of sheets) {
    const rel = relationships.find((r) => r['@_Id'] === sheet['@_id']);
    if (!rel || rel['@_TargetMode'] === 'External') throw Error('Excel 工作表引用无效');
    const target = rel['@_Target'];
    const name = path.posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    if (!name.startsWith('xl/')) throw Error('Excel 工作表路径无效');
    const data = (await xml(name)).worksheet;
    const matrix = [];
    let width = 0;
    for (const row of array(data?.sheetData?.row)) {
      if (Number(row['@_r']) > 10001 || matrix.length >= 10001)
        throw Error('每个工作表最多支持 10,000 行数据');
      const values = [];
      for (const cell of array(row.c)) {
        const address = cell['@_r'] || '';
        if (!/^[A-Z]+[1-9]\d*$/.test(address)) throw Error('Excel 单元格地址无效');
        let col = 0;
        for (const letter of address.match(/^[A-Z]+/)[0])
          col = col * 26 + letter.charCodeAt(0) - 64;
        if (col > 50) throw Error('最多支持 50 列');
        let value;
        if (cell['@_t'] === 'inlineStr') value = richText(cell.is);
        else if (cell['@_t'] === 's') {
          value = shared[Number(text(cell.v))];
          if (value === undefined) throw Error('Excel 共享文本引用无效');
        } else {
          if (cell.f !== undefined && cell.v === undefined)
            throw Error('表格公式尚无计算结果，请在 Excel 中重新计算并保存');
          value = text(cell.v);
        }
        values[col - 1] = value;
        width = Math.max(width, col);
      }
      matrix.push(values);
    }
    if (matrix.filter((r) => r.some((v) => String(v ?? '').trim())).length > 1)
      result.push({
        name: sheet['@_name'],
        matrix: matrix.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')),
      });
  }
  if (!result.length) throw Error('没有找到包含数据的工作表');
  return result;
}
