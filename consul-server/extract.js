'use strict';
/* ============================================================================
 * Извлечение текста из файлов, которые владельцы реально приносят:
 * DOCX, XLSX, PDF, CSV и обычный текст. Только стандартная библиотека Node
 * (zlib для распаковки), никаких зависимостей.
 *
 * Важно: у извлечения есть предел. PDF из сканов и файлы со шрифтами без
 * ToUnicode дают мусор вместо букв. Поэтому каждый результат проходит проверку
 * `looksLikeText` — если текст не похож на текст, мы честно отказываемся,
 * а не кладём мусор в базу знаний. Мусор в базе хуже, чем пустая база:
 * на нём модель начнёт выдумывать.
 * ========================================================================== */

const zlib = require('zlib');

/* ============================================================ ZIP */

/**
 * Минимальный читатель ZIP: находит центральный каталог и распаковывает
 * нужные файлы. DOCX и XLSX — это zip-архивы с XML внутри.
 */
function zipEntries(buf) {
  // End of Central Directory: ищем сигнатуру с конца (в хвосте может быть комментарий)
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('это не zip-архив');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  const lo = e.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) { try { return zlib.inflateRawSync(data); } catch (err) { return null; } }
  return null;
}

/* ============================================================ XML */

const XML_ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const unxml = s => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&(amp|lt|gt|quot|apos);/g, m => XML_ENT[m]);

/* ============================================================ DOCX */

function fromDocx(buf) {
  const entries = zipEntries(buf);
  const xml = zipRead(buf, entries, 'word/document.xml');
  if (!xml) throw new Error('в файле нет word/document.xml — это не DOCX');
  let s = xml.toString('utf8');
  s = s.replace(/<w:tab[^>]*\/>/g, '\t')
       .replace(/<w:br[^>]*\/>/g, '\n')
       .replace(/<\/w:p>/g, '\n');
  const out = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\n|\t)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] != null ? unxml(m[1]) : m[2]);
  return tidy(out.join(''));
}

/* ============================================================ XLSX */

function fromXlsx(buf) {
  const entries = zipEntries(buf);

  // общий словарь строк
  const shared = [];
  const ssXml = zipRead(buf, entries, 'xl/sharedStrings.xml');
  if (ssXml) {
    const s = ssXml.toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(s))) {
      const parts = [];
      const tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let t;
      while ((t = tre.exec(m[1]))) parts.push(unxml(t[1]));
      shared.push(parts.join(''));
    }
  }

  const sheets = [...entries.keys()].filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  if (!sheets.length) throw new Error('в файле нет листов — это не XLSX');

  const lines = [];
  for (const name of sheets.slice(0, 5)) {
    const xml = zipRead(buf, entries, name);
    if (!xml) continue;
    const s = xml.toString('utf8');
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let r;
    while ((r = rowRe.exec(s))) {
      const cells = [];
      const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
      let c;
      while ((c = cellRe.exec(r[1]))) {
        const attrs = c[1] || c[3] || '';
        const inner = c[2] || '';
        const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
        let val = '';
        if (type === 's') {
          const i = +(inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          val = shared[i] || '';
        } else if (type === 'inlineStr') {
          const t = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
          val = t ? unxml(t[1]) : '';
        } else {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          val = v ? unxml(v[1]) : '';
        }
        if (val !== '') cells.push(val);
      }
      if (cells.length) lines.push(cells.join(' · '));
      if (lines.length > 5000) break;
    }
  }
  return tidy(lines.join('\n'));
}

/* ============================================================ PDF */

/**
 * PDF — самый сложный формат здесь, и сложность вся в шрифтах.
 *
 * В простом PDF байты строки это коды WinAnsi/CP1251, их можно читать напрямую.
 * Но почти всё, что сегодня делают InDesign, Word и 1С, использует подмножества
 * шрифтов с произвольными кодами: там байт 0x03 может означать любую букву.
 * Расшифровать такой текст можно только по таблице /ToUnicode, которую PDF
 * несёт рядом со шрифтом.
 *
 * Поэтому здесь настоящий разбор: объекты (включая упакованные в ObjStm) →
 * шрифты → ToUnicode, и лишь когда таблицы нет — побайтовое чтение.
 */

