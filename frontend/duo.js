// One voltage per physical FSR pad. No interpolation into unmeasured areas.
const FSRPressureMap = (() => {
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
    const labels = { service: '本地服务未连接', disconnected: '未连接', waiting: '等待采样', stale: '数据已过期', live: sample.demo ? '模拟数据 · 非实测' : '实时数据' };
    const label = sample.state === 'live' && sample.valid < FSRPressureMap.channels.length
      ? `${labels.live} · ${sample.valid}/${FSRPressureMap.channels.length} 有效`
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
      const description = voltage === null ? '无实时读数' : `${voltage.toFixed(3)} V${voltage > pressureRange ? '，超过颜色标尺上限' : ''}`;
      tile.setAttribute('aria-label', `F${channel}：${description}`);
      tile.title = `F${channel} · ${description}`;
    }
    $('pressurePeak').textContent = sample.peak === null ? '—' : `${sample.peaks.map(channel => `F${channel}`).join(' / ')} · ${sample.peak.toFixed(3)} V`;
    $('pressureDetail').textContent = sample.state !== 'live'
      ? `${label}，暂停着色`
      : `${sample.valid}/8 片有有效读数 · ${sample.demo ? '模拟电压' : 'USB 实测电压'}`;
    if (sample.state !== 'live') notices.push(label);
    else if (sample.valid < 8) notices.push('部分通道无有效读数');
    if (sample.demo) notices.push('使用模拟数据');
    if (sample.values.some(value => value !== null && value > pressureRange)) notices.push('超过颜色上限，已显示最暖色；可调高标尺');
    $('pressureNotice').textContent = notices.join('；') || '可依次轻按每片，核对亮起的位置。电压变化较小时，可调低颜色标尺上限。';
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
    $('quickStatus').textContent = active ? '已连接' : '未连接：点旁边按钮重连';
    $('folderName').disabled = $('note').disabled = busy || status.recording;
    const seconds = Math.floor((status.elapsed_ms || 0) / 1000);
    $('sessionTime').textContent = [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(v=>String(v).padStart(2,'0')).join(':');
    $('sessionStatus').textContent = status.recording ? '记录中 · 正在保存' : status.path ? '已停止并保存 · 点击下方下载本次数据' : '未记录 · 仅实时预览';
    $('recordPath').textContent = status.path || 'Recordings are stored in the local data folder.';

    const stale = active && row && Date.now() - row.pc_epoch_ms > 1500;
    const rate = Number.isFinite(device.input_rate_hz) ? device.input_rate_hz.toFixed(1) : '0.0';
    const label = !active ? (device.error ? 'Disconnected · connection lost' : 'Disconnected')
      : stale ? 'No recent samples'
      : !row ? 'Connected · waiting for samples'
      : `Live · ${String(device.source || 'usb').toUpperCase()} · ${rate} Hz`;
    $('summary').textContent = label;
    $('summary').className = !active || stale ? 'warning' : 'good';

    const coverage = !row ? 'Waiting for data'
      : row.fsr_only ? '8 FSR firmware · IMU reports not present'
      : row.protocol_version !== 4
        ? (device.source === 'demo' ? 'Demo data' : 'Legacy firmware: raw IMU counts / individual ADC samples unavailable')
        : row.raw_config_mask === 0 ? '固件未启用原始 IMU 报告；核心 IMU 与 FSR 独立显示'
        : row.raw_complete ? 'Raw nine-axis + every FSR ADC conversion available' : 'Raw reports missing/stale: inspect firmware / sensor';
    $('detail').textContent = `${coverage} · ${device.recording ? 'Recording' : device.path ? 'Saved' : 'Not recording:'} ${device.recorded || 0} samples · ${device.missing || 0} sample gaps`;

    const warnings = [];
    if (device.error) warnings.push(`ESP32: ${device.error}`);
    if (device.record_error) warnings.push(`ESP32: ${device.record_error}`);
    if (status.recording && !active) warnings.push('采集板已断开；请重新连接后继续保存新分段。');
    if (status.recording && active && !device.recording) warnings.push('采集板在线但未在写盘；请停止记录并检查文件错误后重新开始。');
    $('message').textContent = Date.now() < noticeUntil ? notice : warnings.join(' ') ||
      '8 路 FSR 通过 USB 串口采集。点击“开始记录”才会保存；停止后可下载 ZIP。';
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
      $('message').textContent = `Local service unavailable: ${error.message}`;
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
        link.textContent = entry.name + (entry.active ? ' · 记录中，请停止后下载' : ' · 下载 ZIP');
        if (!entry.active) {
          link.href = '/api/download?name=' + encodeURIComponent(entry.name);
          link.download = entry.name + '.zip';
        }
        row.append(link);
        list.append(row);
      }
      if (!result.recordings.length) list.textContent = '暂无记录，点击“开始记录”后会出现在这里。';
    } catch (e) { $('recordingsList').textContent = '无法读取记录：' + e.message; }
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
  async function tick() { await poll(); setTimeout(tick, pressureEnabled && activeView === 'pressure' ? 100 : 500); }
  void tick();
})();
