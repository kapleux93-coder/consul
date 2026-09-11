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
  const firm = biz.name || w.bot.name || 'компания';
  const who = clean(ai.name, 40);
  // Имя даёт владелец. Не дал — работаем без имени: придумать себе «Нику»
  // значит представить клиенту несуществующего человека.
  lines.push(who
    ? `Тебя зовут ${who}. Ты менеджер по продажам и поддержке компании «${firm}» в Telegram.`
    : `Ты менеджер по продажам и поддержке компании «${firm}» в Telegram.`);
  if (biz.about) lines.push(`О компании: ${biz.about}`);
  if (biz.site) lines.push(`Сайт: ${biz.site}`);
  lines.push('');
  lines.push('КАК ОТВЕЧАТЬ');
  lines.push(`- Пиши на ${LANG[ai.lang] || 'русском'} языке, ${STYLE[ai.style] || STYLE.friendly}.`);
  lines.push(`- ${LENGTH[lengthKey(ai)]}`);
  lines.push('- Ты пишешь в чат мессенджера: без markdown-заголовков, без «Здравствуйте» в каждом сообщении.');
  lines.push('');
  lines.push('ЧТОБЫ ЗВУЧАТЬ ЖИВЫМ ЧЕЛОВЕКОМ, А НЕ СПРАВОЧНОЙ');
  lines.push('- Здоровайся один раз за разговор. Дальше сразу по делу.');
  lines.push('- Никаких канцелярских оборотов: «уточните, пожалуйста», «в случае необходимости», «данный товар», «осуществляется».');
  lines.push('  Пиши как в переписке: «гляну», «сейчас посмотрю», «есть в наличии», «привезём за неделю».');
  lines.push('- Отвечай на заданный вопрос сразу, в первом же предложении. Подробности — после.');
  lines.push('- Подстраивайся под клиента: пишет коротко — отвечай коротко, на «ты» — переходи на «ты».');
  lines.push('- Иногда добавь то, о чём не спросили, но что важно: «кстати, доставка бесплатная от 5 000».');
  lines.push('- Не повторяй вопрос клиента и не пересказывай, что собираешься сделать. Просто делай.');
  lines.push('- Если клиент злится или чем-то недоволен — сначала признай это одной фразой, потом решай.');
  lines.push('- Не заканчивай каждое сообщение вопросом. Иногда просто дай ответ и остановись.');
  // У бота есть имя, поэтому вопрос «а вы человек?» будут задавать. Врать
  // нельзя: пойманный на этом клиент перестаёт верить и всему остальному,
  // включая цены. Признаём коротко и продолжаем помогать.
  lines.push('- Спросили прямо, бот ты или человек, — не отрицай. Скажи коротко, что отвечает');
  lines.push('  AI-помощник компании, и сразу продолжи по делу. Не оправдывайся и не объясняй устройство.');
  lines.push('  Никогда не утверждай, что ты живой человек, и не выдумывай себе биографию.');
  if (!who) {
    // Без этого модель охотно сочиняет себе имя на вопрос «а вас как зовут?».
    lines.push('- Имени у тебя нет. Спросят — скажи, что отвечает помощник компании «' + firm + '»,');
    lines.push('  и не придумывай себе имя ни при каких обстоятельствах.');
  }
  lines.push('- Разбивай ответ на реплики пустой строкой там, где живой человек нажал бы «отправить».');
  lines.push('  Обычно это 1–2 коротких сообщения. Три — уже много.');
  lines.push('- Отвечай ТОЛЬКО фактами из блока ЗНАНИЯ и из истории диалога. Не выдумывай цены, сроки, наличие, характеристики и адреса.');
  // Разделяем два случая. Иначе бот с пустой базой уходит в бесконечное
  // «уточните, пожалуйста»: фактов нет никогда, а уточнять разрешено всегда.
  // Раньше правило было бинарным: нужного факта нет — зови человека. На нём бот
  // сдавал менеджеру даже «здравствуйте». Теперь лестница: сначала ответь тем,
  // что знаешь, потом сузь вопрос, и только если без недостающего факта
  // разговор встал — зови. Человек дорог, его время тратят в последнюю очередь.
  lines.push('- Отвечай тем, что есть. Точного факта нет, но есть соседний — дай соседний и скажи, чего не знаешь.');
  lines.push('  «Цену именно на эту модель уточню, а доставка по области у нас бесплатная» — это нормальный ответ.');
  lines.push('- Уточняющий вопрос задавай, когда он двигает разговор: сузить выбор, понять задачу, назвать город.');
  lines.push('- Никогда не задавай подряд два уточняющих вопроса, не сообщив ни одного факта.');
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
  if (ai.selling !== false) {
    lines.push('ТЫ ПРОДАЁШЬ, А НЕ КОНСУЛЬТИРУЕШЬ');
    lines.push('- Сначала пойми задачу, потом предлагай. Хватит одного-двух вопросов по существу:');
    lines.push('  для кого, сколько человек, когда нужно, есть ли бюджетная рамка.');
    lines.push('- Не вываливай каталог. Выбери ОДИН вариант, который лучше подходит, и назови его.');
    lines.push('  Альтернативу давай только как вторую строчку: «если нужно дешевле — вот».');
    lines.push('- Объясняй выбор через задачу клиента, а не через характеристики.');
    lines.push('  Не «парная 6 м²», а «для двоих-троих в самый раз, париться не тесно».');
    lines.push('- Заканчивай сообщение конкретным следующим шагом, а не «остались вопросы?».');
    lines.push('  Шаг маленький и лёгкий: прислать фото, посчитать доставку в ваш город,');
    lines.push('  забронировать срок, показать похожий готовый заказ.');
    lines.push('- Называй цену прямо, как только она известна. Уход от цены убивает доверие.');
    lines.push('');
    lines.push('ВОЗРАЖЕНИЯ');
    lines.push('- «Дорого» — не сбрасывай цену и не спорь. Спроси, с чем сравнивают, либо');
    lines.push('  покажи, из чего складывается, либо предложи вариант дешевле. Скидку — только если разрешена.');
    lines.push('- «Я подумаю» — не отпускай молча. Спроси, что осталось решить: цена, сроки или сомнение в качестве.');
    lines.push('- «Дешевле у других» — не обесценивай конкурента. Назови, что входит у вас и обычно не входит у них.');
    lines.push('- «Мне надо посоветоваться» — предложи прислать то, что удобно показать: расчёт, фото, условия.');
    lines.push('- Прямой отказ — прими спокойно, поблагодари и оставь дверь открытой. Не уговаривай дважды.');
    lines.push('');
    if (ai.canContacts) {
      lines.push('КОНТАКТ');
      lines.push('- Имя и телефон бери не «для базы», а под конкретную пользу:');
      lines.push('  «оставьте телефон — пришлю расчёт», «на какое имя забронировать срок».');
      lines.push('- Проси один раз и не раньше, чем клиент проявил интерес. Отказался — больше не проси.');
      lines.push('');
    }
    lines.push('ЧЕГО НЕ ДЕЛАТЬ НИКОГДА');
    lines.push('- Выдумывать срочность: «осталось два места», «акция до завтра», если этого нет в ЗНАНИЯХ.');
    lines.push('- Давить и повторять предложение, если клиент уже отказался.');
    lines.push('- Продавать то, что человеку не подходит. Не подходит — скажи прямо, это возвращается доверием.');
    lines.push('- Обещать сроки, цены и наличие, которых нет в ЗНАНИЯХ.');
    lines.push('');
  }

  lines.push('ЧТО ТЕБЕ РАЗРЕШЕНО');
  lines.push(`- Рассказывать о товарах, ценах и наличии: ${ai.canProducts ? 'да' : 'НЕТ — на такие вопросы передавай диалог человеку'}.`);
  lines.push(`- Спрашивать и записывать имя и телефон: ${ai.canContacts ? 'да, но ненавязчиво' : 'НЕТ, не спрашивай контакты'}.`);
  lines.push(`- Давать скидки: ${ai.canDiscount ? 'да, в разумных пределах' : 'НЕТ — вопросы про скидки передавай человеку'}.`);
  if (ai.banned && ai.banned.length) lines.push(`- Запрещённые темы (вежливо уходи от них): ${ai.banned.join('; ')}.`);
  lines.push('');
  lines.push('КОГДА ЗВАТЬ ЧЕЛОВЕКА (handoff = true)');
  lines.push('Человек — дорогой ресурс, и клиент ждёт его дольше, чем тебя. Зови только если');
  lines.push('без него дальше нельзя. Таких случаев немного:');
  (ai.handoff && ai.handoff.length ? ai.handoff : ['клиент просит менеджера']).forEach(h => lines.push(`- ${h}`));
  lines.push('- Клиент раздражён, жалуется или требует вернуть деньги.');
  lines.push('- Нужны документы, счёт, договор, юридические или бухгалтерские детали.');
  lines.push('- Клиент просит решение, которого нет в правилах: особые условия, индивидуальная скидка, срочный перенос срока.');
  lines.push('- Ты уже попробовал ответить, фактов не хватает, и без них разговор встал.');
  lines.push('');
  lines.push('НЕ зови человека, если:');
  lines.push('- клиент просто здоровается или спрашивает, чем вы занимаетесь;');
  lines.push('- вопрос общий («что есть», «расскажите про доставку») — ответь тем, что в ЗНАНИЯХ;');
  lines.push('- нужного факта нет, но ты можешь назвать соседний или задать уточняющий вопрос;');
  lines.push('- ты уже передавал этот разговор человеку — второй раз звать некого, отвечай сам;');
  lines.push('- тебе просто неудобно отвечать. Неудобно — не причина.');
  lines.push('При handoff = true поле reply — короткая фраза клиенту о том, что подключаешь менеджера. Ничего не обещай за менеджера.');
  lines.push('');
  if (chunks.length) {
    lines.push('ЗНАНИЯ (единственный источник фактов о компании)');
    chunks.forEach(c => { lines.push(`### ${c.title}`); lines.push(c.body); lines.push(''); });
  } else {
    lines.push('ЗНАНИЯ: пусто. Фактов о товарах, ценах, размерах и условиях у тебя нет вообще.');
    lines.push('Поздороваться, представиться и спросить, что человеку нужно, ты можешь и без них —');
    lines.push('это не требует фактов. А вот на конкретный вопрос о товаре, цене, сроке или наличии');
    lines.push('отвечай handoff = true и короткой фразой, что подключаешь менеджера: выдумывать нельзя,');
    lines.push('а уточнение ничего не даст — ответа ты всё равно не узнаешь.');
    lines.push('');
  }
  lines.push('ФОРМАТ ОТВЕТА — строго один JSON-объект, без текста вокруг:');
  lines.push('{');
  lines.push('  "reply": "текст клиенту; пустая строка = граница между сообщениями",');
  lines.push('  "handoff": false,');
  lines.push('  "reason": "если handoff — кратко почему, иначе пустая строка",');
  lines.push('  "stage": "new | interested | inprogress | customer",');
  lines.push('  "interest": "что клиенту нужно, 2-5 слов, или пустая строка",');
  lines.push('  "summary": "1-2 предложения о клиенте и его задаче для карточки в CRM",');
  lines.push('  "contact": "телефон или email, если клиент их назвал, иначе пустая строка",');
  lines.push('  "nextStep": "какой следующий шаг ты предложил, 2-4 слова, или пустая строка",');
  lines.push('  "temperature": "hot | warm | cold — насколько клиент близок к покупке",');
  lines.push('  "objection": "что мешает клиенту купить, если это прозвучало, иначе пустая строка"');
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
 * Очистка текста для клиента. В отличие от clean() сохраняет пустые строки:
 * модель ставит их там, где живой человек нажал бы «отправить», и по ним
 * ответ режется на отдельные реплики. Схлопнёшь — получишь стену текста.
 */
