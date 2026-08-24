'use strict';
/* ============================================================================
 * Мозг Consul: собирает промпт из настроек кабинета и базы знаний, зовёт Groq,
 * разбирает структурированный ответ.
 *
 * Модель отвечает ОДНИМ JSON-объектом:
 *   { reply, handoff, reason, stage, interest, summary, contact }
 * — то есть за один вызов мы получаем и текст клиенту, и решение «звать
 * человека», и обновление карточки клиента (стадия, интерес, саммари).
 *
 * Если Groq недоступен или ключа нет — НЕ выдумываем ответ: помечаем диалог
 * как требующий человека. Лучше передать менеджеру, чем соврать клиенту.
 * ========================================================================== */

const groq = require('./groq');

const STYLE = {
  friendly: 'дружелюбно и тепло, на «вы», можно лёгкие эмоции, без панибратства',
  neutral: 'нейтрально и по делу, без лишних эмоций',
  formal: 'официально-деловым тоном, на «вы», без сокращений и смайлов',
};
const LENGTH = {
  short: 'Максимум 2 коротких предложения.',
  mid: 'Максимум 3–4 предложения.',
  long: 'До 6 предложений, можно списком, если так понятнее.',
};
const LANG = { RU: 'русском', EN: 'английском', 'RU+EN': 'языке клиента (русский или английский)' };

const lengthKey = ai => (ai.length && LENGTH[ai.length]) ? ai.length : (ai.lengthVal < 34 ? 'short' : ai.lengthVal < 67 ? 'mid' : 'long');

/* ------------------------------------------------------- база знаний */

const STOP = new Set(['и','в','на','с','по','для','что','как','это','из','у','к','а','но','же','ли','бы','не','the','a','of','to','is','for']);
function terms(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w));
}

/**
 * Простой лексический отбор кусков базы знаний под вопрос клиента.
 * Без эмбеддингов: для 3–10 источников это работает и стоит ноль.
 */