/** Читает сбалансированный словарь << ... >> начиная с позиции open. */
function readDict(s, open) {
  let depth = 0, i = open;
  for (; i < s.length - 1; i++) {
    if (s[i] === '<' && s[i + 1] === '<') { depth++; i++; }
    else if (s[i] === '>' && s[i + 1] === '>') { depth--; i++; if (!depth) return s.slice(open, i + 1); }
  }
  return s.slice(open, Math.min(s.length, open + 4000));
}

/** Значение ключа словаря как сырой токен: «12 0 R», «<<…>>», «/Name», «[…]». */
function dictGet(dict, key) {
  const re = new RegExp('\\' + key + '(?![A-Za-z0-9])');
  const m = re.exec(dict || '');
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < dict.length && /\s/.test(dict[i])) i++;
  if (dict[i] === '<' && dict[i + 1] === '<') return readDict(dict, i);
  if (dict[i] === '[') {
    let depth = 0;
    for (let j = i; j < dict.length; j++) {
      if (dict[j] === '[') depth++;
      else if (dict[j] === ']') { depth--; if (!depth) return dict.slice(i, j + 1); }
    }
  }
  const rest = dict.slice(i, i + 64);
  const ref = /^(\d+)\s+(\d+)\s+R\b/.exec(rest);
  if (ref) return ref[0];
  const tok = /^(\/[^\s/<>[\]()]+|[-\d.]+|\w+)/.exec(rest);
  return tok ? tok[0] : null;
}

const refNum = tok => { const m = tok && /^(\d+)\s+\d+\s+R$/.exec(String(tok).trim()); return m ? +m[1] : null; };

/** Распаковывает поток по фильтру из его словаря. */
function inflateStream(data, dict) {
  if (!/\/FlateDecode/.test(dict || '')) {
    return /\/(DCT|JPX|CCITT|RunLength|LZW)Decode/.test(dict || '') ? null : data;
  }
  try { return zlib.inflateSync(data); }
  catch (e) { try { return zlib.inflateRawSync(data); } catch (e2) { return null; } }
}

/**
 * Разбирает все индиректные объекты документа, включая упакованные
 * в потоки объектов (ObjStm) — так устроены PDF версии 1.5 и новее.
 */
function pdfObjects(buf) {
  const latin = buf.toString('latin1');
  const objs = new Map();   // номер → { dict, data (Buffer|null) }

  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(latin))) {
    const num = +m[1];
    const bodyStart = m.index + m[0].length;
    const endIdx = latin.indexOf('endobj', bodyStart);
    const body = latin.slice(bodyStart, endIdx < 0 ? bodyStart + 200000 : endIdx);

    const dictOpen = body.indexOf('<<');
    const dict = dictOpen >= 0 ? readDict(body, dictOpen) : '';

    let data = null;
    const sIdx = body.indexOf('stream');
    if (sIdx >= 0) {
      let ds = bodyStart + sIdx + 6;
      if (latin[ds] === '\r') ds++;
      if (latin[ds] === '\n') ds++;
      const de = latin.indexOf('endstream', ds);
      if (de > ds) data = buf.slice(ds, de);
    }
    objs.set(num, { dict, data });
    if (endIdx > 0) re.lastIndex = endIdx;
  }

  /* Потоки объектов: внутри лежат словари без собственного `obj`. */
  for (const [, o] of [...objs]) {
    if (!o.dict.includes('/ObjStm') || !o.data) continue;
    const inflated = inflateStream(o.data, o.dict);
    if (!inflated) continue;
    const n = +(dictGet(o.dict, '/N') || 0);
    const first = +(dictGet(o.dict, '/First') || 0);
    if (!n || !first) continue;
    const text = inflated.toString('latin1');
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2], off = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      if (objs.has(num) && objs.get(num).dict) continue;
      const nextOff = header[i * 2 + 3];
      const chunk = text.slice(first + off, first + (Number.isFinite(nextOff) ? nextOff : text.length - first));
      const open = chunk.indexOf('<<');
      objs.set(num, { dict: open >= 0 ? readDict(chunk, open) : chunk.slice(0, 2000), data: null });
    }
  }
  return objs;
}

