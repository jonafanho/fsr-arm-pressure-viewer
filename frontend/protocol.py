"""Rigidity V3/V4/V5 wire protocol for the ESP32 FSR board.

V3 samples are 144 bytes, V4 samples are 344 bytes, and V5 events are 56 bytes.
All are little endian and protected by CRC32/IEEE. The sample format keeps
sixteen FSR slots for compatibility, although this hardware populates 0..7.
"""
from __future__ import annotations

import math
import struct
import zlib

MAGIC = b"\xa5\x5a"
VERSION = 3
PAYLOAD_LENGTH = 134
FRAME_SIZE = 144
CRC_OFFSET = 140
FRAME_LENGTHS = {3: 144, 4: 344, 5: 56}
RAW_NAMES = ('accel', 'gyro', 'mag')
EXTRA_FIELDS = [
    'protocol_version', 'board_id', 'device_time_raw_us', 'raw_config_mask', 'raw_seen_mask',
    'usb_packets_dropped', 'wifi_packets_dropped', 'event_queue_dropped', 'last_event_id',
    *(f'raw_{name}_{axis}_counts' for name in RAW_NAMES for axis in 'xyz'),
    'raw_gyro_temperature_counts',
    *(f'raw_{name}_{suffix}' for name in RAW_NAMES
      for suffix in ('timestamp_us', 'receipt_us', 'age_ms', 'status', 'sequence', 'fresh')),
    *(f'fsr{ch}_adc{j}' for ch in range(8) for j in range(5)),
    *(f'fsr{ch}_sample_us' for ch in range(8)),
]


def decode_event(frame):
    event_id, reset_count, receipt, timestamp, length, report_id = struct.unpack_from('<IIIQBB', frame, 6)
    report = frame[28:44][:min(length, 16)]
    result = dict(kind='event', event_id=event_id, reset_count=reset_count,
                  receipt_us=receipt, timestamp_us=timestamp, report_id=report_id,
                  report_length=length, report_hex=report.hex(),
                  board_id=f'{struct.unpack_from("<Q", frame, 44)[0]:016x}')
    if len(report) >= 4:
        result.update(sequence=report[1], status=report[2], delay=report[3])
    if report_id in (0x14, 0x15, 0x16) and len(report) == 16:
        result.update(zip(('x_counts', 'y_counts', 'z_counts'), struct.unpack_from('<3h', report, 4)))
        result['sensor_timestamp_us'] = struct.unpack_from('<I', report, 12)[0]
        if report_id == 0x15:
            result['temperature_counts'] = struct.unpack_from('<h', report, 10)[0]
    return result


def _floats(frame: bytes, offset: int, count: int) -> list[float]:
    return list(struct.unpack_from(f"<{count}f", frame, offset))


def decode_frame(frame: bytes) -> dict:
    """Decode one already validated V3 frame."""
    sample_id, raw_time_us, reset_count = struct.unpack_from("<III", frame, 6)
    fsr_all = list(struct.unpack_from("<16H", frame, 108))
    result = {
        'kind': 'sample', 'protocol_version': frame[2],
        "flags": frame[3],
        # Bit 0x04 is set by the eight-FSR-only firmware. It tells the local
        # service not to count the intentionally empty IMU fields as faults.
        "fsr_only": bool(frame[3] & 0x04),
        "sample_id": sample_id,
        "raw_time_us": raw_time_us,
        "reset_count": reset_count,
        "accel": _floats(frame, 18, 3),
        "gyro": _floats(frame, 30, 3),
        "mag": _floats(frame, 42, 3),
        "linear": _floats(frame, 54, 3),
        "quaternion": _floats(frame, 66, 4),
        "heading_accuracy": struct.unpack_from("<f", frame, 82)[0],
        "statuses": list(frame[86:91]),
        "fresh_mask": frame[91],
        "ages_ms": list(struct.unpack_from("<5H", frame, 92)),
        "sequences": list(frame[102:107]),
        "diagnostic_code": frame[107],
        "fsr_raw": fsr_all[:8],
        "reserved_fsr_raw": fsr_all[8:],
        "crc32": struct.unpack_from("<I", frame, len(frame) - 4)[0],
    }
    extra = {key: math.nan for key in EXTRA_FIELDS}
    extra.update(protocol_version=frame[2], board_id='', device_time_raw_us=raw_time_us)
    if frame[2] == 4:
        extra.update(board_id=f'{struct.unpack_from("<Q", frame, 140)[0]:016x}',
                     raw_config_mask=frame[160], raw_seen_mask=frame[161])
        for key, value in zip(('usb_packets_dropped', 'wifi_packets_dropped', 'event_queue_dropped'),
                              struct.unpack_from('<3I', frame, 148)):
            extra[key] = value
        for i, name in enumerate(RAW_NAMES):
            x, y, z, temperature, timestamp, receipt, status, sequence, fresh, _ = struct.unpack_from('<4h2I4B', frame, 164 + 20*i)
            seen = bool(frame[161] & (1 << i))
            for axis, value in zip('xyz', (x, y, z)):
                extra[f'raw_{name}_{axis}_counts'] = value if seen else math.nan
            for suffix, value in zip(('timestamp_us', 'receipt_us', 'age_ms', 'status', 'sequence', 'fresh'),
                                    (timestamp, receipt, ((raw_time_us - receipt) & 0xffffffff)/1000, status, sequence, fresh)):
                extra[f'raw_{name}_{suffix}'] = value if seen else math.nan
            if name == 'gyro':
                extra['raw_gyro_temperature_counts'] = temperature if seen else math.nan
        for ch in range(8):
            for j, value in enumerate(struct.unpack_from('<5H', frame, 224 + ch*10)):
                extra[f'fsr{ch}_adc{j}'] = value
            extra[f'fsr{ch}_sample_us'] = struct.unpack_from('<I', frame, 304 + ch*4)[0]
        extra['last_event_id'] = struct.unpack_from('<I', frame, 336)[0]
    result['extra'] = extra
    return result


