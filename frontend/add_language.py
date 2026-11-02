#!/usr/bin/env python3
import os

filepath = "frontend/index.html"
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

old = '<h1>8 路 FSR 实时采集</h1>'
new = '<h1 id="mainTitle">8 路 FSR 实时采集</h1>' + "\n" + '      <div class="language-selector">' + "\n" + '        <select id="languageSelect">' + "\n" + '          <option value="zh-CN">简体中文</option>' + "\n" + '          <option value="en">English</option>' + "\n" + '          <option value="zh-TW">繁體中文</option>' + "\n" + '        </select>' + "\n" + '      </div>'

if old in content:
    content = content.replace(old, new)
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Modified index.html successfully")
else:
    print("Could not find the target string in", filepath)