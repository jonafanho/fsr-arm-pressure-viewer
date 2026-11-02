"""Local acquisition and recording service for one ESP32 FSR board.

The service, rather than the browser, owns USB/TCP reads and CSV writes.  Live
rows are kept in a bounded ring while an active recording is streamed directly
to disk, so a slow, suspended, or closed tab cannot exhaust memory or stop a
recording.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import socket
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

FRONTEND = Path(__file__).resolve().parent
DATA_DIR = FRONTEND / "data"
sys.path.insert(0, str(FRONTEND / ".deps"))
try:
    import serial
    from serial.tools import list_ports
except ImportError:  # The demo remains usable without pyserial.
    serial = list_ports = None

from protocol import Parser, encode_demo, EXTRA_FIELDS

FSR_COUNT = 8
ADC_MAX = 4095.0
ADC_VCC = 3.3
GRAVITY = 9.80665
RAD_TO_DEG = 180.0 / math.pi
CALIBRATION_SAMPLES = 200
CALIBRATION_FUSED_MAX_AGE_MS = 50
VELOCITY_LINEAR_MAX_AGE_MS = 50
VELOCITY_REPORT_MAX_DT_S = 0.06
MAX_INTEGRATION_SECONDS = 10.0
LIVE_RING_ROWS = 7000
MAX_STATUS_ROWS = 1500

KINEMATIC_FIELDS = [
    "radius_x_m", "radius_y_m", "radius_z_m", "radius_mag_m",
    "vx_m_s", "vy_m_s", "vz_m_s", "v_mag_m_s",
    "ax_kin_m_s2", "ay_kin_m_s2", "az_kin_m_s2", "a_kin_mag_m_s2",
    "theta_x_deg", "theta_y_deg", "theta_z_deg", "theta_mag_deg",
    "omega_x_deg_s", "omega_y_deg_s", "omega_z_deg_s", "omega_mag_deg_s",
    "alpha_x_deg_s2", "alpha_y_deg_s2", "alpha_z_deg_s2", "alpha_mag_deg_s2",
]
QUALITY_FIELDS = [
    "imu_valid", "magnetic_reliable", "attitude_reliable", "velocity_reliable",
    "stationary", "timing_gap", "orientation_jump", "gyro_clipped",
    "mag_norm_uT", "heading_accuracy_deg", "seconds_since_zupt",
    "calibration_complete", "motion_preview", "angle_reference_id",
]
RAW_VECTOR_FIELDS = [
    *(f"accel_{axis}_m_s2" for axis in "xyz"),
    *(f"gyro_{axis}_rad_s" for axis in "xyz"),
    *(f"mag_{axis}_uT" for axis in "xyz"),
    *(f"linear_{axis}_m_s2" for axis in "xyz"),
    "quat_w", "quat_x", "quat_y", "quat_z",
]
CSV_FIELDS = [
    "pc_time_iso", "pc_epoch_ms", "pc_elapsed_ms", "source", "index", "boot_id",
    "sample_id", "device_time_us", "device_elapsed_ms", "device_dt_us", "missing_before",
    "flags", "imu_reset_count", *RAW_VECTOR_FIELDS, "heading_accuracy_rad",
    *(f"{name}_status" for name in ("accel", "gyro", "mag", "linear", "quat")),
    "fresh_mask", *(f"{name}_age_ms" for name in ("accel", "gyro", "mag", "linear", "quat")),
    *(f"{name}_sequence" for name in ("accel", "gyro", "mag", "linear", "quat")),
    "bno_diagnostic_code", *(f"raw_fsr{i}_adc" for i in range(FSR_COUNT)),
    *(f"F{i}_V" for i in range(FSR_COUNT)), *KINEMATIC_FIELDS, *QUALITY_FIELDS, "crc32",
]
CSV_FIELDS += EXTRA_FIELDS + ['session_elapsed_ms', 'velocity_estimate_valid',
    'velocity_preview', 'velocity_segment', 'velocity_reason', 'radius_reliable', 'raw_complete']


def magnitude(values) -> float:
    return math.sqrt(sum(value * value for value in values))


def finite_vector(values, length=3) -> bool:
    return len(values) == length and all(math.isfinite(value) for value in values)


def subtract(left, right):
    return [value - right[index] for index, value in enumerate(left)]


def average(values, count):
    return [value / count for value in values]


def normalize_quaternion(value):
    norm = magnitude(value)
    return [component / norm for component in value] if math.isfinite(norm) and norm > 1e-12 else [1.0, 0.0, 0.0, 0.0]


def quaternion_conjugate(value):
    return [value[0], -value[1], -value[2], -value[3]]


def quaternion_multiply(left, right):
    w, x, y, z = left
    a, b, c, d = right
    return [w*a-x*b-y*c-z*d, w*b+x*a+y*d-z*c, w*c-x*d+y*a+z*b, w*d+x*c-y*b+z*a]


def rotate_body_to_world(quaternion, vector):
    return quaternion_multiply(
        quaternion_multiply(quaternion, [0.0, *vector]),
        quaternion_conjugate(quaternion),
    )[1:]


def quaternion_distance(left, right):
    value = abs(sum(a * b for a, b in zip(left, right)))
    return 2.0 * math.acos(max(0.0, min(1.0, value)))


def rotation_vector_deg(quaternion):
    value = list(quaternion)
    if value[0] < 0:
        value = [-component for component in value]
    vector_norm = magnitude(value[1:])
    if vector_norm < 1e-12:
        return [0.0, 0.0, 0.0]
    factor = 2.0 * math.atan2(vector_norm, value[0]) * RAD_TO_DEG / vector_norm
    return [component * factor for component in value[1:]]


def low_pass(previous, value, dt, tau):
    gain = 1.0 - math.exp(-dt / tau) if dt > 0 else 0.0
    return [old + gain * (new - old) for old, new in zip(previous, value)]


def solve_3x3(matrix, vector):
    a, b, c, d, e, f, g, h, i = matrix
    determinant = a * (e*i-f*h) - b * (d*i-f*g) + c * (d*h-e*g)
    if not math.isfinite(determinant) or abs(determinant) < 1e-12:
        return None
    inverse = [e*i-f*h, c*h-b*i, b*f-c*e, f*g-d*i, a*i-c*g, c*d-a*f,
               d*h-e*g, b*g-a*h, a*e-b*d]
    inverse = [value / determinant for value in inverse]
    return [sum(inverse[row*3+column] * vector[column] for column in range(3)) for row in range(3)]


def estimate_radius(acceleration, omega_deg, alpha_deg):
    omega = [value / RAD_TO_DEG for value in omega_deg]
    alpha = [value / RAD_TO_DEG for value in alpha_deg]
    if magnitude(omega) < 0.25 and magnitude(alpha) < 0.8:
        return [math.nan] * 3
    wx, wy, wz = omega
    ax, ay, az = alpha
    squared = wx*wx + wy*wy + wz*wz
    motion = [wx*wx-squared, wx*wy-az, wx*wz+ay,
              wy*wx+az, wy*wy-squared, wy*wz-ax,
              wz*wx-ay, wz*wy+ax, wz*wz-squared]
    normal = [0.0] * 9
    right = [0.0] * 3
    for row in range(3):
        for column in range(3):
            right[column] += motion[row*3+column] * acceleration[row]
            for inner in range(3):
                normal[column*3+inner] += motion[row*3+column] * motion[row*3+inner]
    regularization = max((normal[0] + normal[4] + normal[8]) * 1e-6, 1e-8)
    normal[0] += regularization
    normal[4] += regularization
    normal[8] += regularization
    radius = solve_3x3(normal, right)
    return radius if radius and all(math.isfinite(v) for v in radius) and magnitude(radius) <= 1.0 else [math.nan] * 3


class MotionProcessor:
    """BNO08X quality gates and short-term dynamics calculation."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.integration_reference = None
        self.estimate_velocity = [0.0] * 3
        self.estimate_acceleration = None
        self.estimate_time = None
        self.estimate_sequence = None
        self.estimate_sample_time = None
        self.estimate_sample_id = None
        self.velocity_segment = 0
        self.display_reference = None
        self.angle_reference_id = 0
        self.preview_gyro = None
        self.preview_gyro_time_us = None
        self.preview_gyro_sequence = None
        self.preview_alpha = [math.nan] * 3
        self.calibration_count = 0
        self.gyro_sum = [0.0] * 3
        self.linear_sum = [0.0] * 3
        self.mag_sum = [0.0] * 3
        self.mag_count = 0
        self.quat_sum = [0.0] * 4
        self.first_quaternion = None
        self.last_cal_sequence = None
        self.reference = None
        self.magnetic_reference = None
        self.gyro_bias = [0.0] * 3
        self.linear_bias = [0.0] * 3
        self.previous_time_us = None
        self.previous_sample_id = None
        self.reset_count = None
        self.previous_quaternion = None
        self.previous_quaternion_time_us = None
        self.previous_quat_sequence = None
        self.previous_gyro_sequence = None
        self.previous_gyro_time_us = None
        self.omega = None
        self.alpha = [0.0] * 3
        self.acceleration = None
        self.world_acceleration = None
        self.velocity = [0.0] * 3
        self.velocity_reliable = False
        self.stationary_seconds = 0.0
        self.seconds_since_zupt = 0.0
        self.magnetic_good_seconds = 0.0

    @property
    def calibrated(self):
        return self.reference is not None

    def quality(self, raw):
        core = (0, 1, 3, 4)
        q_norm = magnitude(raw["quaternion"])
        gyro_clipped = any(abs(value) >= 34.8 for value in raw["gyro"])
        imu_valid = not (raw["flags"] & 0x09) \
            and all(raw["ages_ms"][i] <= 30 and raw["statuses"][i] >= 1 for i in core) \
            and all(finite_vector(raw[name], 4 if name == "quaternion" else 3)
                    for name in ("accel", "gyro", "linear", "quaternion")) \
            and 0.95 <= q_norm <= 1.05 and not gyro_clipped
        mag_norm = magnitude(raw["mag"])
        magnetic = imu_valid and not (raw["flags"] & 0x02) \
            and raw["ages_ms"][2] <= 100 and raw["statuses"][2] >= 2 and raw["statuses"][4] >= 2 \
            and math.isfinite(raw["heading_accuracy"]) and 0 <= raw["heading_accuracy"] <= math.pi / 12 \
            and finite_vector(raw["mag"]) and 15 <= mag_norm <= 100
        if magnetic and self.magnetic_reference:
            q = normalize_quaternion(raw["quaternion"])
            world_mag = rotate_body_to_world(q, raw["mag"])
            reference_norm = magnitude(self.magnetic_reference)
            cosine = sum(a*b for a, b in zip(world_mag, self.magnetic_reference)) / (mag_norm * reference_norm)
            direction_error = math.acos(max(-1.0, min(1.0, cosine)))
            magnetic = abs(mag_norm - reference_norm) <= reference_norm * 0.25 and direction_error <= math.radians(25)
        return {
            "imu_valid": bool(imu_valid), "magnetic_reliable": bool(magnetic),
            "gyro_clipped": bool(gyro_clipped), "mag_norm_uT": mag_norm,
            "heading_accuracy_deg": raw["heading_accuracy"] * RAD_TO_DEG,
        }

    def _reset_calibration_samples(self):
        self.calibration_count = 0
        self.gyro_sum = [0.0] * 3
        self.linear_sum = [0.0] * 3
        self.mag_sum = [0.0] * 3
        self.mag_count = 0
        self.quat_sum = [0.0] * 4
        self.first_quaternion = None
        self.last_cal_sequence = None

    def _calibrate(self, raw, time_us):
        dt = None if self.previous_time_us is None else (time_us - self.previous_time_us) / 1e6
        sample_delta = None if self.previous_sample_id is None else (
            raw["sample_id"] - self.previous_sample_id) & 0xFFFFFFFF
        gap = dt is not None and (dt <= 0 or dt > 0.03 or sample_delta != 1)
        reset = self.reset_count is not None and raw["reset_count"] != self.reset_count
        # Bias-zero calibration needs stable numeric motion reports, not a
        # magnetometer or high SH-2 accuracy grades. Keep those grades in the
        # independent reliability indicators below.
        q = self.display_quaternion(raw["quaternion"])
        reports_ready = q is not None and all(
            raw["ages_ms"][index] <= CALIBRATION_FUSED_MAX_AGE_MS for index in (0, 3)) \
            and all(raw["ages_ms"][index] <= 30 for index in (1, 4)) \
            and all(finite_vector(raw[name]) for name in ("accel", "gyro", "linear"))
        moved = not reports_ready or magnitude(raw["gyro"]) > math.radians(1) \
            or abs(magnitude(raw["accel"]) - GRAVITY) > 0.3 or magnitude(raw["linear"]) > 0.2 \
            or (self.first_quaternion is not None
                and quaternion_distance(q, self.first_quaternion) > math.radians(2))
        if gap or reset or moved:
            self._reset_calibration_samples()
        self.previous_time_us = time_us
        self.previous_sample_id = raw["sample_id"]
        self.reset_count = raw["reset_count"]
        if moved:
            return
        if raw["sequences"][1] == self.last_cal_sequence or not (raw["fresh_mask"] & 0x02):
            return
        self.last_cal_sequence = raw["sequences"][1]
        self.first_quaternion = self.first_quaternion or q
        sign = -1.0 if sum(a*b for a, b in zip(q, self.first_quaternion)) < 0 else 1.0
        for index in range(3):
            self.gyro_sum[index] += raw["gyro"][index]
            self.linear_sum[index] += raw["linear"][index]
        if raw["ages_ms"][2] <= 100 and finite_vector(raw["mag"]) \
                and 15 <= magnitude(raw["mag"]) <= 100:
            world_mag = rotate_body_to_world(q, raw["mag"])
            for index in range(3):
                self.mag_sum[index] += world_mag[index]
            self.mag_count += 1
        for index in range(4):
            self.quat_sum[index] += sign * q[index]
        self.calibration_count += 1
        if self.calibration_count >= CALIBRATION_SAMPLES:
            self.reference = normalize_quaternion(self.quat_sum)
            self.magnetic_reference = average(self.mag_sum, self.mag_count) if self.mag_count else None
            self.gyro_bias = average(self.gyro_sum, self.calibration_count)
            self.linear_bias = average(self.linear_sum, self.calibration_count)
            self.previous_quaternion = self.reference
            self.previous_quaternion_time_us = time_us
            self.velocity_reliable = True
            self.magnetic_good_seconds = 0.5

    def process(self, raw, time_us):
        # Display and precision dynamics have separate references. A numeric
        # quaternion can be shown even when its accuracy status is 0.
        if self.reset_count is not None and raw["reset_count"] != self.reset_count:
            self.reset()
        previous_time = self.previous_time_us
        previous_sample = self.previous_sample_id
        gap = previous_time is not None and (
            not 0 < time_us - previous_time <= 30_000
            or (raw["sample_id"] - previous_sample) & 0xFFFFFFFF != 1)
        values, quality = self._process_dynamics(raw, time_us)
        values["timing_gap"] = int(gap)
        q = self.display_quaternion(raw["quaternion"])
        if q is not None:
            if self.display_reference is None:
                self.set_display_reference(raw["quaternion"])
            theta = rotation_vector_deg(quaternion_multiply(
                quaternion_conjugate(self.display_reference), q))
        else:
            theta = [math.nan] * 3
        self._put_vector(values, ("theta_x_deg", "theta_y_deg", "theta_z_deg", "theta_mag_deg"), theta)

        # Missing/NaN reports remain unavailable. Low accuracy alone does not
        # suppress their numeric values; the original reports are also exposed.
        gyro = subtract(raw["gyro"], self.gyro_bias) if finite_vector(raw["gyro"]) else [math.nan] * 3
        omega = [value * RAD_TO_DEG for value in gyro]
        if gap or raw["ages_ms"][1] > 30 or not finite_vector(omega):
            self.preview_gyro = None
            self.preview_alpha = [math.nan] * 3
            self.preview_gyro_sequence = None
        if finite_vector(omega) and raw["ages_ms"][1] <= 30 and raw["sequences"][1] != self.preview_gyro_sequence:
            dt = None if self.preview_gyro_time_us is None else (time_us - self.preview_gyro_time_us) / 1e6
            self.preview_alpha = [(a-b) / dt for a, b in zip(omega, self.preview_gyro)] \
                if self.preview_gyro is not None and dt is not None and 0 < dt <= 0.03 else [math.nan] * 3
            self.preview_gyro = omega
            self.preview_gyro_time_us = time_us
            self.preview_gyro_sequence = raw["sequences"][1]
        preview = False
        for names, vector in (
            (("ax_kin_m_s2", "ay_kin_m_s2", "az_kin_m_s2", "a_kin_mag_m_s2"),
             subtract(raw["linear"], self.linear_bias)),
            (("omega_x_deg_s", "omega_y_deg_s", "omega_z_deg_s", "omega_mag_deg_s"), omega),
            (("alpha_x_deg_s2", "alpha_y_deg_s2", "alpha_z_deg_s2", "alpha_mag_deg_s2"), self.preview_alpha),
        ):
            if not math.isfinite(values[names[0]]) and finite_vector(vector):
                self._put_vector(values, names, vector)
                preview = True
        values.update(calibration_complete=int(self.calibrated), motion_preview=int(preview),
                      angle_reference_id=self.angle_reference_id)
        self._visible_estimates(raw, time_us, values)
        return values, quality

    def _visible_estimates(self, raw, time_us, values):
        """Integrate numeric reports independently of accuracy/calibration gates.

        All estimates use a fixed first-quaternion frame. Manual angle zeroing
        does not rotate this frame. A missing interval starts a new zero-initial
        velocity segment: never integrate across missing data or repeated reports.
        """
        q = self.display_quaternion(raw['quaternion'])
        valid = q is not None and finite_vector(raw['linear']) \
            and raw['ages_ms'][3] <= VELOCITY_LINEAR_MAX_AGE_MS and raw['ages_ms'][4] <= 30
        gap = self.estimate_sample_time is not None and (
            not 0 < time_us - self.estimate_sample_time <= 30_000
            or (raw['sample_id'] - self.estimate_sample_id) & 0xffffffff != 1)
        self.estimate_sample_time, self.estimate_sample_id = time_us, raw['sample_id']
        if not valid or gap:
            self.estimate_time = None
            self.estimate_sequence = None
            self.estimate_acceleration = None
            self.estimate_velocity = [0.0] * 3
        if not valid:
            velocity = [math.nan] * 3
            reason = 'Missing/stale linear acceleration or quaternion'
        else:
            if self.integration_reference is None:
                self.integration_reference = list(q)
            relative = quaternion_multiply(quaternion_conjugate(self.integration_reference), q)
            world = rotate_body_to_world(relative, subtract(raw['linear'], self.linear_bias))
            if self.estimate_time is None:
                self.velocity_segment += 1
                self.estimate_time, self.estimate_sequence = time_us, raw['sequences'][3]
                self.estimate_acceleration = world
            elif raw['sequences'][3] != self.estimate_sequence:
                dt = (time_us - self.estimate_time) / 1e6
                if 0 < dt <= VELOCITY_REPORT_MAX_DT_S:
                    filtered = low_pass(self.estimate_acceleration, world, dt, 0.0448)
                    self.estimate_velocity = [v + (a + b)*0.5*dt for v, a, b in
                        zip(self.estimate_velocity, self.estimate_acceleration, filtered)]
                    self.estimate_acceleration = filtered
                else:
                    self.velocity_segment += 1
                    self.estimate_velocity = [0.0] * 3
                    self.estimate_acceleration = world
                self.estimate_time, self.estimate_sequence = time_us, raw['sequences'][3]
            if values['stationary']:
                self.estimate_velocity = [0.0] * 3
                self.estimate_acceleration = [0.0] * 3
            velocity = self.estimate_velocity
            reason = 'Quality OK' if values['velocity_reliable'] else 'Unverified estimate; drift possible'
            if gap:
                reason = 'Data gap; new segment starts at zero velocity'
        reliable = bool(values['velocity_reliable'] and valid and not gap)
        values.update(velocity_estimate_valid=int(valid), velocity_preview=int(valid and not reliable),
                      velocity_reliable=int(reliable), velocity_segment=self.velocity_segment,
                      velocity_reason=reason)
        self._put_vector(values, ('vx_m_s', 'vy_m_s', 'vz_m_s', 'v_mag_m_s'), velocity)
        values['radius_reliable'] = int(values['attitude_reliable'] and math.isfinite(values['radius_mag_m']))
        if not math.isfinite(values['radius_mag_m']) and valid and raw['ages_ms'][1] <= 30:
            vectors = [[values[k] for k in names] for names in (
                ('ax_kin_m_s2', 'ay_kin_m_s2', 'az_kin_m_s2'),
                ('omega_x_deg_s', 'omega_y_deg_s', 'omega_z_deg_s'),
                ('alpha_x_deg_s2', 'alpha_y_deg_s2', 'alpha_z_deg_s2'))]
            if all(finite_vector(v) for v in vectors):
                self._put_vector(values, ('radius_x_m', 'radius_y_m', 'radius_z_m', 'radius_mag_m'), estimate_radius(*vectors))
        values['motion_preview'] |= int(valid and not reliable)

    @staticmethod
    def _put_vector(values, names, vector):
        for name, value in zip(names, [*vector, magnitude(vector)]):
            values[name] = value

    @staticmethod
    def display_quaternion(quaternion):
        norm = magnitude(quaternion)
        if not finite_vector(quaternion, 4) or not 0.95 <= norm <= 1.05:
            return None
        return [value / norm for value in quaternion]

    def set_display_reference(self, quaternion):
        reference = self.display_quaternion(quaternion)
        if reference is None:
            raise ValueError("Wait for a numeric BNO080 quaternion before zeroing.")
        self.display_reference = reference
        self.angle_reference_id += 1

    def _process_dynamics(self, raw, time_us):
        quality = self.quality(raw)
        if not self.calibrated:
            self._calibrate(raw, time_us)
            values = {field: math.nan for field in KINEMATIC_FIELDS}
            values.update({
                "imu_valid": int(quality["imu_valid"]),
                "magnetic_reliable": int(quality["magnetic_reliable"]),
                "attitude_reliable": 0, "velocity_reliable": 0, "stationary": 0,
                "timing_gap": 0, "orientation_jump": 0,
                "gyro_clipped": int(quality["gyro_clipped"]),
                "mag_norm_uT": quality["mag_norm_uT"],
                "heading_accuracy_deg": quality["heading_accuracy_deg"],
                "seconds_since_zupt": 0.0,
            })
            return values, quality

        dt = (time_us - self.previous_time_us) / 1e6
        sample_delta = (raw["sample_id"] - self.previous_sample_id) & 0xFFFFFFFF
        timing_gap = not math.isfinite(dt) or dt <= 0 or dt > 0.03 or sample_delta != 1
        sensor_reset = raw["reset_count"] != self.reset_count
        self.previous_time_us = time_us
        self.previous_sample_id = raw["sample_id"]
        if math.isfinite(dt) and dt > 0:
            self.seconds_since_zupt += dt
        quality = self.quality(raw)
        usable = quality["imu_valid"] and not sensor_reset
        q = normalize_quaternion(raw["quaternion"]) if usable else None
        orientation_jump = False
        if q is not None and raw["sequences"][4] != self.previous_quat_sequence:
            q_dt = (time_us - self.previous_quaternion_time_us) / 1e6
            if self.previous_quaternion is not None and 0 < q_dt <= 0.1:
                orientation_jump = quaternion_distance(q, self.previous_quaternion) \
                    > magnitude(raw["gyro"]) * q_dt + math.radians(3)
            self.previous_quaternion = q
            self.previous_quaternion_time_us = time_us
            self.previous_quat_sequence = raw["sequences"][4]
        magnetic_good = quality["magnetic_reliable"] and not orientation_jump and not sensor_reset
        self.magnetic_good_seconds = min(0.5, self.magnetic_good_seconds + dt) \
            if magnetic_good and not timing_gap else 0.0
        attitude_reliable = usable and magnetic_good and self.magnetic_good_seconds >= 0.5
        if timing_gap or not usable or not attitude_reliable:
            self.velocity_reliable = False
            self.world_acceleration = None
            self.acceleration = None
            self.stationary_seconds = 0.0
        if timing_gap or not usable:
            self.omega = None
            self.previous_gyro_time_us = None
            self.alpha = [0.0] * 3

        invalid = [math.nan] * 3
        omega = invalid
        alpha = invalid
        acceleration = invalid
        theta = invalid
        radius = invalid
        stationary = False
        if usable:
            gyro = subtract(raw["gyro"], self.gyro_bias)
            linear = subtract(raw["linear"], self.linear_bias)
            quiet = magnitude(gyro) <= math.radians(1) and magnitude(linear) <= 0.10 \
                and abs(magnitude(raw["accel"]) - GRAVITY) <= 0.25
            self.stationary_seconds = self.stationary_seconds + dt \
                if quiet and attitude_reliable and not timing_gap else 0.0
            stationary = self.stationary_seconds >= 0.5
            if raw["sequences"][1] != self.previous_gyro_sequence:
                gyro_dt = math.nan if self.previous_gyro_time_us is None else (time_us - self.previous_gyro_time_us) / 1e6
                gyro_deg = [value * RAD_TO_DEG for value in gyro]
                if self.omega is None or not math.isfinite(gyro_dt) or not 0 < gyro_dt <= 0.03:
                    self.omega = gyro_deg
                    self.alpha = [0.0] * 3
                else:
                    previous = self.omega
                    self.omega = low_pass(previous, gyro_deg, gyro_dt, 0.0348)
                    derivative = [(value - previous[index]) / gyro_dt for index, value in enumerate(self.omega)]
                    self.alpha = low_pass(self.alpha, derivative, gyro_dt, 0.0615)
                self.previous_gyro_sequence = raw["sequences"][1]
                self.previous_gyro_time_us = time_us
            omega = self.omega or invalid
            alpha = self.alpha
            step = 0.0 if timing_gap else dt
            self.acceleration = low_pass(self.acceleration, linear, step, 0.0448) if self.acceleration else list(linear)
            acceleration = self.acceleration
            if stationary:
                self.linear_bias = low_pass(self.linear_bias, raw["linear"], dt, 5.0)
                self.gyro_bias = low_pass(self.gyro_bias, raw["gyro"], dt, 10.0)
                self.velocity = [0.0] * 3
                self.velocity_reliable = True
                self.seconds_since_zupt = 0.0
                self.world_acceleration = [0.0] * 3
                self.acceleration = [0.0] * 3
                acceleration = self.acceleration
            else:
                if self.seconds_since_zupt > MAX_INTEGRATION_SECONDS:
                    self.velocity_reliable = False
                if attitude_reliable and not timing_gap:
                    relative = quaternion_multiply(quaternion_conjugate(self.reference), q)
                    world = rotate_body_to_world(relative, linear)
                    previous = self.world_acceleration
                    self.world_acceleration = low_pass(previous, world, dt, 0.0448) if previous else world
                    if previous and self.velocity_reliable:
                        self.velocity = [value + (previous[i] + self.world_acceleration[i]) * 0.5 * dt
                                         for i, value in enumerate(self.velocity)]
            if attitude_reliable:
                theta = rotation_vector_deg(quaternion_multiply(quaternion_conjugate(self.reference), q))
                if not timing_gap:
                    radius = estimate_radius(acceleration, omega, alpha)

        velocity_reliable = self.velocity_reliable and attitude_reliable and not timing_gap
        velocity = self.velocity if velocity_reliable else invalid
        values = {}
        for names, vector in (
            (("radius_x_m", "radius_y_m", "radius_z_m", "radius_mag_m"), radius),
            (("vx_m_s", "vy_m_s", "vz_m_s", "v_mag_m_s"), velocity),
            (("ax_kin_m_s2", "ay_kin_m_s2", "az_kin_m_s2", "a_kin_mag_m_s2"), acceleration),
            (("theta_x_deg", "theta_y_deg", "theta_z_deg", "theta_mag_deg"), theta),
            (("omega_x_deg_s", "omega_y_deg_s", "omega_z_deg_s", "omega_mag_deg_s"), omega),
            (("alpha_x_deg_s2", "alpha_y_deg_s2", "alpha_z_deg_s2", "alpha_mag_deg_s2"), alpha),
        ):
            for index, name in enumerate(names):
                values[name] = magnitude(vector) if index == 3 else vector[index]
        values.update({
            "imu_valid": int(usable), "magnetic_reliable": int(magnetic_good),
            "attitude_reliable": int(attitude_reliable), "velocity_reliable": int(velocity_reliable),
            "stationary": int(stationary), "timing_gap": int(timing_gap),
            "orientation_jump": int(orientation_jump), "gyro_clipped": int(quality["gyro_clipped"]),
            "mag_norm_uT": quality["mag_norm_uT"],
            "heading_accuracy_deg": quality["heading_accuracy_deg"],
            "seconds_since_zupt": self.seconds_since_zupt,
        })
        quality.update(attitude_reliable=attitude_reliable, velocity_reliable=velocity_reliable,
                       stationary=stationary, timing_gap=timing_gap, orientation_jump=orientation_jump,
                       sensor_reset=sensor_reset)
        return values, quality


