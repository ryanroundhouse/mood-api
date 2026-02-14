const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function createMockDocument() {
  const elementsById = new Map();

  function makeElement(tagName) {
    const el = {
      tagName: String(tagName || 'div').toUpperCase(),
      children: [],
      parentNode: null,
      _attrs: Object.create(null),
      textContent: '',
      type: '',
      addEventListener() {},
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) {
          this.children.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
      setAttribute(name, value) {
        this._attrs[String(name)] = String(value);
      },
      getAttribute(name) {
        return this._attrs[String(name)];
      },
    };

    let _id = '';
    Object.defineProperty(el, 'id', {
      get() {
        return _id;
      },
      set(v) {
        const next = String(v ?? '');
        if (_id) elementsById.delete(_id);
        _id = next;
        if (_id) elementsById.set(_id, el);
      },
      enumerable: true,
    });

    let _className = '';
    Object.defineProperty(el, 'className', {
      get() {
        return _className;
      },
      set(v) {
        _className = String(v ?? '');
      },
      enumerable: true,
    });

    el.classList = {
      contains(token) {
        return el.className.split(/\s+/).filter(Boolean).includes(token);
      },
      add(token) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        set.add(token);
        el.className = Array.from(set).join(' ');
      },
      remove(token) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        set.delete(token);
        el.className = Array.from(set).join(' ');
      },
      toggle(token, force) {
        const has = this.contains(token);
        const next = typeof force === 'boolean' ? force : !has;
        if (next) this.add(token);
        else this.remove(token);
        return next;
      },
    };

    Object.defineProperty(el, 'firstElementChild', {
      get() {
        return this.children[0] || null;
      },
    });

    return el;
  }

  const body = makeElement('body');

  return {
    body,
    createElement: makeElement,
    getElementById(id) {
      return elementsById.get(String(id)) || null;
    },
  };
}

async function importToastModule() {
  const toastPath = path.resolve(__dirname, '..', 'app', 'toast.mjs');
  return await import(pathToFileURL(toastPath).href);
}

test('showToast creates a toast container and toast', async () => {
  global.document = createMockDocument();

  const { showToast } = await importToastModule();
  showToast('Hello', { variant: 'success', durationMs: 0 });

  const container = global.document.getElementById('toastContainer');
  assert.ok(container, 'toastContainer should exist');
  assert.equal(container.getAttribute('aria-live'), 'polite');
  assert.equal(container.children.length, 1);

  const toast = container.children[0];
  assert.ok(toast.className.includes('toast--success'));
  assert.equal(toast.children[0].textContent, 'Hello');
});

test('showToast keeps only the most recent toasts', async () => {
  global.document = createMockDocument();

  const { showToast } = await importToastModule();
  showToast('t1', { durationMs: 0 });
  showToast('t2', { durationMs: 0 });
  showToast('t3', { durationMs: 0 });
  showToast('t4', { durationMs: 0 });

  const container = global.document.getElementById('toastContainer');
  assert.equal(container.children.length, 3);
  assert.equal(container.children[0].children[0].textContent, 't2');
  assert.equal(container.children[1].children[0].textContent, 't3');
  assert.equal(container.children[2].children[0].textContent, 't4');
});

