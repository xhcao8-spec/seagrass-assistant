const DEBUG_PORT = Number(process.env.SEAGRASS_DEBUG_PORT || 9222);
const SOURCE_TEXT = process.env.SEAGRASS_TEST_SOURCE || '好的';
const DEBUG_LIST_URL = `http://127.0.0.1:${DEBUG_PORT}/json/list`;
const SEND_SELECTOR = [
  '#main [data-testid="send"]',
  '#main [data-icon="send"]',
  '#main button[aria-label="Send"]',
  '#main button[aria-label*="Send"]',
  '#main button[aria-label*="发送"]',
].join(', ');
const COMPOSER_SELECTOR = [
  '#main [data-testid="conversation-compose-box-input"]',
  '#main footer [contenteditable="true"][data-tab]',
  '#main footer [contenteditable="true"][role="textbox"]',
  '#main footer [contenteditable="true"]',
].join(', ');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const normalize = (value) => String(value ?? '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();

const targets = await fetch(DEBUG_LIST_URL).then((response) => response.json());
const target = targets.find(
  (item) => item.type === 'page' && item.url.startsWith('https://web.whatsapp.com'),
);
if (!target) throw new Error('WhatsApp runtime target was not found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(message);
};
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

function call(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || 'Runtime evaluation failed');
  }
  return response.result?.result?.value;
}

async function composerState() {
  return evaluate(`(() => {
    const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
    const progress = document.querySelector('[data-seagrass-composer-progress]');
    const fakeSend = document.querySelector('[data-seagrass-test-send]');
    return {
      composer: Boolean(composer),
      draft: (composer?.textContent || '').trim(),
      progress: progress?.textContent || '',
      error: progress?.dataset?.seagrassError || '',
      autoClicks: Number(fakeSend?.dataset?.autoClicks || 0),
    };
  })()`);
}

async function replaceComposerText(text) {
  const focused = await evaluate(`(() => {
    const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
    composer?.focus();
    return Boolean(composer);
  })()`);
  if (!focused) throw new Error('Composer was not found');

  const current = await composerState();
  // Ctrl+A on an empty Lexical composer can be interpreted as a selection
  // command by WhatsApp when the synthetic send target is present. Skip it
  // for an already-empty editor; this also mirrors a real user typing flow.
  if (normalize(current.draft)) {
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
    });
    await sleep(30);
  }
  if (text) {
    await call('Input.insertText', { text });
  } else {
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
  }
  await sleep(160);
  const state = await composerState();
  if (normalize(state.draft) !== normalize(text)) {
    throw new Error(`Test composer mismatch: expected ${JSON.stringify(text)}, received ${JSON.stringify(state.draft)}`);
  }
}

async function runRound(round) {
  await replaceComposerText(SOURCE_TEXT);
  const before = await composerState();
  await evaluate(`document.querySelector('[data-seagrass-test-send]')?.click()`);

  let state = before;
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    await sleep(200);
    state = await composerState();
    if (state.autoClicks > before.autoClicks || state.error) break;
  }

  const fakeMessageId = `seagrass-runtime-test-${Date.now()}-${round}`;
  const rendered = state.autoClicks > before.autoClicks && !state.error
    ? await evaluate(`(() => {
      const message = document.createElement('div');
      message.className = 'message-out';
      message.setAttribute('data-id', ${JSON.stringify(fakeMessageId)});
      message.setAttribute('data-seagrass-test-message', '');
      const wrapper = document.createElement('div');
      const anchor = document.createElement('span');
      anchor.setAttribute('data-testid', 'selectable-text');
      anchor.textContent = ${JSON.stringify(state.draft)};
      wrapper.appendChild(anchor);
      message.appendChild(wrapper);
      document.body.appendChild(message);
      return true;
    })()`)
    : false;

  let originalRendered = '';
  let cacheKind = '';
  if (rendered) {
    const deadlineForOriginal = Date.now() + 3_000;
    while (Date.now() < deadlineForOriginal) {
      await sleep(100);
      const result = await evaluate(`(() => {
        const message = document.querySelector('[data-seagrass-test-message]');
        const cache = JSON.parse(localStorage.getItem('seagrass:translation-cache:v1') || '{}');
        return {
          text: message?.querySelector('[data-seagrass-translation]')?.textContent || '',
          kind: cache[${JSON.stringify(fakeMessageId)}]?.kind || '',
        };
      })()`);
      originalRendered = result.text;
      cacheKind = result.kind;
      if (originalRendered) break;
    }
  }

  await evaluate(`document.querySelector('[data-seagrass-test-message]')?.remove()`);
  return {
    round,
    translatedDraft: state.draft,
    autoSendTriggered: state.autoClicks > before.autoClicks,
    progress: state.progress,
    error: state.error,
    originalRendered,
    cacheKind,
    fakeMessageId,
  };
}