/**
 * Разбирает таблицу /ToUnicode: коды шрифта → настоящие символы.
 * Формат CMap — блоки beginbfchar/beginbfrange с шестнадцатеричными кодами.
 */
function parseToUnicode(text) {
  const map = new Map();
  const hexToStr = h => {
    let s = '';
    for (let i = 0; i + 4 <= h.length; i += 4) {
      const code = parseInt(h.substr(i, 4), 16);
      if (Number.isFinite(code)) s += String.fromCharCode(code);
    }
    return s;
  };

  let m;
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = charRe.exec(text))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let p;
    while ((p = pairRe.exec(m[1]))) map.set(parseInt(p[1], 16), hexToStr(p[2]));
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rangeRe.exec(text))) {
    const body = m[1];
    let r;
    const simple = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    while ((r = simple.exec(body))) {
      const from = parseInt(r[1], 16), to = parseInt(r[2], 16);
      const base = parseInt(r[3].slice(-4) || '0', 16);
      if (to < from || to - from > 65535) continue;
      for (let c = from; c <= to; c++) map.set(c, String.fromCharCode(base + (c - from)));
    }
    const arrayed = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    while ((r = arrayed.exec(body))) {
      const from = parseInt(r[1], 16);
      const items = r[3].match(/<([0-9A-Fa-f]*)>/g) || [];
      items.forEach((it, i) => map.set(from + i, hexToStr(it.slice(1, -1))));
    }
  }
  return map;
}

/** Собирает шрифты документа: имя ресурса (/F1) → { map, twoByte }. */
function pdfFonts(objs) {
  const byObj = new Map();
  for (const [num, o] of objs) {
    if (!/\/Type\s*\/Font/.test(o.dict)) continue;
    const subtype = (dictGet(o.dict, '/Subtype') || '').replace('/', '');
    const tuRef = refNum(dictGet(o.dict, '/ToUnicode'));
    let map = null;
    if (tuRef != null && objs.has(tuRef)) {
      const tu = objs.get(tuRef);
      const raw = tu.data ? inflateStream(tu.data, tu.dict) : null;
      if (raw) map = parseToUnicode(raw.toString('latin1'));
    }
    byObj.set(num, { map, twoByte: subtype === 'Type0', subtype });
  }

  const byName = new Map();
  for (const [, o] of objs) {
    const res = dictGet(o.dict, '/Resources');
    const fontDict = res && res.startsWith('<<') ? dictGet(res, '/Font') : dictGet(o.dict, '/Font');
    if (!fontDict || !fontDict.startsWith('<<')) continue;
    const pairRe = /\/([A-Za-z0-9.+#-]+)\s+(\d+)\s+\d+\s+R/g;
    let p;
    while ((p = pairRe.exec(fontDict))) {
      const desc = byObj.get(+p[2]);
      if (desc && !byName.has(p[1])) byName.set(p[1], desc);
    }
  }
  return byName;
}

/** Раскрывает escape-последовательности внутри строкового литерала PDF. */
function pdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b' || next === 'f') out += ' ';
    else if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (next === '\n') { /* перенос строки внутри литерала */ }
    else out += next;
  }
  return out;
}

