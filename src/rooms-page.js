/* 圆桌面板的前端脚本。
 *
 * 刻意放在独立文件里、由 /rooms.js 直接提供:内联在模板字符串里时,
 * 正则里的 \s \n 会被 TS 的模板转义吃掉,而且测试只能间接发现。
 *
 * 渲染纪律:模型输出一律**逐节点构建 DOM**(createElement/textContent),
 * 不碰 innerHTML —— Markdown 渲染也不例外。
 */
(function () {
  var selected = null;
  var catalog = [];
  var listSig = null;
  var chatSig = null;
  var chatRoom = null;
  var NL = String.fromCharCode(10);
  var BT = String.fromCharCode(96);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function fmtTime(ts) {
    try { return new Date(ts || Date.now()).toLocaleTimeString(); } catch (e) { return ''; }
  }
  function initials(seat) { return String(seat || '?').slice(0, 2); }

  /* ---------------- Markdown(安全子集) ---------------- */

  function inlineInto(parent, s) {
    var pattern = '(\\*\\*[^*]+\\*\\*|' + BT + '[^' + BT + ']+' + BT + '|\\*[^*]+\\*|\\[[^\\]]+\\]\\([^)]+\\))';
    var re = new RegExp(pattern, 'g');
    var last = 0;
    var m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
      var tok = m[0];
      if (tok.slice(0, 2) === '**') {
        parent.appendChild(el('strong', null, tok.slice(2, -2)));
      } else if (tok.charAt(0) === BT) {
        parent.appendChild(el('code', 'inline', tok.slice(1, -1)));
      } else if (tok.charAt(0) === '*') {
        parent.appendChild(el('em', null, tok.slice(1, -1)));
      } else {
        var mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
        var href = mm ? mm[2].trim() : '';
        // 只放行 http(s)/mailto:模型写 javascript: 之类一律降级成纯文本。
        if (mm && /^(https?:\/\/|mailto:)/i.test(href)) {
          var a = el('a', null, mm[1]);
          a.href = href;
          a.target = '_blank';
          a.rel = 'noreferrer noopener';
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(tok));
        }
      }
      last = m.index + tok.length;
    }
    if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
  }

  function renderMarkdown(text) {
    var frag = document.createDocumentFragment();
    var raw = String(text == null ? '' : text).replace(/\r/g, '');
    var lines = raw.split(NL);

    function flushParagraph(buf) {
      if (!buf.length) return;
      var p = el('p');
      buf.forEach(function (line, idx) {
        if (idx > 0) p.appendChild(el('br'));
        inlineInto(p, line);
      });
      frag.appendChild(p);
    }

    var buf = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      if (line.indexOf(BT + BT + BT) === 0) {
        flushParagraph(buf); buf = [];
        var lang = line.slice(3).trim();
        var code = [];
        i += 1;
        while (i < lines.length && lines[i].indexOf(BT + BT + BT) !== 0) { code.push(lines[i]); i += 1; }
        i += 1;
        var pre = el('pre');
        pre.appendChild(el('code', lang ? 'lang-' + lang : null, code.join(NL)));
        frag.appendChild(pre);
        continue;
      }

      if (/^\s*$/.test(line)) { flushParagraph(buf); buf = []; i += 1; continue; }

      var h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flushParagraph(buf); buf = [];
        var tag = h[1].length <= 2 ? 'h2' : 'h3';
        var hn = el(tag);
        inlineInto(hn, h[2]);
        frag.appendChild(hn);
        i += 1; continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        flushParagraph(buf); buf = [];
        var ul = el('ul');
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          var li = el('li');
          inlineInto(li, lines[i].replace(/^\s*[-*+]\s+/, ''));
          ul.appendChild(li);
          i += 1;
        }
        frag.appendChild(ul);
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushParagraph(buf); buf = [];
        var ol = el('ol');
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          var li2 = el('li');
          inlineInto(li2, lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          ol.appendChild(li2);
          i += 1;
        }
        frag.appendChild(ol);
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph(buf); buf = [];
        var q = el('blockquote');
        inlineInto(q, line.replace(/^\s*>\s?/, ''));
        frag.appendChild(q);
        i += 1; continue;
      }

      if (/^\s*([-*_]\s*){3,}$/.test(line)) {
        flushParagraph(buf); buf = [];
        frag.appendChild(el('hr'));
        i += 1; continue;
      }

      buf.push(line);
      i += 1;
    }
    flushParagraph(buf);
    return frag;
  }

  /* ---------------- 会话列表 / 消息流 ---------------- */

  function renderList(rooms) {
    var box = document.getElementById('rooms');
    var sig = rooms.map(function (r) {
      return r.id + ':' + r.turns + ':' + (r.updatedAt || 0) + ':' + (r.missing ? 'm' : '');
    }).join('|') + '#' + selected;
    if (sig === listSig) return;
    listSig = sig;
    box.textContent = '';
    if (!rooms.length) {
      box.appendChild(el('p', 'empty', '还没有讨论'));
      return;
    }
    rooms.forEach(function (r) {
      var b = el('button', 'room' + (r.id === selected ? ' active' : ''));
      b.type = 'button';
      b.appendChild(el('span', 'rid', r.topic ? String(r.topic).split(NL)[0].slice(0, 40) : r.id));
      b.appendChild(el('span', 'rsub', (r.seats || []).join(' · ')));
      b.appendChild(el('span', 'rsub', r.turns + ' 条' + (r.missing ? ' · 目录不见了' : '') + ' · ' + fmtTime(r.updatedAt)));
      b.addEventListener('click', function () { selected = r.id; chatSig = null; load(); });
      box.appendChild(b);
    });
  }

  function renderChat(data) {
    var log = document.getElementById('chatlog');
    var title = document.getElementById('roomtitle');
    var meta = document.getElementById('roommeta');

    if (!data || !data.found) {
      log.textContent = '';
      chatSig = null;
      title.textContent = '还没有选择讨论';
      meta.textContent = '在下面发第一条消息即可开一个新讨论';
      log.appendChild(el('p', 'empty', (data && data.why) || '还没有选择讨论'));
      return;
    }

    var turns = data.transcript || [];
    var sig = data.id + '|' + turns.map(function (t) {
      return t.turn + ':' + (t.at || 0) + ':' + (t.kind || '');
    }).join(',');
    if (sig === chatSig) return;
    chatSig = sig;

    var room = data.room || {};
    title.textContent = room.topic ? String(room.topic).split(NL)[0].slice(0, 80) : data.id;
    var seats = (room.seats || []).map(function (s) { return s.label || s.harness; });
    meta.textContent = seats.join(' · ') + ' · ' + turns.length + ' 条';

    var stick = (log.scrollHeight - log.scrollTop - log.clientHeight) < 48;
    if (data.id !== chatRoom) { chatRoom = data.id; stick = true; }

    log.textContent = '';
    var wrap = el('div', 'chatwrap');
    if (!turns.length) wrap.appendChild(el('p', 'empty', '还没有发言。在下面说第一句。'));

    turns.forEach(function (t) {
      var row = el('div', 'msg ' + (t.kind || 'message'));
      row.appendChild(el('div', 'avatar', initials(t.seat)));

      var body = el('div', 'body');
      var head = el('div', 'mhead');
      head.appendChild(el('span', 'name', t.seat || '?'));
      head.appendChild(el('span', null, fmtTime(t.at)));
      if (t.kind === 'pass') head.appendChild(el('span', 'pill', '弃权'));
      if (t.kind === 'absent') head.appendChild(el('span', 'pill bad', '缺席'));
      if (t.kind === 'final') head.appendChild(el('span', 'pill', '最终结果'));
      if (t.kind === 'system') head.appendChild(el('span', 'pill warn', '编排'));
      if (t.reseeded) head.appendChild(el('span', 'pill warn', '重建会话'));
      if (t.usage) {
        head.appendChild(el('span', null, 'in ' + (t.usage.inputTokens == null ? '?' : t.usage.inputTokens) + ' / out ' + (t.usage.outputTokens == null ? '?' : t.usage.outputTokens)));
      }
      body.appendChild(head);

      var bubble = el('div', 'bubble');
      if (t.text) bubble.appendChild(renderMarkdown(t.text));
      else if (t.reason) bubble.appendChild(el('div', 'hint', t.reason));
      body.appendChild(bubble);

      row.appendChild(body);
      wrap.appendChild(row);
    });

    log.appendChild(wrap);
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function load() {
    fetch('/api/rooms').then(function (r) { return r.json(); }).then(renderList).catch(function () {});
    if (!selected) { renderChat(null); return; }
    fetch('/api/room?id=' + encodeURIComponent(selected)).then(function (r) { return r.json(); }).then(renderChat).catch(function () {});
  }

  /* ---------------- 席位选择器 ---------------- */

  function closeMenus(except) {
    Array.prototype.forEach.call(document.querySelectorAll('.menu'), function (m) {
      if (m !== except) m.hidden = true;
    });
  }
  document.addEventListener('click', function () { closeMenus(null); });

  function makePicker(cls, values, emptyLabel, selectedValue, labelOf) {
    var wrap = el('div', 'picker ' + cls);
    var btn = el('button', 'pbtn');
    btn.type = 'button';
    var menu = el('div', 'menu');
    menu.hidden = true;
    // 菜单里的点击不要冒泡到 document(否则一点就关)。
    menu.addEventListener('click', function (ev) { ev.stopPropagation(); });

    var current = selectedValue || '';
    var empty = emptyLabel || '';
    var list = values || [];
    var cb = function () {};
    var filterText = '';
    var itemsBox = null;

    function name(v) { return labelOf ? labelOf(v) : v; }
    function label() {
      if (list.length === 0) return empty || '未知';
      return name(current || list[0]);
    }
    function fillItems() {
      if (!itemsBox) return;
      itemsBox.textContent = '';
      var f = filterText.trim().toLowerCase();
      var shown = 0;
      for (var i = 0; i < list.length && shown < 400; i++) {
        var v = list[i];
        var text = name(v);
        if (f && text.toLowerCase().indexOf(f) === -1) continue;
        var it = el('button', 'mitem' + (v === current ? ' sel' : ''), text);
        it.type = 'button';
        (function (val) {
          it.addEventListener('click', function (ev) {
            ev.stopPropagation();
            current = val;
            menu.hidden = true;
            render();
            cb();
          });
        })(v);
        itemsBox.appendChild(it);
        shown += 1;
      }
      if (shown === 0) itemsBox.appendChild(el('div', 'mitem', '没有匹配的项'));
    }
    function render() {
      btn.textContent = label() + '  ▾';
      btn.disabled = list.length === 0;
      menu.textContent = '';
      // 长清单(opencode 有几百个模型)必须能筛,否则只能瞎滚。
      if (list.length > 30) {
        var box = el('input', 'mfilter');
        box.type = 'text';
        box.placeholder = '筛选 ' + list.length + ' 个…';
        box.value = filterText;
        box.addEventListener('input', function () { filterText = box.value; fillItems(); });
        box.addEventListener('click', function (ev) { ev.stopPropagation(); });
        menu.appendChild(box);
      }
      itemsBox = el('div', 'mitems');
      menu.appendChild(itemsBox);
      fillItems();
    }
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (btn.disabled) return;
      closeMenus(menu);
      menu.hidden = !menu.hidden;
      if (!menu.hidden) {
        var box = menu.querySelector('.mfilter');
        if (box) box.focus();
      }
    });
    render();
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return {
      el: wrap,
      get value() { return current; },
      onChange: function (fn) { cb = fn; },
      reset: function (vals, emptyText, sel) {
        list = vals || [];
        empty = emptyText || '';
        current = sel || '';
        filterText = '';
        render();
      }
    };
  }

  function catOf(id) {
    for (var i = 0; i < catalog.length; i++) if (catalog[i].id === id) return catalog[i];
    return null;
  }

  function makeRow(preset) {
    var row = el('div', 'seatrow');
    var harnessName = function (id) {
      var c = catOf(id);
      return c ? c.name + (c.available ? '' : ' · 不可用') : id;
    };
    var harness = makePicker('harness', catalog.map(function (c) { return c.id; }), null, (preset && preset.harness) || 'codex', harnessName);
    var model = makePicker('model', [], '未知(用 CLI 默认)', preset && preset.model);
    var effort = makePicker('effort', [], '未知 / 不支持', preset && preset.effort);

    function refresh(pm, pe) {
      var c = catOf(harness.value);
      if (!c) return;
      model.reset(c.models, c.models.length ? null : '未知(用 CLI 默认)', pm);
      effort.reset(c.efforts, c.efforts.length ? null : '未知 / 不支持', pe);
    }
    harness.onChange(function () {
      var c = catOf(harness.value);
      model.reset(c ? c.models : [], '未知(用 CLI 默认)', null);
      effort.reset(c ? c.efforts : [], '未知 / 不支持', null);
    });

    var del = el('button', 'iconbtn', '×');
    del.type = 'button';
    del.addEventListener('click', function () { row.remove(); });

    row.appendChild(harness.el);
    row.appendChild(model.el);
    row.appendChild(effort.el);
    row.appendChild(del);
    row._pickers = { h: harness, m: model, e: effort };
    refresh(preset && preset.model, preset && preset.effort);
    document.getElementById('seats').appendChild(row);
  }

  function collectSeats() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('#seats .seatrow'), function (row) {
      var p = row._pickers;
      if (!p) return;
      var h = p.h.value;
      if (!h) return;
      out.push(h + (p.m.value ? ':' + p.m.value : '') + (p.e.value ? '@' + p.e.value : ''));
    });
    return out.join(',');
  }

  function loadCatalog() {
    fetch('/api/seats-catalog').then(function (r) { return r.json(); }).then(function (list) {
      catalog = list || [];
      document.getElementById('seats').textContent = '';
      makeRow({ harness: 'codex', model: 'gpt-6-astra', effort: 'low' });
      makeRow({ harness: 'claude', effort: 'low' });
      makeRow({ harness: 'antigravity' });
    }).catch(function () {});
  }

  /* ---------------- 发送 / 上传 ---------------- */

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function ensureRoom() {
    if (selected) return Promise.resolve(selected);
    var topic = (document.getElementById('input').value || '').trim() || '(新讨论)';
    return postJson('/api/roundtable/start', { topic: topic, seats: collectSeats(), rounds: 0 })
      .then(function (res) {
        if (!res.ok) throw new Error(res.why || '开房间失败');
        selected = res.id;
        chatSig = null;
        return res.id;
      });
  }

  function appendPath(path) {
    var input = document.getElementById('input');
    input.value = (input.value ? input.value + NL : '') + '[附件] ' + path;
  }

  function uploadOne(f) {
    return new Promise(function (resolve) {
      var cmsg = document.getElementById('cmsg');
      if (f.size > 4 * 1024 * 1024) { cmsg.textContent = f.name + ' 太大(上限 4MB)'; resolve(false); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var b64 = String(reader.result).split(',')[1];
        cmsg.textContent = '上传中… ' + f.name;
        ensureRoom().then(function (roomId) {
          return postJson('/api/upload', { name: f.name, data: b64, id: roomId });
        }).then(function (res) {
          if (res.ok) {
            appendPath(res.rel ? res.rel + ' (abs: ' + res.path + ')' : res.path);
            cmsg.textContent = '已附加 ' + f.name;
            resolve(true);
          } else {
            cmsg.textContent = '上传失败:' + (res.why || '');
            resolve(false);
          }
        }).catch(function (e) { cmsg.textContent = '上传失败:' + e; resolve(false); });
      };
      reader.readAsDataURL(f);
    });
  }

  function uploadFiles(files) {
    var arr = Array.prototype.slice.call(files || []);
    return arr.reduce(function (p, f) {
      return p.then(function () { return uploadOne(f); });
    }, Promise.resolve());
  }

  function sendMessage() {
    var input = document.getElementById('input');
    var text = input.value.trim();
    var cmsg = document.getElementById('cmsg');
    if (!text) { cmsg.textContent = '先写点什么'; return; }

    var request;
    if (selected) {
      request = postJson('/api/room/say', { id: selected, text: text });
    } else {
      var body = {
        topic: text,
        seats: collectSeats(),
        rounds: Number(document.getElementById('rounds').value) || 1
      };
      if (document.getElementById('converge').checked) body.untilConsensus = true;
      request = postJson('/api/roundtable/start', body);
    }

    cmsg.textContent = '发送中…';
    request.then(function (res) {
      if (res.ok) {
        input.value = '';
        if (res.id) { selected = res.id; chatSig = null; }
        cmsg.textContent = '';
        load();
      } else {
        cmsg.textContent = '没发出去:' + (res.why || '未知原因');
      }
    }).catch(function (e) { cmsg.textContent = '请求失败:' + e; });
  }

  function refreshRun() {
    fetch('/api/run').then(function (r) { return r.json(); }).then(function (s) {
      var send = document.getElementById('send');
      var bar = document.getElementById('progress');
      var state = document.getElementById('pstate');
      if (s && s.running) {
        send.disabled = true;
        bar.hidden = false;
        state.textContent = (s.id || '') + ' · ' + (s.lastStatus || '正在启动…') + ' · 已 ' + Math.round((s.elapsedMs || 0) / 1000) + 's';
        if (!selected) { selected = s.id; chatSig = null; }
      } else {
        send.disabled = false;
        bar.hidden = true;
      }
    }).catch(function () {});
  }

  /* ---------------- 事件绑定 ---------------- */

  document.getElementById('send').addEventListener('click', sendMessage);
  document.getElementById('stop').addEventListener('click', function () {
    fetch('/api/run/stop', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (res) {
      document.getElementById('cmsg').textContent = res.ok ? '已停止' : ('没法停:' + (res.why || ''));
      refreshRun();
    }).catch(function (e) { document.getElementById('cmsg').textContent = '停止失败:' + e; });
  });
  document.addEventListener('keydown', function (ev) {
    var input = document.getElementById('input');
    if (document.activeElement !== input) return;
    // 中文输入法选词时也会发 Enter,别把半截拼音发出去。
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage();
    }
  });
  document.getElementById('newbtn').addEventListener('click', function () {
    selected = null;
    chatSig = null;
    listSig = null;
    document.getElementById('chatlog').textContent = '';
    document.getElementById('roomtitle').textContent = '新讨论';
    document.getElementById('roommeta').textContent = '写第一句话,它会成为议题';
    document.getElementById('settings').hidden = false;
    document.getElementById('input').focus();
    load();
  });
  document.getElementById('settingsbtn').addEventListener('click', function () {
    document.getElementById('settings').hidden = false;
  });
  document.getElementById('closesettings').addEventListener('click', function () {
    document.getElementById('settings').hidden = true;
  });
  document.getElementById('addseat').addEventListener('click', function () { makeRow({ harness: 'claude' }); });

  document.getElementById('attach').addEventListener('click', function () {
    document.getElementById('file').click();
  });
  document.getElementById('file').addEventListener('change', function (ev) {
    uploadFiles(ev.target.files);
    ev.target.value = '';
  });

  var dragDepth = 0;
  var dropBox = document.getElementById('drop');
  document.addEventListener('dragenter', function (ev) { ev.preventDefault(); dragDepth += 1; dropBox.hidden = false; });
  document.addEventListener('dragover', function (ev) { ev.preventDefault(); });
  document.addEventListener('dragleave', function (ev) {
    ev.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropBox.hidden = true;
  });
  document.addEventListener('drop', function (ev) {
    ev.preventDefault();
    dragDepth = 0;
    dropBox.hidden = true;
    if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) uploadFiles(ev.dataTransfer.files);
  });
  document.getElementById('input').addEventListener('paste', function (ev) {
    var files = ev.clipboardData && ev.clipboardData.files;
    if (files && files.length) { ev.preventDefault(); uploadFiles(files); }
  });

  /* 导出当前讨论为 .md:在浏览器里拼好再下载,不新增服务端写接口。 */
  function exportMarkdown() {
    if (!selected) { document.getElementById('cmsg').textContent = '先选一个讨论'; return; }
    fetch('/api/room?id=' + encodeURIComponent(selected)).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.found) { document.getElementById('cmsg').textContent = '房间不存在'; return; }
      var room = d.room || {};
      var seats = (room.seats || []).map(function (s) { return s.label || s.harness; });
      var lines = [];
      lines.push('# ' + (room.topic || d.id));
      lines.push('');
      lines.push('- 房间:`' + d.id + '`');
      lines.push('- 席位:' + (seats.join(' / ') || '未知'));
      lines.push('- 导出时间:' + new Date().toLocaleString());
      lines.push('');
      (d.transcript || []).forEach(function (t) {
        var tags = [];
        if (t.kind === 'pass') tags.push('弃权');
        if (t.kind === 'absent') tags.push('缺席');
        if (t.reseeded) tags.push('重建会话');
        lines.push('## ' + (t.seat || '?') + ' · 第 ' + t.turn + ' 轮' + (tags.length ? ' · ' + tags.join(' / ') : ''));
        lines.push('');
        if (t.usage) {
          lines.push('> tokens: in ' + (t.usage.inputTokens == null ? '?' : t.usage.inputTokens) + ' / out ' + (t.usage.outputTokens == null ? '?' : t.usage.outputTokens));
          lines.push('');
        }
        lines.push(t.text || ('(' + (t.reason || '无内容') + ')'));
        lines.push('');
      });
      var blob = new Blob([lines.join(NL)], { type: 'text/markdown;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = d.id + '.md';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      document.getElementById('cmsg').textContent = '已导出 ' + d.id + '.md';
    }).catch(function (e) { document.getElementById('cmsg').textContent = '导出失败:' + e; });
  }
  document.getElementById('export').addEventListener('click', exportMarkdown);

  loadCatalog();
  refreshRun();
  load();
  setInterval(function () { refreshRun(); load(); }, 1000);
})();
