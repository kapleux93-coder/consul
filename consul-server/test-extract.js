'use strict';
/* Тест извлечения текста из файлов. Фикстуры собираются прямо здесь, чтобы
 * тест не зависел от внешних файлов: настоящий zip (DOCX/XLSX) и настоящий PDF
 * со сжатым потоком. */
const assert = require('assert');
const zlib = require('zlib');
const ex = require('./extract');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

/* ------------------------------------------------ сборка zip */

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/* ------------------------------------------------ сборка pdf */

function makePdf(contentStream, compress) {
  let data = Buffer.from(contentStream, 'latin1');
  let filter = '';
  if (compress !== false) { data = zlib.deflateSync(data); filter = '/Filter /FlateDecode '; }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    null,
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let len = parts[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(len);
    let b;
    if (o === null) {
      const head = Buffer.from(`4 0 obj\n<< ${filter}/Length ${data.length} >>\nstream\n`, 'latin1');
      b = Buffer.concat([head, data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else {
      b = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    }
    parts.push(b); len += b.length;
  });
  parts.push(Buffer.from(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${len}\n%%EOF`, 'latin1'));
  return Buffer.concat(parts);
}

/** Кириллица в PDF-строке: байты CP1251 через октальные escape. */
const CP1251_TABLE = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–— ™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
function toCp1251Octal(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 127 && !'()\\'.includes(ch)) { out += ch; continue; }
    const idx = CP1251_TABLE.indexOf(ch);
    if (idx >= 0) out += '\\' + (0x80 + idx).toString(8).padStart(3, '0');
    else out += '?';
  }
  return out;
}

/* ------------------------------------------------ тесты */

console.log('extract / DOCX');

const DOCX = makeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
  ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
    <w:p><w:r><w:t>Правила доставки Nordlight</w:t></w:r></w:p>
    <w:p><w:r><w:t>По Москве бесплатно от 5 000 </w:t></w:r><w:r><w:t>рублей, курьер 490 рублей.</w:t></w:r></w:p>
    <w:p><w:r><w:t>По России СДЭК 2-5 дней. Возврат в течение 14 дней без объяснения причин.</w:t></w:r></w:p>
  </w:body></w:document>`],
]);

t('читает DOCX и склеивает разорванные фрагменты строки', () => {
  const r = ex.extract(DOCX, 'rules.docx');
  assert.strictEqual(r.kind, 'docx');
  assert.ok(/Правила доставки Nordlight/.test(r.text));
  assert.ok(/от 5 000 рублей, курьер 490 рублей/.test(r.text), 'два <w:t> склеены без пробела-разрыва');
  assert.ok(/СДЭК/.test(r.text));
});

t('абзацы становятся переносами строк', () => {
  const r = ex.extract(DOCX, 'rules.docx');
  assert.ok(r.text.split('\n').length >= 3);
});

console.log('extract / XLSX');

const XLSX = makeZip([
  ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst>
    <si><t>Товар</t></si><si><t>Цена</t></si><si><t>Наличие</t></si>
    <si><t>Торшер Lumen Arc</t></si><si><t>Панель Lumen Office</t></si><si><t>есть</t></si></sst>`],
  ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>12400</v></c><c r="C2" t="s"><v>5</v></c></row>
    <row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>3200</v></c><c r="C3" t="s"><v>5</v></c></row>
  </sheetData></worksheet>`],
]);

t('читает XLSX через словарь общих строк', () => {
  const r = ex.extract(XLSX, 'price.xlsx');
  assert.strictEqual(r.kind, 'xlsx');
  assert.ok(/Торшер Lumen Arc/.test(r.text));
  assert.ok(/12400/.test(r.text), 'числовые ячейки не теряются');
});

t('строка прайса остаётся одной строкой', () => {
  const line = ex.extract(XLSX, 'price.xlsx').text.split('\n').find(l => /Lumen Arc/.test(l));
  assert.ok(/Торшер Lumen Arc · 12400 · есть/.test(line), line);
});

console.log('extract / PDF');

const LINES = [
  'Каталог Nordlight 2026',
  'Торшер Lumen Arc - 12 400 рублей, теплый свет, диммер, высота 175 см',
  'Панель Lumen Office - 3 200 рублей за штуку, от 10 штук скидка 7 процентов',
  'Лента LED Flex - 1 890 рублей за метр, блок питания в комплекте',
];
const PDF = makePdf('BT /F1 12 Tf 50 740 Td 16 TL\n' + LINES.map(l => `(${toCp1251Octal(l)}) Tj T*`).join('\n') + '\nET');

t('читает PDF со сжатым потоком и кириллицей', () => {
  const r = ex.extract(PDF, 'catalog.pdf');
  assert.strictEqual(r.kind, 'pdf');
  assert.ok(/Торшер Lumen Arc/.test(r.text), r.text.slice(0, 120));
  assert.ok(/12 400 рублей/.test(r.text));
  assert.ok(/скидка 7 процентов/.test(r.text));
});

t('PDF без текстового слоя отклоняется, а не выдаёт пустоту', () => {
  const scan = makePdf('q 612 0 0 792 0 0 cm /Im0 Do Q');
  assert.throws(() => ex.extract(scan, 'scan.pdf'), /скан|текстов/i);
});

t('не-PDF с расширением .pdf отклоняется', () => {
  assert.throws(() => ex.extract(Buffer.from('просто текст'), 'fake.pdf'), /это не PDF/);
});

/* --- современный PDF: Type0 + Identity-H + ToUnicode --- */

/** Собирает PDF, где буквы закодированы произвольными glyph id, а расшифровать
 *  их можно только по таблице ToUnicode — так делают InDesign, Word и 1С. */
function makeModernPdf(lines, packInObjStm) {
  const chars = [...new Set(lines.join(''))].sort();
  const gid = new Map(chars.map((c, i) => [c, i + 3]));
  const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');

  const bf = chars.map(c => `<${hex4(gid.get(c))}> <${hex4(c.charCodeAt(0))}>`).join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
    `${chars.length} beginbfchar\n${bf}\nendbfchar\nendcmap\nend`;

  const content = 'BT /F1 12 Tf 50 740 Td 16 TL\n' +
    lines.map(l => '<' + [...l].map(c => hex4(gid.get(c))).join('') + '> Tj T*').join('\n') + '\nET';

  const streamObj = (num, data) => {
    const comp = zlib.deflateSync(Buffer.from(data, 'latin1'));
    return Buffer.concat([
      Buffer.from(`${num} 0 obj\n<< /Filter /FlateDecode /Length ${comp.length} >>\nstream\n`, 'latin1'),
      comp,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]);
  };

  const dicts = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    5: '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Golos /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    6: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Golos >>',
  };

  const parts = [Buffer.from('%PDF-1.7\n', 'latin1')];
  parts.push(streamObj(4, content));
  parts.push(streamObj(7, Buffer.from(cmap, 'utf8').toString('latin1')));

  if (packInObjStm) {
    // Словари прячем в сжатый поток объектов — формат PDF 1.5 и новее.
    let body = '', header = [];
    for (const [num, d] of Object.entries(dicts)) { header.push(`${num} ${body.length}`); body += d + ' '; }
    const head = header.join(' ') + '\n';
    const comp = zlib.deflateSync(Buffer.from(head + body, 'latin1'));
    parts.push(Buffer.concat([
      Buffer.from(`8 0 obj\n<< /Type /ObjStm /N ${Object.keys(dicts).length} /First ${head.length} /Filter /FlateDecode /Length ${comp.length} >>\nstream\n`, 'latin1'),
      comp,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]));
  } else {
    for (const [num, d] of Object.entries(dicts)) parts.push(Buffer.from(`${num} 0 obj\n${d}\nendobj\n`, 'latin1'));
  }
  parts.push(Buffer.from('trailer\n<< /Size 9 /Root 1 0 R >>\n%%EOF', 'latin1'));
  return Buffer.concat(parts);
}