/** Переводит байты строки в символы через таблицу текущего шрифта. */
function decodeWithFont(bytes, font) {
  if (!font || !font.map || !font.map.size) return bytes;
  let out = '';
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1);
      const mapped = font.map.get(code);
      out += mapped != null ? mapped : '';
    }
  } else {
    for (let i = 0; i < bytes.length; i++) {
      const mapped = font.map.get(bytes.charCodeAt(i));
      out += mapped != null ? mapped : bytes[i];
    }
  }
  return out;
}

/** Достаёт текст из распакованного потока страницы, следя за текущим шрифтом. */
function pdfStreamText(content, fonts) {
  const out = [];
  let font = null;
  const re = /\/([A-Za-z0-9.+#-]+)\s+[-\d.]+\s+Tf|\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>|\bT[*dDJjm]\b|\bET\b/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) { font = fonts ? fonts.get(m[1]) || null : null; continue; }
    if (m[2] !== undefined) { out.push(decodeWithFont(pdfString(m[2]), font)); continue; }
    if (m[3] !== undefined) {
      const hex = m[3].replace(/\s+/g, '');
      let s = '';
      for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      out.push(decodeWithFont(s, font));
      continue;
    }
    out.push('\n');
  }
  return out.join('');
}

function fromPdf(buf) {
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') throw new Error('это не PDF');
  if (/\/Encrypt\b/.test(buf.slice(-3000).toString('latin1'))) {
    throw new Error('PDF защищён паролем — снимите защиту или пришлите текст');
  }

  let objs = null, fonts = null;
  try { objs = pdfObjects(buf); fonts = pdfFonts(objs); }
  catch (e) { objs = null; fonts = null; }
  if (!objs) throw new Error('не смог разобрать структуру PDF');

  const chunks = [];
  for (const [, o] of objs) {
    if (!o.data || /\/ObjStm|\/XObject|\/Image|\/FontFile/.test(o.dict)) continue;
    const raw = inflateStream(o.data, o.dict);
    if (!raw) continue;
    const text = raw.toString('latin1');
    if (!/\bBT\b|\bTj\b|\bTJ\b/.test(text)) continue;
    chunks.push(pdfStreamText(text, fonts));
    if (chunks.length > 400) break;
  }
  if (!chunks.length) throw new Error('в PDF не нашлось текстового слоя');

  const text = tidy(chunks.join('\n'));
  const hasCmap = fonts && [...fonts.values()].some(f => f && f.map && f.map.size);
  // Таблицы шрифтов уже дали настоящие символы — перекодировать нечего.
  return hasCmap ? text : maybeCp1251(text);
}

/* CP1251 для диапазона 0x80..0xFF. Непечатаемые позиции заданы \u-escape,
 * чтобы в исходнике не было управляющих символов. Длина строго 128 —
 * при расхождении перекодировка не применяется. */
const CP1251 =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ' +
  'ђ‘’“”•–— ™љ›њќћџ' +
  ' ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї' +
  '°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ' +
  'абвгдежзийклмнопрстуфхцчшщъыьэюя';

/** Текст из PDF без таблиц шрифтов часто оказывается кириллицей в CP1251. */
function maybeCp1251(text) {
  if (CP1251.length !== 128) return text;
  let highs = 0;
  for (const ch of text) { const c = ch.charCodeAt(0); if (c >= 0x80 && c <= 0xFF) highs++; }
  if (highs < text.length * 0.15) return text;
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out += (c >= 0x80 && c <= 0xFF) ? CP1251[c - 0x80] : ch;
  }
  return cyrLatinRatio(out) > cyrLatinRatio(text) ? out : text;
}
/* ============================================================ общее */