def discover(timeout=1.25):
    found = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(("", 0))
        sock.sendto(b"RIGIDITY_DISCOVER_V2", ("255.255.255.255", 9001))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            sock.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                payload, address = sock.recvfrom(256)
            except socket.timeout:
                break
            fields = payload.decode("ascii", errors="replace").split(",")
            if len(fields) != 4 or fields[0] != "RIGIDITY_ESP32_V2" \
                    or fields[3] not in ("SUPER_MINI_BNO080_8FSR_V1", "SUPER_MINI_DUO_RAW_V4"):
                continue
            try:
                port = int(fields[2])
            except ValueError:
                continue
            if 1 <= port <= 65535:
                found[address[0]] = {"host": address[0], "port": port, "firmware": fields[3]}
    return list(found.values())


CH340_VID = 0x1A86
CH340_PIDS = {0x7522, 0x7523, 0x5523, 0x55D4}
CP210X_VID = 0x10C4
FTDI_VID = 0x0403


def port_kind(port):
    """Classify a pyserial ListPortInfo by its USB-serial bridge chip."""
    vid = getattr(port, "vid", None)
    pid = getattr(port, "pid", None)
    if vid == CH340_VID or (pid is not None and pid in CH340_PIDS):
        return "ch340"
    if vid == CP210X_VID:
        return "cp210x"
    if vid == FTDI_VID:
        return "ftdi"
    text = " ".join(str(getattr(port, name, "") or "") for name in
                    ("description", "manufacturer", "hwid", "product")).lower()
    if "ch340" in text or "ch341" in text:
        return "ch340"
    if "cp210" in text:
        return "cp210x"
    if "ftdi" in text or "ft232" in text or "ft2232" in text:
        return "ftdi"
    return "unknown"


