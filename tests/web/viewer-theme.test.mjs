import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSketchCache } from '../../runtime/web/app.js';

const themes = ['sketchbook', 'ocean', 'forest', 'sunset', 'berry', 'sepia', 'blueprint', 'midnight'];
const roles = ['client', 'service', 'datastore', 'queue', 'external', 'module', 'function', 'class', 'interface', 'event', 'configuration', 'package'];
const css = await readFile(new URL('../../runtime/web/style.css', import.meta.url), 'utf8');
const markup = await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8');
const colors = body => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(match => [match[1], match[2]]));
const base = colors(css.match(/\.drawing\s*\{([^}]+)\}/)[1]);
function palette(theme) {
  const overrides = css.match(new RegExp(`\\.drawing\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`))?.[1] || '';
  return { ...base, ...colors(overrides) };
}
function luminance(color) {
  return color.slice(1).match(/../g).map(hex => Number.parseInt(hex, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}
function contrast(a, b) {
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

test('eight distinct local palettes offer a readable fill for every role and every evidence label', () => {
  const signatures = new Set();
  for (const theme of themes) {
    const values = palette(theme);
    signatures.add(roles.map(role => values[`role-${role}`]).join(','));
    assert.ok(new Set(roles.map(role => values[`role-${role}`])).size >= 6);
    for (const role of roles) {
      const fill = values[`role-${role}`];
      assert.match(fill, /^#[\da-f]{6}$/i);
      for (const foreground of ['ink', 'muted', 'node-ink', 'amber', 'diagram-stale']) {
        const ratio = contrast(values[foreground], fill);
        assert.ok(ratio >= 4.5, `${theme}: ${foreground} text against ${role} is ${ratio.toFixed(2)}:1`);
      }
      assert.ok(contrast(values['diagram-focus'], fill) >= 3, `${theme}: focus against ${role}`);
    }
    for (const background of ['canvas', 'white', 'soft']) {
      for (const foreground of ['ink', 'muted']) assert.ok(contrast(values[foreground], values[background]) >= 4.5, `${theme}: toolbar/label ${foreground} on ${background}`);
    }
    for (const foreground of ['diagram-edge', 'diagram-stale', 'diagram-focus', 'amber']) {
      assert.ok(contrast(values[foreground], values.canvas) >= 3, `${theme}: ${foreground} remains visible on canvas`);
    }
  }
  assert.equal(signatures.size, 8, 'each selection changes the color combination');
});

test('theme controls are named and finite, with diagram-scoped dark mode and redundant evidence styles', () => {
  const select = markup.match(/<select id="theme"[\s\S]*?<\/select>/)[0];
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), themes);
  assert.match(markup, /<label for="theme">Theme/);
  assert.match(select, /aria-describedby="theme-note"/);
  assert.match(markup, /class="theme-preview" aria-hidden="true"/);
  for (const theme of ['blueprint', 'midnight']) {
    assert.match(css, new RegExp(`\\.drawing\\[data-theme="${theme}"\\]\\s*\\{\\s*color-scheme: dark;`));
  }
  assert.match(css, /\.diagram-node\[data-tone="proposed"\][^{]+\{[^}]*stroke-dasharray: 6 4/);
  assert.match(css, /\.diagram-node\[data-tone="stale"\][^{]+\{[^}]*stroke-dasharray: 2 5/);
  assert.match(markup, /Proposed \/ tentative/);
  assert.match(markup, /Stale \/ retracted/);
  assert.match(css, /\.drawing :is\(button, input, select, summary\):focus-visible/);
  assert.match(css, /--body: "Avenir Next", Avenir, "Segoe UI", sans-serif/);
});

test('the renderer keeps at most 512 recently used outlines and regenerates evicted identities deterministically', () => {
  let calls = 0;
  const cache = createSketchCache((shape, id) => {
    calls++;
    return [`${shape}:${id}:first`, `${shape}:${id}:second`, 'never painted'];
  });
  const first = cache.paths('rect', '0');
  assert.equal(first.length, 2);
  assert.ok(Object.isFrozen(first));
  for (let index = 1; index < 512; index++) cache.paths('rect', String(index));
  assert.equal(calls, 512);
  assert.equal(cache.paths('rect', '0'), first, 'a cache hit reuses the exact path list');
  cache.paths('rect', '512');
  assert.equal(cache.paths('rect', '0'), first, 'recently used entries survive eviction');
  cache.paths('rect', '1');
  assert.equal(calls, 514, 'the oldest entry was evicted at the bound');
  cache.paths('folder', '0');
  assert.equal(calls, 515, 'a visual shape override uses its own outline');
  cache.clear();
  assert.deepEqual(cache.paths('rect', '0'), first);
  assert.equal(calls, 516, 'teardown releases cached path strings');
});
