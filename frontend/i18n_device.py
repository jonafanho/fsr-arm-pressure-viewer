#!/usr/bin/env python3
import re, sys

filepath = "frontend/device.html"
with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

# Add data-i18n to key elements
replacements = [
    ('<p id="message" role="status"', '<p id="message" role="status" data-i18n="message"'),
    ('<p id="recordPath" class="path"', '<p id="recordPath" class="path" data-i18n="record_path"'),
    ('<strong id="pressurePeak">', '<strong id="pressurePeak" data-i18n="pressure_peak">'),
    ('<small id="pressureDetail">', '<small id="pressureDetail" data-i18n="pressure_detail">'),
    ('<p id="pressureNotice"', '<p id="pressureNotice" data-i18n="pressure_notice">'),
    ('<p class="pressure-footnote">', '<p class="pressure-footnote" data-i18n="pressure_footnote">'),
    ('<p class="pressure-connection">', '<p class="pressure-connection" data-i18n="pressure_connection">'),
    ('<strong id="pressureState">', '<strong id="pressureState" data-i18n="pressure_state">'),
]
for old, new in replacements:
    if old in content:
        content = content.replace(old, new)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
print("Modified device.html successfully")