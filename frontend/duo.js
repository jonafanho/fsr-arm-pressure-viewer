// One voltage per physical FSR pad. No interpolation into unmeasured areas.
const FSRPressureMap = (() => {
  "use strict";
  const channels = [0, 1, 2, 3, 4, 5, 6, 7];
  const ranges = [0.1, 0.5, 1, 2, 3.3];
  const colors = [[232, 242, 251], [112, 205, 224], [247, 218, 111], [241, 139, 74], [190, 44, 54]];
  function color(voltage, maximum) {
    if (!Number.isFinite(voltage) || voltage < 0) return null;
    const scaled = Math.max(0, Math.min(1, voltage / maximum)) * (colors.length - 1);
    const index = Math.min(colors.length - 2, Math.floor(scaled));
    const fraction = scaled - index;
    const rgb = colors[index].map((value, axis) => Math.round(value + fraction * (colors[index + 1][axis] - value)));
    const linear = rgb.map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
    return { background: `rgb(${rgb.join(', ')})`, foreground: luminance < .3 ? '#ffffff' : '#162c3c' };
  }
  function reading(device, now) {
    let state = 'live';
    if (!device) state = 'service';
    else if (!device.active) state = 'disconnected';
    else if (!device.latest) state = 'waiting';
    else if (!Number.isFinite(device.latest.pc_epoch_ms) || now - device.latest.pc_epoch_ms > 1500 || now - device.latest.pc_epoch_ms < -1000) state = 'stale';
    const values = channels.map(channel => {
      const value = state === 'live' ? device.latest[`F${channel}_V`] : null;
      return Number.isFinite(value) && value >= 0 && value <= 3.3 + 1e-6 ? value : null;
    });
    const valid = values.filter(value => value !== null);
    const peak = valid.length ? Math.max(...valid) : null;
    const peaks = peak === null ? [] : channels.filter((_, index) => values[index] === peak);
    return { state, values, valid: valid.length, peak, peaks, demo: device?.source === 'demo' };
  }
  return { channels, ranges, color, reading };
})();

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let busy = false, snapshot = null, notice = '', noticeUntil = 0;
  let pressureRange = 3.3, activeView = 'pressure';
  const pressureEnabled = Boolean($('pressureView'));
  const analysisEnabled = Boolean($('analysisView'));
  const VIEWS = ['pressure', 'monitor', 'analysis'];
  const ANALYSIS_SENSITIVITIES = [0.04, 0.08, 0.18];
  const ANALYSIS_COLORS = ['#c34f5f', '#0b7f8c', '#d89a25', '#4d8f6f', '#7d5aa5', '#2d7fb0', '#bd6a32', '#596b63'];
  let analysisSensitivity = 0.08;
  let analysisDataset = null;
  let analysisPeaks = [];
  let analysisChart = null;
  let analysisHoverPeak = null;
  let analysisHoverIndex = null;
  let analysisLoading = false;
  let analysisStatusKind = '';
  let analysisDrawPending = false;
  const LANGUAGES = ['en', 'zh-CN', 'zh-TW'];
  let translations = {};
  let currentLanguage = 'en';

  function t(key, fallback, vars) {
    let value = Object.prototype.hasOwnProperty.call(translations, key) ? translations[key] : fallback ?? key;
    if (vars) for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  }

  function applyTranslations() {
    document.documentElement.lang = currentLanguage;
    document.querySelectorAll('[data-i18n]').forEach(elem => {
      const value = translations[elem.dataset.i18n];
      if (typeof value === 'string') elem.textContent = value;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(elem => {
      const value = translations[elem.dataset.i18nPlaceholder];
      if (typeof value === 'string') elem.placeholder = value;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(elem => {
      const value = translations[elem.dataset.i18nTitle];
      if (typeof value === 'string') elem.title = value;
    });
  }

  function syncLanguageToFrame() {
    const frame = document.querySelector?.('#monitorView iframe');
    try { frame?.contentWindow?.postMessage({ type: 'fsr-language', lang: currentLanguage }, location.origin); } catch {}
  }

  async function loadLanguage(lang) {
    if (!LANGUAGES.includes(lang)) lang = 'en';
    try {
      const response = await fetch(`public/loc/${lang}.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      translations = await response.json();
      currentLanguage = lang;
      applyTranslations();
      const select = document.getElementById('languageSelect');
      if (select) select.value = lang;
      syncLanguageToFrame();
      if (snapshot) render(snapshot);
      renderPressure(snapshot);
      renderAnalysis();
      void listRecordings();
    } catch (error) {
      console.error(`Unable to load language "${lang}":`, error);
    }
  }

  function showView(view) {
    activeView = VIEWS.includes(view) && $(`${view}View`) ? view : 'pressure';
    for (const name of VIEWS) {
      const panel = $(`${name}View`), tab = $(`${name}Tab`);
      if (!panel || !tab) continue;
      const selected = name === activeView;
      panel.hidden = !selected;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    if (activeView === 'monitor') {
      for (const frame of document.querySelectorAll('#monitorView iframe')) {
        frame.contentWindow?.dispatchEvent(new Event('resize'));
      }
    }
    if (activeView === 'analysis') scheduleAnalysisDraw();
    try { localStorage.setItem('rigidity.fsr.view', activeView); } catch {}
  }

  function renderPressure(status, now = Date.now()) {
    if (!pressureEnabled) return;
    $('pressureMid').textContent = `${(pressureRange / 2).toFixed(2)} V`;
    $('pressureMax').textContent = `${pressureRange.toFixed(2)} V`;
    const notices = [];
    const device = status?.device;
    const sample = FSRPressureMap.reading(device, now);
    const labels = {
      service: t('state_service', 'Local service unavailable'),
      disconnected: t('state_disconnected', 'Disconnected'),
      waiting: t('state_waiting', 'Waiting for samples'),
      stale: t('state_stale', 'Data stale'),
      live: sample.demo ? t('state_demo', 'Simulated data · not measured') : t('state_live', 'Live data'),
    };
    const label = sample.state === 'live' && sample.valid < FSRPressureMap.channels.length
      ? t('state_valid', '{valid}/{total} valid', { valid: sample.valid, total: FSRPressureMap.channels.length })
      : labels[sample.state];
    $('pressureState').textContent = label;
    $('pressureState').className = `pressure-connection ${sample.state === 'live' && sample.valid === FSRPressureMap.channels.length && !sample.demo ? 'good' : 'warning'}`;
    for (const [index, channel] of FSRPressureMap.channels.entries()) {
      const tile = $(`pressure${channel}`), voltage = sample.values[index];
      const paint = FSRPressureMap.color(voltage, pressureRange);
      tile.classList.toggle('unavailable', paint === null);
      tile.classList.toggle('over-range', voltage !== null && voltage > pressureRange);
      tile.style.backgroundColor = paint?.background || '';
      tile.style.color = paint?.foreground || '';
      $(`voltage${channel}`).textContent = voltage === null ? '—' : voltage.toFixed(3);
      const description = voltage === null
        ? t('no_live_reading', 'No live reading')
        : `${voltage.toFixed(3)} V${voltage > pressureRange ? ` · ${t('over_scale_short', 'above color scale maximum')}` : ''}`;
      tile.setAttribute('aria-label', `F${channel}: ${description}`);
      tile.title = `F${channel} · ${description}`;
    }
    $('pressurePeak').textContent = sample.peak === null ? '—' : `${sample.peaks.map(channel => `F${channel}`).join(' / ')} · ${sample.peak.toFixed(3)} V`;
    $('pressureDetail').textContent = sample.state !== 'live'
      ? t('pressure_detail_paused', '{label} · coloring paused', { label })
      : t('pressure_detail_live', '{valid}/{total} pads have valid readings · {source}', {
        valid: sample.valid, total: FSRPressureMap.channels.length,
        source: sample.demo ? t('source_demo_voltage', 'Simulated voltage') : t('source_usb_voltage', 'USB measured voltage'),
      });
    if (sample.state !== 'live') notices.push(label);
    else if (sample.valid < FSRPressureMap.channels.length) notices.push(t('notice_partial', 'Some channels have no valid reading'));
    if (sample.demo) notices.push(t('notice_demo', 'Using simulated data'));
    if (sample.values.some(value => value !== null && value > pressureRange)) notices.push(t('notice_over_scale', 'Above color maximum; showing the warmest color. Raise the scale to see detail.'));
    $('pressureNotice').textContent = notices.join(t('notice_separator', '; ')) || t('pressure_notice_default', 'Tap each pad in turn to verify the lit position. If voltage changes are small, lower the color scale maximum.');
    $('pressureNotice').className = `pressure-notice${notices.length ? ' warning' : ''}`;
  }

  function setupPressure() {
    if (!pressureEnabled) return;
    try {
      const savedRange = Number(localStorage.getItem('rigidity.fsr.pressureRange'));
      if (FSRPressureMap.ranges.includes(savedRange)) pressureRange = savedRange;
      const savedView = localStorage.getItem('rigidity.fsr.view');
      if (VIEWS.includes(savedView) && $(`${savedView}View`)) activeView = savedView;
    } catch {}
    $('pressureRange').value = String(pressureRange);
    $('pressureRange').addEventListener('change', () => {
      const value = Number($('pressureRange').value);
      if (!FSRPressureMap.ranges.includes(value)) return;
      pressureRange = value;
      try { localStorage.setItem('rigidity.fsr.pressureRange', String(value)); } catch {}
      renderPressure(snapshot);
    });
    const views = VIEWS.filter(name => $(`${name}Tab`) && $(`${name}View`));
    for (const name of views) {
      $(`${name}Tab`).addEventListener('click', () => showView(name));
      $(`${name}Tab`).addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = views.indexOf(name);
        const next = event.key === 'Home' ? views[0]
          : event.key === 'End' ? views[views.length - 1]
          : views[(index + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length];
        showView(next);
        $(`${next}Tab`).focus();
      });
    }
    showView(activeView);
    renderPressure(null);
    // Clear stale colours even while a stalled HTTP request is awaiting timeout.
    setInterval(() => renderPressure(snapshot), 500);
  }

  function createAnalysisNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatSeconds(value) {
    if (!Number.isFinite(value)) return '—';
    if (value < 60) return `${value.toFixed(1)} s`;
    const total = Math.max(0, Math.round(value));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const seconds = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function formatAxisTime(value) {
    if (!Number.isFinite(value)) return '';
    if (value >= 3600) return `${Math.floor(value / 3600)}h`;
    if (value >= 60) {
      const minutes = Math.floor(value / 60);
      const seconds = Math.floor(value) % 60;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)}s`;
  }

  function formatVoltage(value) {
    return Number.isFinite(value) ? `${value.toFixed(3)} V` : '—';
  }

  function setAnalysisStatus(text, kind = '') {
    if (!analysisEnabled) return;
    analysisStatusKind = kind;
    const status = $('analysisStatus');
    status.textContent = text;
    status.className = `analysis-status${kind ? ` ${kind}` : ''}`;
  }

  function renderAnalysisSummary() {
    const container = $('analysisSummary');
    container.replaceChildren();
    const add = (label, value, className = '') => {
      const card = createAnalysisNode('article', className);
      card.append(createAnalysisNode('span', '', label), createAnalysisNode('strong', '', value));
      container.append(card);
    };
    add(t('analysis_summary_duration', 'Duration'), formatSeconds(analysisDataset.duration));
    add(t('analysis_summary_samples', 'Samples'), String(analysisDataset.samples.length));
    add(t('analysis_summary_rate', 'Sample rate'), analysisDataset.sampleRate > 0 ? `${analysisDataset.sampleRate.toFixed(1)} Hz` : '—');
    add(t('analysis_summary_segments', 'Segments'), String(analysisDataset.segmentCount));
    add(t('analysis_summary_peaks', 'Detected peaks'), String(analysisPeaks.length));
    add(t('analysis_summary_file', 'File'), analysisDataset.fileName || '—');
    if (analysisDataset.note) add(t('analysis_summary_note', 'Experiment note'), analysisDataset.note, 'analysis-summary-wide');
  }

  function renderAnalysisLegend() {
    const container = $('analysisLegend');
    container.replaceChildren();
    for (let channel = 0; channel < ANALYSIS_COLORS.length; channel += 1) {
      const item = createAnalysisNode('span', 'analysis-legend-item');
      const swatch = createAnalysisNode('i');
      swatch.style.background = ANALYSIS_COLORS[channel];
      item.append(swatch, `F${channel}`);
      container.append(item);
    }
  }

  function analysisTable(headers, rows) {
    const table = createAnalysisNode('table', 'analysis-table');
    const head = createAnalysisNode('thead');
    const headRow = createAnalysisNode('tr');
    for (const heading of headers) headRow.append(createAnalysisNode('th', '', heading));
    head.append(headRow);
    const body = createAnalysisNode('tbody');
    for (const row of rows) {
      const tr = createAnalysisNode('tr');
      for (const cell of row) tr.append(createAnalysisNode('td', '', cell));
      body.append(tr);
    }
    table.append(head, body);
    return table;
  }

  function renderAnalysisChannelTable() {
    const container = $('analysisChannelTable');
    container.replaceChildren();
    const table = analysisTable(
      [t('analysis_channel', 'Channel'), t('analysis_min', 'Min'), t('analysis_max', 'Max'), t('analysis_mean', 'Mean')],
      analysisDataset.channels.map(summary => [
        `F${summary.channel}`,
        formatVoltage(summary.min),
        formatVoltage(summary.max),
        formatVoltage(summary.mean),
      ]),
    );
    container.append(table);
  }

  function renderAnalysisPeakTable() {
    const container = $('analysisPeakTable');
    container.replaceChildren();
    if (!analysisPeaks.length) {
      container.append(createAnalysisNode('p', 'analysis-empty-note',
        t('analysis_no_peaks', 'No peaks were detected with this sensitivity. Lower the sensitivity or review the channel ranges below.')));
      return;
    }
    const table = analysisTable(
      [
        t('analysis_peak_number', '#'),
        t('analysis_peak_time', 'Time'),
        t('analysis_peak_duration', 'Duration'),
        t('analysis_peak_value', 'Peak'),
        t('analysis_peak_min', 'Min'),
        t('analysis_peak_max', 'Max'),
        t('analysis_peak_channels', 'Peak channels'),
      ],
      [],
    );
    const body = table.querySelector('tbody');
    analysisPeaks.forEach((peak, index) => {
      const row = createAnalysisNode('tr', 'analysis-peak-row');
      const values = [
        String(index + 1),
        formatSeconds(peak.t),
        formatSeconds(peak.duration),
        formatVoltage(peak.value),
        formatVoltage(peak.min),
        formatVoltage(peak.max),
        peak.peakChannels.length ? peak.peakChannels.map(channel => `F${channel}`).join(' / ') : '—',
      ];
      for (const value of values) row.append(createAnalysisNode('td', '', value));
      row.title = peak.channels
        .map(channel => `F${channel.channel}: ${formatVoltage(channel.min)} → ${formatVoltage(channel.max)}`)
        .join('\n');
      row.addEventListener('pointerenter', () => {
        analysisHoverPeak = { peak, number: index + 1 };
        analysisHoverIndex = null;
        scheduleAnalysisDraw();
      });
      row.addEventListener('pointerleave', () => {
        if (analysisHoverPeak?.peak === peak) {
          analysisHoverPeak = null;
          scheduleAnalysisDraw();
        }
      });
      body.append(row);
    });
    container.append(table);
  }

  function renderAnalysis() {
    if (!analysisEnabled) return;
    if (!analysisDataset) {
      $('analysisResults').hidden = true;
      if (!analysisLoading && analysisStatusKind !== 'error') {
        setAnalysisStatus(t('analysis_idle', 'No recording loaded yet.'), '');
      }
      return;
    }
    const file = analysisDataset.fileName || t('analysis_summary_file', 'File');
    setAnalysisStatus(t('analysis_loaded', 'Loaded {file} · {samples} samples · {peaks} peaks', {
      file,
      samples: analysisDataset.samples.length,
      peaks: analysisPeaks.length,
    }), 'good');
    $('analysisResults').hidden = false;
    renderAnalysisSummary();
    renderAnalysisLegend();
    renderAnalysisChannelTable();
    renderAnalysisPeakTable();
    scheduleAnalysisDraw();
  }

  async function runAnalysis(blobPromise, name) {
    if (analysisLoading) return;
    analysisLoading = true;
    analysisDrawPending = false;
    $('analysisChoose').disabled = true;
    showView('analysis');
    analysisDataset = null;
    analysisPeaks = [];
    analysisChart = null;
    analysisHoverPeak = null;
    analysisHoverIndex = null;
    $('analysisResults').hidden = true;
    setAnalysisStatus(t('analysis_loading', 'Reading {file}…', { file: name }), 'busy');
    try {
      if (typeof FSRRecording === 'undefined') {
        throw new Error(t('analysis_unsupported', 'The analysis module did not load. Reload the page and try again.'));
      }
      const dataset = await FSRRecording.load(await blobPromise, name);
      analysisDataset = dataset;
      analysisPeaks = FSRRecording.detectPeaks(dataset.samples, { prominenceRatio: analysisSensitivity });
      renderAnalysis();
    } catch (error) {
      analysisDataset = null;
      analysisPeaks = [];
      analysisChart = null;
      $('analysisResults').hidden = true;
      setAnalysisStatus(t('analysis_error', 'Cannot read {file}: {error}', { file: name, error: error.message }), 'error');
    } finally {
      analysisLoading = false;
      $('analysisChoose').disabled = false;
    }
  }

  function analyzeBlob(blob, name) {
    return runAnalysis(blob, name);
  }

  function analyzeServerRecording(name) {
    if (analysisLoading) return;
    const request = (async () => {
      const response = await fetch(`/api/download?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.blob();
    })();
    return runAnalysis(request, `${name}.zip`);
  }

  function changeAnalysisSensitivity(value) {
    const sensitivity = Number(value);
    if (!ANALYSIS_SENSITIVITIES.includes(sensitivity)) return;
    analysisSensitivity = sensitivity;
    try { localStorage.setItem('rigidity.fsr.analysisSensitivity', String(sensitivity)); } catch {}
    if (!analysisDataset) return;
    analysisPeaks = FSRRecording.detectPeaks(analysisDataset.samples, { prominenceRatio: sensitivity });
    analysisHoverPeak = null;
    analysisHoverIndex = null;
    renderAnalysis();
  }

  function setupAnalysis() {
    if (!analysisEnabled) return;
    const file = $('analysisFile'), drop = $('analysisDrop'), sensitivity = $('analysisSensitivity');
    try {
      const saved = Number(localStorage.getItem('rigidity.fsr.analysisSensitivity'));
      if (ANALYSIS_SENSITIVITIES.includes(saved)) analysisSensitivity = saved;
    } catch {}
    sensitivity.value = String(analysisSensitivity);
    $('analysisChoose').addEventListener('click', () => file.click());
    drop.addEventListener('click', () => file.click());
    drop.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      file.click();
    });
    file.addEventListener('change', () => {
      const selected = file.files && file.files[0];
      if (selected) void analyzeBlob(selected, selected.name);
      file.value = '';
    });
    for (const name of ['dragenter', 'dragover']) {
      drop.addEventListener(name, event => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        drop.classList.add('dragging');
      });
    }
    for (const name of ['dragleave', 'dragend']) {
      drop.addEventListener(name, event => {
        event.preventDefault();
        drop.classList.remove('dragging');
      });
    }
    drop.addEventListener('drop', event => {
      event.preventDefault();
      drop.classList.remove('dragging');
      const selected = event.dataTransfer?.files?.[0];
      if (selected) void analyzeBlob(selected, selected.name);
    });
    sensitivity.addEventListener('change', () => changeAnalysisSensitivity(sensitivity.value));
    const chart = $('analysisChart');
    chart.addEventListener('pointermove', handleAnalysisPointer);
    chart.addEventListener('pointerdown', handleAnalysisPointer);
    chart.addEventListener('pointerleave', hideAnalysisTooltip);
    chart.addEventListener('pointercancel', hideAnalysisTooltip);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', scheduleAnalysisDraw);
    }
    renderAnalysis();
  }

  function analysisYMaximum(maximum) {
    const target = Math.max(0.1, maximum * 1.05);
    for (const step of [0.1, 0.2, 0.25, 0.5, 1, 2, 5]) {
      const top = Math.ceil(target / step) * step;
      if (top / step <= 8) return top;
    }
    return Math.ceil(target);
  }

  function nearestAnalysisSample(time) {
    const samples = analysisChart?.samples;
    if (!samples || !samples.length) return -1;
    let low = 0, high = samples.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (samples[middle].t < time) low = middle + 1;
      else high = middle;
    }
    if (low > 0 && Math.abs(samples[low - 1].t - time) <= Math.abs(samples[low].t - time)) return low - 1;
    return low;
  }

  function analysisPeakAt(x) {
    if (!analysisChart) return null;
    const { left, width } = analysisChart.geometry;
    let match = null, distance = 14;
    analysisPeaks.forEach((peak, index) => {
      const peakX = left + (peak.t / analysisChart.span) * width;
      const candidate = Math.abs(peakX - x);
      if (candidate <= distance) {
        distance = candidate;
        match = { peak, number: index + 1 };
      }
    });
    return match;
  }

  function scheduleAnalysisDraw() {
    if (!analysisEnabled || !analysisDataset) return;
    if (typeof requestAnimationFrame !== 'function') {
      drawAnalysisChart();
      return;
    }
    if (analysisDrawPending) return;
    analysisDrawPending = true;
    requestAnimationFrame(() => {
      analysisDrawPending = false;
      drawAnalysisChart();
    });
  }

  function drawAnalysisChart() {
    if (!analysisEnabled || !analysisDataset) return;
    const canvas = $('analysisChart');
    if (!canvas) return;
    const width = Math.max(320, Math.round(canvas.clientWidth || 1000));
    const height = Math.max(240, Math.round(canvas.clientHeight || 380));
    const pixelRatio = typeof window !== 'undefined' && window.devicePixelRatio ? Math.min(2, window.devicePixelRatio) : 1;
    if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const left = 58, right = width - 16, top = 18, bottom = height - 34;
    const plotWidth = Math.max(1, right - left), plotHeight = Math.max(1, bottom - top);
    const span = Math.max(1e-6, analysisDataset.duration);
    let maximum = 0;
    for (const sample of analysisDataset.samples) {
      for (const value of sample.values) if (Number.isFinite(value) && value > maximum) maximum = value;
    }
    const yMax = analysisYMaximum(maximum);
    const xAt = time => left + Math.max(0, Math.min(1, time / span)) * plotWidth;
    const yAt = value => bottom - Math.max(0, Math.min(yMax, value)) / yMax * plotHeight;
    analysisChart = { geometry: { left, right, top, bottom, width: plotWidth, height: plotHeight }, span, samples: analysisDataset.samples };

    context.fillStyle = '#ffffff';
    context.fillRect(left, top, plotWidth, plotHeight);

    for (const [index, peak] of analysisPeaks.entries()) {
      const selected = analysisHoverPeak?.number === index + 1 && analysisHoverPeak?.peak === peak;
      context.fillStyle = selected ? 'rgba(191, 62, 64, .14)' : 'rgba(82, 118, 145, .055)';
      const start = xAt(peak.startT), end = xAt(peak.endT);
      context.fillRect(start, top, Math.max(1, end - start), plotHeight);
    }

    context.strokeStyle = '#e2e9f0';
    context.lineWidth = 1;
    context.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace';
    context.fillStyle = '#7b8a99';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (let tick = 0; tick <= 5; tick += 1) {
      const y = top + plotHeight * tick / 5;
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(right, y);
      context.stroke();
      const value = yMax * (1 - tick / 5);
      context.fillText(value.toFixed(yMax < 1 ? 2 : 1), left - 8, y);
    }
    context.textAlign = 'center';
    context.textBaseline = 'top';
    for (let tick = 0; tick <= 5; tick += 1) {
      const x = left + plotWidth * tick / 5;
      context.beginPath();
      context.moveTo(x, top);
      context.lineTo(x, bottom);
      context.stroke();
      context.fillText(formatAxisTime(span * tick / 5), x, bottom + 8);
    }

    for (let channel = 0; channel < ANALYSIS_COLORS.length; channel += 1) {
      const points = FSRRecording.downsample(analysisDataset.samples, channel, Math.max(240, Math.round(plotWidth * 1.5)));
      context.beginPath();
      context.strokeStyle = ANALYSIS_COLORS[channel];
      context.globalAlpha = 0.8;
      context.lineWidth = 1.2;
      let started = false;
      for (const point of points) {
        if (point.value === null || !Number.isFinite(point.value)) {
          started = false;
          continue;
        }
        const x = xAt(point.t), y = yAt(point.value);
        if (started) context.lineTo(x, y);
        else {
          context.moveTo(x, y);
          started = true;
        }
      }
      context.stroke();
    }
    context.globalAlpha = 1;

    analysisPeaks.forEach((peak, index) => {
      const selected = analysisHoverPeak?.number === index + 1 && analysisHoverPeak?.peak === peak;
      const x = xAt(peak.t), y = yAt(peak.value);
      if (selected) {
        context.strokeStyle = 'rgba(159, 45, 48, .75)';
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(x, top);
        context.lineTo(x, bottom);
        context.stroke();
      }
      context.fillStyle = selected ? '#a22f33' : '#b55a3c';
      context.beginPath();
      context.moveTo(x, y - 5);
      context.lineTo(x + 5, y);
      context.lineTo(x, y + 5);
      context.lineTo(x - 5, y);
      context.closePath();
      context.fill();
      if (selected) {
        context.fillStyle = '#8f2c2f';
        context.font = '600 11px Inter, ui-sans-serif, system-ui, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'bottom';
        context.fillText(`#${index + 1}`, x, Math.max(top + 10, y - 8));
      }
    });

    if (analysisHoverIndex !== null && analysisHoverIndex >= 0 && analysisHoverIndex < analysisDataset.samples.length) {
      const sample = analysisDataset.samples[analysisHoverIndex];
      const x = xAt(sample.t);
      context.strokeStyle = 'rgba(47, 70, 91, .55)';
      context.lineWidth = 1;
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(x, top);
      context.lineTo(x, bottom);
      context.stroke();
      context.setLineDash([]);
      sample.values.forEach((value, channel) => {
        if (!Number.isFinite(value)) return;
        context.fillStyle = ANALYSIS_COLORS[channel];
        context.beginPath();
        context.arc(x, yAt(value), 2.6, 0, Math.PI * 2);
        context.fill();
      });
    }

    context.strokeStyle = '#cbd7e2';
    context.lineWidth = 1;
    context.strokeRect(left, top, plotWidth, plotHeight);
    context.fillStyle = '#6f8090';
    context.font = '11px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.fillText('V', 10, top);
  }

  function analysisTooltipRow(label, value, color) {
    const row = createAnalysisNode('div', 'analysis-tooltip-row');
    const key = createAnalysisNode('span', 'analysis-tooltip-key');
    if (color) {
      const swatch = createAnalysisNode('i', 'analysis-tooltip-swatch');
      swatch.style.background = color;
      key.append(swatch);
    }
    key.append(label);
    row.append(key, createAnalysisNode('span', 'analysis-tooltip-value', value));
    return row;
  }

  function updateAnalysisTooltip(event, sample, peak) {
    const tooltip = $('analysisTooltip');
    if (!tooltip) return;
    const wrap = tooltip.parentElement;
    if (!wrap) return;
    tooltip.replaceChildren();
    tooltip.append(createAnalysisNode('strong', 'analysis-tooltip-title',
      t('analysis_tooltip_time', 't = {time} s', { time: sample.t.toFixed(3) })));

    if (peak) {
      tooltip.append(createAnalysisNode('span', 'analysis-tooltip-subtitle',
        t('analysis_tooltip_peak', 'Peak #{number}', { number: peak.number })));
      tooltip.append(createAnalysisNode('span', 'analysis-tooltip-range',
        t('analysis_tooltip_range', 'Event range {min} → {max} · {duration}', {
          min: formatVoltage(peak.peak.min),
          max: formatVoltage(peak.peak.max),
          duration: formatSeconds(peak.peak.duration),
        })));
      const table = createAnalysisNode('table', 'analysis-tooltip-table');
      const head = createAnalysisNode('thead');
      const headRow = createAnalysisNode('tr');
      for (const heading of [t('analysis_channel', 'Channel'), t('analysis_min', 'Min'), t('analysis_max', 'Max')]) {
        headRow.append(createAnalysisNode('th', '', heading));
      }
      head.append(headRow);
      const body = createAnalysisNode('tbody');
      for (const channel of peak.peak.channels) {
        const row = createAnalysisNode('tr', peak.peak.peakChannels.includes(channel.channel) ? 'analysis-tooltip-peak-channel' : '');
        const name = createAnalysisNode('td', '', `F${channel.channel}`);
        const swatch = createAnalysisNode('i', 'analysis-tooltip-swatch');
        swatch.style.background = ANALYSIS_COLORS[channel.channel];
        name.prepend(swatch);
        row.append(name,
          createAnalysisNode('td', '', formatVoltage(channel.min)),
          createAnalysisNode('td', '', formatVoltage(channel.max)));
        body.append(row);
      }
      table.append(head, body);
      tooltip.append(table);
    } else {
      tooltip.append(createAnalysisNode('span', 'analysis-tooltip-subtitle',
        t('analysis_tooltip_sample', 'Nearest sample')));
      sample.values.forEach((value, channel) => {
        tooltip.append(analysisTooltipRow(`F${channel}`, formatVoltage(value), ANALYSIS_COLORS[channel]));
      });
    }

    tooltip.hidden = false;
    const wrapRect = wrap.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    let left = event.clientX - wrapRect.left + 16;
    let top = event.clientY - wrapRect.top + 16;
    if (left + tooltipRect.width > wrapRect.width - 8) {
      left = Math.max(8, event.clientX - wrapRect.left - tooltipRect.width - 16);
    }
    if (top + tooltipRect.height > wrapRect.height - 8) {
      top = Math.max(8, event.clientY - wrapRect.top - tooltipRect.height - 16);
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideAnalysisTooltip() {
    const tooltip = $('analysisTooltip');
    if (tooltip) {
      tooltip.hidden = true;
      tooltip.replaceChildren();
    }
    analysisHoverPeak = null;
    analysisHoverIndex = null;
    scheduleAnalysisDraw();
  }

  function handleAnalysisPointer(event) {
    if (!analysisChart) return;
    const canvas = $('analysisChart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const geometry = analysisChart.geometry;
    if (x < geometry.left || x > geometry.right || y < geometry.top || y > geometry.bottom) {
      hideAnalysisTooltip();
      return;
    }
    const ratio = geometry.width > 0 ? (x - geometry.left) / geometry.width : 0;
    const time = Math.max(0, Math.min(analysisChart.span, ratio * analysisChart.span));
    const index = nearestAnalysisSample(time);
    if (index < 0) return;
    analysisHoverIndex = index;
    analysisHoverPeak = analysisPeakAt(x);
    updateAnalysisTooltip(event, analysisChart.samples[index], analysisHoverPeak);
    scheduleAnalysisDraw();
  }

  async function api(path, payload) {
    const response = await fetch(`/api/${path}`, { cache:'no-store', signal:AbortSignal.timeout(8000),
      ...(payload === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) }) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
    return result;
  }

  function render(status) {
    snapshot = status;
    const device = status?.device || {};
    const row = device.latest;
    const active = Boolean(device.active);
    $('record').disabled = busy || status.recording || !active;
    $('stop').disabled = busy || !status.recording;
    $('downloadLatest').disabled = busy || status.recording || !device.path;
    $('reconnect').disabled = busy || active;
    $('quickStatus').textContent = active ? t('quick_connected', 'Connected') : t('quick_disconnected', 'Disconnected: click the button to reconnect');
    $('folderName').disabled = $('note').disabled = busy || status.recording;
    const seconds = Math.floor((status.elapsed_ms || 0) / 1000);
    $('sessionTime').textContent = [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(v=>String(v).padStart(2,'0')).join(':');
    $('sessionStatus').textContent = status.recording ? t('session_recording', 'Recording · saving') : status.path ? t('session_saved', 'Stopped and saved · download below') : t('session_preview', 'Not recording · live preview only');
    $('recordPath').textContent = status.path || t('record_path', 'Recordings are stored in the local data folder.');

    const stale = active && row && Date.now() - row.pc_epoch_ms > 1500;
    const rate = Number.isFinite(device.input_rate_hz) ? device.input_rate_hz.toFixed(1) : '0.0';
    const label = !active ? (device.error ? t('status_connection_lost', 'Disconnected · connection lost') : t('status_disconnected', 'Disconnected'))
      : stale ? t('status_no_recent', 'No recent samples')
      : !row ? t('status_waiting_samples', 'Connected · waiting for samples')
      : t('status_live', 'Live · {source} · {rate} Hz', { source: String(device.source || 'usb').toUpperCase(), rate });
    $('summary').textContent = label;
    $('summary').className = !active || stale ? 'warning' : 'good';

    const coverage = !row ? t('coverage_waiting', 'Waiting for data')
      : row.fsr_only ? t('coverage_fsr_only', '8 FSR firmware · IMU reports not present')
      : row.protocol_version !== 4
        ? (device.source === 'demo' ? t('coverage_demo', 'Demo data') : t('coverage_legacy', 'Legacy firmware: raw IMU counts / individual ADC samples unavailable'))
        : row.raw_config_mask === 0 ? t('coverage_no_raw', 'Firmware did not enable raw IMU reports; core IMU and FSR are displayed independently')
        : row.raw_complete ? t('coverage_raw_complete', 'Raw nine-axis + every FSR ADC conversion available') : t('coverage_raw_missing', 'Raw reports missing/stale: inspect firmware / sensor');
    $('detail').textContent = `${coverage} · ${device.recording ? t('detail_recording', 'Recording') : device.path ? t('detail_saved', 'Saved') : t('detail_not_recording', 'Not recording:')} ${device.recorded || 0} ${t('samples', 'samples')} · ${device.missing || 0} ${t('sample_gaps', 'sample gaps')}`;

    const warnings = [];
    if (device.error) warnings.push(t('warning_device_error', 'ESP32: {error}', { error: device.error }));
    if (device.record_error) warnings.push(t('warning_record_error', 'ESP32: {error}', { error: device.record_error }));
    if (status.recording && !active) warnings.push(t('warning_disconnected', 'The board is disconnected; reconnect to continue saving a new segment.'));
    if (status.recording && active && !device.recording) warnings.push(t('warning_not_writing', 'The board is online but not writing; stop the recording, check the file error, then start again.'));
    $('message').textContent = Date.now() < noticeUntil ? notice : warnings.join(' ') ||
      t('message_default', '8 FSR channels are acquired over USB serial. Click "Start Recording" to save; stop to download a ZIP.');
    $('message').className = Date.now() < noticeUntil || warnings.length ? 'error' : '';
    renderPressure(status);
  }

  async function action(path, payload) {
    if (busy) return;
    busy = true;
    if (snapshot) render(snapshot);
    try { await api(path, payload); notice = ''; noticeUntil = 0; await listRecordings(); }
    catch (error) { notice = error.message; noticeUntil = Date.now() + 12000; }
    finally { busy = false; await poll(); }
  }

  async function poll() {
    try { render(await api('status')); }
    catch (error) {
      snapshot = null;
      renderPressure(null);
      $('message').textContent = t('message_service_unavailable', 'Local service unavailable: {error}', { error: error.message });
      $('message').className = 'error';
      $('record').disabled = $('stop').disabled = true;
    }
  }

  $('record').addEventListener('click',()=>action('record/start',{folder_name:$('folderName').value,note:$('note').value}));
  $('stop').addEventListener('click',()=>action('record/stop',{}));

  async function listRecordings() {
    try {
      const result = await api('recordings');
      const list = $('recordingsList');
      list.replaceChildren();
      for (const entry of result.recordings) {
        const row = document.createElement('p');
        const link = document.createElement('a');
        link.textContent = entry.name + (entry.active ? ` · ${t('recordings_active', 'recording, stop before download')}` : ` · ${t('recordings_download', 'download ZIP')}`);
        row.append(link);
        if (!entry.active) {
          link.href = '/api/download?name=' + encodeURIComponent(entry.name);
          link.download = entry.name + '.zip';
          const analyze = document.createElement('button');
          analyze.type = 'button';
          analyze.className = 'secondary analysis-analyze';
          analyze.textContent = t('analysis_analyze', 'Analyze');
          analyze.addEventListener('click', () => void analyzeServerRecording(entry.name));
          row.append(' ', analyze);
        }
        list.append(row);
      }
      if (!result.recordings.length) list.textContent = t('recordings_empty', 'No recordings yet. Click "Start Recording" to see them here.');
    } catch (e) { $('recordingsList').textContent = t('recordings_error', 'Cannot read recordings: {error}', { error: e.message }); }
  }

  $('downloadLatest').addEventListener('click',()=>{
    if (snapshot && !snapshot.recording) {
      const name = snapshot.path.split(/[\\/]/).pop();
      const a = document.createElement('a');
      a.href = '/api/download?name=' + encodeURIComponent(name);
      a.download = name + '.zip';
      a.click();
    }
  });
  $('refreshRecordings').addEventListener('click', listRecordings);
  $('reconnect').addEventListener('click',()=>action('device/reconnect',{}));
  void listRecordings();
  setupPressure();
  setupAnalysis();
  const languageSelect = $('languageSelect');
  if (languageSelect) {
    languageSelect.value = currentLanguage;
    languageSelect.addEventListener('change', event => void loadLanguage(event.target.value));
  }
  void loadLanguage(currentLanguage);
  document.querySelector?.('#monitorView iframe')?.addEventListener('load', syncLanguageToFrame);
  async function tick() { await poll(); setTimeout(tick, pressureEnabled && activeView === 'pressure' ? 100 : 500); }
  void tick();
})();