const MODERN_LINES = [
  'Каталог Nordlight 2026',
  'Торшер Lumen Arc — 12 400 ₽, тёплый свет, диммер, высота 175 см',
  'Панель Lumen Office — 3 200 ₽ за штуку, от 10 штук скидка 7%',
  'Доставка по Москве от 5 000 ₽ бесплатно, по России СДЭК 2–5 дней',
];

t('читает современный PDF с subset-шрифтом по таблице ToUnicode', () => {
  const r = ex.extract(makeModernPdf(MODERN_LINES, false), 'catalog.pdf');
  assert.ok(/Торшер Lumen Arc/.test(r.text), r.text.slice(0, 200));
  assert.ok(/12 400 ₽/.test(r.text), 'символ рубля сохранён');
  assert.ok(/СДЭК 2–5 дней/.test(r.text), 'длинное тире сохранено');
});

t('читает PDF, где объекты упакованы в сжатый ObjStm', () => {
  const r = ex.extract(makeModernPdf(MODERN_LINES, true), 'catalog.pdf');
  assert.ok(/Панель Lumen Office/.test(r.text), r.text.slice(0, 200));
  assert.ok(/3 200 ₽ за штуку/.test(r.text));
});

t('PDF с паролем отклоняется до разбора', () => {
  const enc = Buffer.concat([makeModernPdf(MODERN_LINES, false), Buffer.from('\n/Encrypt 9 0 R\n', 'latin1')]);
  assert.throws(() => ex.extract(enc, 'locked.pdf'), /паролем/);
});


