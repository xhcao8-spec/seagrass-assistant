const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./platform-preload.cjs'), 'utf8');

function sourceBetween(startName, nextName) {
  const start = source.indexOf(`function ${startName}(`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `missing ${startName}`);
  assert.notEqual(end, -1, `missing ${nextName}`);
  return source.slice(start, end);
}

const context = {};
vm.runInNewContext(
  sourceBetween('messageLikeDataId', 'canonicalMessageRoot')
    + sourceBetween('canonicalMessageRoot', 'visibleMessageRoots')
    + sourceBetween('findMessageText', 'removeQuotedTranslationArtifacts'),
  context,
);

class FakeNode {
  constructor({ dataId = '', testId = '', text = '', classes = [] } = {}) {
    this.parentElement = null;
    this.children = [];
    this.dataId = dataId;
    this.testId = testId;
    this.textContent = text;
    this.classes = new Set(classes);
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    if (name === 'data-id') return this.dataId || null;
    if (name === 'data-testid') return this.testId || null;
    return null;
  }

  matches(selector) {
    if (selector === '[data-id]') return Boolean(this.dataId);
    if (selector === '[data-testid="msg-container"]') return this.testId === 'msg-container';
    if (selector === '.message-in, .message-out') {
      return this.classes.has('message-in') || this.classes.has('message-out');
    }
    if (selector === '[data-seagrass-translation], [data-seagrass-translate-manually]') {
      return false;
    }
    return false;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selector === '[data-testid="selectable-text"]' && child.testId === 'selectable-text') {
          result.push(child);
        }
        if (selector === 'span[dir="auto"]' && child.testId === 'dir-auto') result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

test('quoted reply resolves to outer message and selects the new reply body', () => {
  const outer = new FakeNode({ dataId: 'true_chat_message-new' });
  const quote = outer.append(new FakeNode({ dataId: 'false_chat_message-old' }));
  quote.append(new FakeNode({
    testId: 'selectable-text',
    text: 'As for me, I am suffering greatly with my back.',
  }));
  const body = outer.append(new FakeNode({
    testId: 'selectable-text',
    text: "That's terrible. So are you also unemployed right now?",
  }));

  assert.equal(context.canonicalMessageRoot(quote), outer);
  assert.equal(context.findMessageText(outer), body);
});

test('quoted incoming reply works with legacy message-in roots', () => {
  const outer = new FakeNode({ classes: ['message-in'] });
  const quote = outer.append(new FakeNode({ dataId: 'true_chat_message-old' }));
  quote.append(new FakeNode({ testId: 'selectable-text', text: 'Old outgoing text' }));
  const body = outer.append(new FakeNode({ testId: 'selectable-text', text: 'New customer reply' }));

  assert.equal(context.canonicalMessageRoot(quote), outer);
  assert.equal(context.findMessageText(outer), body);
});

test('current WhatsApp msg-container remains the root for quoted replies', () => {
  const outer = new FakeNode({ testId: 'msg-container' });
  const quote = outer.append(new FakeNode({ testId: 'quoted-message' }));
  quote.append(new FakeNode({ testId: 'selectable-text', text: 'Old quoted message' }));
  const body = outer.append(new FakeNode({ testId: 'selectable-text', text: 'Current reply body' }));

  assert.equal(context.canonicalMessageRoot(quote), outer);
  assert.equal(context.findMessageText(outer), body);
});
