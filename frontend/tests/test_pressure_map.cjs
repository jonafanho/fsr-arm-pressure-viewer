const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function page() {
  const nodes = {};
  for (const [, id] of fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) {
    const classes = new Set();
    nodes[id] = { style: {}, attributes: {}, listeners: {}, hidden: false,
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.listeners[name] = callback; }, focus() {} };
  }
  const storage = new Map();
  const context = vm.createContext({ document: { getElementById: id => nodes[id], querySelectorAll: () => [], querySelector: () => null, documentElement: {} },
    console, Date, AbortSignal, setTimeout() {}, setInterval() {}, Event: class {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  const source = fs.readFileSync(path.join(root, 'duo.js'), 'utf8').replace('void tick();',
    'globalThis.testMap = { model: FSRPressureMap, renderPressure, render, showView };');
  vm.runInContext(source, context);
  return { ...context.testMap, nodes };
}

function device(values = [.1, .2, .3, .4, .5, .6, .7, .8], extra = {}) {
  const latest = { pc_epoch_ms: Date.now(), fsr_only: true };
  for (let index = 0; index < 8; index += 1) latest[`F${index}_V`] = values[index];
  return { active: true, source: 'usb', input_rate_hz: 100, latest,
    recording: false, path: '', recorded: 0, missing: 0, error: '', ...extra };
}

test('the map uses all eight channels in physical order', () => {
  const { model } = page();
  const result = model.reading(device(), Date.now());
  assert.deepEqual(Array.from(result.values), [.1, .2, .3, .4, .5, .6, .7, .8]);
  assert.deepEqual(Array.from(result.peaks), [7]);
});

test('zero voltage remains valid; missing and out-of-range voltages remain unavailable', () => {
  const { model } = page();
  const result = model.reading(device([0, null, -1, 3.4, .5, .6, .7, .8]), Date.now());
  assert.equal(result.valid, 5);
  assert.equal(result.values[0], 0);
  assert.equal(result.values[1], null);
  assert.equal(result.values[2], null);
  assert.equal(result.values[3], null);
  assert.ok(model.color(0, 3.3));
  assert.equal(model.color(null, 3.3), null);
});

test('stale and disconnected sensors cannot leave a live-looking heat map', () => {
  const { model, renderPressure, nodes } = page();
  const d = device();
  assert.equal(model.reading(d, d.latest.pc_epoch_ms + 1501).state, 'stale');
  renderPressure({ device: d }, d.latest.pc_epoch_ms + 1600);
  for (let channel = 0; channel < 8; channel += 1) {
    assert.equal(nodes[`voltage${channel}`].textContent, '—');
    assert.equal(nodes[`pressure${channel}`].style.backgroundColor, '');
  }
  assert.match(nodes.pressureState.textContent, /Data stale/);
  renderPressure({ device: { ...d, active: false } });
  assert.match(nodes.pressureState.textContent, /Disconnected/);
});

test('all eight pads share one fixed colour scale and report the peak', () => {
  const { renderPressure, nodes } = page();
  renderPressure({ device: device([.1, .5, .2, .3, .4, .5, .7, 1.2]) });
  assert.equal(nodes.voltage1.textContent, '0.500');
  assert.equal(nodes.voltage7.textContent, '1.200');
  assert.equal(nodes.pressure1.style.backgroundColor, nodes.pressure5.style.backgroundColor);
  assert.match(nodes.pressurePeak.textContent, /^F7 · 1.200 V$/);
  assert.match(nodes.pressureDetail.textContent, /8\/8/);
});

test('lowering the colour limit clips only the colour, never the actual voltage', () => {
  const { render, nodes, model } = page();
  render({ device: device([2.5, .2, .3, .4, .5, .6, .7, .8]), elapsed_ms: 0, path: 'data', recording: false });
  nodes.pressureRange.value = '0.5';
  nodes.pressureRange.listeners.change();
  assert.equal(nodes.voltage0.textContent, '2.500');
  assert.equal(nodes.pressure0.style.backgroundColor, model.color(.5, .5).background);
  assert.ok(nodes.pressure0.classList.contains('over-range'));
  assert.match(nodes.pressureNotice.textContent, /Above color maximum/);
});

test('service failure clears the map and demo mode is explicitly labelled', () => {
  const { renderPressure, nodes } = page();
  renderPressure({ device: device(undefined, { source: 'demo' }) });
  assert.match(nodes.pressureState.textContent, /Simulated data/);
  renderPressure(null);
  assert.equal(nodes.voltage0.textContent, '—');
  assert.equal(nodes.voltage7.textContent, '—');
  assert.match(nodes.pressureNotice.textContent, /Local service unavailable/);
});

test('view switching preserves access to the monitor and recording controls', () => {
  const { showView, nodes } = page();
  assert.equal(nodes.pressureView.hidden, false);
  assert.equal(nodes.monitorView.hidden, true);
  showView('monitor');
  assert.equal(nodes.pressureView.hidden, true);
  assert.equal(nodes.monitorView.hidden, false);
  assert.equal(nodes.monitorTab.attributes['aria-selected'], 'true');
  assert.equal(nodes.pressureTab.tabIndex, -1);
  assert.ok(nodes.record.listeners.click);
});

test('recorded data view is reachable and keeps the session controls usable', () => {
  const { showView, nodes } = page();
  showView('analysis');
  assert.equal(nodes.pressureView.hidden, true);
  assert.equal(nodes.monitorView.hidden, true);
  assert.equal(nodes.analysisView.hidden, false);
  assert.equal(nodes.analysisTab.attributes['aria-selected'], 'true');
  assert.equal(nodes.analysisTab.tabIndex, 0);
  assert.equal(nodes.analysisView.hidden, false);
  assert.ok(nodes.analysisChoose.listeners.click);
  assert.ok(nodes.analysisFile.listeners.change);
  assert.ok(nodes.analysisDrop.listeners.drop);
});
