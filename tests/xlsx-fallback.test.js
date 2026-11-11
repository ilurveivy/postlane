import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Worker } from 'node:worker_threads';
import { readNamespacedXlsx } from '../server/xlsx-fallback.js';
async function fixture(body = '  Hi &amp; hello&#10;&#10;原文&#10;  ') {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Candidates" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    'xl/sharedStrings.xml',
    '<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:si><x:r><x:t>  Subject</x:t></x:r><x:r><x:t>  </x:t></x:r></x:si></x:sst>',
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>business_email</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>email_subject</x:t></x:is></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>email_content</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>person@example.com</x:t></x:is></x:c><x:c r="B2" t="s"><x:v>0</x:v></x:c><x:c r="C2" t="inlineStr"><x:is><x:t xml:space="preserve">${body}</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
function parse(buffer) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../server/import-worker.js', import.meta.url), {
      workerData: { buffer, csv: false },
    });
    w.once('message', resolve);
    w.once('error', reject);
  });
}
test('namespace-prefixed inline/shared strings retain whitespace, entities and line breaks', async () => {
  const buffer = await fixture();
  const expected = ['person@example.com', '  Subject  ', '  Hi & hello\n\n原文\n  '];
  const sheets = await readNamespacedXlsx(buffer);
  assert.deepEqual(sheets[0].matrix[1], expected);
  const parsed = await parse(buffer);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(Object.values(parsed.sheets[0].rows[0]), expected);
});
test('oversized content fails import rather than silently truncating copy', async () => {
  const parsed = await parse(await fixture('a'.repeat(5001)));
  assert.match(parsed.error, /未截断原文/);
});
