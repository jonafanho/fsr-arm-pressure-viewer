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
      void listRecordings();
    } catch (error) {
      console.error(`Unable to load language "${lang}":`, error);
    }
  }

  function showView(view) {
    activeView = view === 'monitor' ? 'monitor' : 'pressure';
    for (const name of ['pressure', 'monitor']) {
      const selected = name === activeView;
      $(`${name}View`).hidden = !selected;
      $(`${name}Tab`).setAttribute('aria-selected', String(selected));
      $(`${name}Tab`).tabIndex = selected ? 0 : -1;
    }
    if (activeView === 'monitor') {
      for (const frame of document.querySelectorAll('#monitorView iframe')) {
        frame.contentWindow?.dispatchEvent(new Event('resize'));
      }
    }
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
      activeView = localStorage.getItem('rigidity.fsr.view') === 'monitor' ? 'monitor' : 'pressure';
    } catch {}
    $('pressureRange').value = String(pressureRange);
    $('pressureRange').addEventListener('change', () => {
      const value = Number($('pressureRange').value);
      if (!FSRPressureMap.ranges.includes(value)) return;
      pressureRange = value;
      try { localStorage.setItem('rigidity.fsr.pressureRange', String(value)); } catch {}
      renderPressure(snapshot);
    });
    for (const name of ['pressure', 'monitor']) {
      $(`${name}Tab`).addEventListener('click', () => showView(name));
      $(`${name}Tab`).addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'pressure' : event.key === 'End' ? 'monitor' : name === 'pressure' ? 'monitor' : 'pressure';
        showView(next);
        $(`${next}Tab`).focus();
      });
    }
    showView(activeView);
    renderPressure(null);
    // Clear stale colours even while a stalled HTTP request is awaiting timeout.
    setInterval(() => renderPressure(snapshot), 500);
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
        if (!entry.active) {
          link.href = '/api/download?name=' + encodeURIComponent(entry.name);
          link.download = entry.name + '.zip';
        }
        row.append(link);
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
