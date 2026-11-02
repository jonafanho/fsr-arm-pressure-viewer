// Exercise the shipped page's display logic with a small DOM stand-in.
// No browser, device, or running acquisition service is required.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const root = path.resolve(__dirname, "..");

function loadPage() {
  function node() {
    return { children: [], style: {}, dataset: {}, nodeType: 1, value: "usb", textContent: "",
      classList: { toggle() {}, contains() { return false; } },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; } };
  }
  const nodes = Object.fromEntries([...fs.readFileSync(path.join(root, "device.html"), "utf8")
    .matchAll(/id="([^"]+)"/g)].map((match) => [match[1], node()]));
  const context = vm.createContext({
    document: {
      getElementById(id) { assert.ok(nodes[id], `Missing page element: ${id}`); return nodes[id]; },
      createElement: node,
      createTextNode(value) { return { nodeType: 3, nodeValue: value }; },
    },
    URLSearchParams, AbortController,
    Node: { TEXT_NODE: 3 }, window: { location: {search:""}, setTimeout() { return 1; }, clearTimeout() {} },
    fetch: async (url, options) => { calls.push({url,options}); return {ok:true,json:async()=>({ok:true})}; },
  });
  const calls=[];
  const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.ok(source.includes("  start();"));
  vm.runInContext(source.replace("  start();",
    "  globalThis.ui = { api, createMetrics, updateStatusUi, ingest, plotPoints, state, metricNodes, reportNodes, CHARTS };"), context);
  context.ui.createMetrics();
  return { ui: context.ui, nodes, calls };
}

function status(row = {}) {
  return { active: true, source: "usb", calibrated: false, calibration_count: 0, calibration_target: 200,
    angle_reference_set: true, can_zero: true, received: 2, sensor_faults: 2,
    latest: { index: 2, pc_elapsed_ms: 20, boot_id: 1, imu_reset_count: 1, angle_reference_id: 1,
      theta_z_deg: 7.58, theta_mag_deg: 7.58, omega_z_deg_s: 1.2, ax_kin_m_s2: 0.1,
      radius_mag_m: null, v_mag_m_s: null, accel_z_m_s2: 9.8, mag_x_uT: 260,
      accel_status: 2, gyro_status: 3, mag_status: 0, linear_status: 3, quat_status: 0,
      accel_age_ms: 5, gyro_age_ms: 5, mag_age_ms: 5, linear_age_ms: 5, quat_age_ms: 5,
      attitude_reliable: 0, magnetic_reliable: 0, motion_preview: 1, ...row } };
}

test("uncalibrated samples appear in readings and waveform points with warnings", () => {
  const { ui, nodes } = loadPage();
  const snapshot = status();
  ui.state.status = snapshot;
  ui.updateStatusUi(snapshot);
  ui.ingest([snapshot.latest], false);
  assert.equal(nodes.statusLabel.textContent, "Connected · Live preview");
  assert.match(nodes["metric-calibration"].textContent, /Hold still/);
  assert.match(nodes["metric-attitude_quality"].textContent, /unverified/);
  assert.equal(ui.metricNodes.theta_z_deg.nodeValue, "7.580");
  assert.equal(ui.metricNodes.accel_z_m_s2.nodeValue, "9.800");
  assert.equal(ui.metricNodes.mag_x_uT, undefined);
  assert.equal(ui.metricNodes.v_mag_m_s.nodeValue, "--");
  assert.equal(ui.reportNodes.mag, undefined);
  assert.equal(ui.plotPoints(ui.state.history, "theta_z_deg", 20)[0][1], 7.58);
  assert.equal(nodes.zero.disabled, false);
});

test('disabled IMU reports take no space while FSR ADC remains visible', () => {
  const {ui, nodes} = loadPage();
  assert.equal(nodes.rawMetrics.children.length, 4);
  for (const field of ['raw_accel_x_counts', 'raw_gyro_x_counts', 'raw_mag_x_counts', 'mag_x_uT']) {
    assert.equal(ui.metricNodes[field], undefined);
  }
  assert.ok(!ui.CHARTS.some(chart => ['raw_mag', 'raw_raw_accel', 'raw_raw_gyro', 'raw_raw_mag'].includes(chart.id)));
  assert.equal(ui.metricNodes.raw_fsr2_adc.textContent, 'ADC --');
  assert.equal(nodes['metric-magnetic_quality'], undefined);
  const snapshot = status({ raw_fsr2_adc: 2481 });
  ui.updateStatusUi(snapshot);
  assert.equal(ui.metricNodes.raw_fsr2_adc.textContent, 'ADC 2481');
  assert.equal(nodes['metric-report_status'].textContent, '2 / 3 / 3 / 0');
});