const initial = await composerState();
if (!initial.composer) throw new Error('Open a WhatsApp conversation before running this check');
const storedOutgoingOriginals = await evaluate(
  `localStorage.getItem('seagrass:outgoing-originals:v1') || '[]'`,
);
const realOutgoingCount = await evaluate(`document.querySelectorAll('.message-out').length`);
const results = [];
let finalOutgoingCount = realOutgoingCount;

try {
  await evaluate(`(() => {
    document.querySelector('[data-seagrass-test-overlay]')?.remove();
    document.querySelector('[data-seagrass-test-send]')?.remove();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-seagrass-test-overlay', '');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      background: 'rgba(255,255,255,.08)',
      cursor: 'wait',
      pointerEvents: 'none',
    });
    // A synthetic <button> inside WhatsApp's #main makes Chromium route
    // subsequent editor input to that button. A div still matches the
    // platform send selector and supports click(), without stealing editor
    // input focus.
    const fakeSend = document.createElement('div');
    fakeSend.setAttribute('data-testid', 'send');
    fakeSend.setAttribute('data-seagrass-test-send', '');
    fakeSend.dataset.autoClicks = '0';
    Object.assign(fakeSend.style, {
      position: 'fixed',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
    });
    fakeSend.addEventListener('click', () => {
      fakeSend.dataset.autoClicks = String(Number(fakeSend.dataset.autoClicks || 0) + 1);
    });
    document.querySelector('#main')?.appendChild(fakeSend);
    // Do not attach a full-screen element: Chromium routes synthetic input
    // to the topmost document layer even when pointer-events is disabled.
    // The check runs against a dedicated debug session, so no visual blocker
    // is needed here.
  })()`);

  results.push(await runRound(1));
  results.push(await runRound(2));
} finally {
  await replaceComposerText(initial.draft).catch(() => undefined);
  await evaluate(`(() => {
    document.querySelector('[data-seagrass-test-overlay]')?.remove();
    document.querySelector('[data-seagrass-test-send]')?.remove();
    document.querySelector('[data-seagrass-test-message]')?.remove();
    localStorage.setItem('seagrass:outgoing-originals:v1', ${JSON.stringify(storedOutgoingOriginals)});
    const cache = JSON.parse(localStorage.getItem('seagrass:translation-cache:v1') || '{}');
    for (const key of ${JSON.stringify(results.map((item) => item.fakeMessageId))}) delete cache[key];
    localStorage.setItem('seagrass:translation-cache:v1', JSON.stringify(cache));
  })()`);
  finalOutgoingCount = await evaluate(`document.querySelectorAll('.message-out').length`);
  socket.close();
}

console.log(JSON.stringify({
  source: SOURCE_TEXT,
  originalDraft: initial.draft,
  realMessageCountUnchanged: finalOutgoingCount === realOutgoingCount,
  rounds: results.map(({ fakeMessageId: _fakeMessageId, ...result }) => result),
}));
