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

test('Tidy sketch uses CSS ink weights and preserves tone, selection and focus for both shafts and solid open heads', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
    selectors: match[1].trim().split(',').map(selector => selector.trim()),
    properties: Object.fromEntries(match[2].split(';').filter(part => part.includes(':')).map(part => {
      const colon = part.indexOf(':');
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
    })),
  }));
  const style = selector => Object.assign({}, ...rules.filter(rule => rule.selectors.includes(selector)).map(rule => rule.properties));
  const ruleIndex = selector => rules.findIndex(rule => rule.selectors.includes(selector));
  assert.equal(style('.node-shape').stroke, 'none', 'canonical fills do not add a straight underlying edge');
  assert.equal(style('.node-shape').fill, 'var(--node-fill, var(--role-module))');
  assert.equal(style('.sketch-primary')['stroke-width'], '1.9');
  assert.equal(style('.sketch-secondary')['stroke-width'], '1.2');
  assert.equal(style('.sketch-secondary')['stroke-opacity'], '.46');
  assert.ok(Number(style('.node-sketch-details .sketch-primary')['stroke-width']) < 1.9, 'detail seams use gentler ink around labels');
  assert.equal(style('.diagram-edge')['--edge-ink'], 'var(--diagram-edge)');
  assert.equal(style('.diagram-edge')['--edge-primary-width'], '1.9');
  assert.equal(style('.diagram-edge')['--edge-secondary-width'], '1.2');
  for (const selector of ['.edge-line', '.edge-line-secondary', '.edge-head']) {
    const ink = style(selector);
    assert.equal(ink.stroke, 'var(--edge-ink)', `${selector} inherits status and focus color`);
    assert.equal(ink.fill, 'none');
    assert.equal(ink['stroke-linecap'], 'round');
    assert.equal(ink['stroke-linejoin'], 'round');
    assert.equal(ink['pointer-events'], 'none');
  }
  for (const selector of ['.edge-line-secondary', '.edge-head-secondary']) {
    assert.equal(style(selector)['stroke-opacity'], '.46');
    assert.equal(style(selector)['stroke-width'], 'var(--edge-secondary-width)');
  }
  for (const [tone, color, dash] of [['proposed', 'var(--amber)', '6 4'], ['stale', 'var(--diagram-stale)', '2 5']]) {
    const edge = `.diagram-edge[data-tone="${tone}"]`;
    assert.equal(style(edge)['--edge-ink'], color);
    assert.equal(style(edge)['stroke-dasharray'], undefined, 'dashes are not inherited by heads');
    for (const shaft of ['.edge-line', '.edge-line-secondary']) {
      assert.equal(style(`${edge} ${shaft}`)['stroke-dasharray'], dash);
    }
    const node = `.diagram-node[data-tone="${tone}"] .node-sketch`;
    assert.equal(style(node).stroke, color, 'outlines and details share the evidence tone');
    assert.equal(style(node)['stroke-dasharray'], dash);
    assert.equal(style(`.diagram-node[data-tone="${tone}"] .node-shape`).stroke, undefined, 'status cannot restore a straight outline');
    for (const focused of ['.diagram-edge[data-selected="true"]', '.diagram-edge.is-focused']) {
      assert.equal(style(focused)['--edge-ink'], 'var(--diagram-focus)');
      assert.equal(style(focused)['--edge-primary-width'], '3.5');
      assert.equal(style(focused)['--edge-secondary-width'], '2.2');
      assert.ok(ruleIndex(focused) > ruleIndex(edge), 'focus and selection override status colors for every ink pass');
    }
  }
  assert.equal(style('.edge-head')['stroke-dasharray'], 'none', 'arrowheads stay visible on dashed relationships');
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