function retrieve(knowledge, question, limit = 4, budget = 6000) {
  const q = terms(question);
  const scored = (knowledge || []).filter(k => k.ready && k.body).map(k => {
    const hay = (k.title + ' ' + k.body).toLowerCase();
    let score = 0;
    for (const t of q) if (hay.includes(t.slice(0, Math.max(4, t.length - 1)))) score++;
    return { k, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let used = 0;
  for (const { k, score } of scored) {
    if (picked.length >= limit) break;
    if (score === 0 && picked.length) break;          // нерелевантное добираем только если пусто
    const body = String(k.body).slice(0, 2500);
    if (used + body.length > budget) continue;
    used += body.length;
    picked.push({ title: k.title, body });
  }
  return picked;
}

/* ------------------------------------------------------- промпт */

function systemPrompt(w, chunks) {
  const ai = w.ai, biz = w.biz;
  const lines = [];
  lines.push(`Ты — ${ai.name || 'AI-менеджер'}, менеджер по продажам и поддержке компании «${biz.name || w.bot.name || 'компания'}» в Telegram.`);
  if (biz.about) lines.push(`О компании: ${biz.about}`);
  if (biz.site) lines.push(`Сайт: ${biz.site}`);
  lines.push('');
  lines.push('КАК ОТВЕЧАТЬ');
  lines.push(`- Пиши на ${LANG[ai.lang] || 'русском'} языке, ${STYLE[ai.style] || STYLE.friendly}.`);
  lines.push(`- ${LENGTH[lengthKey(ai)]}`);
  lines.push('- Ты пишешь в чат мессенджера: без markdown-заголовков, без «Здравствуйте» в каждом сообщении.');
  lines.push('- Отвечай ТОЛЬКО фактами из блока ЗНАНИЯ и из истории диалога. Не выдумывай цены, сроки, наличие, характеристики и адреса.');
  lines.push('- Если фактов не хватает — либо задай один уточняющий вопрос, либо передай диалог человеку.');
  if (ai.instructions) lines.push(`- Указания владельца: ${ai.instructions}`);
  if (ai.styleProfile && ai.styleProfile.instructions) {
    lines.push('');
    lines.push('ГОЛОС КОМПАНИИ — снят с реальной переписки владельца, держись его:');
    lines.push(ai.styleProfile.instructions);
    if (ai.styleProfile.examples && ai.styleProfile.examples.length) {
      lines.push('Так владелец пишет сам (подражай манере, а не содержанию):');
      ai.styleProfile.examples.slice(0, 4).forEach(e => lines.push('  «' + e + '»'));
    }
  }
  lines.push('');
  lines.push('ЧТО ТЕБЕ РАЗРЕШЕНО');
  lines.push(`- Рассказывать о товарах, ценах и наличии: ${ai.canProducts ? 'да' : 'НЕТ — на такие вопросы передавай диалог человеку'}.`);
  lines.push(`- Спрашивать и записывать имя и телефон: ${ai.canContacts ? 'да, но ненавязчиво' : 'НЕТ, не спрашивай контакты'}.`);
  lines.push(`- Давать скидки: ${ai.canDiscount ? 'да, в разумных пределах' : 'НЕТ — вопросы про скидки передавай человеку'}.`);
  if (ai.banned && ai.banned.length) lines.push(`- Запрещённые темы (вежливо уходи от них): ${ai.banned.join('; ')}.`);
  lines.push('');
  lines.push('КОГДА ЗВАТЬ ЧЕЛОВЕКА (handoff = true)');
  (ai.handoff && ai.handoff.length ? ai.handoff : ['клиент просит менеджера']).forEach(h => lines.push(`- ${h}`));
  lines.push('- Клиент раздражён, спорит или ситуация нестандартная.');
  lines.push('- Нужны документы, счёт, договор, юридические или бухгалтерские детали.');
  lines.push('При handoff = true поле reply — короткая фраза клиенту о том, что подключаешь менеджера. Ничего не обещай за менеджера.');
  lines.push('');
  if (chunks.length) {
    lines.push('ЗНАНИЯ (единственный источник фактов о компании)');
    chunks.forEach(c => { lines.push(`### ${c.title}`); lines.push(c.body); lines.push(''); });
  } else {
    lines.push('ЗНАНИЯ: пусто. Фактов о товарах, ценах и условиях у тебя нет — любые такие вопросы передавай человеку (handoff = true).');
    lines.push('');
  }
  lines.push('ФОРМАТ ОТВЕТА — строго один JSON-объект, без текста вокруг:');
  lines.push('{');
  lines.push('  "reply": "текст клиенту",');
  lines.push('  "handoff": false,');
  lines.push('  "reason": "если handoff — кратко почему, иначе пустая строка",');
  lines.push('  "stage": "new | interested | inprogress | customer",');
  lines.push('  "interest": "что клиенту нужно, 2-5 слов, или пустая строка",');
  lines.push('  "summary": "1-2 предложения о клиенте и его задаче для карточки в CRM",');
  lines.push('  "contact": "телефон или email, если клиент их назвал, иначе пустая строка"');
  lines.push('}');
  return lines.join('\n');
}

function history(dialog, limit = 14) {
  return (dialog.msgs || []).slice(-limit).map(m => {
    if (m.r === 'user') return { role: 'user', content: m.t };
    if (m.r === 'sys') return { role: 'system', content: '[событие] ' + m.t };
    const who = m.r === 'human' ? `менеджер ${m.who || ''}`.trim() : 'ты';
    return { role: 'assistant', content: (m.r === 'human' ? `[${who}] ` : '') + m.t };
  });
}

/* ------------------------------------------------------- ответ */

const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/**
 * Готовит ответ на последнее сообщение клиента.
 * @returns {{reply:string, handoff:boolean, reason:string, stage:string,
 *            interest:string, summary:string, contact:string, model:string,
 *            usage:object, fallback?:boolean, error?:string}}
 */
async function reply(w, dialog, question) {
  const chunks = retrieve(w.knowledge, question);
  const sys = systemPrompt(w, chunks);
  const msgs = history(dialog);
  if (!msgs.length || msgs[msgs.length - 1].content !== question) msgs.push({ role: 'user', content: question });

  if (!groq.enabled()) return offline(w, 'AI не настроен: нет GROQ_API_KEY');

  let out;
  try {
    out = await groq.chat({ system: sys, messages: msgs, json: true, maxTokens: 600, temperature: 0.4 });
  } catch (e) {
    console.error('[ai] groq: ' + e.message);
    return offline(w, e.message);
  }

  const parsed = groq.extractJson(out.text);
  if (!parsed || !clean(parsed.reply)) {
    // Модель не дала валидный JSON — используем сырой текст, если он есть.
    const raw = clean(out.text);
    if (raw && raw.length < 900 && !raw.startsWith('{')) {
      return { reply: raw, handoff: false, reason: '', stage: dialog.stage || 'new', interest: dialog.interest || '', summary: dialog.summary || '', contact: '', model: out.model, usage: out.usage };
    }
    return offline(w, 'модель вернула нечитаемый ответ');
  }

  const stages = ['new', 'interested', 'inprogress', 'customer'];
  return {
    reply: clean(parsed.reply).slice(0, 1500),
    handoff: parsed.handoff === true || parsed.handoff === 'true',
    reason: clean(parsed.reason).slice(0, 120),
    stage: stages.includes(parsed.stage) ? parsed.stage : (dialog.stage || 'new'),
    interest: clean(parsed.interest).slice(0, 80) || dialog.interest || '',
    summary: clean(parsed.summary).slice(0, 400) || dialog.summary || '',
    contact: clean(parsed.contact).slice(0, 80),
    model: out.model,
    usage: out.usage || {},
  };
}

/** Ответ, когда модель недоступна: честно зовём человека. */
function offline(w, why) {
  return {
    reply: 'Секунду — подключаю менеджера, он ответит здесь же.',
    handoff: true,
    reason: 'AI недоступен',
    stage: 'new', interest: '', summary: '', contact: '',
    model: null, usage: {}, fallback: true, error: why,
  };
}

/* ------------------------------------------------------- пост в канал */

async function channelPost(w, topic, kind) {
  const chunks = retrieve(w.knowledge, topic, 2, 3000);
  const sys = [
    `Ты пишешь посты для Telegram-канала компании «${w.biz.name || w.bot.name}».`,
    w.biz.about ? 'О компании: ' + w.biz.about : '',
    `Тон: ${STYLE[w.ai.style] || STYLE.friendly}. Язык: ${LANG[w.ai.lang] || 'русском'}.`,
    'Пост: 2–4 коротких абзаца, без markdown-заголовков и без хэштегов. Заканчивай призывом написать в бота.',
    'Опирайся только на факты ниже, ничего не выдумывай про цены и сроки.',
    chunks.length ? chunks.map(c => '### ' + c.title + '\n' + c.body).join('\n\n') : '',
    'Ответ — один JSON: {"text":"текст поста"}',
  ].filter(Boolean).join('\n');
  const out = await groq.chat({
    system: sys,
    messages: [{ role: 'user', content: `Формат: ${kind || 'Анонс'}. Тема: ${topic}` }],
    json: true, maxTokens: 500, temperature: 0.8,
  });
  const p = groq.extractJson(out.text);
  return { text: clean((p && p.text) || out.text).slice(0, 2000), model: out.model, usage: out.usage };
}

/* ============================================================ тренировка стиля */

/**
 * Сценарии для симуляции клиента. Разные типы разговора вытаскивают разные
 * грани манеры: на торге видно жёсткость, на жалобе — терпение,
 * на простом вопросе — многословность.
 */
const SCENARIOS = [
  { id: 'pick',     title: 'Выбирает товар',   brief: 'ты не определился и просишь помочь выбрать, спрашиваешь про отличия и цену' },
  { id: 'delivery', title: 'Спрашивает доставку', brief: 'тебя волнуют сроки и стоимость доставки в твой город, ты торопишься' },
  { id: 'haggle',   title: 'Торгуется',         brief: 'цена кажется высокой, ты просишь скидку и сравниваешь с конкурентами' },
  { id: 'complain', title: 'Недоволен',         brief: 'заказ пришёл позже обещанного, ты раздражён и хочешь понять, что делать' },
  { id: 'bulk',     title: 'Оптовый заказ',     brief: 'тебе нужна большая партия для компании, ты спрашиваешь про условия и документы' },
];

/**
 * Следующая реплика «клиента». Модель играет покупателя, владелец отвечает
 * как продавец — по этим ответам потом снимается стиль.
 */
async function customerMessage(w, history, scenarioId) {
  const sc = SCENARIOS.find(x => x.id === scenarioId) || SCENARIOS[0];
  const chunks = retrieve(w.knowledge, sc.brief, 2, 2500);
  const sys = [
    `Ты играешь ПОКУПАТЕЛЯ, который пишет в Telegram компании «${w.biz.name || w.bot.name || 'магазин'}».`,
    w.biz.about ? 'Чем занимается компания: ' + w.biz.about : '',
    `Твоя роль: ${sc.brief}.`,
    '',
    'КАК ПИСАТЬ',
    '- Ты обычный человек в мессенджере: коротко, 1–2 предложения, без формальностей.',
    '- Пиши по-русски, живо, можешь ошибаться и переспрашивать.',
    '- Задавай по одному вопросу за раз, реагируй на то, что тебе ответили.',
    '- НЕ играй продавца и не подсказывай ему. Ты клиент, тебе нужно решить свою задачу.',
    '- Если продавец ответил исчерпывающе — поблагодари и заверши разговор (done = true).',
    '',
    chunks.length ? 'Что компания продаёт (для правдоподобных вопросов):\n' + chunks.map(c => c.body.slice(0, 600)).join('\n') : '',
    'Ответ — один JSON: {"message":"твоя реплика","done":false}',
  ].filter(Boolean).join('\n');

  const msgs = history.map(m => ({ role: m.r === 'client' ? 'assistant' : 'user', content: m.t }));
  if (!msgs.length) msgs.push({ role: 'user', content: '(начни разговор первым сообщением)' });

  const out = await groq.chat({ system: sys, messages: msgs, json: true, maxTokens: 200, temperature: 0.9 });
  const p = groq.extractJson(out.text);
  return {
    message: clean((p && p.message) || out.text).slice(0, 400) || 'Здравствуйте! Подскажите, пожалуйста.',
    done: !!(p && p.done),
    scenario: sc,
    usage: out.usage,
  };
}

/**
 * Снимает манеру письма с ответов владельца.
 * Возвращает профиль, который потом уходит в системный промпт бота.
 */
async function analyzeStyle(w, replies) {
  const sys = [
    'Ты разбираешь манеру письма продавца, чтобы AI-ассистент отвечал клиентам так же.',
    'Тебе дают только реплики самого продавца из переписки с клиентом.',
    '',
    'Оцени по фактам из текста, не додумывай:',
    '- длину сообщений (в предложениях);',
    '- обращение: на «вы» или на «ты»;',
    '- тон: дружелюбный, нейтральный или формальный;',
    '- смайлы и восклицательные знаки: есть или нет;',
    '- здоровается ли, как заканчивает сообщения;',
    '- характерные слова и обороты, которые повторяются.',
    '',
    'Поле instructions — это готовая инструкция для другого AI, во втором лице,',
    'конкретная и проверяемая. Не пиши общих слов вроде «будь вежлив».',
    '',
    'Ответ — один JSON:',
    '{',
    '  "summary": "как пишет продавец, 1-2 предложения",',
    '  "style": "friendly | neutral | formal",',
    '  "lengthVal": 0-100,',
    '  "traits": ["3-5 коротких наблюдений"],',
    '  "instructions": "инструкция для AI, 2-4 предложения",',
    '  "examples": ["до 3 характерных фраз продавца дословно"]',
    '}',
  ].join('\n');

  const user = 'Реплики продавца:\n' + replies.map((t, i) => (i + 1) + '. ' + t).join('\n');
  const out = await groq.chat({ system: sys, messages: [{ role: 'user', content: user }], json: true, maxTokens: 600, temperature: 0.2 });
  const p = groq.extractJson(out.text);
  if (!p || !clean(p.instructions)) throw new Error('не удалось разобрать стиль — попробуйте ещё раз');

  const styles = ['friendly', 'neutral', 'formal'];
  const lv = Number(p.lengthVal);
  return {
    summary: clean(p.summary).slice(0, 300),
    style: styles.includes(p.style) ? p.style : 'neutral',
    lengthVal: Number.isFinite(lv) ? Math.max(0, Math.min(100, Math.round(lv))) : 40,
    traits: (Array.isArray(p.traits) ? p.traits : []).slice(0, 6).map(t => clean(t).slice(0, 80)).filter(Boolean),
    instructions: clean(p.instructions).slice(0, 900),
    examples: (Array.isArray(p.examples) ? p.examples : []).slice(0, 3).map(t => clean(t).slice(0, 200)).filter(Boolean),
    trainedAt: Date.now(),
    usage: out.usage,
  };
}

module.exports = {
  reply, channelPost, systemPrompt, retrieve, terms, lengthKey,
  customerMessage, analyzeStyle, SCENARIOS,
};
