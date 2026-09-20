const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./platform-preload.cjs'), 'utf8');
const start = source.indexOf('function messageTimestampFor(');
const end = source.indexOf('function messageIdFor(', start);
assert.notEqual(start, -1, 'missing messageTimestampFor');
assert.notEqual(end, -1, 'missing messageIdFor');
const timestampSource = source.slice(start, end);

function parseTimestamp(raw, language) {
  const context = { navigator: { language } };
  vm.runInNewContext(timestampSource, context);
  const message = {
    getAttribute(name) {
      return name === 'data-pre-plain-text' ? raw : null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  };
  return new Date(context.messageTimestampFor(message));
}

function assertLocalDate(value, { year, month, day, hour, minute }) {
  assert.equal(value.getFullYear(), year);
  assert.equal(value.getMonth() + 1, month);
  assert.equal(value.getDate(), day);
  assert.equal(value.getHours(), hour);
  assert.equal(value.getMinutes(), minute);
}

test('parses time-first day/month WhatsApp timestamps', () => {
  assertLocalDate(parseTimestamp('[13:29, 02/09/2026] Hervé:', 'zh-CN'), {
    year: 2026,
    month: 9,
    day: 2,
    hour: 13,
    minute: 29,
  });
});

test('uses browser locale for ambiguous US month/day timestamps', () => {
  assertLocalDate(parseTimestamp('[1:29 PM, 09/02/2026] Hervé:', 'en-US'), {
    year: 2026,
    month: 9,
    day: 2,
    hour: 13,
    minute: 29,
  });
});

test('treats a trailing two-digit value as the year, not a leading year', () => {
  assertLocalDate(parseTimestamp('[13:29, 02/09/26] Hervé:', 'zh-CN'), {
    year: 2026,
    month: 9,
    day: 2,
    hour: 13,
    minute: 29,
  });
});

test('parses Chinese year-first WhatsApp timestamps', () => {
  assertLocalDate(parseTimestamp('[2026年9月2日 13:29] Hervé:', 'zh-CN'), {
    year: 2026,
    month: 9,
    day: 2,
    hour: 13,
    minute: 29,
  });
});