function tidy(s) {
  return String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cyrLatinRatio(s) {
  const total = (s.match(/\S/g) || []).length;
  if (!total) return 0;
  const letters = (s.match(/[A-Za-zА-Яа-яЁё0-9.,;:!?()%№₽\-–—/"'«»]/g) || []).length;
  return letters / total;
}

/* Частотные служебные слова: в осмысленном тексте они есть почти всегда,
 * а в «расшифровке» со сбитой кодировкой — нет. */
// \b в JS опирается на \w = [A-Za-z0-9_], поэтому с кириллицей не работает —
// границы слова задаём явными lookaround'ами.
const W = '[A-Za-zА-Яа-яЁё0-9]';
const STOPWORDS = new RegExp(
  '(?<!' + W + ')(и|в|на|с|со|по|для|не|от|до|за|из|что|как|это|при|или|руб|рубл[а-яё]*|цена|цены|шт|the|and|for|with|from|price|our|you)(?!' + W + ')',
  'gi');
const VOWELS = /[аеёиоуыэюяaeiouy]/gi;

/**
 * Похоже ли извлечённое на осмысленный текст.
 * Три сита: объём, доля букв и «человечность» — частотные слова плюс
 * правдоподобная доля гласных. Без последнего сита в базу знаний просачивается
 * текст со сбитой кодировкой: букв в нём много, но слов не существует.
 */
function looksLikeText(s) {
  const t = String(s || '').trim();
  if (t.length < 40) return { ok: false, reason: 'текста почти нет — похоже на скан или картинки' };

  const ratio = cyrLatinRatio(t);
  if (ratio < 0.72) return { ok: false, reason: 'вместо букв получился набор символов — шрифты в файле не читаются' };

  // Порог низкий намеренно: прайс из нескольких строк — законный источник,
  // а от почти пустой выжимки уже защищает минимум по длине и сита ниже.
  const words = t.split(/\s+/).filter(w => w.length > 1);
  if (words.length < 8) return { ok: false, reason: 'слов слишком мало, чтобы AI мог на этом отвечать' };

  const letters = (t.match(/[A-Za-zА-Яа-яЁё]/g) || []).length;
  if (letters >= 40) {
    const vowels = (t.match(VOWELS) || []).length;
    const vr = vowels / letters;
    if (vr < 0.22 || vr > 0.62) {
      return { ok: false, reason: 'буквы складываются в несуществующие слова — кодировка файла не распозналась' };
    }
  }

  const hits = new Set((t.match(STOPWORDS) || []).map(w => w.toLowerCase())).size;
  if (words.length >= 30 && hits < 3) {
    return { ok: false, reason: 'в тексте не нашлось обычных слов — скорее всего, кодировка не распозналась' };
  }
  return { ok: true, ratio, stopwords: hits };
}

const KIND_BY_EXT = {
  docx: 'docx', doc: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx',
  pdf: 'pdf',
  txt: 'text', md: 'text', csv: 'text', tsv: 'text', json: 'text', htm: 'html', html: 'html',
};

/**
 * Главный вход: буфер + имя файла → текст.
 * @returns {{text:string, kind:string}}
 * @throws {Error} с понятным пользователю сообщением
 */
function extract(buf, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  const kind = KIND_BY_EXT[ext];
  if (!kind) throw new Error('Не понимаю формат .' + ext + '. Поддерживаю PDF, DOCX, XLSX, TXT, CSV и ссылки.');

  let text;
  if (kind === 'docx') text = fromDocx(buf);
  else if (kind === 'xlsx') text = fromXlsx(buf);
  else if (kind === 'pdf') text = fromPdf(buf);
  else if (kind === 'html') text = tidy(buf.toString('utf8').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  else text = tidy(buf.toString('utf8'));

  const v = looksLikeText(text);
  if (!v.ok) {
    const hint = kind === 'pdf'
      ? ' Если это скан, скопируйте текст вручную или дайте ссылку на страницу сайта.'
      : ' Попробуйте сохранить файл как обычный текст или вставьте содержимое вручную.';
    throw new Error('Файл прочитался, но ' + v.reason + '.' + hint);
  }
  return { text, kind };
}

module.exports = { extract, fromDocx, fromXlsx, fromPdf, looksLikeText, tidy, zipEntries, zipRead, maybeCp1251 };