const cleanReply = s => String(s == null ? '' : s)
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

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

  /* Защита от круга «уточните, пожалуйста». Модель может проигнорировать
     инструкцию, поэтому считаем сами: если два последних ответа бота были
     вопросами и ни одного факта клиент не услышал — хватит, зовём человека. */
  /* Круг «уточните, пожалуйста» надо разрывать, но не всегда человеком: если
   * факты есть, правильный выход — назвать их, а не звать менеджера. Зовём
   * только когда сказать действительно нечего. */
  const loop = questionLoop(dialog);
  const sysFinal = !loop ? sys
    : chunks.length
      ? sys + '\n\nВАЖНО: ты уже дважды переспросил и не сообщил клиенту ни одного факта. ' +
              'Больше не уточняй — назови конкретику из ЗНАНИЙ: вариант, цену, срок. Человека не зови.'
      : sys + '\n\nВАЖНО: ты уже дважды переспросил, а фактов у тебя нет. ' +
              'Ответь handoff = true и короткой фразой, что подключаешь менеджера.';

  let out;
  try {
    /* 600 не хватало: кроме самого ответа модель заполняет восемь служебных
     * полей, и на длинной реплике JSON обрывался на середине. */
    out = await groq.chat({ system: sysFinal, messages: msgs, json: true, maxTokens: 900, temperature: 0.4, reasoning: 'low' });
  } catch (e) {
    console.error('[ai] groq: ' + e.message);
    return offline(w, e.message);
  }

  const parsed = groq.extractJson(out.text);
  if (!parsed || !cleanReply(parsed.reply)) {
    // Модель не дала валидный JSON — используем сырой текст, если он есть.
    const raw = cleanReply(out.text);
    if (raw && raw.length < 900 && !raw.startsWith('{')) {
      return { reply: raw, handoff: false, reason: '', stage: dialog.stage || 'new', interest: dialog.interest || '', summary: dialog.summary || '', contact: '', model: out.model, usage: out.usage };
    }
    return offline(w, 'модель вернула нечитаемый ответ');
  }

  const stages = ['new', 'interested', 'inprogress', 'customer'];
  const temps = ['hot', 'warm', 'cold'];
  const asked = /\?\s*$/.test(cleanReply(parsed.reply));
  return {
    reply: cleanReply(parsed.reply).slice(0, 1500),
    // Если круг всё же случился, а модель снова переспрашивает — решаем за неё.
    handoff: parsed.handoff === true || parsed.handoff === 'true' || (loop && asked),
    loopBroken: loop && asked || undefined,
    reason: clean(parsed.reason).slice(0, 120) || (loop && asked ? 'нет данных для ответа' : ''),
    stage: stages.includes(parsed.stage) ? parsed.stage : (dialog.stage || 'new'),
    interest: clean(parsed.interest).slice(0, 80) || dialog.interest || '',
    summary: clean(parsed.summary).slice(0, 400) || dialog.summary || '',
    contact: clean(parsed.contact).slice(0, 80),
    nextStep: clean(parsed.nextStep).slice(0, 60),
    temperature: temps.includes(parsed.temperature) ? parsed.temperature : '',
    objection: clean(parsed.objection).slice(0, 120),
    model: out.model,
    usage: out.usage || {},
  };
}

