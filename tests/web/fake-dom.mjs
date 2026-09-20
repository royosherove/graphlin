// A minimal DOM test double, not a browser or a visual/layout assertion.
// It deliberately has no HTML parser: the viewer must create elements and text.
export class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toLowerCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this._text = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const has = this.className.split(' ').includes(name);
        const next = force ?? !has;
        if (next) this.classList.add(name); else this.classList.remove(name);
        return next;
      },
      contains: name => this.className.split(' ').includes(name),
    };
  }
  set textContent(value) {
    this.replaceChildren();
    this._text = String(value);
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get childElementCount() { return this.children.length; }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'class') this.className = String(value);
    if (key === 'id') this.ownerDocument.elements.set(String(value), this);
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  showModal() { this.open = true; this.setAttribute('open', ''); }
  close() {
    this.open = false;
    this.attributes.delete('open');
    for (const listener of this.listeners.get('close') || []) listener({ target: this });
  }
  append(...items) {
    for (const item of items) {
      item.remove();
      item.parentElement = this;
      this.children.push(item);
    }
  }
  insertBefore(item, next) {
    item.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    item.parentElement = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, item);
  }
  replaceChildren(...items) {
    for (const item of this.children) item.parentElement = null;
    this.children = [];
    this._text = '';
    this.append(...items);
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentElement = null;
    }
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
  }
  async fire(type, properties = {}) {
    const event = {
      target: this, currentTarget: this, bubbles: true, cancelBubble: false,
      preventDefault() {}, stopPropagation() { this.cancelBubble = true; }, ...properties,
    };
    for (let current = this; current; current = current.parentElement) {
      event.currentTarget = current;
      for (const listener of current.listeners.get(type) || []) await listener(event);
      if (!event.bubbles || event.cancelBubble) break;
    }
  }
  focus() { this.ownerDocument.activeElement = this; }
  contains(element) {
    return element === this || this.children.some(child => child.contains(element));
  }
  querySelector(selector) {
    const attribute = selector.match(/^\[([\w-]+)="([^"]+)"\]$/);
    const matches = element => attribute ? element.getAttribute(attribute[1]) === attribute[2] : element.tagName === selector;
    for (const child of this.children) {
      if (matches(child)) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  scrollIntoView() {}
}

export function createDocument(markup) {
  const document = {
    elements: new Map(),
    activeElement: null,
    hidden: false,
    listeners: new Map(),
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
    },
    fire(type) { for (const listener of this.listeners.get(type) || []) listener(); },
    createElement(tag) { return new Element(tag, this); },
    createElementNS(_namespace, tag) { return new Element(tag, this); },
    getElementById(id) { return this.elements.get(id) || null; },
  };
  document.body = document.createElement('body');
  for (const match of markup.matchAll(/<([a-z0-9-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = document.createElement(match[1]);
    element.setAttribute('id', match[2]);
    document.body.append(element);
  }
  return document;
}
