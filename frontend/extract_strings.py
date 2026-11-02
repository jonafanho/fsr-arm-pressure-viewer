#!/usr/bin/env python3
import re, os, html

files = [
    'app.js',
    'duo.js', 
    'device.html',
    'index.html',
]

all_text = ''
for f in files:
    try:
        with open(f, 'r', encoding='utf-8') as fh:
            all_text += fh.read() + ' '
    except Exception as e:
        print(f"Warning: could not read {f}: {e}")

# Find strings in various attribute values
patterns = [
    (r'[\"\'`]([^"\`]{3,80})[\"\'`]', 'inline'),
    (r'value=[\"`]([^\"`]{3,80})[\"`]', 'value attr'),
    (r'placeholder=[\"`]([^\"`]{3,80})[\"`]', 'placeholder'),
    (r'alt=[\"`]([^\"`]{3,80})[\"`]', 'alt'),
    (r'title=[\"`]([^\"`]{3,80})[\"`]', 'title'),
    (r'<option[^>]*>([^<]{3,60})</option>', 'option'),
    (r'aria-label=[\"`]([^\"`]{3,80})[\"`]', 'aria-label'),
    (r'aria-labelledby=[\"`]([^\"`]{3,80})[\"`]', 'aria-labelledby'),
]

all_strings = []
for pattern, label in patterns:
    matches = re.findall(pattern, all_text, re.DOTALL)
    for m in matches:
        s = html.unescape(m.strip())
        if s and len(s) > 2:
            all_strings.append(s)

# Deduplicate
seen = set()
result = []
for s in all_strings:
    # Normalize whitespace
    s = ' '.join(s.split())
    if s and s not in seen:
        seen.add(s)
        result.append(s)

# Sort by length descending
result.sort(key=len, reverse=True)

# Write to output file
with open('strings_output.txt', 'w', encoding='utf-8') as f:
    f.write(f"Total unique strings found: {len(result)}\n")
    for s in result:
        # Write each string, replacing newlines with literal \n
        s_display = s.replace('\n', '\\n')
        f.write(s_display + '\n')
print(f"Written {len(result)} strings to strings_output.txt")