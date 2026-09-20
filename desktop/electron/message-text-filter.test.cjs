const test = require('node:test');
const assert = require('node:assert/strict');
const { isTranslatableMessageText } = require('./message-text-filter.cjs');

test('skips media metadata and machine-only values', () => {
  const skipped = [
    '',
    '00:19',
    '17:40:12',
    '2026/7/10',
    '2026年7月10日',
    '2026年7月10日 17:40',
    '13 kB',
    '39 KB · 00:19',
    '+86 157 7762 1331',
    'https://example.com/a?b=1',
    'hello@example.com',
    '123456',
    '🎉👍',
    '……？！',
  ];

  for (const value of skipped) {
    assert.equal(isTranslatableMessageText(value), false, value);
  }
});

test('keeps natural-language messages that also contain numbers', () => {
  const translated = [
    'Hello',
    '您好',
    'Order 123 is ready',
    '订单 123 明天发货',
    'The price is 100 USD',
    'The file is 13 kB',
    'See https://example.com for details',
    '#precio 100',
  ];

  for (const value of translated) {
    assert.equal(isTranslatableMessageText(value), true, value);
  }
});
