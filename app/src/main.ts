import { App } from '@modelcontextprotocol/ext-apps';
import './styles.css';

// ---- types mirrored from the server's view payloads --------------------------------------------
interface Mark { time: number; start: number; end: number; value: string }
interface Page { id: string; text: string; imageUrl?: string; audioUrl?: string; marks?: Mark[] }
interface Book {
  id: string; hero: string; sidekick: string; title?: string; dedication?: string; pages: Page[];
  choice?: { question: string; questionAudioUrl?: string; options: { id: 'a' | 'b'; label: string; pages: Page[] }[] };
  wordOfTheNight?: { word: string; meaning: string; example: string; audioUrl?: string };
  branch?: 'a' | 'b';
}
interface Studio {
  id: string; hero: string; status: string; title?: string; step: string; log: string[]; done: number; total: number; error?: string; preview: string[];
  /** Optional: estimated AWS spend and wall-clock time, when the server passes them through. */
  cost?: { usd?: number; items?: { label: string; qty: number; usd: number }[] }; generationMs?: number;
}
type View =
  | { view: 'studio'; story: Studio }
  | { view: 'storybook'; story: Book; position: number }
  | { view: 'library'; hero: string; stories: { id: string; title?: string; date: string; cover?: string; choiceMade?: string }[] }
  | { view: 'recap'; recap: any }
  | { view: 'world'; hero: any }
  | { view: 'message'; title: string; body: string };

