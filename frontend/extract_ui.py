#!/usr/bin/env python3
import re

with open('strings_output.txt', 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')
ui_strings = []
for line in lines:
    line = line.strip()
    # Skip JS code patterns
    if any(pattern in line for pattern in ['=>', 'function', 'var ', 'let ', 'const ', '==>', '==>', '==', '!=', '!==', '&&', '||']):
        continue
    # Skip lines that are mostly code
    if len(line) > 120:
        continue
    # Skip lines starting with { or } or ,
    if line.startswith('{') or line.startswith('}') or line.startswith(','):
        continue
    # Skip empty lines
    if not line:
        continue
    # Keep reasonable UI strings
    if 5 < len(line) < 100:
        ui_strings.append(line)

# Deduplicate
seen = set()
unique = []
for s in ui_strings:
    # Normalize
    s_norm = ' '.join(s.split())
    if s_norm and s_norm not in seen:
        seen.add(s_norm)
        unique.append(s_norm)

# Sort by length descending
unique.sort(key=len, reverse=True)

print(f"Found {len(unique)} UI strings")
print("\nTop 80 UI strings:")
for i, s in enumerate(unique[:80], 1):
    # Replace newlines with literal \n for display
    s_disp = s.replace('\n', '\\n')
    print(f"{i:3d}. {s_disp}")
" 2>&1