/**
 * Два последних ответа бота были вопросами и не содержали фактов?
 * Признак факта — цифра (цена, размер, срок) или ссылка: если их нет,
 * клиент по сути ничего не узнал.
 */
function questionLoop(dialog) {
  const botTurns = (dialog.msgs || []).filter(m => m.r === 'ai').slice(-2);
  if (botTurns.length < 2) return false;
  return botTurns.every(m => {
    const t = String(m.t || '').trim();
    return /\?\s*$/.test(t) && !/\d/.test(t);
  });
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
    json: true, maxTokens: 500, temperature: 0.8, reasoning: 'low',
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

  // Реплики без текста отбрасываем: Groq отвечает на такое 400, и вместо
  // разговора владелец видит ошибку сети.
  const msgs = history
    .map(m => ({ role: m.r === 'client' ? 'assistant' : 'user', content: clean(m && m.t, 600) }))
    .filter(m => m.content);
  if (!msgs.length) msgs.push({ role: 'user', content: '(начни разговор первым сообщением)' });

  const out = await groq.chat({ system: sys, messages: msgs, json: true, maxTokens: 200, temperature: 0.9, reasoning: 'low' });
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
/* ============================================================ разбор простыни
 *
 * Владелец редко приходит с аккуратно разложенными файлами. Обычно у него есть
 * одна простыня: прайс, условия доставки, гарантия и часы работы вперемешку.
 * Просить его разложить это руками — значит потерять половину владельцев на
 * первом же шаге.
 *
 * Модель здесь НЕ переписывает текст: она только называет разделы и указывает
 * границы строк. Резать по этим границам будет сервер. Иначе цена, которую
 * модель «слегка перефразировала», уедет клиенту как настоящая.
 * ========================================================================== */

/** Виды разделов, которые понимает база знаний. */
const KINDS = ['price', 'rules', 'faq', 'text', 'doc'];

/** Максимум текста за один разбор: дальше модель начинает терять середину. */
const SPLIT_MAX_CHARS = 40000;

/**
 * Делит текст на именованные разделы.
 * @returns {Promise<{sections:Array<{title:string,kind:string,body:string}>, usage:object, model:string}>}
 */
async function split(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!src) throw new Error('нечего разбирать — текст пустой');

  const lines = src.slice(0, SPLIT_MAX_CHARS).split('\n');
  const numbered = lines.map((l, i) => (i + 1) + '\t' + l).join('\n');

  const sys = [
    'Ты раскладываешь материалы компании по разделам, чтобы AI-менеджер быстрее находил нужное.',
    'Тебе дают текст с пронумерованными строками. Твоя работа — назвать разделы и указать их границы.',
    '',
    'ГЛАВНОЕ',
    '- Текст НЕ переписывай, не сокращай и не пересказывай. Ты возвращаешь только номера строк.',
    '- Разделы идут подряд и не пересекаются. Первый начинается со строки 1, последний кончается последней строкой.',
    '- Не теряй ни одной строки: между разделами не должно быть пропусков.',
    '- Режь по смыслу: цены отдельно от условий доставки, гарантия отдельно от часов работы.',
    '- Не дроби мелко. Обычно выходит от 2 до 8 разделов. Один связный кусок — один раздел.',
    '- Если весь текст об одном, верни один раздел на весь текст. Это нормальный ответ.',
    '',
    'ВИД РАЗДЕЛА (kind)',
    '- price — товары, услуги, цены, прайс, каталог, тарифы;',
    '- rules — доставка, оплата, возврат, гарантия, условия работы;',
    '- faq — вопросы клиентов и ответы на них;',
    '- text — всё остальное: о компании, контакты, часы работы.',
    '',
    'НАЗВАНИЕ (title) — короткое и по делу, 2-4 слова, как назвал бы папку человек:',
    '«Цены на бани», «Доставка и оплата», «Гарантия», «О компании». Без слова «раздел».',
    '',
    'Ответ — один JSON:',
    '{"sections":[{"title":"Цены на бани","kind":"price","from":1,"to":24}]}',
  ].join('\n');

  const out = await groq.chat({
    system: sys,
    messages: [{ role: 'user', content: 'Текст:\n' + numbered }],
    json: true, maxTokens: 900, temperature: 0.1, reasoning: 'low',
  });

  const p = groq.extractJson(out.text);
  const raw = (p && Array.isArray(p.sections)) ? p.sections : [];
  const sections = sliceByLines(lines, raw);
  if (!sections.length) throw new Error('не удалось разложить текст — добавьте его одним куском');
  return { sections, usage: out.usage || {}, model: out.model };
}

