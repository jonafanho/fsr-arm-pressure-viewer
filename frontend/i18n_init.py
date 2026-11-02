#!/usr/bin/env python3
import re, sys

filepath = "frontend/app.js"
with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

# Find the start function
start_marker = "function start() {"
idx = content.find(start_marker)
if idx >= 0:
    # i18n initialization code
    i18n_code = """

  // i18n initialization
  i18n_data = {};
  current_language = "zh-CN";

  function loadLanguage(lang) {
    current_language = lang;
    fetch("public/loc/" + lang + ".json")
      .then(response => response.json())
      .then(data => {
        i18n_data = data;
        // Replace all translatable elements
        document.querySelectorAll("[data-i18n]").forEach(elem => {
          const key = elem.getAttribute("data-i18n");
          if (i18n_data[key]) {
            elem.textContent = i18n_data[key];
          }
        });
        // Update language selector
        document.getElementById("languageSelect").value = lang;
      });
  }

  // Set up language selector
  document.getElementById("languageSelect").addEventListener("change", (e) => {
    loadLanguage(e.target.value);
  });

  // Load default language on startup
  loadLanguage("zh-CN");
"""

    # Insert i18n code at the start of the start function
    # Find 'function start() {' and insert after the opening brace
    marker_start = "function start() {"
    insertion_point = content.find("}", content.find(marker_start)) + 1
    
    new_content = content[:insertion_point] + i18n_code + content[insertion_point:]
    
    # Also add data-i18n attributes to key elements
    # Add data-i18n to the main title
    content = content.replace('<h1 id="mainTitle">', '<h1 id="mainTitle" data-i18n="device_title">')
    
    # Add data-i18n to other key elements
    replacements = [
        ('<p id="sessionStatus" role="status">', '<p id="sessionStatus" role="status" data-i18n="session_status">'),
        ('<button id="record" disabled>', '<button id="record" data-i18n="record_text" disabled>'),
        ('<button id="stop" class="secondary" disabled>', '<button id="stop" class="secondary" data-i18n="stop_text" disabled>'),
        ('<button id="downloadLatest" class="secondary" disabled>', '<button id="downloadLatest" class="secondary" data-i18n="download_text" disabled>'),
        ('<span id="quickStatus" role="status">', '<span id="quickStatus" role="status" data-i18n="quick_status">'),
        ('<button id="reconnect" class="secondary">', '<button id="reconnect" class="secondary" data-i18n="reconnect_button">'),
    ]
    
    for old, new in replacements:
        content = content.replace(old, new)
    
    # Insert i18n code
    new_content = content[:insertion_point] + i18n_code + content[insertion_point:]
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print("Modified app.js successfully")
else:
    print("Could not find start function in", filepath)
    # Print what we found
    idx = content.find("function start")
    if idx >= 0:
        print("Found at index", idx)
        print(content[idx:idx+50])