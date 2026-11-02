(() => {
  "use strict";

  const LANGUAGES = ["en", "zh-CN", "zh-TW"];
  let translations = {};
  let currentLanguage = "en";
  const $ = (id) => document.getElementById(id);

  function t(key, fallback, vars) {
    let value = Object.prototype.hasOwnProperty.call(translations, key) ? translations[key] : fallback ?? key;
    if (vars) for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  }

  function applyTranslations() {
    document.documentElement.lang = currentLanguage;
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const value = translations[node.dataset.i18n];
      if (typeof value === "string") node.textContent = value + (node.dataset.i18nSuffix || "");
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      const value = translations[node.dataset.i18nPlaceholder];
      if (typeof value === "string") node.placeholder = value;
    });
    document.querySelectorAll("[data-i18n-title]").forEach((node) => {
      const value = translations[node.dataset.i18nTitle];
      if (typeof value === "string") node.title = value;
    });
    document.title = t("device_page_title", "ESP32-WROOM-32 · 8 FSR Monitor");
  }

  async function loadLanguage(lang) {
    if (!LANGUAGES.includes(lang)) lang = "en";
    try {
      const response = await fetch(`public/loc/${lang}.json`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      translations = await response.json();
      currentLanguage = lang;
      applyTranslations();
      Object.values(state.charts).forEach((chart) => chart.resize?.());
      if (state.status) updateStatusUi(state.status);
    } catch (error) {
      console.error(`Unable to load language "${lang}":`, error);
    }
  }

  const FSR_COUNT = 8;
  const MAX_BROWSER_ROWS = 7200;
  const MAX_PLOT_POINTS = 650;
  const CHART_INTERVAL_MS = 250;
  const AXIS_COLORS = { x: "#0f8b8d", y: "#e4572e", z: "#2e5aac", mag: "#f3a712" };
  const FSR_COLORS = ["#5e60ce", "#118ab2", "#06a77d", "#e09f3e", "#d1495b", "#7b2cbf", "#3a86ff", "#ef476f"];

  const METRIC_GROUPS = [
    { title: "Rotation Radius", titleKey: "chart_radius", unit: "m", items: [["radius_x_m", "rₓ"], ["radius_y_m", "rᵧ"], ["radius_z_m", "r𝓏"], ["radius_mag_m", "|r|"]] },
    { title: "Linear Velocity", titleKey: "chart_velocity", unit: "m/s", items: [["vx_m_s", "vₓ"], ["vy_m_s", "vᵧ"], ["vz_m_s", "v𝓏"], ["v_mag_m_s", "|v|"]] },
    { title: "Acceleration", titleKey: "chart_acceleration", unit: "m/s²", items: [["ax_kin_m_s2", "aₓ"], ["ay_kin_m_s2", "aᵧ"], ["az_kin_m_s2", "a𝓏"], ["a_kin_mag_m_s2", "|a|"]] },
    { title: "Angular Displacement", titleKey: "chart_angle", unit: "°", items: [["theta_x_deg", "θₓ"], ["theta_y_deg", "θᵧ"], ["theta_z_deg", "θ𝓏"], ["theta_mag_deg", "|θ|"]] },
    { title: "Angular Velocity", titleKey: "chart_omega", unit: "°/s", items: [["omega_x_deg_s", "ωₓ"], ["omega_y_deg_s", "ωᵧ"], ["omega_z_deg_s", "ω𝓏"], ["omega_mag_deg_s", "|ω|"]] },
    { title: "Angular Acceleration", titleKey: "chart_alpha", unit: "°/s²", items: [["alpha_x_deg_s2", "αₓ"], ["alpha_y_deg_s2", "αᵧ"], ["alpha_z_deg_s2", "α𝓏"], ["alpha_mag_deg_s2", "|α|"]] },
  ];
  const RAW_GROUPS = [
    { title: "Acceleration (with gravity)", titleKey: "raw_accel", unit: "m/s²", report: "accel", prefix: "accel", suffix: "m_s2" },
    { title: "Gyroscope", titleKey: "raw_gyro", unit: "rad/s", report: "gyro", prefix: "gyro", suffix: "rad_s" },
    { title: "Linear Acceleration", titleKey: "raw_linear", unit: "m/s²", report: "linear", prefix: "linear", suffix: "m_s2" },
  ].map((group) => ({ ...group, items: ["x", "y", "z"].map((axis) => [`${group.prefix}_${axis}_${group.suffix}`, axis.toUpperCase()]) }));
  RAW_GROUPS.push({ title: "Quaternion", titleKey: "raw_quat", unit: "", report: "quat", items: ["w", "x", "y", "z"].map((axis) => [`quat_${axis}`, axis.toUpperCase()]) });

  const chartGroup = (id, title, unit, prefix) => ({
    id, title, titleKey: `chart_${id}`, unit,
    series: [
      { key: `${prefix}_x`, name: "X", color: AXIS_COLORS.x },
      { key: `${prefix}_y`, name: "Y", color: AXIS_COLORS.y },
      { key: `${prefix}_z`, name: "Z", color: AXIS_COLORS.z },
      { key: `${prefix}_mag`, name: "Magnitude", color: AXIS_COLORS.mag },
    ],
  });
  const CHARTS = [
    chartGroup("radius", "Rotation Radius", "m", "radius"),
    chartGroup("velocity", "Linear Velocity", "m/s", "v"),
    chartGroup("acceleration", "Acceleration", "m/s²", "a_kin"),
    chartGroup("angle", "Angular Displacement", "°", "theta"),
    chartGroup("omega", "Angular Velocity", "°/s", "omega"),
    chartGroup("alpha", "Angular Acceleration", "°/s²", "alpha"),
  ];
  // Field names are not perfectly uniform across the metric families.
  CHARTS[0].series.forEach((series, index) => { series.key = ["radius_x_m", "radius_y_m", "radius_z_m", "radius_mag_m"][index]; });
  CHARTS[1].series.forEach((series, index) => { series.key = ["vx_m_s", "vy_m_s", "vz_m_s", "v_mag_m_s"][index]; });
  CHARTS[2].series.forEach((series, index) => { series.key = ["ax_kin_m_s2", "ay_kin_m_s2", "az_kin_m_s2", "a_kin_mag_m_s2"][index]; });
  CHARTS[3].series.forEach((series, index) => { series.key = ["theta_x_deg", "theta_y_deg", "theta_z_deg", "theta_mag_deg"][index]; });
  CHARTS[4].series.forEach((series, index) => { series.key = ["omega_x_deg_s", "omega_y_deg_s", "omega_z_deg_s", "omega_mag_deg_s"][index]; });
  CHARTS[5].series.forEach((series, index) => { series.key = ["alpha_x_deg_s2", "alpha_y_deg_s2", "alpha_z_deg_s2", "alpha_mag_deg_s2"][index]; });
  for (const group of RAW_GROUPS.filter(group => group.items.length === 3)) {
    CHARTS.push({ id: `raw_${group.report}`, title: group.title + " · Sensor Report", unit: group.unit,
      series: group.items.map(([key, name], index) => ({ key, name, color: AXIS_COLORS[["x", "y", "z"][index]] })) });
  }
  const FSR_CHART = {
    id: "fsr", title: "FSR Voltage", titleKey: "fsr_voltage_chart", unit: "V",
    series: Array.from({ length: FSR_COUNT }, (_, index) => ({ key: `F${index}_V`, name: `F${index}`, color: FSR_COLORS[index] })),
  };
  const ALL_CHARTS = [...CHARTS, FSR_CHART];

  const elements = {
    source: $("source"), port: $("port"), host: $("host"), usbFields: $("usbFields"), wifiFields: $("wifiFields"),
    history: $("historySeconds"), refresh: $("refresh"), discover: $("discover"), connect: $("connect"), disconnect: $("disconnect"),
    record: $("record"), stop: $("stop"), zero: $("zero"), folderName: $("folderName"), note: $("note"),
    statusPill: $("statusPill"), statusLabel: $("statusLabel"), connectionText: $("connectionText"), message: $("message"),
    inputRate: $("metric-input_rate"), sampleDt: $("metric-sample_dt"), deviceTime: $("metric-device_time"),
    retainedRows: $("metric-retained_rows"), frameHealth: $("metric-frame_health"), calibration: $("metric-calibration"),
    velocity: $("metric-velocity_quality"), pipeline: $("metric-pipeline"),
    recordingMetric: $("metric-recording"), recordStatus: $("recordStatus"), recordTime: $("recordTime"), recordPath: $("recordPath"),
    kinematicMetrics: $("kinematicMetrics"), rawMetrics: $("rawMetrics"), forceMetrics: $("forceMetrics"),
    reportStatus: $("metric-report_status"), attitude: $("metric-attitude_quality"), motionNotice: $("motionNotice"),
    kinematicCharts: $("kinematicCharts"), mechanicalCharts: $("mechanicalCharts"),
  };

  const state = {
    history: [], after: 0, generation: null, status: null, busy: false, polling: false,
    notice: "", noticeUntil: 0, charts: {}, chartCards: {}, visibleCharts: {}, chartTimer: null,
  };
  const metricNodes = {};
  const reportNodes = {};

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createMetrics() {
    const createGroup = (group) => {
      const card = element("article", "metric-group");
      const heading = element("h3", "", `${t(group.titleKey, group.title)} · ${group.unit}`);
      if (group.titleKey) {
        heading.dataset.i18n = group.titleKey;
        heading.dataset.i18nSuffix = ` · ${group.unit}`;
      }
      card.append(heading);
      for (const [key, label] of group.items) {
        const row = element("div", "metric-row");
        const name = element("span", "", label);
        const value = element("strong", "", "--");
        value.append(element("span", "metric-unit", ` ${group.unit}`));
        const number = document.createTextNode("--");
        value.replaceChildren(number, element("span", "metric-unit", ` ${group.unit}`));
        metricNodes[key] = number;
        row.append(name, value);
        card.append(row);
      }
      if (group.report) {
        const quality = element("p", "report-quality", t("waiting_for_report", "Waiting for report"));
        reportNodes[group.report] = quality;
        card.append(quality);
      }
      return card;
    };
    elements.kinematicMetrics.replaceChildren(...METRIC_GROUPS.map(createGroup));
    elements.rawMetrics.replaceChildren(...RAW_GROUPS.map(createGroup));

    const fsrCards = Array.from({ length: FSR_COUNT }, (_, index) => {
      const card = element("article", "force-metric");
      card.append(element("span", "force-metric-label", `FSR ${index}`));
      const strong = element("strong");
      const voltage = document.createTextNode("--");
      strong.append(voltage, element("span", "force-value-unit", " V"));
      metricNodes[`F${index}_V`] = voltage;
      const raw = element("span", "force-metric-unit", "ADC --");
      metricNodes[`raw_fsr${index}_adc`] = raw;
      card.append(strong, raw);
      return card;
    });
    elements.forceMetrics.replaceChildren(...fsrCards);
  }

  function chartOption(config) {
    return {
      animation: false,
      color: config.series.map((series) => series.color),
      grid: { left: 58, right: 18, top: config.series.length > 4 ? 52 : 42, bottom: 40 },
      tooltip: { trigger: "axis", confine: true, valueFormatter: (value) => value == null ? "--" : Number(value).toFixed(3) },
      legend: { top: 8, type: "scroll", textStyle: { color: "#667385", fontSize: 11 } },
      xAxis: {
        type: "value", min: -10, max: 0, name: "s", nameLocation: "end",
        axisLabel: { color: "#778497" }, axisLine: { lineStyle: { color: "#cdd6e1" } },
        splitLine: { lineStyle: { color: "#edf1f5" } },
      },
      yAxis: {
        type: "value", scale: true, name: config.unit, nameTextStyle: { color: "#778497" },
        axisLabel: { color: "#778497" }, splitLine: { lineStyle: { color: "#edf1f5" } },
      },
      series: config.series.map((series) => ({
        name: series.name, type: "line", showSymbol: false, connectNulls: false,
        sampling: "lttb", progressive: 0, lineStyle: { width: 1.7 }, data: [],
      })),
    };
  }

  function createCanvasChart(canvas, config) {
    let seconds = 10;
    let datasets = config.series.map(() => []);

    function draw() {
      const width = Math.max(320, canvas.clientWidth || 800);
      const height = Math.max(220, canvas.clientHeight || 270);
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const context = canvas.getContext("2d");
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);

      const legendRows = config.series.length > 4 ? 2 : 1;
      const left = 56, right = width - 14, top = 17 + legendRows * 17, bottom = height - 31;
      context.font = "11px Segoe UI, sans-serif";
      let legendX = left;
      let legendY = 16;
      config.series.forEach((series) => {
        const itemWidth = context.measureText(series.name).width + 31;
        if (legendX + itemWidth > right) { legendX = left; legendY += 16; }
        context.strokeStyle = series.color;
        context.lineWidth = 2;
        context.beginPath(); context.moveTo(legendX, legendY - 3); context.lineTo(legendX + 12, legendY - 3); context.stroke();
        context.fillStyle = "#667385";
        context.fillText(series.name, legendX + 16, legendY);
        legendX += itemWidth;
      });

      const finite = datasets.flatMap((data) => data.map((point) => point?.[1]).filter(Number.isFinite));
      let minimum = finite.length ? Math.min(...finite) : -1;
      let maximum = finite.length ? Math.max(...finite) : 1;
      if (maximum - minimum < 1e-9) {
        const padding = Math.max(Math.abs(maximum) * 0.1, 0.1);
        minimum -= padding; maximum += padding;
      } else {
        const padding = (maximum - minimum) * 0.1;
        minimum -= padding; maximum += padding;
      }
      const xAt = (value) => left + (value + seconds) / seconds * (right - left);
      const yAt = (value) => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);

      context.lineWidth = 1;
      context.textAlign = "right";
      for (let index = 0; index <= 4; index += 1) {
        const ratio = index / 4;
        const y = bottom - ratio * (bottom - top);
        const value = minimum + ratio * (maximum - minimum);
        context.strokeStyle = "#edf1f5";
        context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
        context.fillStyle = "#778497";
        context.fillText(Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(3), left - 7, y + 4);
      }
      context.textAlign = "center";
      for (let index = 0; index <= 5; index += 1) {
        const value = -seconds + index * seconds / 5;
        const x = xAt(value);
        context.strokeStyle = "#f1f4f7";
        context.beginPath(); context.moveTo(x, top); context.lineTo(x, bottom); context.stroke();
        context.fillStyle = "#778497";
        context.fillText(`${value.toFixed(seconds <= 2 ? 1 : 0)}s`, x, height - 9);
      }
      context.save();
      context.translate(11, (top + bottom) / 2);
      context.rotate(-Math.PI / 2);
      context.fillStyle = "#778497";
      context.fillText(config.unit, 0, 0);
      context.restore();

      datasets.forEach((data, seriesIndex) => {
        context.strokeStyle = config.series[seriesIndex].color;
        context.lineWidth = 1.7;
        context.beginPath();
        let drawing = false;
        for (const point of data) {
          if (!point || !Number.isFinite(point[1])) { drawing = false; continue; }
          const x = xAt(point[0]);
          const y = yAt(point[1]);
          if (!drawing) context.moveTo(x, y); else context.lineTo(x, y);
          drawing = true;
        }
        context.stroke();
      });
      if (!finite.length) {
        context.fillStyle = "#8a96a6";
        context.textAlign = "center";
        context.fillText(t("waiting_for_live_samples", "Waiting for live samples"), (left + right) / 2, (top + bottom) / 2);
      }
    }

    return {
      setOption(option) {
        if (Number.isFinite(option?.xAxis?.min) && option.xAxis.min < 0) seconds = Math.abs(option.xAxis.min);
        if (Array.isArray(option?.series)) {
          datasets = option.series.map((series, index) => Array.isArray(series.data) ? series.data : (datasets[index] || []));
        }
        draw();
      },
      resize: draw,
    };
  }

  function createChart(config) {
    const card = element("article", "chart-card");
    card.dataset.chartId = config.id;
    const head = element("div", "chart-card-head");
    const title = element("strong", "", config.titleKey ? t(config.titleKey, config.title) : config.title);
    if (config.titleKey) title.dataset.i18n = config.titleKey;
    head.append(title, element("span", "", config.unit));
    const body = element("canvas", "chart");
    body.setAttribute("role", "img");
    body.setAttribute("aria-label", `${title.textContent} live waveform`);
    card.append(head, body);
    state.chartCards[config.id] = card;
    state.visibleCharts[config.id] = true;
    const chart = createCanvasChart(body, config);
    chart.setOption(chartOption(config));
    state.charts[config.id] = chart;
    return card;
  }

  function initCharts() {
    elements.kinematicCharts.replaceChildren(...CHARTS.map(createChart));
    elements.mechanicalCharts.replaceChildren(createChart(FSR_CHART));
    if (window.IntersectionObserver) {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const id = entry.target.dataset.chartId;
          state.visibleCharts[id] = entry.isIntersecting;
          if (entry.isIntersecting) state.charts[id]?.resize();
        }
        scheduleChartRender();
      }, { rootMargin: "180px 0px" });
      Object.values(state.chartCards).forEach((card) => observer.observe(card));
    }
  }

  function message(text, error = false) {
    elements.message.textContent = text;
    elements.message.classList.toggle("error", error);
  }

  function setConnection(kind, label, detail) {
    elements.statusPill.className = `status-pill${kind ? ` ${kind}` : ""}`;
    elements.statusLabel.textContent = label;
    elements.connectionText.textContent = detail || "";
  }

  async function api(path, body, timeoutMs = 8000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const options = { signal: controller.signal, cache: "no-store" };
      if (body !== undefined) {
        options.method = "POST";
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(body);
      }
      const shared = path === 'ports' || path === 'discover';
      const response = await fetch(`/api/${shared ? '' : 'device/'}${path}`, options);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw new Error(t("service_timeout", "The local service timed out."));
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function action(callback) {
    if (state.busy) return;
    state.busy = true;
    updateButtons();
    try {
      await callback();
      state.notice = "";
      await poll();
    } catch (error) {
      state.notice = error.message || String(error);
      state.noticeUntil = Date.now() + 9000;
      message(state.notice, true);
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  function sourceChanged() {
    const source = elements.source.value;
    elements.usbFields.hidden = elements.refresh.hidden = source !== "usb";
    elements.wifiFields.hidden = elements.discover.hidden = source !== "wifi";
    try { localStorage.setItem('rigidity.fsr.source', source); } catch {}
    updateButtons();
  }

  function updateButtons() {
    const status = state.status || {};
    const active = Boolean(status.active);
    const recording = Boolean(status.recording);
    elements.connect.disabled = state.busy || active;
    elements.disconnect.disabled = state.busy || !active;
    elements.record.disabled = state.busy || !active || !status.latest || recording;
    elements.zero.disabled = state.busy || !status.can_zero;
    elements.stop.disabled = state.busy || !recording;
    elements.source.disabled = state.busy || active;
    elements.port.disabled = state.busy || active;
    elements.host.disabled = state.busy || active;
    elements.refresh.disabled = state.busy || active;
    elements.discover.disabled = state.busy || active;
    elements.folderName.disabled = state.busy || recording;
    elements.note.disabled = state.busy || recording;
  }

  async function loadPorts() {
    const selected = elements.port.value;
    const result = await api("ports");
    const options = result.ports.map((port) => {
      const name = port.description || port.manufacturer || t("serial_device", "Serial device");
      const chip = port.ch340 ? " · CH340" : port.kind && port.kind !== "unknown" ? ` · ${port.kind.toUpperCase()}` : "";
      return new Option(`${name}${chip} · ${port.device}`, port.device);
    });
    if (!options.length) options.push(new Option(result.available ? t("no_serial_ports", "No serial ports found") : t("install_pyserial", "Install pyserial (see README)"), ""));
    options.unshift(new Option(t("select_board", "Select FSR Board"), ""));
    elements.port.replaceChildren(...options);
    const recommended = result.ports.find((port) => port.recommended);
    if (recommended) elements.port.value = recommended.device;
    else if (selected && result.ports.some((port) => port.device === selected)) elements.port.value = selected;
  }

  function resetLiveState() {
    state.history = [];
    state.after = 0;
    for (const node of Object.values(reportNodes)) node.textContent = t("waiting_for_report", "Waiting for report");
    for (const node of Object.values(metricNodes)) {
      if (node.nodeType === Node.TEXT_NODE) node.nodeValue = "--";
      else node.textContent = node.classList.contains("force-metric-unit") ? "ADC --" : "--";
    }
    for (const config of ALL_CHARTS) {
      state.charts[config.id]?.setOption({ series: config.series.map(() => ({ data: [] })) }, { notMerge: false, lazyUpdate: true });
    }
    scheduleChartRender();
  }

  function ingest(rows, cursorDropped) {
    if (cursorDropped) state.history = [];
    for (const row of rows || []) {
      if (row.index <= state.after && !cursorDropped) continue;
      state.history.push(row);
      state.after = Math.max(state.after, row.index);
    }
    if (!state.history.length) return;
    const newest = state.history[state.history.length - 1].pc_elapsed_ms;
    const cutoff = newest - 60_000;
    let remove = 0;
    while (remove < state.history.length && state.history[remove].pc_elapsed_ms < cutoff) remove += 1;
    if (remove) state.history.splice(0, remove);
    if (state.history.length > MAX_BROWSER_ROWS) state.history.splice(0, state.history.length - MAX_BROWSER_ROWS);
  }

  function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? value.toFixed(digits) : "--";
  }

  function duration(milliseconds) {
    const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map((part) => String(part).padStart(2, "0")).join(":");
  }

  function updateMetrics(status) {
    const row = status.latest;
    elements.inputRate.textContent = `${formatNumber(status.input_rate_hz, 1)} Hz`;
    elements.sampleDt.textContent = row && row.device_dt_us ? `${formatNumber(row.device_dt_us / 1000, 2)} ms` : "-- ms";
    elements.deviceTime.textContent = row ? `${formatNumber(row.device_elapsed_ms / 1000, 3)} s` : "-- s";
    elements.retainedRows.textContent = `${status.retained_rows || 0} ${t("rows", "rows")}`;
    elements.frameHealth.textContent = t("rejected_missing", "{rejected} rejected / {missing} missing", {
      rejected: status.rejected || 0, missing: status.missing || 0,
    });
    elements.calibration.textContent = status.calibrated ? t("bias_zero_complete", "Bias zero complete") : t("calibration_hold", "Hold still · {count} / {target}", {
      count: status.calibration_count || 0, target: status.calibration_target || 200,
    });
    elements.calibration.className = status.calibrated ? "quality-good" : "quality-warning";
    elements.reportStatus.textContent = row ? ["accel", "gyro", "linear", "quat"].map((name) => row[`${name}_status`] ?? "--").join(" / ") : "--";
    elements.attitude.textContent = !status.angle_reference_set ? t("waiting_for_quaternion", "Waiting for quaternion") : !Number.isFinite(row?.theta_mag_deg)
      ? t("quaternion_unavailable", "Quaternion unavailable") : row.attitude_reliable ? t("attitude_ok", "Relative angle · quality OK") : t("attitude_unverified", "Relative angle · quality unverified");
    elements.attitude.className = row?.attitude_reliable ? "quality-good" : "quality-warning";
    elements.motionNotice.textContent = row?.motion_preview
      ? t("motion_live_note", "Live estimates remain visible even before calibration or with unreliable quality. Velocity can drift; gaps start a new zero-velocity segment. Angle zero does not reset velocity.")
      : t("motion_idle_note", "Relative angle uses the first quaternion or manual zero. Velocity uses a separate fixed reference. Quality and numeric estimates are shown independently.");
    elements.pipeline.textContent = status.quality_detail || "--";
    elements.velocity.textContent = !row ? "--" : row.velocity_reliable
      ? (row.stationary ? t("velocity_zeroed", "Zeroed") : t("velocity_short_term", "Short-term estimate")) : row.velocity_estimate_valid ? t("velocity_unreliable", "Unreliable · estimate displayed") : t("velocity_missing", "Missing data · integration paused");

    if (row) {
      for (const group of [...METRIC_GROUPS, ...RAW_GROUPS]) {
        for (const [key] of group.items) {
          const value = formatNumber(row[key], key.startsWith("radius") ? 4 : 3);
          if (metricNodes[key]?.nodeType === Node.TEXT_NODE) metricNodes[key].nodeValue = value;
        }
        if (group.report) {
          const age = row[`${group.report}_age_ms`];
          const accuracy = row[`${group.report}_status`];
          const missing = !Number.isFinite(age) || age === 65535;
          const stale = missing || age > (group.report.endsWith("mag") ? 100 : 30);
          const node = reportNodes[group.report];
          node.textContent = missing ? t("report_unknown", "Report age unknown / unavailable") : t("report_accuracy", "Accuracy {accuracy} / 3 · {age} ms{stale}", {
            accuracy, age, stale: stale ? ` · ${t("stale", "stale")}` : "",
          });
          node.className = `report-quality ${stale || accuracy < 2 ? "quality-warning" : "quality-good"}`;
        }
      }
      for (let index = 0; index < FSR_COUNT; index += 1) {
        metricNodes[`F${index}_V`].nodeValue = formatNumber(row[`F${index}_V`], 3);
        const raw = row[`raw_fsr${index}_adc`];
        metricNodes[`raw_fsr${index}_adc`].textContent = `ADC ${Number.isFinite(raw) ? raw : "--"}`;
      }
    }

    const recording = Boolean(status.recording);
    elements.recordTime.textContent = duration(status.recording_elapsed_ms);
    elements.recordStatus.classList.toggle("active", recording);
    elements.recordStatus.textContent = recording
      ? t("recording_active", "● Recording · {count} samples", { count: status.recorded || 0 })
      : status.path ? t("saved_status", "Saved · {count} samples", { count: status.recorded || 0 }) : t("not_recording_status", "Not recording");
    elements.recordingMetric.textContent = recording
      ? t("recording_metric", "Recording · {count} rows · {time}", { count: status.recorded || 0, time: duration(status.recording_elapsed_ms) })
      : status.record_error || (status.path ? t("saved_metric", "Saved · {count} rows", { count: status.recorded || 0 }) : t("not_recording_status", "Not recording"));
    elements.recordingMetric.style.color = status.record_error ? "#c23b3b" : recording ? "#087f5b" : "";
    elements.recordPath.textContent = status.path || t("save_location", "Save location: {path}", { path: status.data_dir || t("local_data_directory", "local data directory") });
  }

  function updateSensorPanels(status) {
    // The FSR-only firmware reports no IMU. Keep the IMU/kinematic panels out
    // of the way until a firmware build actually streams them.
    const row = status?.latest;
    const hasImu = Boolean(row) && !row.fsr_only && Number.isFinite(row.accel_status);
    if (typeof document.querySelectorAll !== "function") return;
    for (const node of document.querySelectorAll("[data-imu]")) node.hidden = !hasImu;
  }

  function updateStatusUi(status) {
    const row = status.latest;
    if (!status.active) setConnection(status.error ? "error" : "", status.error ? t("status_connection_error", "Connection error") : t("status_disconnected", "Disconnected"), status.error || t("status_acquisition_stopped", "Acquisition stopped"));
    else if (!row) setConnection("waiting", t("status_connected_waiting", "Connected · Waiting for data"), status.quality_detail);
    // This firmware streams eight FSR voltages without an IMU. Treat a finite
    // F0 voltage as live data instead of waiting for BNO080 calibration.
    else if (Number.isFinite(row.F0_V)) setConnection("live", status.source === "demo" ? t("status_demo_live", "Demo · Live") : t("status_connected_source", "Connected · {source}", { source: status.source.toUpperCase() }), status.quality_detail);
    else if (!status.calibrated || !row.attitude_reliable) setConnection("waiting", status.source === "demo" ? t("status_demo_preview", "Demo · Live preview") : t("status_connected_preview", "Connected · Live preview"), status.quality_detail);
    else setConnection("live", status.source === "demo" ? t("status_demo_live", "Demo · Live") : t("status_connected_source", "Connected · {source}", { source: status.source.toUpperCase() }), status.quality_detail);
    if (status.active && elements.source.value !== status.source) {
      elements.source.value = status.source;
      sourceChanged();
    }
    if (state.notice && Date.now() < state.noticeUntil) message(state.notice, true);
    else if (status.record_error) message(status.record_error, true);
    else if (status.error) message(status.error, true);
    else if (status.cursor_dropped) message(t("message_cursor_dropped", "The live display skipped older buffered rows; recording on disk is unaffected."));
    else message(status.active
      ? t("device_message_live", "Live acquisition is running. Use the Record button on the pressure-map page to save.")
      : t("device_message_default", "Connect starts live acquisition only. Use the Record button on the pressure-map page to save and export data."));
    updateMetrics(status);
    updateSensorPanels(status);
    updateButtons();
    scheduleChartRender();
  }

  async function poll() {
    if (state.polling) return;
    state.polling = true;
    try {
      const status = await api(`status?after=${state.after}`, undefined, 5000);
      const generationChanged = state.generation !== null && state.generation !== status.generation;
      if (generationChanged) {
        resetLiveState();
        state.generation = status.generation;
        // The request used a cursor from the old connection. Fetch the new
        // ring on the next poll rather than mixing sessions.
      } else {
        state.generation = status.generation;
        ingest(status.rows, status.cursor_dropped);
      }
      state.status = status;
      updateStatusUi(status);
    } catch (error) {
      state.status = null;
      setConnection("error", t("status_service_unavailable", "Local service unavailable"), error.message || String(error));
      message(t("message_service_unavailable", "Local service unavailable: {error}", { error: error.message || error }), true);
      updateButtons();
    } finally {
      state.polling = false;
    }
  }

  function firstVisibleIndex(rows, cutoff) {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (rows[middle].pc_elapsed_ms < cutoff) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function plotPoints(rows, key, now) {
    const point = (row) => [(row.pc_elapsed_ms - now) / 1000, Number.isFinite(row[key]) ? row[key] : null];
    const hasBreak = (index) => index > 0 && (rows[index].missing_before || rows[index].boot_id !== rows[index - 1].boot_id
      || rows[index].imu_reset_count !== rows[index - 1].imu_reset_count
      || ((key.startsWith('v_') || /^v[xyz]_/.test(key)) && rows[index].velocity_segment !== rows[index - 1].velocity_segment)
      || (key.startsWith("theta_") && rows[index].angle_reference_id !== rows[index - 1].angle_reference_id));
    if (rows.length <= MAX_PLOT_POINTS) {
      const output = [];
      rows.forEach((row, index) => {
        if (hasBreak(index)) output.push([(row.pc_elapsed_ms - now) / 1000, null]);
        output.push(point(row));
      });
      return output;
    }
    const bucketSize = Math.ceil(rows.length / (MAX_PLOT_POINTS / 2));
    const output = [];
    for (let start = 0; start < rows.length; start += bucketSize) {
      const end = Math.min(rows.length, start + bucketSize);
      let minimum = null;
      let maximum = null;
      let discontinuity = false;
      for (let index = start; index < end; index += 1) {
        discontinuity ||= hasBreak(index);
        const value = rows[index][key];
        if (!Number.isFinite(value)) continue;
        if (!minimum || value < minimum.value) minimum = { index, value };
        if (!maximum || value > maximum.value) maximum = { index, value };
      }
      if (discontinuity || !minimum) output.push([(rows[start].pc_elapsed_ms - now) / 1000, null]);
      else {
        const ordered = minimum.index <= maximum.index ? [minimum, maximum] : [maximum, minimum];
        for (const item of ordered) output.push(point(rows[item.index]));
      }
    }
    return output;
  }

  function renderCharts() {
    if (!state.history.length || document.hidden) return;
    const seconds = Math.max(1, Number(elements.history.value) || 10);
    const now = state.history[state.history.length - 1].pc_elapsed_ms;
    const start = firstVisibleIndex(state.history, now - seconds * 1000);
    const rows = state.history.slice(start);
    for (const config of ALL_CHARTS) {
      if (!state.visibleCharts[config.id]) continue;
      const chart = state.charts[config.id];
      if (!chart) continue;
      chart.setOption({
        xAxis: { min: -seconds, max: 0, interval: seconds <= 2 ? 0.5 : seconds <= 10 ? 2 : seconds <= 30 ? 5 : 10 },
        series: config.series.map((series) => ({ data: plotPoints(rows, series.key, now) })),
      }, { notMerge: false, lazyUpdate: true });
    }
  }

  function scheduleChartRender() {
    if (state.chartTimer !== null) return;
    state.chartTimer = window.setTimeout(() => {
      state.chartTimer = null;
      renderCharts();
    }, CHART_INTERVAL_MS);
  }

  function setupEvents() {
    elements.source.addEventListener("change", sourceChanged);
    elements.history.addEventListener("change", () => {
      try { localStorage.setItem("rigidity.supermini.history", elements.history.value); } catch {}
      scheduleChartRender();
    });
    elements.refresh.addEventListener("click", () => action(loadPorts));
    elements.discover.addEventListener("click", () => action(async () => {
      const result = await api("discover", undefined, 7000);
      if (result.devices.length === 1) {
        elements.host.value = result.devices[0].host;
        message(t("discover_found", "Found compatible ESP32 at {host}.", { host: result.devices[0].host }));
      } else if (result.devices.length > 1) {
        const select = $('discovered');
        select.replaceChildren(new Option(t("discover_select", "Select this ESP32 IP…"), ''), ...result.devices.map(item => new Option(`${item.host} · ${item.firmware}`, item.host)));
        select.hidden = false;
        select.onchange = () => { if (select.value) elements.host.value = select.value; };
      } else throw new Error(t("discover_none", "No compatible ESP32 found. Check Wi-Fi or enter its IP manually."));
    }));
    elements.connect.addEventListener("click", () => action(async () => {
      resetLiveState();
      await api("connect", { source: elements.source.value, port: elements.port.value, host: elements.host.value, tcp_port: 9000 });
    }));
    elements.disconnect.addEventListener("click", () => action(async () => { await api("disconnect", {}); }));
    elements.zero.addEventListener("click", () => action(async () => { await api("zero", {}); }));
    elements.record.addEventListener("click", () => action(async () => {
      await api("record/start", { folder_name: elements.folderName.value, note: elements.note.value });
    }));
    elements.stop.addEventListener("click", () => action(async () => { await api("record/stop", {}); }));
    window.addEventListener("resize", () => Object.values(state.charts).forEach((chart) => chart.resize()));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleChartRender(); });
  }

  function loadPreferences() {
    try {
      const source = localStorage.getItem('rigidity.fsr.source');
      const history = localStorage.getItem("rigidity.supermini.history");
      if (["usb", "demo"].includes(source)) elements.source.value = source;
      if ([...elements.history.options].some((option) => option.value === history)) elements.history.value = history;
    } catch {}
  }

  function start() {
    createMetrics();
    initCharts();
    loadPreferences();
    setupEvents();
    sourceChanged();
    setConnection("", t("status_disconnected", "Disconnected"), t("connection_waiting_service", "Waiting for the local acquisition service."));
    loadPorts().catch((error) => message(error.message, true));
    const tick = async () => {
      await poll();
      window.setTimeout(tick, 100);
    }
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin) return;
      if (event.data?.type !== "fsr-language") return;
      void loadLanguage(event.data.lang);
    });
    void loadLanguage("en");
    void tick();
  }

  start();
})();