def serial_port_list():
    """Every serial port as a plain dict, annotated with its bridge chip."""
    ports = []
    for port in (list_ports.comports() if list_ports else []):
        kind = port_kind(port)
        ports.append(dict(
            device=port.device,
            description=getattr(port, "description", "") or "",
            manufacturer=getattr(port, "manufacturer", "") or "",
            serial_number=getattr(port, "serial_number", "") or "",
            hwid=getattr(port, "hwid", "") or "",
            vid=getattr(port, "vid", None),
            pid=getattr(port, "pid", None),
            kind=kind,
            ch340=kind == "ch340",
        ))
    return ports


def choose_port(ports):
    """Pick the port to connect automatically, or None when ambiguous.

    With a single board there is nothing to disambiguate: a lone port is used
    as-is, otherwise a single CH340 bridge (the NodeMCU-32 V1.3 USB chip) wins
    over unrelated adapters. Two or more CH340 boards stay a manual choice.
    """
    if len(ports) == 1:
        return ports[0]
    ch340 = [port for port in ports if port.get("ch340")]
    if len(ch340) == 1:
        return ch340[0]
    return None


def valid_folder_name(value):
    if not isinstance(value, str):
        return False
    value = value.strip()
    reserved = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} | {
        prefix + digit for prefix in ("COM", "LPT") for digit in "123456789"
    }
    return not value or (len(value) <= 100 and value not in (".", "..")
        and not value.endswith(".") and not any(ord(char) < 32 or char in '<>:"/\\|?*' for char in value)
        and value.split(".")[0].upper() not in reserved)


