#!/usr/bin/env python3
import re, sys

filepath = "frontend/duo.js"
with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

# Find the render function and add i18n loading
render_idx = content.find('function render(status)')
if render_idx >= 0:
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
        // Update language selector if it exists
        const langSelect = document.getElementById("languageSelect");
        if (langSelect) {
          langSelect.value = lang;
        }
      });
  }

  // Set up language selector if language selector exists in the DOM
  const langSelect = document.getElementById("languageSelect");
  if (langSelect) {
    langSelect.addEventListener("change", (e) => {
      loadLanguage(e.target.value);
    });
    // Load default language
    loadLanguage("zh-CN");
  }
"""

    # Insert i18n code just before the closing of the IIFE
    # Find the IIFE closing pattern
    iife_end = content.rfind("});")
    if iife_end >= 0:
        # Insert i18n code before the closing
        new_content = content[:iife_end] + i18n_code + "\n" + content[iife_end:]
        
        # Also add data-i18n attributes to key elements in duo.js
        replacements = [
            ('<span id="pressureState">', '<span id="pressureState" data-i18n="pressure_state">'),
            ('<span id="pressurePeak">', '<span id="pressurePeak" data-i18n="pressure_peak">'),
            ('<span id="pressureDetail">', '<span id="pressureDetail" data-i18n="pressure_detail">'),
            ('<span id="voltage0">', '<span id="voltage0" data-i18n="f0">'),
            ('<span id="voltage1">', '<span id="voltage1" data-i18n="f1">'),
            ('<span id="voltage2">', '<span id="voltage2" data-i18n="f2">'),
            ('<span id="voltage3">', '<span id="voltage3" data-i18n="f3">'),
            ('<span id="voltage4">', '<span id="voltage4" data-i18n="f4">'),
            ('<span id="voltage5">', '<span id="voltage5" data-i18n="f5">'),
            ('<span id="voltage6">', '<span id="voltage6" data-i18n="f6">'),
            ('<span id="voltage7">', '<span id="voltage7" data-i18n="f7">'),
        ]
        
        for old, new in replacements:
            new_content = new_content.replace(old, new)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print("Modified duo.js successfully")
    else:
        print("Could not find IIFE end in", filepath)
else:
    print("Could not find render function in", filepath)