console.log('extract / защита от мусора');

t('текст со сбитой кодировкой не попадает в базу знаний', () => {
  const garbled = 'Лбубмпд Nordlight 2026 Упсщжс Lumen Arc 12 400 сфвмжк ужрмьк тгжу ейннжс гьтпуб 175 тн ' +
                  'Рбожмэ Lumen Office 3 200 сфвмжк иб щуфлф пу 10 щуфл тлйелб 7 рспчжоупг Мжоуб LED Flex 1 890 сфвмжк';
  const v = ex.looksLikeText(garbled);
  assert.strictEqual(v.ok, false);
  assert.ok(/кодировк/i.test(v.reason), v.reason);
});

t('нормальный текст проходит проверку', () => {
  assert.strictEqual(ex.looksLikeText(LINES.join('\n')).ok, true);
});

t('короткий обрывок не принимается', () => {
  assert.strictEqual(ex.looksLikeText('Цена 100').ok, false);
});

t('прайс без служебных слов проходит (короткие строки — не проза)', () => {
  assert.strictEqual(ex.looksLikeText(ex.extract(XLSX, 'price.xlsx').text).ok, true);
});

t('неизвестное расширение отклоняется с понятным текстом', () => {
  assert.throws(() => ex.extract(Buffer.from('x'), 'photo.heic'), /Не понимаю формат/);
});

t('CSV и TXT читаются как есть', () => {
  const csv = 'Товар;Цена;Наличие\nТоршер Lumen Arc;12400;есть\nПанель Lumen Office;3200;под заказ\nЛента LED Flex;1890;есть';
  const r = ex.extract(Buffer.from(csv, 'utf8'), 'price.csv');
  assert.strictEqual(r.kind, 'text');
  assert.ok(/Lumen Office/.test(r.text));
});

t('HTML чистится от скриптов и тегов', () => {
  const html = '<html><script>alert(1)</script><body><h1>Доставка</h1><p>По Москве от 5 000 рублей бесплатно, курьер 490 рублей за заказ</p></body></html>';
  const r = ex.extract(Buffer.from(html, 'utf8'), 'page.html');
  assert.ok(!/alert|<|>/.test(r.text), r.text);
  assert.ok(/Доставка/.test(r.text) && /490/.test(r.text));
});

console.log('extract: ' + n + ' тестов пройдено\n');