const VIEW_KEY = 'once-upon-tonight/view';
const root = document.getElementById('root')!;
const app = new App({ name: 'Once Upon Tonight', version: '0.1.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });

// ---- small helpers -------------------------------------------------------------------------------
const h = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const esc = (s = '') => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const icon = {
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.4"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.4"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
};
const brand = () => `<div class="brand"><div class="moon-icon"></div>Once Upon Tonight</div>`;
const quiet = async <T>(p: Promise<T>) => {
  try { return await p; } catch (e) { console.debug('[view] host call failed', e); return undefined; }
};

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await quiet(app.callServerTool({ name, arguments: args }));
  const v = (res as any)?._meta?.[VIEW_KEY] as View | undefined;
  if (v) render(v);
  return res;
}

// ---- host context: theme, sizing, display mode ----------------------------------------------------
let displayMode: 'inline' | 'fullscreen' = 'inline';
function applyContext(ctx: any) {
  if (!ctx) return;
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme === 'light' ? 'light' : 'dark';
  if (ctx.displayMode) displayMode = ctx.displayMode;
  const fixedHeight = ctx.containerDimensions?.height ?? ctx.maxHeight;
  document.body.classList.toggle('inline', displayMode === 'inline' && !fixedHeight && !ctx.deviceClass);
}
const canFullscreen = () => (app.getHostContext() as any)?.availableDisplayModes?.includes('fullscreen') && displayMode !== 'fullscreen';

// ---- narration engine: Polly audio + word marks → live highlight ----------------------------------
const audio = new Audio();
audio.preload = 'auto';
let raf = 0;
let onEnded: (() => void) | null = null;
let clipOn = false;
/** Tell the host when narration starts/stops (hosts can use it for captions, ducking or recordings). */
function audioEvent(event: 'start' | 'stop') {
  if ((event === 'start') === clipOn) return;
  clipOn = event === 'start';
  quiet(app.sendLog({ level: 'info', logger: 'audio', data: { event, url: audio.src, at: Date.now(), offsetMs: Math.round(audio.currentTime * 1000) } }));
}
audio.addEventListener('ended', () => {
  audioEvent('stop');
  onEnded?.();
});

function stopAudio() {
  audioEvent('stop');
  audio.pause();
  cancelAnimationFrame(raf);
  onEnded = null;
}

async function playClip(url: string | undefined, spans: HTMLElement[] = [], marks: Mark[] = [], done?: () => void) {
  stopAudio();
  if (!url) { done?.(); return true; }
  audio.src = url;
  onEnded = () => { spans.forEach((s) => s.classList.replace('now', 'said')); cancelAnimationFrame(raf); done?.(); };
  const tick = () => {
    const t = audio.currentTime * 1000;
    let idx = -1;
    for (let i = 0; i < marks.length; i++) if (marks[i].time <= t) idx = i; else break;
    spans.forEach((s, i) => { s.classList.toggle('now', i === idx); s.classList.toggle('said', i < idx); });
    showPassage(spans[Math.max(idx, 0)]?.parentElement);
    raf = requestAnimationFrame(tick);
  };
  try {
    await audio.play();
    audioEvent('start');
    raf = requestAnimationFrame(tick);
    return true;
  } catch {
    return false; // autoplay blocked → caller shows a tap-to-start button
  }
}

/**
 * A long page is shown a passage at a time (a few sentences, cut at sentence ends), and the read-along
 * moves to the next passage when the narrator gets there, so the words never cover the whole picture.
 */
function passagesOf(text: string, maxWords = 45): [number, number][] {
  // Sentence ends: . ! ? or … (and any closing quote) before a space, except after "Mr." and friends.
  const ends: number[] = [];
  const re = /[.!?…]+["”’')]*\s+/g;
  for (let m; (m = re.exec(text)); ) if (!/\b(?:Mr|Mrs|Ms|Dr|St|Mt)\.$/.test(text.slice(0, m.index + 1))) ends.push(m.index + m[0].length);
  ends.push(text.length);
  const out: [number, number][] = [];
  let start = 0;
  let prev = 0;
  let words = 0;
  for (const end of ends) {
    const n = text.slice(prev, end).split(/\s+/).filter(Boolean).length;
    if (words && words + n > maxWords) {
      out.push([start, prev]);
      start = prev;
      words = 0;
    }
    words += n;
    prev = end;
  }
  out.push([start, text.length]);
  return out;
}

function showPassage(box: Element | null | undefined) {
  if (!box?.classList.contains('passage') || box.classList.contains('on')) return;
  box.parentElement?.querySelectorAll('.passage.on').forEach((b) => b.classList.remove('on'));
  box.classList.add('on');
}

/** Wrap each spoken word in a span (using Polly's char offsets) and mark the word of the night. */
function renderWords(el: HTMLElement, page: Page, wotn?: string) {
  const text = page.text;
  const marks = page.marks ?? [];
  el.innerHTML = '';
  const spans: HTMLElement[] = [];
  let cursor = 0;
  const isWotn = (w: string) => !!wotn && w.toLowerCase().replace(/[^a-z']/g, '') === wotn.toLowerCase();
  if (!marks.length) {
    el.textContent = text;
    return spans;
  }
  const parts = passagesOf(text);
  const boxes = parts.map(() => el.appendChild(Object.assign(document.createElement('span'), { className: 'passage' })));
  const boxAt = (i: number) => boxes[Math.max(0, parts.findIndex(([s, e]) => i >= s && i < e))];
  const appendText = (a: number, b: number) =>
    parts.forEach(([s, e], k) => { if (Math.min(b, e) > Math.max(a, s)) boxes[k].append(text.slice(Math.max(a, s), Math.min(b, e))); });
  for (const m of marks) {
    if (m.start > cursor) appendText(cursor, m.start);
    const word = text.slice(m.start, m.end);
    const span = document.createElement(isWotn(word) ? 'button' : 'span');
    span.className = 'w' + (isWotn(word) ? ' wotn' : '');
    span.textContent = word;
    if (isWotn(word)) {
      span.setAttribute('aria-label', `Word of the night: ${word}. Tap to hear what it means.`);
      span.addEventListener('click', (e) => { e.stopPropagation(); showWord(); });
    }
    boxAt(m.start).append(span);
    spans.push(span);
    cursor = m.end;
  }
  appendText(cursor, text.length);
  if (boxes.length > 1) el.classList.add('paged');
  boxes[0].classList.add('on');
  return spans;
}

// ---- storybook state ------------------------------------------------------------------------------
let book: Book | null = null;
let pos = 0;
let playing = true;
let started = false;
let sleepTimer = 0;

type Step = { kind: 'title' } | { kind: 'page'; page: Page; n: number; total: number } | { kind: 'choice' } | { kind: 'end' };

/** Reading positions match the server: -1 title · 0..k-1 shared · k choice · k+1.. chosen path · last = The End */
function stepAt(p: number): Step {
  const b = book!;
  const k = b.pages.length;
  const branch = b.choice?.options.find((o) => o.id === b.branch);
  const m = branch?.pages.length ?? b.choice?.options[0].pages.length ?? 0;
  if (p < 0) return { kind: 'title' };
  if (p < k) return { kind: 'page', page: b.pages[p], n: p + 1, total: k + m };
  if (p === k || !branch) return b.choice ? { kind: 'choice' } : { kind: 'end' };
  if (p - k - 1 < branch.pages.length) return { kind: 'page', page: branch.pages[p - k - 1], n: p, total: k + m };
  return { kind: 'end' };
}

function openBook(v: Extract<View, { view: 'storybook' }>) {
  const same = book?.id === v.story.id;
  book = v.story;
  if (same && started) {
    if (v.position !== pos) goTo(v.position, false, 1600);
    return;
  }
  started = false;
  pos = v.position;
  // Preload every illustration so page turns never flash black on a slow connection.
  [...v.story.pages, ...(v.story.choice?.options.flatMap((o) => o.pages) ?? [])].forEach((p) => { if (p.imageUrl) new Image().src = p.imageUrl; });
  drawBookFrame();
  goTo(v.position === 0 ? -1 : v.position, false);
}

function drawBookFrame() {
  root.innerHTML = '';
  const frame = h(`<div class="frame book">
    <img class="illustration" alt="" />
    <div class="shade"></div>
    ${brand()}
    <div class="top-right"><div class="dots"></div>${canFullscreen() ? `<button class="icon-btn full" aria-label="Full screen">${icon.full}</button>` : ''}</div>
    <div class="stage"></div>
    <button class="icon-btn nav prev" aria-label="Previous page">${icon.prev}</button>
    <button class="icon-btn nav next" aria-label="Next page">${icon.next}</button>
    <div class="sleep-dim"></div>
  </div>`);
  root.append(frame);
  frame.querySelector<HTMLButtonElement>('.prev')!.onclick = () => goTo(pos - 1);
  frame.querySelector<HTMLButtonElement>('.next')!.onclick = () => goTo(pos + 1);
  frame.querySelector<HTMLButtonElement>('.full')?.addEventListener('click', () => quiet(app.requestDisplayMode({ mode: 'fullscreen' })));
}

function setIllustration(url?: string) {
  const img = root.querySelector<HTMLImageElement>('.illustration');
  if (!img || !url || img.src === url) return;
  img.classList.add('fade');
  const next = new Image();
  next.onload = () => { img.src = url; img.classList.remove('fade'); };
  next.src = url;
}

function drawDots() {
  const b = book!;
  const dots = root.querySelector('.dots');
  if (!dots) return;
  const k = b.pages.length;
  const m = b.choice?.options.find((o) => o.id === b.branch)?.pages.length ?? b.choice?.options[0].pages.length ?? 0;
  const items: string[] = [];
  for (let i = 0; i < k; i++) items.push(`<i class="dot${i === pos ? ' on' : ''}"></i>`);
  if (b.choice) items.push(`<i class="dot dot-choice${pos === k ? ' on' : ''}"></i>`);
  for (let i = 0; i < m; i++) items.push(`<i class="dot${pos === k + 1 + i ? ' on' : ''}"></i>`);
  dots.innerHTML = items.join('');
}

function goTo(p: number, report = true, narrateDelay = 0) {
  if (!book) return;
  const b = book;
  const k = b.pages.length;
  if (p > k && !b.branch) p = k; // the story waits for a choice
  const lastIdx = k + 1 + (b.choice?.options.find((o) => o.id === b.branch)?.pages.length ?? 0);
  p = Math.max(-1, Math.min(p, lastIdx));
  pos = p;
  stopAudio();
  clearTimeout(sleepTimer);
  root.querySelector('.sleep-dim')?.classList.remove('on');
  root.querySelector('.word-pop')?.remove();
  const stage = root.querySelector<HTMLElement>('.stage')!;
  const step = stepAt(p);
  root.querySelector<HTMLButtonElement>('.prev')!.disabled = p <= -1;
  root.querySelector<HTMLButtonElement>('.next')!.disabled = step.kind === 'end' || step.kind === 'choice' || step.kind === 'title';
  drawDots();
  if (report && p >= 0) quiet(app.callServerTool({ name: 'log_reading_progress', arguments: { story_id: b.id, position: p } }));

  if (step.kind === 'title') {
    setIllustration(b.pages[0]?.imageUrl);
    stage.innerHTML = `<div class="title-card"><div>
      <div class="pill gold">Tonight's story for ${esc(b.hero)}</div>
      <h1 style="margin-top:14px">${esc(b.title)}</h1>
      <div class="dedication">${esc(b.dedication)}</div>
      <div class="actions"><button class="primary-btn begin">${icon.play.replace('<svg', '<svg width="20" height="20"')} Begin</button></div>
    </div></div>`;
    stage.querySelector<HTMLButtonElement>('.begin')!.onclick = () => { started = true; goTo(0); };
    // Begin on its own after a beat, so the assistant's short intro isn't talked over.
    sleepTimer = window.setTimeout(() => pos === -1 && book?.id === b.id && goTo(0), 4500);
    updateContext(`Storybook open on the title page of “${b.title}”.`);
    return;
  }
  started = true;

  if (step.kind === 'page') {
    setIllustration(step.page.imageUrl);
    stage.innerHTML = `<div class="text-panel"><p class="page-text"></p></div>
      <div class="page-count">${step.n} / ${step.total}</div>
      <button class="icon-btn play" aria-label="Pause narration">${playing ? icon.pause : icon.play}</button>`;
    const spans = renderWords(stage.querySelector('.page-text')!, step.page, b.wordOfTheNight?.word);
    const playBtn = stage.querySelector<HTMLButtonElement>('.play')!;
    const narrate = async () => {
      const ok = await playClip(step.page.audioUrl, spans, step.page.marks, () => {
        if (playing && pos === p) setTimeout(() => pos === p && playing && goTo(p + 1, true, 600), 1300);
      });
      if (!ok) showTapToStart(narrate);
    };
    playBtn.onclick = () => {
      playing = !playing;
      playBtn.innerHTML = playing ? icon.pause : icon.play;
      playBtn.setAttribute('aria-label', playing ? 'Pause narration' : 'Play narration');
      if (playing) narrate(); else stopAudio();
    };
    if (playing) setTimeout(() => pos === p && narrate(), narrateDelay);
    updateContext(`Storybook showing “${b.title}”, page ${step.n} of ${step.total}: ${step.page.text}`);
    return;
  }

  if (step.kind === 'choice') {
    const c = b.choice!;
    setIllustration(b.pages[k - 1]?.imageUrl);
    stage.innerHTML = `<div class="choice">
      <h2>${esc(c.question)}</h2>
      <div class="options">${c.options
        .map((o, i) => `<button class="option" data-id="${o.id}"><img alt="" src="${esc(o.pages[0]?.imageUrl)}"/><i class="letter">${i + 1}</i><span>${esc(o.label)}</span></button>`)
        .join('')}</div></div>`;
    stage.querySelectorAll<HTMLButtonElement>('.option').forEach((btn) => {
      btn.onclick = () => choose(btn.dataset.id as 'a' | 'b');
    });
    setTimeout(() => pos === p && playClip(c.questionAudioUrl).then((ok) => { if (!ok) showTapToStart(() => playClip(c.questionAudioUrl)); }), narrateDelay);
    updateContext(`Storybook is waiting for a choice: ${c.question} Options: 1) ${c.options[0].label} 2) ${c.options[1].label}`);
    return;
  }

  // the end
  stage.innerHTML = `<div class="the-end"><div class="stars"></div><div>
    <div class="big-moon"></div><h1>The End</h1><p>Goodnight, ${esc(b.hero)}. Sweet dreams.</p>
    <p style="font-size:0.8em;opacity:.8;margin-top:14px">${esc(b.dedication)}</p></div></div>`;
  sleepTimer = window.setTimeout(() => root.querySelector('.sleep-dim')?.classList.add('on'), 6000);
  updateContext(`Storybook finished “${b.title}”. Screen is dimming for sleep.`);
}

function choose(id: 'a' | 'b') {
  if (!book) return;
  book.branch = id;
  const label = book.choice!.options.find((o) => o.id === id)!.label;
  goTo(book.pages.length + 1, false);
  quiet(app.callServerTool({ name: 'choose_path', arguments: { story_id: book.id, option_number: id === 'a' ? 1 : 2 } }));
  updateContext(`The child chose “${label}”.`);
}

function showWord() {
  const w = book?.wordOfTheNight;
  if (!w) return;
  root.querySelector('.word-pop')?.remove();
  const pop = h(`<div class="word-pop" role="dialog" aria-label="Word of the night">
    <div class="label">✨ Word of the night</div><div class="word">${esc(w.word)}</div>
    <p>${esc(w.meaning)}</p><p class="example">“${esc(w.example)}”</p></div>`);
  root.querySelector('.frame')!.append(pop);
  const wasPlaying = !audio.paused;
  playClip(w.audioUrl, [], [], () => setTimeout(() => { pop.remove(); if (wasPlaying) goTo(pos, false); }, 2500));
  quiet(app.callServerTool({ name: 'log_reading_progress', arguments: { story_id: book!.id, position: Math.max(0, pos), word_explored: w.word } }));
}

function showTapToStart(retry: () => void) {
  if (root.querySelector('.tap-to-start')) return;
  const el = h(`<div class="tap-to-start"><button class="primary-btn">${icon.play.replace('<svg', '<svg width="20" height="20"')} Tap to start reading</button></div>`);
  el.querySelector('button')!.addEventListener('click', () => { el.remove(); retry(); });
  root.querySelector('.frame')!.append(el);
}

let lastContext = '';
function updateContext(text: string) {
  if (text === lastContext) return;
  lastContext = text;
  quiet(app.updateModelContext({ content: [{ type: 'text', text }] }));
}

// ---- studio ----------------------------------------------------------------------------------------
let poll = 0;
const STUDIO_STEPS = [
  { key: 'writing', ico: '✍️', label: 'Writing the story', sub: 'Amazon Bedrock · Claude' },
  { key: 'checking', ico: '🛡️', label: 'Bedtime safety check', sub: 'Guardrails + Claude review' },
  { key: 'illustrating', ico: '🎨', label: 'Painting the pictures', sub: 'SD3.5 Large · Rekognition + Claude picture check' },
  { key: 'narrating', ico: '🎙️', label: 'Recording the narration', sub: 'Amazon Polly' },
  { key: 'ready', ico: '🌙', label: 'Ready for bedtime', sub: 'Remembered for next time' },
];

/** "≈ $0.42 · made in 3m 5s" under a finished story; either half is skipped if the server didn't send it. */
function madeIn(s: Studio) {
  const n = s.cost?.usd;
  const usd = typeof n !== 'number' || !Number.isFinite(n) ? '' : n > 0 && n < 0.005 ? '< $0.01' : `≈ $${n.toFixed(2)}`;
  const secs = typeof s.generationMs === 'number' && s.generationMs >= 0 ? Math.round(s.generationMs / 1000) : undefined;
  const took = secs === undefined ? '' : `made in ${Math.floor(secs / 60)}m ${secs % 60}s`;
  const items = Array.isArray(s.cost?.items) ? s.cost.items : [];
  const breakdown = ['Estimated at AWS list prices', ...items.map((i) => `${i.label}: ${Number(i.qty).toLocaleString()} → $${Number(i.usd).toFixed(4)}`)].join('\n');
  const line = [usd, took].filter(Boolean).join(' · ');
  return line ? `<p class="sub made-in" style="font-size:calc(12 * var(--u));opacity:0.8"${usd ? ` title="${esc(breakdown)}"` : ''}>${esc(line)}</p>` : '';
}

function drawStudio(s: Studio) {
  stopAudio();
  book = null;
  const order = STUDIO_STEPS.map((x) => x.key);
  const cur = s.status === 'queued' ? 0 : order.indexOf(s.status);
  const pct = s.status === 'ready' ? 100 : Math.round((s.done / Math.max(1, s.total)) * 100);
  root.innerHTML = '';
  const frame = h(`<div class="frame">${brand()}
    <div class="panel-view">
      <div class="studio-hero">
        <div class="kicker">Story studio</div>
        <h1>${s.status === 'ready' ? `“${esc(s.title)}”` : s.status === 'failed' ? 'That story got tangled' : `Making tonight's story for ${esc(s.hero)}`} ${s.status === 'ready' || s.status === 'failed' ? '' : '<span class="quill">🪶</span>'}</h1>
        <p class="sub">${esc(s.status === 'failed' ? s.error ?? 'Please try again.' : s.step)}</p>
        ${s.status === 'ready' ? madeIn(s) : ''}
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="thumbs">${s.preview.map((u) => `<img alt="" src="${esc(u)}"/>`).join('')}</div>
        ${s.status === 'ready' ? `<div><button class="primary-btn read-now">${icon.play.replace('<svg', '<svg width="18" height="18"')} Read it now</button></div>` : ''}
      </div>
      <ol class="steps">${STUDIO_STEPS.map((st, i) => {
        const state = s.status === 'ready' || i < cur ? 'done' : i === cur && s.status !== 'failed' ? 'active' : '';
        return `<li class="step ${state}"><span class="ico">${state === 'done' ? '✓' : st.ico}</span><div>${st.label}<small>${st.sub}</small></div></li>`;
      }).join('')}</ol>
    </div></div>`);
  root.append(frame);
  frame.querySelector<HTMLButtonElement>('.read-now')?.addEventListener('click', () => callTool('open_storybook', { story_id: s.id, start_over: true }));
  clearTimeout(poll);
  if (s.status !== 'ready' && s.status !== 'failed') {
    poll = window.setTimeout(() => callTool('check_story_progress', { story_id: s.id }), 2000);
  }
}

// ---- library / recap / world / message ---------------------------------------------------------------
function drawLibrary(v: Extract<View, { view: 'library' }>) {
  stopAudio();
  book = null;
  root.innerHTML = '';
  const frame = h(`<div class="frame">${brand()}<div class="list-view">
    <h1>${esc(v.hero)}'s story shelf</h1>
    <div class="carousel">${v.stories.map((s) => `<button class="book-card" data-id="${s.id}">
      <img alt="" src="${esc(s.cover)}"/><div><b>${esc(s.title)}</b><small>${esc(s.date)}${s.choiceMade ? ` · chose “${esc(s.choiceMade)}”` : ''}</small></div></button>`).join('')}</div>
  </div></div>`);
  root.append(frame);
  frame.querySelectorAll<HTMLButtonElement>('.book-card').forEach((b) => (b.onclick = () => callTool('open_storybook', { story_id: b.dataset.id, start_over: true })));
}

function drawRecap(r: any) {
  stopAudio();
  book = null;
  root.innerHTML = '';
  const facts = [
    r.finished ? ['🌙', `Listened all the way to <b>the end</b>`] : ['📖', `Heard <b>${r.pagesHeard} of ${r.totalPages}</b> pages`],
    r.choiceMade && ['🧭', `At the big moment, chose <b>“${esc(r.choiceMade)}”</b>`],
    r.wordOfTheNight && ['✨', `Word of the night: <b>${esc(r.wordOfTheNight)}</b>${r.wordsExplored?.length ? ' · asked what it means' : ''}`],
    ['🗺️', `Story world: <b>${r.worldSize.episodes}</b> episodes · <b>${r.worldSize.places}</b> places · <b>${r.worldSize.characters}</b> ${r.worldSize.characters === 1 ? 'friend' : 'friends'}`],
  ].filter(Boolean) as string[][];
  root.append(h(`<div class="frame">${brand()}<div class="recap">
    <img alt="" src="${esc(r.cover)}"/>
    <div><div class="kicker">Bedtime recap · ${esc(r.date)}</div><h1>${esc(r.title)}</h1>
    <div class="facts">${facts.map(([i, t]) => `<div class="fact"><span class="ico">${i}</span><span>${t}</span></div>`).join('')}</div></div>
  </div></div>`));
}

function drawWorld(w: any) {
  stopAudio();
  book = null;
  root.innerHTML = '';
  const chips = (xs: string[], cls = '') => `<div class="chips">${xs.map((x) => `<span class="pill ${cls}">${esc(x)}</span>`).join('') || '<span class="pill">none yet</span>'}</div>`;
  root.append(h(`<div class="frame">${brand()}<div class="world">
    <div class="card"><h2>${esc(w.name)}'s sidekick</h2><p><b style="color:var(--ink)">${esc(w.sidekick.name)}</b>: ${esc(w.sidekick.description)}</p></div>
    <div class="card"><h2>Loves</h2>${chips(w.favoriteThings, 'gold')}<h2 style="margin-top:12px">Never in stories</h2>${chips(w.avoid)}</div>
    <div class="card"><h2>Places</h2>${chips(w.places)}<h2 style="margin-top:12px">Friends</h2>${chips(w.characters.map((c: any) => c.name))}</div>
    <div class="card"><h2>Recent episodes</h2>${w.episodes.map((e: any) => `<div class="episode"><b>${esc(e.title)}</b> · ${esc(e.date)}${e.choiceMade ? ` · chose “${esc(e.choiceMade)}”` : ''}</div>`).join('') || '<p>No episodes yet.</p>'}</div>
  </div></div>`));
}

function drawMessage(title: string, body: string) {
  stopAudio();
  book = null;
  root.innerHTML = '';
  root.append(h(`<div class="frame">${brand()}<div class="message"><div><div class="moon-icon" style="margin:0 auto 16px;width:44px;height:44px"></div><h1>${esc(title)}</h1><p>${esc(body)}</p></div></div></div>`));
}

// ---- dispatch ----------------------------------------------------------------------------------------
function render(v: View) {
  if (v.view !== 'studio') clearTimeout(poll);
  switch (v.view) {
    case 'storybook': return openBook(v);
    case 'studio': return drawStudio(v.story);
    case 'library': return drawLibrary(v);
    case 'recap': return drawRecap(v.recap);
    case 'world': return drawWorld(v.hero);
    case 'message': return drawMessage(v.title, v.body);
  }
}

app.ontoolresult = (result) => {
  const v = (result as any)?._meta?.[VIEW_KEY] as View | undefined;
  if (v) render(v);
  else if ((result as any)?.isError) drawMessage('Hmm…', (result as any).content?.[0]?.text ?? 'Something went wrong.');
};
app.ontoolcancelled = () => drawMessage('Hmm…', 'That took too long. Please try again.');
app.onhostcontextchanged = (ctx) => applyContext(ctx);
app.onteardown = async () => { stopAudio(); clearTimeout(poll); return {}; };

app.connect().then(() => applyContext(app.getHostContext()));