def json_safe(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, deque)):
        return [json_safe(item) for item in value]
    return value


class Acquisition:
    def __init__(self, data_dir=DATA_DIR):
        self.data_dir = Path(data_dir)
        self.lock = threading.RLock()
        self.commands = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.connection = None
        self.active = False
        self.source = ""
        self.error = ""
        self.rows = deque(maxlen=LIVE_RING_ROWS)
        self.index = 0
        self.generation = 0
        self.parser = Parser()
        self.motion = MotionProcessor()
        self.previous_raw = None
        self.last_raw_time = None
        self.extended_time = 0
        self.device_start_time = 0
        self.boot_id = 0
        self.missing = 0
        self.duplicates = 0
        self.reboots = 0
        self.sensor_faults = 0
        self.rate_times = deque(maxlen=300)
        self.started_ns = 0
        self.record_file = None
        self.record_writer = None
        self.record_path = ""
        self.record_folder = ""
        self.recorded = 0
        self.record_started_ns = None
        self.record_elapsed_ms = 0.0
        self.record_error = ""
        self.last_flush_ns = 0

    def start(self, config):
        if self.active:
            raise ValueError("Disconnect the current device first.")
        source = config.get("source", "usb")
        connection = None
        if source == "usb":
            if serial is None:
                raise ValueError("pyserial is missing. Install requirements.txt first.")
            port = str(config.get("port", "")).strip()
            if not port:
                chosen = choose_port(serial_port_list())
                if chosen is None:
                    raise ValueError("Select a serial port; no unique CH340 adapter was detected.")
                port = chosen["device"]
            connection = serial.Serial(port, 921600, timeout=0.1)
        elif source == "wifi":
            host = str(config.get("host", "")).strip()
            port = int(config.get("tcp_port", 9000))
            if not 1 <= port <= 65535:
                raise ValueError("Invalid TCP port.")
            if not host or host.lower() == "auto":
                devices = discover()
                if len(devices) != 1:
                    raise ValueError(f"Found {len(devices)} devices. Enter the device IP explicitly.")
                host, port = devices[0]["host"], devices[0]["port"]
            connection = socket.create_connection((host, port), timeout=3)
            connection.settimeout(0.1)
        elif source != "demo":
            raise ValueError("Unknown data source.")
        with self.lock:
            self.source = source
            self.connection = connection
            self.active = True
            self.error = ""
            self.rows.clear()
            self.index = 0
            self.generation += 1
            self.parser = Parser()
            self.motion = MotionProcessor()
            self.previous_raw = None
            self.last_raw_time = None
            self.extended_time = 0
            self.device_start_time = 0
            self.boot_id = 0
            self.missing = self.duplicates = self.reboots = self.sensor_faults = 0
            self.rate_times.clear()
            self.started_ns = time.monotonic_ns()
            self.record_path = self.record_folder = ""
            self.recorded = 0
            self.record_elapsed_ms = 0.0
            self.record_error = ""
            self.stop_event = threading.Event()
            self.thread = threading.Thread(target=self._run, args=(connection, source), daemon=True)
            self.thread.start()

    def disconnect(self):
        self.stop_event.set()
        with self.lock:
            connection = self.connection
            thread = self.thread
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        if thread and thread is not threading.current_thread():
            thread.join(timeout=4)
            if thread.is_alive():
                raise RuntimeError("The acquisition thread is still stopping. Try again shortly.")
        with self.lock:
            self.active = False
            self.connection = None
            self._stop_record_locked()

    def _run(self, connection, source):
        demo_id = 0
        next_tick = time.monotonic()
        last_valid = next_tick
        try:
            while not self.stop_event.is_set():
                if source == "demo":
                    if self.stop_event.wait(max(0.0, next_tick - time.monotonic())):
                        break
                    demo_id = (demo_id + 1) & 0xFFFFFFFF
                    chunk = encode_demo(demo_id)
                    next_tick += 0.01
                    if next_tick < time.monotonic() - 0.1:
                        next_tick = time.monotonic()
                elif source == "wifi":
                    try:
                        chunk = connection.recv(8192)
                    except socket.timeout:
                        chunk = None
                    if chunk == b"":
                        raise ConnectionError("The ESP32 closed the TCP connection.")
                else:
                    waiting = getattr(connection, "in_waiting", 0)
                    chunk = connection.read(min(waiting or 1, 8192))
                with self.lock:
                    self._capture_chunk(chunk or b'')
                    parsed = self.parser.push(chunk or b"")
                    if parsed:
                        for raw in parsed:
                            if raw.get('kind') == 'event':
                                self._accept_event(raw)
                            else:
                                self._accept(raw)
                                last_valid = time.monotonic()
                if time.monotonic() - last_valid > 5:
                    raise TimeoutError("No valid sample for 5 seconds. Device disconnected or stalled.")
        except Exception as error:
            if not self.stop_event.is_set():
                with self.lock:
                    self.error = str(error)
        finally:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            with self.lock:
                self.active = False
                self.connection = None
                self._stop_record_locked()

    def _start_new_boot(self, raw):
        self.boot_id += 1
        self.reboots += int(self.previous_raw is not None)
        self.motion.reset()
        self.last_raw_time = raw["raw_time_us"]
        self.extended_time = raw["raw_time_us"]
        self.device_start_time = self.extended_time
        self.previous_raw = None

    def _capture_chunk(self, chunk):
        pass

    def _accept_event(self, raw):
        pass

    def _extra_row(self, raw):
        return raw.get('extra', {})

    def _accept(self, raw):
        previous = self.previous_raw
        reset_changed = previous is not None and raw["reset_count"] != previous["reset_count"]
        if previous is None:
            self._start_new_boot(raw)
        else:
            delta_id = (raw["sample_id"] - previous["sample_id"]) & 0xFFFFFFFF
            if delta_id == 0:
                self.duplicates += 1
                return
            if delta_id > 0x7FFFFFFF:
                self._start_new_boot(raw)
                previous = None
            else:
                if delta_id > 1:
                    self.missing += delta_id - 1
                delta_time = (raw["raw_time_us"] - self.last_raw_time) & 0xFFFFFFFF
                if delta_time >= 0x80000000:
                    self._start_new_boot(raw)
                    previous = None
                else:
                    self.extended_time += delta_time
                    self.last_raw_time = raw["raw_time_us"]
        if reset_changed and previous is not None:
            self.motion.reset()
        device_dt_us = 0 if previous is None else self.extended_time - previous["extended_time"]
        raw["extended_time"] = self.extended_time
        self.previous_raw = raw
        self.index += 1
        now_ns = time.monotonic_ns()
        epoch_ms = time.time_ns() / 1e6
        pc_elapsed_ms = (now_ns - self.started_ns) / 1e6
        values, quality = self.motion.process(raw, self.extended_time)
        if not quality.get("imu_valid") and not raw.get("fsr_only"):
            self.sensor_faults += 1
        row = {
            "pc_time_iso": datetime.fromtimestamp(epoch_ms / 1000, timezone.utc).isoformat(timespec="milliseconds"),
            "pc_epoch_ms": round(epoch_ms, 3), "pc_elapsed_ms": round(pc_elapsed_ms, 3),
            "source": self.source, "index": self.index, "boot_id": self.boot_id,
            "sample_id": raw["sample_id"], "device_time_us": self.extended_time,
            "device_elapsed_ms": (self.extended_time - self.device_start_time) / 1000.0,
            "device_dt_us": device_dt_us, "missing_before": 0 if previous is None else max(0, ((raw["sample_id"] - previous["sample_id"]) & 0xFFFFFFFF) - 1),
            "flags": raw["flags"], "fsr_only": int(raw.get("fsr_only", False)),
            "imu_reset_count": raw["reset_count"],
            "heading_accuracy_rad": raw["heading_accuracy"], "fresh_mask": raw["fresh_mask"],
            "bno_diagnostic_code": raw["diagnostic_code"], "crc32": f'{raw["crc32"]:08x}',
        }
        for prefix, vector in (("accel", raw["accel"]), ("gyro", raw["gyro"]),
                               ("mag", raw["mag"]), ("linear", raw["linear"])):
            suffix = "uT" if prefix == "mag" else ("rad_s" if prefix == "gyro" else "m_s2")
            for axis, value in zip("xyz", vector):
                row[f"{prefix}_{axis}_{suffix}"] = value
        for name, value in zip(("quat_w", "quat_x", "quat_y", "quat_z"), raw["quaternion"]):
            row[name] = value
        for name, value in zip(("accel", "gyro", "mag", "linear", "quat"), raw["statuses"]):
            row[f"{name}_status"] = value
        for name, value in zip(("accel", "gyro", "mag", "linear", "quat"), raw["ages_ms"]):
            row[f"{name}_age_ms"] = value
        for name, value in zip(("accel", "gyro", "mag", "linear", "quat"), raw["sequences"]):
            row[f"{name}_sequence"] = value
        for channel, adc in enumerate(raw["fsr_raw"]):
            row[f"raw_fsr{channel}_adc"] = adc
            row[f"F{channel}_V"] = max(0.0, min(ADC_MAX, adc)) / ADC_MAX * ADC_VCC
        row.update(values)
        row.update(self._extra_row(raw))
        self.rows.append(row)
        self.rate_times.append(now_ns)
        if self.record_writer:
            try:
                self.record_writer.writerow(row)
                self.recorded += 1
                if self.recorded % 100 == 0 or now_ns - self.last_flush_ns >= 1_000_000_000:
                    self.record_file.flush()
                    self.last_flush_ns = now_ns
            except Exception as error:
                self.record_error = f"Recording stopped: {error}"
                self._stop_record_locked()

    def zero_attitude(self):
        with self.lock:
            if not self.active or self.previous_raw is None:
                raise ValueError("Connect a device and wait for a quaternion first.")
            self.motion.set_display_reference(self.previous_raw["quaternion"])

    def start_record(self, note="", folder_name=""):
        with self.lock:
            if not self.active:
                raise ValueError("Connect a device first.")
            if self.record_file:
                raise ValueError("Recording is already active.")
            if not valid_folder_name(folder_name):
                raise ValueError("Use a valid folder name (up to 100 characters, no paths or reserved names).")
            folder_name = folder_name.strip()
            folder = self.data_dir / (folder_name or datetime.now().strftime("%Y%m%d_%H%M%S_") + uuid4().hex[:8])
            file_handle = None
            try:
                folder.mkdir(parents=True)
                metadata = {
                    "source": self.source, "note": str(note)[:1000],
                    "started_at_utc": datetime.now(timezone.utc).isoformat(),
                    "protocol": "RIGIDITY_V3_144_BYTE", "fsr_channels": FSR_COUNT,
                    "sample_rate_hz_nominal": 100, "adc_voltage_v": ADC_VCC,
                    "recording_model": "Server-side streaming; rows begin after Start Recording.",
                }
                (folder / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
                file_handle = (folder / "samples.csv").open("x", encoding="utf-8", newline="")
                writer = csv.DictWriter(file_handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
                writer.writeheader()
                file_handle.flush()
            except FileExistsError:
                if file_handle:
                    file_handle.close()
                raise ValueError("That recording folder already exists. Choose a different name.") from None
            except Exception:
                if file_handle:
                    file_handle.close()
                # Leave metadata/folder in place as evidence of an I/O error;
                # never publish a half-open writer as an active recording.
                raise
            self.record_file = file_handle
            self.record_writer = writer
            self.record_folder = str(folder)
            self.record_path = str(folder / "samples.csv")
            self.recorded = 0
            self.record_started_ns = time.monotonic_ns()
            self.record_elapsed_ms = 0.0
            self.record_error = ""
            self.last_flush_ns = self.record_started_ns

    def _stop_record_locked(self):
        if self.record_file:
            self.record_elapsed_ms = (time.monotonic_ns() - self.record_started_ns) / 1e6
            try:
                self.record_file.flush()
                self.record_file.close()
            except Exception as error:
                self.record_error = self.record_error or f"Could not finalize recording: {error}"
        self.record_file = None
        self.record_writer = None

    def stop_record(self):
        with self.lock:
            self._stop_record_locked()

    def snapshot(self, after=0):
        with self.lock:
            all_rows = list(self.rows)
            cursor_dropped = bool(after and all_rows and after < all_rows[0]["index"] - 1)
            selected = [row for row in all_rows if row["index"] > after]
            if len(selected) > MAX_STATUS_ROWS:
                selected = selected[-MAX_STATUS_ROWS:]
                cursor_dropped = True
            elapsed = ((time.monotonic_ns() - self.record_started_ns) / 1e6
                       if self.record_file else self.record_elapsed_ms)
            if len(self.rate_times) >= 2:
                span = (self.rate_times[-1] - self.rate_times[0]) / 1e9
                rate = (len(self.rate_times) - 1) / span if span > 0 else 0.0
            else:
                rate = 0.0
            latest = all_rows[-1] if all_rows else None
            detail = self._quality_detail(latest)
            result = {
                "active": self.active, "source": self.source, "error": self.error,
                "generation": self.generation, "received": self.index,
                "missing": self.missing, "duplicates": self.duplicates,
                "reboots": self.reboots, "rejected": self.parser.rejected,
                "protocol_rejected": self.parser.protocol_rejected,
                "sensor_faults": self.sensor_faults, "input_rate_hz": rate,
                "retained_rows": len(all_rows), "cursor_dropped": cursor_dropped,
                "calibration_count": self.motion.calibration_count,
                "calibration_target": CALIBRATION_SAMPLES, "calibrated": self.motion.calibrated,
                "can_zero": bool(self.active and self.previous_raw is not None
                                 and self.motion.display_quaternion(self.previous_raw["quaternion"]) is not None),
                "angle_reference_set": self.motion.display_reference is not None,
                "quality_detail": detail, "latest": latest, "rows": selected,
                "recording": self.record_file is not None, "recorded": self.recorded,
                "recording_elapsed_ms": elapsed, "path": self.record_path,
                "folder": self.record_folder, "data_dir": str(self.data_dir),
                "record_error": self.record_error,
            }
            return json_safe(result)

    def _quality_detail(self, latest):
        if not self.active:
            return "Acquisition stopped"
        if latest is None:
            return "Waiting for a valid V3/V4 frame"
        if latest.get("fsr_only"):
            return "8 FSR live; this firmware does not stream IMU reports"
        code = latest.get("bno_diagnostic_code")
        if code == 2:
            return "BNO080 not detected; check SPI wiring and interface mode"
        if code == 4:
            return "BNO080 report configuration failed"
        if code == 5:
            return "BNO080 initialized but no report callback arrived"
        if any(latest.get(f"{name}_age_ms", 65535) > 30 for name in ("accel", "gyro", "linear", "quat")):
            return "IMU reports missing or stale; available values remain visible"
        if not latest.get("imu_valid"):
            return "IMU accuracy low or report invalid; available values remain visible"
        if not self.motion.calibrated:
            return f"Hold still for bias-zero calibration ({self.motion.calibration_count}/{CALIBRATION_SAMPLES}); magnetic accuracy is optional"
        if not latest.get("magnetic_reliable"):
            return "Bias-zero complete; magnetic accuracy unverified; relative angle remains visible"
        if not latest.get("attitude_reliable"):
            return "Waiting for stable orientation"
        if not latest.get("velocity_reliable"):
            return "Velocity estimate displayed with unverified quality; hold still to restore reference"
        if latest.get("stationary"):
            return "Stationary; velocity reset to zero"
        return "BNO080 nine-axis fusion ready"


class MonitorServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(SimpleHTTPRequestHandler):
    server_version = "RigiditySuperMini/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND), **kwargs)

    def log_message(self, *_args):
        pass

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, value, status=HTTPStatus.OK):
        body = json.dumps(json_safe(value), ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def local_host(self):
        # The service is intentionally loopback-only.  Reject a rebinding Host
        # header as well, instead of trusting a matching attacker-controlled
        # Origin/Host pair that resolves to 127.0.0.1.
        host = urlparse("//" + self.headers.get("Host", "")).hostname
        return host in {"127.0.0.1", "localhost", "::1"}

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if not self.local_host():
                return self.send_json({"error": "Host rejected"}, HTTPStatus.FORBIDDEN)
            if url.path == "/api/status":
                raw_after = parse_qs(url.query).get("after", ["0"])[0]
                return self.send_json(self.server.acquisition.snapshot(max(0, int(raw_after))))
            if url.path == "/api/ports":
                ports = ([{"device": port.device, "description": port.description}
                          for port in list_ports.comports()] if list_ports else [])
                return self.send_json({"ports": ports, "available": serial is not None})
            if url.path == "/api/discover":
                return self.send_json({"devices": discover()})
            if url.path not in ("/", "/index.html", "/app.js", "/styles.css"):
                return self.send_error(HTTPStatus.NOT_FOUND)
            return super().do_GET()
        except Exception as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

    def do_POST(self):
        if not self.local_host():
            return self.send_json({"error": "Host rejected"}, HTTPStatus.FORBIDDEN)
        origin = self.headers.get("Origin")
        expected_origin = f"http://{self.headers.get('Host')}"
        if origin and origin != expected_origin:
            return self.send_json({"error": "Origin rejected"}, HTTPStatus.FORBIDDEN)
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
            return self.send_json({"error": "Expected JSON"}, HTTPStatus.BAD_REQUEST)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(length))
            acquisition = self.server.acquisition
            with acquisition.commands:
                if self.path == "/api/connect":
                    acquisition.start(payload)
                elif self.path == "/api/disconnect":
                    acquisition.disconnect()
                elif self.path == "/api/zero":
                    acquisition.zero_attitude()
                elif self.path == "/api/record/start":
                    acquisition.start_record(payload.get("note", ""), payload.get("folder_name", ""))
                elif self.path == "/api/record/stop":
                    acquisition.stop_record()
                else:
                    return self.send_error(HTTPStatus.NOT_FOUND)
            return self.send_json({"ok": True})
        except Exception as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)


def main():
    parser = argparse.ArgumentParser(description="Single ESP32 FSR monitor")
    parser.add_argument("--port", type=int, default=5182, help="local HTTP port")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="recording directory")
    args = parser.parse_args()
    server = MonitorServer(("127.0.0.1", args.port), Handler)
    server.acquisition = Acquisition(args.data_dir)
    print(f"Open http://127.0.0.1:{args.port}/\nData: {args.data_dir.resolve()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.acquisition.disconnect()
        server.server_close()


if __name__ == "__main__":
    main()