/**
 * Режет строки по границам, которые назвала модель, и чинит её огрехи:
 * перехлёсты, дыры и вылеты за край. Ни одна строка не должна пропасть —
 * пропавшая строка это потерянная цена.
 */
function sliceByLines(lines, raw) {
  const total = lines.length;
  const want = raw
    .map(sec => ({
      title: clean(sec && sec.title, 60) || 'Без названия',
      kind: KINDS.includes(sec && sec.kind) ? sec.kind : 'text',
      from: Math.round(Number(sec && sec.from)),
      to: Math.round(Number(sec && sec.to)),
    }))
    .filter(s => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from)
    .sort((a, b) => a.from - b.from);

  const out = [];
  let cursor = 1;                       // первая ещё не разобранная строка
  for (const s of want) {
    const from = Math.max(cursor, Math.min(s.from, total));
    const to = Math.max(from, Math.min(s.to, total));
    if (from > total) break;
    // Модель начала раздел позже, чем кончился прошлый: пропущенное отдаём
    // предыдущему разделу, а не выбрасываем.
    if (s.from > cursor && out.length) out[out.length - 1].to = s.from - 1;
    out.push({ title: s.title, kind: s.kind, from, to });
    cursor = to + 1;
  }
  if (!out.length) out.push({ title: 'Материалы', kind: 'text', from: 1, to: total });
  // Хвост, до которого модель не дошла, дописываем в последний раздел.
  if (cursor <= total) out[out.length - 1].to = total;

  return out
    .map(s => ({ title: s.title, kind: s.kind, body: lines.slice(s.from - 1, s.to).join('\n').trim() }))
    .filter(s => s.body);
}

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
  reply, channelPost, systemPrompt, retrieve, terms, lengthKey, questionLoop,
  customerMessage, analyzeStyle, SCENARIOS,
  split, sliceByLines, KINDS, SPLIT_MAX_CHARS,
};
