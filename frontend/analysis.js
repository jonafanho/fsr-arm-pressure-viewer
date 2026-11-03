// Read FSR recording ZIP exports and find pressure peaks in the browser.
//
// A downloaded ZIP contains one or more segment folders with samples.csv plus
// metadata JSON files.  Only the small CSV/JSON entries are decompressed; the
// large binary stream is ignored.
const FSRRecording = (() => {
  "use strict";

  const CHANNELS = 8;
  const ADC_MAX = 4095;
  const DEFAULT_ADC_VOLTAGE = 3.3;

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (character === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            quoted = false;
          }
        } else {
          field += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        row.push(field);
        field = "";
      } else if (character === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (character !== "\r") {
        field += character;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function numberOrNull(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function headerOf(rows) {
    if (!rows.length) return [];
    return rows[0].map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim());
  }

  function hasNumericColumn(rows, index) {
    if (index < 0) return false;
    for (let row = 1; row < rows.length; row += 1) {
      if (numberOrNull(rows[row]?.[index]) !== null) return true;
    }
    return false;
  }

  function sampleCsv(text, adcVoltage = DEFAULT_ADC_VOLTAGE) {
    const rows = parseCsv(text);
    const header = headerOf(rows);
    if (!header.length) return { samples: [], timeKey: null };

    const timeNames = ["session_elapsed_ms", "pc_elapsed_ms", "device_elapsed_ms", "pc_epoch_ms"];
    const timeIndex = timeNames
      .map((name) => ({ name, index: header.indexOf(name) }))
      .find((item) => hasNumericColumn(rows, item.index)) || { name: null, index: -1 };

    const valueIndexes = [];
    const adcIndexes = [];
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      valueIndexes.push(header.indexOf(`F${channel}_V`));
      adcIndexes.push(header.indexOf(`raw_fsr${channel}_adc`));
    }

    const samples = [];
    let previousTime = null;
    let fallbackStep = 10; // milliseconds; the firmware nominally streams at 100 Hz
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (!row.length || (row.length === 1 && !row[0].trim())) continue;
      let time = timeIndex.index >= 0 ? numberOrNull(row[timeIndex.index]) : null;
      if (time === null) {
        time = previousTime === null ? rowIndex * fallbackStep : previousTime + fallbackStep;
      } else if (previousTime !== null && time > previousTime) {
        fallbackStep = Math.max(1, time - previousTime);
      }
      previousTime = time;

      const values = [];
      let anyValue = false;
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        let value = numberOrNull(row[valueIndexes[channel]]);
        if (value === null) {
          const adc = numberOrNull(row[adcIndexes[channel]]);
          if (adc !== null) value = Math.max(0, Math.min(ADC_MAX, adc)) / ADC_MAX * adcVoltage;
        }
        values.push(value);
        if (value !== null) anyValue = true;
      }
      if (anyValue) samples.push({ t: time / 1000, values });
    }
    return { samples, timeKey: timeIndex.name };
  }

  function channelSummary(samples) {
    return Array.from({ length: CHANNELS }, (_, channel) => {
      let minimum = null;
      let maximum = null;
      let sum = 0;
      let count = 0;
      let maximumTime = null;
      for (const sample of samples) {
        const value = sample.values[channel];
        if (value === null) continue;
        if (minimum === null || value < minimum) minimum = value;
        if (maximum === null || value > maximum) {
          maximum = value;
          maximumTime = sample.t;
        }
        sum += value;
        count += 1;
      }
      return {
        channel,
        min: minimum,
        max: maximum,
        mean: count ? sum / count : null,
        maxTime: maximumTime,
        count,
      };
    });
  }

  function aggregateSignal(samples) {
    const signal = new Float64Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      let value = null;
      for (const candidate of samples[index].values) {
        if (candidate !== null && (value === null || candidate > value)) value = candidate;
      }
      signal[index] = value === null ? NaN : value;
    }
    return signal;
  }

  function smoothSignal(signal, halfWindow) {
    if (halfWindow < 1) return signal;
    const smoothed = new Float64Array(signal.length).fill(NaN);
    for (let index = 0; index < signal.length; index += 1) {
      let sum = 0;
      let count = 0;
      const start = Math.max(0, index - halfWindow);
      const end = Math.min(signal.length - 1, index + halfWindow);
      for (let cursor = start; cursor <= end; cursor += 1) {
        if (Number.isFinite(signal[cursor])) {
          sum += signal[cursor];
          count += 1;
        }
      }
      if (count) smoothed[index] = sum / count;
    }
    return smoothed;
  }

  function indexOfMinimum(signal, from, to) {
    let best = from;
    for (let index = from; index <= to; index += 1) {
      if (!Number.isFinite(signal[index])) continue;
      if (!Number.isFinite(signal[best]) || signal[index] < signal[best]) best = index;
    }
    return best;
  }

  function indexOfMaximum(signal, from, to) {
    let best = from;
    for (let index = from; index <= to; index += 1) {
      if (!Number.isFinite(signal[index])) continue;
      if (!Number.isFinite(signal[best]) || signal[index] > signal[best]) best = index;
    }
    return best;
  }

  function detectPeaks(samples, options = {}) {
    if (samples.length < 3) return [];
    const signal = aggregateSignal(samples);
    const times = samples.map((sample) => sample.t);
    const differences = [];
    for (let index = 1; index < times.length; index += 1) {
      const difference = times[index] - times[index - 1];
      if (difference > 1e-6) differences.push(difference);
    }
    const step = differences.length ? median(differences) : 0.01;
    const halfWindow = Math.max(0, Math.min(200, Math.round(0.1 / Math.max(step, 1e-4))));
    const smoothed = smoothSignal(signal, halfWindow);

    let finiteMinimum = Infinity;
    let finiteMaximum = -Infinity;
    for (const value of signal) {
      if (!Number.isFinite(value)) continue;
      if (value < finiteMinimum) finiteMinimum = value;
      if (value > finiteMaximum) finiteMaximum = value;
    }
    if (!Number.isFinite(finiteMinimum) || finiteMaximum - finiteMinimum < 1e-6) return [];

    const ratio = Math.max(0.01, Math.min(0.5, Number(options.prominenceRatio) || 0.08));
    const minimumProminence = Math.max(0.005, (finiteMaximum - finiteMinimum) * ratio);
    const threshold = finiteMinimum + minimumProminence;
    const separation = Math.max(0.15, Number(options.minSeparationS) || 0.35);
    const maxPeaks = Math.max(1, Math.min(200, Number(options.maxPeaks) || 40));
    const walk = Math.max(10, Math.min(signal.length, Math.round(3 / Math.max(step, 1e-4))));

    const candidates = [];
    for (let index = 0; index < smoothed.length; index += 1) {
      const value = smoothed[index];
      if (!Number.isFinite(value) || value < threshold) continue;
      const left = index > 0 ? smoothed[index - 1] : null;
      const right = index < smoothed.length - 1 ? smoothed[index + 1] : null;
      if (left !== null && Number.isFinite(left) && value < left) continue;
      if (right !== null && Number.isFinite(right) && value <= right) continue;

      let leftMinimum = value;
      for (let cursor = index - 1; cursor >= Math.max(0, index - walk); cursor -= 1) {
        const candidate = smoothed[cursor];
        if (!Number.isFinite(candidate)) continue;
        if (candidate > value) break;
        if (candidate < leftMinimum) leftMinimum = candidate;
      }
      let rightMinimum = value;
      for (let cursor = index + 1; cursor <= Math.min(smoothed.length - 1, index + walk); cursor += 1) {
        const candidate = smoothed[cursor];
        if (!Number.isFinite(candidate)) continue;
        if (candidate > value) break;
        if (candidate < rightMinimum) rightMinimum = candidate;
      }
      const prominence = value - Math.max(leftMinimum, rightMinimum);
      if (prominence >= minimumProminence) candidates.push({ index, time: times[index], prominence });
    }

    candidates.sort((left, right) => right.prominence - left.prominence);
    const accepted = [];
    for (const candidate of candidates) {
      if (accepted.some((peak) => Math.abs(peak.time - candidate.time) < separation)) continue;
      accepted.push(candidate);
      if (accepted.length >= maxPeaks) break;
    }
    accepted.sort((left, right) => left.time - right.time);
    if (!accepted.length) return [];

    const peaks = [];
    for (let number = 0; number < accepted.length; number += 1) {
      const candidate = accepted[number];
      const previousPeak = number > 0 ? accepted[number - 1].index : null;
      const nextPeak = number < accepted.length - 1 ? accepted[number + 1].index : null;
      const leftLimit = previousPeak === null ? Math.max(0, candidate.index - walk) : previousPeak;
      const rightLimit = nextPeak === null ? Math.min(signal.length - 1, candidate.index + walk) : nextPeak;
      const start = indexOfMinimum(signal, leftLimit, candidate.index);
      const end = indexOfMinimum(signal, candidate.index, rightLimit);

      let peakIndex = indexOfMaximum(signal, Math.min(start, end), Math.max(start, end));
      if (!Number.isFinite(signal[peakIndex])) continue;
      const value = signal[peakIndex];
      const channels = Array.from({ length: CHANNELS }, (_, channel) => {
        let minimum = null;
        let maximum = null;
        for (let index = start; index <= end; index += 1) {
          const sample = samples[index]?.values[channel];
          if (sample === null || sample === undefined) continue;
          if (minimum === null || sample < minimum) minimum = sample;
          if (maximum === null || sample > maximum) maximum = sample;
        }
        return { channel, min: minimum, max: maximum, atPeak: samples[peakIndex].values[channel] };
      });
      let minimum = null;
      let maximum = null;
      for (let index = start; index <= end; index += 1) {
        const sample = signal[index];
        if (!Number.isFinite(sample)) continue;
        if (minimum === null || sample < minimum) minimum = sample;
        if (maximum === null || sample > maximum) maximum = sample;
      }
      const peakChannels = samples[peakIndex].values
        .map((sample, channel) => sample !== null && Math.abs(sample - value) < 1e-9 ? channel : null)
        .filter((channel) => channel !== null);
      peaks.push({
        index: peakIndex,
        t: times[peakIndex],
        value,
        peakChannels,
        startT: times[start],
        endT: times[end],
        duration: Math.max(0, times[end] - times[start]),
        min: minimum,
        max: maximum,
        channels,
      });
    }
    return peaks;
  }

  function downsample(samples, channel, maxPoints) {
    const limit = Math.max(16, Number(maxPoints) || 1000);
    if (samples.length <= limit * 2) {
      return samples.map((sample, index) => ({ t: sample.t, value: sample.values[channel], index }));
    }
    const start = samples[0].t;
    const end = samples[samples.length - 1].t;
    const span = Math.max(1e-9, end - start);
    const buckets = new Map();
    for (let index = 0; index < samples.length; index += 1) {
      const bucket = Math.min(limit - 1, Math.floor((samples[index].t - start) / span * limit));
      let entry = buckets.get(bucket);
      if (!entry) {
        entry = { first: index, last: index, minimum: -1, maximum: -1 };
        buckets.set(bucket, entry);
      }
      entry.last = index;
      const value = samples[index].values[channel];
      if (value === null) continue;
      if (entry.minimum < 0 || value < samples[entry.minimum].values[channel]) entry.minimum = index;
      if (entry.maximum < 0 || value > samples[entry.maximum].values[channel]) entry.maximum = index;
    }
    const indices = [];
    for (const bucket of [...buckets.keys()].sort((left, right) => left - right)) {
      const entry = buckets.get(bucket);
      const chosen = [entry.first, entry.minimum, entry.maximum, entry.last]
        .filter((index) => index >= 0);
      chosen.sort((left, right) => left - right);
      for (const index of chosen) {
        if (indices[indices.length - 1] !== index) indices.push(index);
      }
    }
    return indices.map((index) => ({ t: samples[index].t, value: samples[index].values[channel], index }));
  }

  function buildDataset(files, metadata = {}) {
    const adcVoltage = Number(metadata.adcVoltage) > 0 ? Number(metadata.adcVoltage) : DEFAULT_ADC_VOLTAGE;
    const segments = [];
    for (const file of files) {
      const segment = sampleCsv(file.text, adcVoltage);
      if (segment.samples.length) segments.push(segment);
    }
    if (!segments.length) throw new Error("No readable FSR samples were found in this recording.");

    const samples = [];
    let lastTime = -Infinity;
    let nominalStep = 0.01;
    for (const segment of segments) {
      const first = segment.samples[0].t;
      const differences = [];
      for (let index = 1; index < segment.samples.length; index += 1) {
        const difference = segment.samples[index].t - segment.samples[index - 1].t;
        if (difference > 1e-6) differences.push(difference);
      }
      if (differences.length) nominalStep = median(differences);
      let offset = 0;
      if (Number.isFinite(lastTime) && first <= lastTime + 1e-9) {
        offset = lastTime + nominalStep - first;
      }
      for (const sample of segment.samples) samples.push({ t: sample.t + offset, values: sample.values });
      if (segment.samples.length) lastTime = samples[samples.length - 1].t;
    }
    samples.sort((left, right) => left.t - right.t);
    const firstTime = samples[0].t;
    for (const sample of samples) sample.t -= firstTime;
    const duration = samples.length ? samples[samples.length - 1].t : 0;
    const differences = [];
    for (let index = 1; index < samples.length; index += 1) {
      const difference = samples[index].t - samples[index - 1].t;
      if (difference > 1e-6) differences.push(difference);
    }
    return {
      samples,
      duration,
      sampleRate: differences.length ? 1 / median(differences) : 0,
      segmentCount: segments.length,
      channels: channelSummary(samples),
      peaks: detectPeaks(samples),
      adcVoltage,
      note: typeof metadata.note === "string" ? metadata.note : "",
      startedAt: typeof metadata.startedAt === "string" ? metadata.startedAt : "",
    };
  }

  async function readZip(blob) {
    if (!blob || typeof blob.slice !== "function") throw new Error("This file cannot be read.");
    const tailLength = Math.min(blob.size, 65557);
    const tail = new DataView(await blob.slice(blob.size - tailLength).arrayBuffer());
    let eocd = -1;
    for (let index = tailLength - 22; index >= 0; index -= 1) {
      if (tail.getUint32(index, true) === 0x06054b50) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) throw new Error("This is not a valid ZIP file.");
    const count = tail.getUint16(eocd + 10, true);
    const directorySize = tail.getUint32(eocd + 12, true);
    const directoryOffset = tail.getUint32(eocd + 16, true);
    if (directoryOffset + directorySize > blob.size) throw new Error("The ZIP directory is corrupt.");

    const directory = new DataView(await blob.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
    const entries = new Map();
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
      if (directory.getUint32(offset, true) !== 0x02014b50) throw new Error("The ZIP directory is corrupt.");
      const flags = directory.getUint16(offset + 8, true);
      const method = directory.getUint16(offset + 10, true);
      const compressedSize = directory.getUint32(offset + 20, true);
      const uncompressedSize = directory.getUint32(offset + 24, true);
      const nameLength = directory.getUint16(offset + 28, true);
      const extraLength = directory.getUint16(offset + 30, true);
      const commentLength = directory.getUint16(offset + 32, true);
      const localOffset = directory.getUint32(offset + 42, true);
      const nameBytes = new Uint8Array(directory.buffer, directory.byteOffset + offset + 46, nameLength);
      const name = new TextDecoder("utf-8").decode(nameBytes).replaceAll("\\", "/");
      entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }

    return {
      entries,
      async read(name) {
        const entry = entries.get(name);
        if (!entry) return null;
        if (entry.flags & 1) throw new Error("Encrypted ZIP files are not supported.");
        const header = new DataView(await blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
        if (header.getUint32(0, true) !== 0x04034b50) throw new Error("The ZIP entry header is corrupt.");
        const nameLength = header.getUint16(26, true);
        const extraLength = header.getUint16(28, true);
        const start = entry.localOffset + 30 + nameLength + extraLength;
        const compressed = await blob.slice(start, start + entry.compressedSize).arrayBuffer();
        if (entry.method === 0) return compressed;
        if (entry.method !== 8) throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
        if (typeof DecompressionStream !== "function") throw new Error("This browser cannot decompress ZIP files.");
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Response(stream).arrayBuffer();
      },
    };
  }

  async function readJson(zip, name) {
    if (!name) return null;
    const bytes = await zip.read(name);
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(bytes)));
    } catch {
      return null;
    }
  }

  function basename(name) {
    return name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  }

  async function load(blob, name = "recording") {
    if (String(name).toLowerCase().endsWith(".csv")) {
      const dataset = buildDataset([{ name, text: await blob.text() }]);
      dataset.fileName = name;
      return dataset;
    }

    const zip = await readZip(blob);
    const names = [...zip.entries.keys()];
    const sampleNames = names.filter((entry) => basename(entry) === "samples.csv").sort();
    if (!sampleNames.length) throw new Error("No samples.csv was found inside this ZIP.");
    const sessionName = names.find((entry) => basename(entry) === "session.json");
    const metadataName = names.find((entry) => basename(entry) === "metadata.json");
    const session = await readJson(zip, sessionName);
    const metadata = await readJson(zip, metadataName);
    const files = [];
    for (const sampleName of sampleNames) {
      const bytes = await zip.read(sampleName);
      if (bytes) files.push({ name: sampleName, text: new TextDecoder("utf-8").decode(new Uint8Array(bytes)) });
    }
    const dataset = buildDataset(files, {
      adcVoltage: metadata?.adc_voltage_v,
      note: session?.note || metadata?.note || "",
      startedAt: session?.started_at_utc || metadata?.started_at_utc || "",
    });
    dataset.fileName = name;
    return dataset;
  }

  return {
    CHANNELS,
    parseCsv,
    detectPeaks,
    downsample,
    buildDataset,
    sampleCsv,
    channelSummary,
    load,
    readZip,
  };
})();

if (typeof module !== "undefined") module.exports = FSRRecording;
