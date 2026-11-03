const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const FSRRecording = require('../analysis.js');

const root = path.resolve(__dirname, '..');

function recordingCsv(startMs, endMs) {
  const rows = ['session_elapsed_ms,F0_V,F1_V,F2_V,F3_V,F4_V,F5_V,F6_V,F7_V'];
  const voltages = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4];
  for (let time = startMs; time <= endMs; time += 10) {
    rows.push([time, ...voltages].map((value) => value.toFixed(2)).join(','));
  }
  return `${rows.join('\n')}\n`;
}

test('csv parser understands quoted fields, commas and line endings', () => {
  const rows = FSRRecording.parseCsv('session_elapsed_ms,F0_V,F1_V\r\n0,"1,2",3\r\n');
  assert.deepEqual(rows, [['session_elapsed_ms', 'F0_V', 'F1_V'], ['0', '1,2', '3']]);
});

test('sample csv falls back to the raw ADC value when the voltage is missing', () => {
  const segment = FSRRecording.sampleCsv('session_elapsed_ms,F0_V,F1_V,F2_V,F3_V,F4_V,F5_V,F6_V,F7_V,raw_fsr0_adc,raw_fsr1_adc,raw_fsr2_adc\n'
    + '0,,0.1,nan,0.2,0,0.3,0.4,0.5,4095,1023,2046\n');
  assert.equal(segment.timeKey, 'session_elapsed_ms');
  assert.equal(segment.samples.length, 1);
  assert.equal(segment.samples[0].t, 0);
  assert.equal(segment.samples[0].values[0], 3.3);
  assert.equal(segment.samples[0].values[1], 0.1);
  assert.ok(Math.abs(segment.samples[0].values[2] - 2046 / 4095 * 3.3) < 1e-9);
});

test('detected peaks use valley to valley windows and report channel extremes', () => {
  const samples = [];
  for (let index = 0; index < 1200; index += 1) {
    const time = index * 0.01;
    const values = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
    let voltage = 0.1;
    if (time > 2 && time < 2.35) voltage = 0.1 + ((time - 2) / 0.35) * 1.8;
    if (time > 5.5 && time < 6.1) voltage = 0.1 + ((time - 5.5) / 0.6) * 2.2;
    values[7] = voltage;
    samples.push({ t: time, values });
  }
  const peaks = FSRRecording.detectPeaks(samples, { prominenceRatio: 0.08 });
  assert.equal(peaks.length, 2);
  const first = peaks[0];
  assert.ok(first.t > 1.9 && first.t < 2.4);
  assert.ok(first.value > 1.8);
  assert.ok(first.min < 0.2);
  assert.equal(first.peakChannels.length, 1);
  assert.equal(first.peakChannels[0], 7);
  assert.equal(first.channels.length, FSRRecording.CHANNELS);
  const second = peaks[1];
  assert.ok(second.t > 5 && second.t < 6.2);
  assert.ok(second.max > 2);
});

test('downsampling keeps bucketed minima and maxima without exploding long series', () => {
  const samples = [];
  for (let index = 0; index < 5000; index += 1) {
    samples.push({ t: index * 0.01, values: [index * 0.001, index * 0.0001, null, 0.2, 0.2, 0.2, 0.2, 0.2] });
  }
  const series = FSRRecording.downsample(samples, 0, 100);
  assert.ok(series.length <= 200);
  assert.equal(series[0].value, 0);
});

test('loading a downloaded recording zip returns the segment samples and metadata', async () => {
  const archive = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'recording.zip'));
  const dataset = await FSRRecording.load(new Blob([archive]), 'recording.zip');
  assert.equal(dataset.fileName, 'recording.zip');
  assert.equal(dataset.segmentCount, 1);
  assert.equal(dataset.adcVoltage, 3.3);
  assert.equal(dataset.startedAt, '2026-11-02T16:36:55.744497+00:00');
  assert.equal(dataset.samples.length, 21);
});

test('the real recorded sample csv builds a dataset with peaks and channel ranges', () => {
  const realCsv = fs.readFileSync(path.join(root, 'data', 'test', 'segment_001', 'samples.csv'), 'utf8');
  const dataset = FSRRecording.buildDataset(
    [{ name: 'segment_001/samples.csv', text: realCsv }],
    { adcVoltage: 3.3, note: 'abc' },
  );
  assert.ok(dataset.samples.length > 0);
  assert.ok(dataset.duration > 0);
  assert.ok(Array.isArray(dataset.channels));
  assert.equal(dataset.channels.length, FSRRecording.CHANNELS);
  assert.ok(Array.isArray(dataset.peaks));
  assert.ok(dataset.peaks.length > 0);
  assert.ok(dataset.peaks[0].channels.every((channel) => Number.isFinite(channel.min) && Number.isFinite(channel.max)));
});

test('all three language files keep the same key set', () => {
  const names = ['en', 'zh-CN', 'zh-TW'];
  const maps = names.map((name) => JSON.parse(fs.readFileSync(path.join(root, 'public', 'loc', `${name}.json`), 'utf8')));
  const baseKeys = Object.keys(maps[0]).sort();
  for (const map of maps) {
    assert.deepEqual(Object.keys(map).sort(), baseKeys);
    for (const key of baseKeys) {
      assert.equal(typeof map[key], 'string', `Key ${key} is not a string in ${names[0]}`);
    }
  }
  assert.ok(baseKeys.includes('analysis_tab'));
});