class Parser:
    """Incremental parser that resynchronizes after noise or a damaged frame."""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.rejected = 0
        self.protocol_rejected = 0

    def push(self, chunk: bytes | bytearray | memoryview) -> list[dict]:
        if chunk:
            self.buffer.extend(chunk)
        rows: list[dict] = []
        while len(self.buffer) >= 6:
            marker = self.buffer.find(MAGIC)
            if marker < 0:
                # Keep a trailing A5 because it may be the first byte of a
                # header split across reads.
                self.buffer[:] = self.buffer[-1:] if self.buffer[-1] == MAGIC[0] else b""
                break
            if marker:
                del self.buffer[:marker]
            if len(self.buffer) < 6:
                break
            version = self.buffer[2]
            payload_length = struct.unpack_from("<H", self.buffer, 4)[0]
            frame_size = FRAME_LENGTHS.get(version)
            if frame_size is None or payload_length != frame_size - 10:
                self.rejected += 1
                self.protocol_rejected += 1
                del self.buffer[0]
                continue
            if len(self.buffer) < frame_size:
                break
            frame = bytes(self.buffer[:frame_size])
            expected = struct.unpack_from("<I", frame, frame_size - 4)[0]
            actual = zlib.crc32(frame[2:-4]) & 0xFFFFFFFF
            if expected != actual:
                self.rejected += 1
                # Advance one byte rather than a whole candidate: a dropped
                # byte can put the next valid header inside this region.
                del self.buffer[0]
                continue
            rows.append(decode_event(frame) if version == 5 else decode_frame(frame))
            del self.buffer[:frame_size]
        return rows


def encode_demo(sample_id: int, reset_count: int = 1) -> bytes:
    """Build a realistic frame for the UI demo and protocol tests."""
    frame = bytearray(FRAME_SIZE)
    struct.pack_into("<2sBBHIII", frame, 0, MAGIC, VERSION, 0, PAYLOAD_LENGTH,
                     sample_id & 0xFFFFFFFF, (sample_id * 10_000) & 0xFFFFFFFF,
                     reset_count & 0xFFFFFFFF)
    # The first three seconds are still so startup calibration can complete.
    t = max(0.0, (sample_id - 300) / 100.0)
    yaw = 0.55 * (1.0 - math.cos(t * 0.7))
    gyro_z = 0.385 * math.sin(t * 0.7) if t else 0.0
    linear_x = 0.24 * math.sin(t * 1.4) if t else 0.0
    values = [
        0.0, 0.0, 9.80665,
        0.0, 0.0, gyro_z,
        30.0 * math.sin(yaw), 30.0 * math.cos(yaw), -35.0,
        linear_x, 0.0, 0.0,
        math.cos(yaw / 2.0), 0.0, 0.0, math.sin(yaw / 2.0),
        0.03,
    ]
    struct.pack_into("<17f", frame, 18, *values)
    frame[86:91] = bytes([3] * 5)
    frame[91] = 0x1F
    struct.pack_into("<5H", frame, 92, 0, 0, 0, 0, 0)
    frame[102:107] = bytes([sample_id & 0xFF] * 5)
    frame[107] = 3
    fsr = []
    for channel in range(8):
        phase = t * (1.2 + channel * 0.07) + channel * 0.55
        fsr.append(round(300 + channel * 55 + max(0.0, math.sin(phase)) * (850 - channel * 35)))
    struct.pack_into("<16H", frame, 108, *(fsr + [0] * 8))
    struct.pack_into("<I", frame, CRC_OFFSET, zlib.crc32(frame[2:CRC_OFFSET]) & 0xFFFFFFFF)
    return bytes(frame)