test('unreliable velocity is numeric in metrics and waveform, with a warning', () => {
  const {ui,nodes}=loadPage();
  const snapshot=status({vx_m_s:.42,v_mag_m_s:.42,velocity_estimate_valid:1,velocity_reliable:0,velocity_segment:1});
  ui.state.status=snapshot;ui.updateStatusUi(snapshot);ui.ingest([snapshot.latest],false);
  assert.equal(ui.metricNodes.v_mag_m_s.nodeValue,'0.420');
  assert.match(nodes['metric-velocity_quality'].textContent,/Unreliable.*displayed/);
  assert.equal(ui.plotPoints(ui.state.history,'vx_m_s',20)[0][1],.42);
  const next={...snapshot.latest,index:3,pc_elapsed_ms:30,velocity_segment:2,vx_m_s:0};
  assert.equal(ui.plotPoints([snapshot.latest,next],'vx_m_s',30)[1][1],null);
});

test('one board uses the device routes; discovery stays shared', async () => {
  const {ui,calls}=loadPage();
  await ui.api('status?after=5');await ui.api('connect',{source:'usb',port:'COM9'});await ui.api('discover');
  assert.equal(calls[0].url,'/api/device/status?after=5');
  assert.equal(calls[1].url,'/api/device/connect');
  assert.equal(calls[2].url,'/api/discover');
});

test('single-board session keeps recording controls usable and reports a lost connection', () => {
  const nodes={};
  for(const id of ['downloadLatest','refreshRecordings','recordingsList','reconnect','quickStatus','record','stop','folderName','note','sessionTime','sessionStatus','recordPath','summary','detail','message']) nodes[id]={addEventListener(){}};
  const context=vm.createContext({document:{getElementById:id=>nodes[id],querySelector:()=>null,querySelectorAll:()=>[],documentElement:{}},Date,
    setTimeout(){},AbortSignal,fetch:async()=>({ok:true,json:async()=>({})}),console});
  nodes.record.addEventListener=nodes.stop.addEventListener=()=>{};
  vm.runInContext(fs.readFileSync(path.join(root,'duo.js'),'utf8').replace('void tick();','globalThis.renderDuo=render;'),context);
  const a={active:false,error:'Cable removed',recorded:50};
  context.renderDuo({recording:true,path:'trial',elapsed_ms:1000,device:a});
  assert.equal(nodes.stop.disabled,false);
  assert.equal(nodes.record.disabled,true);
  assert.match(nodes.message.textContent,/Cable removed/);
  assert.match(nodes.summary.textContent,/connection lost/);
  assert.match(nodes.detail.textContent,/Not recording.*50 samples/);

  const live={active:true,recording:true,source:'usb',input_rate_hz:100,recorded:100,
    latest:{pc_epoch_ms:Date.now(),fsr_only:true,protocol_version:3,raw_complete:0}};
  context.renderDuo({recording:true,path:'trial',elapsed_ms:1000,device:live});
  assert.equal(nodes.stop.disabled,false);
  assert.equal(nodes.record.disabled,true);
  assert.match(nodes.summary.textContent,/Live.*USB.*100.0 Hz/);
  assert.match(nodes.detail.textContent,/8 FSR firmware/);
});

test("calibration success and current reliability are independent", () => {
  const { ui, nodes } = loadPage();
  const snapshot = { ...status(), calibrated: true };
  ui.state.status = snapshot;
  ui.updateStatusUi(snapshot);
  assert.equal(nodes["metric-calibration"].textContent, "Bias zero complete");
  assert.match(nodes["metric-attitude_quality"].textContent, /unverified/);
  snapshot.latest.attitude_reliable = 1;
  ui.updateStatusUi(snapshot);
  assert.equal(nodes.statusLabel.textContent, "Connected · USB");
  assert.match(nodes["metric-attitude_quality"].textContent, /quality OK/);
});

test("missing quaternion stays unavailable; manual zero breaks only angle traces", () => {
  const { ui, nodes } = loadPage();
  const snapshot = { ...status({ theta_z_deg: null, theta_mag_deg: null, quat_age_ms: 65535 }), can_zero: false };
  ui.state.status = snapshot;
  ui.updateStatusUi(snapshot);
  assert.equal(ui.metricNodes.theta_z_deg.nodeValue, "--");
  assert.equal(nodes.zero.disabled, true);
  assert.match(ui.reportNodes.quat.textContent, /unavailable/);
  const first = status().latest;
  const second = { ...first, pc_elapsed_ms: 30, angle_reference_id: 2, theta_z_deg: 0 };
  const points = ui.plotPoints([first, second], "theta_z_deg", 30);
  assert.equal(points.length, 3);
  assert.equal(points[1][1], null);
  assert.equal(ui.plotPoints([first, second], "mag_x_uT", 30).length, 2);
});
