// ================================================================
//  苦海工具箱 · 工具实现
//  --------------------------------------------------------------
//  结构：一张 TOOLS 注册表（一个键 = 一个工具）+ 一个统一的弹窗壳。
//  加新工具只需在表里添一项，不用碰页面 HTML、不用改弹窗逻辑。
//
//  为什么全部本地算：
//  这些工具（JSON、编码、哈希、配色…）都不需要服务器；放在浏览器里算，
//  输入内容不上传，站点也不用为它们加接口和限流。
// ================================================================

// ---------- 小工具函数 ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function field(label, node) {
  const w = el('div', 'tw-field');
  if (label) w.appendChild(el('label', 'tw-label', label));
  w.appendChild(node);
  return w;
}

function ta(placeholder, rows = 6, readOnly = false, value = '') {
  const n = el('textarea', 'tw-ta');
  n.rows = rows;
  n.placeholder = placeholder || '';
  n.readOnly = readOnly;
  n.value = value;
  n.spellcheck = false;
  return n;
}

function inp(placeholder, value = '', type = 'text') {
  const n = el('input', 'tw-inp');
  n.type = type;
  n.placeholder = placeholder || '';
  n.value = value;
  n.spellcheck = false;
  return n;
}

function btn(text, fn, primary = false) {
  const b = el('button', 'tw-btn' + (primary ? ' prim' : ''), text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

function row(...nodes) {
  const r = el('div', 'tw-row');
  nodes.forEach((n) => n && r.appendChild(n));
  return r;
}

function msg() {
  return el('div', 'tw-msg');
}

function setMsg(node, text, isErr = false) {
  node.textContent = text;
  node.className = 'tw-msg' + (isErr ? ' err' : ' ok');
}

function copy(text, note) {
  const done = () => { if (note) setMsg(note, '已复制到剪贴板'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, note));
  } else {
    fallbackCopy(text, note);
  }
}

function fallbackCopy(text, note) {
  try {
    const t = el('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    document.body.removeChild(t);
    if (note) setMsg(note, '已复制到剪贴板');
  } catch {
    if (note) setMsg(note, '复制失败，请手动选中', true);
  }
}

// ---------- 颜色工具 ----------
function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function rgbToHex({ r, g, b }) {
  const f = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}

function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
    else if (max === G) h = ((B - R) / d + 2) / 6;
    else h = ((R - G) / d + 4) / 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function relLum({ r, g, b }) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// ---------- 工具注册表 ----------
const TOOLS = {
  text: {
    icon: '📝', name: '文本统计与清洗',
    build(box) {
      const src = ta('把文本粘进来…', 8);
      const stat = el('div', 'tw-stat', '0 字符 · 0 行');
      const note = msg();

      const recount = () => {
        const s = src.value;
        const noSpace = s.replace(/\s/g, '').length;
        const lines = s ? s.split('\n') : [];
        const nonEmpty = lines.filter((l) => l.trim()).length;
        stat.textContent = `${s.length} 字符（不含空白 ${noSpace}） · ${lines.length} 行（非空 ${nonEmpty}）`;
      };
      src.addEventListener('input', recount);

      const lines = () => src.value.split('\n');

      const apply = (label, fn) => {
        src.value = fn(lines()).join('\n');
        recount();
        setMsg(note, label);
      };

      box.append(
        field('原文', src),
        stat,
        row(
          btn('去重行', () => apply('已去掉重复行', (ls) => [...new Set(ls.filter((l) => l.trim() || true))])),
          btn('去空行', () => apply('已删除空行', (ls) => ls.filter((l) => l.trim()))),
          btn('排序（升）', () => apply('已按升序排序', (ls) => ls.slice().sort((a, b) => a.localeCompare(b, 'zh')))),
          btn('排序（降）', () => apply('已按降序排序', (ls) => ls.slice().sort((a, b) => b.localeCompare(a, 'zh')))),
          btn('首尾空格清理', () => apply('已清理每行首尾空格', (ls) => ls.map((l) => l.trim())), true)
        ),
        note
      );
      recount();
    },
  },

  case: {
    icon: '🔤', name: '大小写与命名转换',
    build(box) {
      const src = ta('例如：user profile name', 3);
      const out = ta('结果', 3, true);
      const note = msg();

      const run = (label, fn) => {
        out.value = fn(src.value);
        setMsg(note, label);
      };

      const words = (s) => s
        .replace(/[\-_]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/\s+/)
        .filter(Boolean);

      box.append(
        field('原文', src),
        row(
          btn('全大写', () => run('已转大写', (s) => s.toUpperCase())),
          btn('全小写', () => run('已转小写', (s) => s.toLowerCase())),
          btn('首字母大写', () => run('已转标题式', (s) => s.replace(/\b\w/g, (c) => c.toUpperCase()))),
          btn('camelCase', () => run('已转驼峰', (s) => {
            const w = words(s);
            return w.map((x, i) => (i === 0 ? x.toLowerCase() : x.charAt(0).toUpperCase() + x.slice(1).toLowerCase())).join('');
          })),
          btn('snake_case', () => run('已转下划线', (s) => words(s).map((x) => x.toLowerCase()).join('_'))),
          btn('kebab-case', () => run('已转短横线', (s) => words(s).map((x) => x.toLowerCase()).join('-'), true))
        ),
        field('结果', out),
        row(btn('复制结果', () => copy(out.value, note))),
        note
      );
    },
  },

  regex: {
    icon: '🔍', name: '正则测试',
    build(box) {
      const pat = inp('例如 \\d{3,}', '');
      const flags = inp('gi', 'gi');
      const src = ta('放要匹配的文本…', 6);
      const out = el('div', 'tw-out');
      const note = msg();

      const run = () => {
        out.innerHTML = '';
        let re;
        try {
          re = new RegExp(pat.value, flags.value || '');
        } catch (e) {
          setMsg(note, '正则写错了：' + e.message, true);
          return;
        }
        const text = src.value;
        if (!re.global) {
          const m = text.match(re);
          if (!m) return setMsg(note, '没有匹配到', true);
          out.appendChild(el('div', 'tw-hit', `命中 1 处：${m[0]}`));
          return setMsg(note, '命中 1 处（去掉 g 旗标只匹配第一个）');
        }
        const hits = [...text.matchAll(re)];
        if (!hits.length) return setMsg(note, '没有匹配到', true);
        hits.slice(0, 200).forEach((m, i) => {
          const g = m.slice(1).filter((x) => x !== undefined);
          out.appendChild(el('div', 'tw-hit',
            `#${i + 1}  位置 ${m.index}  「${m[0]}」${g.length ? '  分组：' + g.join(' / ') : ''}`));
        });
        setMsg(note, `命中 ${hits.length} 处${hits.length > 200 ? '（只列出前 200）' : ''}`);
      };

      src.addEventListener('input', run);
      pat.addEventListener('input', run);

      box.append(
        field('正则表达式', pat),
        field('旗标（g 全局 / i 忽略大小写 / m 多行）', flags),
        field('测试文本', src),
        row(btn('执行匹配', run, true)),
        out,
        note
      );
    },
  },

  urlcode: {
    icon: '🔗', name: 'URL 编解码',
    build(box) {
      const src = ta('粘贴 URL 或参数值…', 5);
      const out = ta('结果', 5, true);
      const note = msg();

      box.append(
        field('原文', src),
        row(
          btn('URL 编码', () => { out.value = encodeURIComponent(src.value); setMsg(note, '已编码'); }),
          btn('URL 解码', () => {
            try { out.value = decodeURIComponent(src.value); setMsg(note, '已解码'); }
            catch { setMsg(note, '这段不是合法的 URL 编码（可能有残缺的 %xx）', true); }
          }, true)
        ),
        field('结果', out),
        row(btn('复制结果', () => copy(out.value, note))),
        note
      );
    },
  },

  base64: {
    icon: '🧬', name: 'Base64',
    build(box) {
      const src = ta('文本或 Base64…', 5);
      const out = ta('结果', 5, true);
      const note = msg();

      const toB64 = (s) => {
        const bytes = new TextEncoder().encode(s);
        let bin = '';
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        return btoa(bin);
      };
      const fromB64 = (s) => {
        const bin = atob(s.replace(/\s+/g, ''));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
      };

      box.append(
        field('原文 / 密文', src),
        row(
          btn('文本 → Base64', () => {
            try { out.value = toB64(src.value); setMsg(note, '已编码（中文也能正确往返）'); }
            catch (e) { setMsg(note, '编码失败：' + e.message, true); }
          }),
          btn('Base64 → 文本', () => {
            try { out.value = fromB64(src.value); setMsg(note, '已解码'); }
            catch { setMsg(note, '这段不是合法 Base64', true); }
          }, true)
        ),
        field('结果', out),
        row(btn('复制结果', () => copy(out.value, note))),
        note
      );
    },
  },

  timestamp: {
    icon: '⏰', name: '时间戳转换',
    build(box) {
      const ts = inp('1750000000 或 1750000000000', '');
      const unit = el('select', 'tw-inp');
      unit.innerHTML = '<option value="s">秒</option><option value="ms">毫秒</option>';
      const human = el('div', 'tw-out');
      const dt = inp('', new Date().toISOString().slice(0, 16), 'datetime-local');
      const back = el('div', 'tw-out');
      const note = msg();

      const pad = (n) => String(n).padStart(2, '0');
      const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

      const toHuman = () => {
        human.innerHTML = '';
        const raw = ts.value.trim();
        if (!raw) return;
        const n = Number(raw);
        if (!Number.isFinite(n)) return setMsg(note, '不是数字', true);
        // 下拉框未选时按秒处理，避免把 1700000000 当成毫秒算成 1970 年
        const unitValue = unit.value || 's';
        const ms = unitValue === 's' ? n * 1000 : n;
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return setMsg(note, '超出可表示的日期范围', true);
        human.appendChild(el('div', 'tw-hit', '本地：' + fmt(d)));
        human.appendChild(el('div', 'tw-hit', 'UTC ：' + d.toUTCString()));
        human.appendChild(el('div', 'tw-hit', '星期：' + ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]));
        setMsg(note, '已转换');
      };

      const toStamp = () => {
        back.innerHTML = '';
        if (!dt.value) return;
        const d = new Date(dt.value);
        if (Number.isNaN(d.getTime())) return setMsg(note, '时间格式不对', true);
        back.appendChild(el('div', 'tw-hit', '秒  ：' + Math.floor(d.getTime() / 1000)));
        back.appendChild(el('div', 'tw-hit', '毫秒：' + d.getTime()));
        setMsg(note, '已转换');
      };

      ts.addEventListener('input', toHuman);
      unit.addEventListener('change', toHuman);

      box.append(
        field('时间戳 → 日期', row(ts, unit, btn('转换', toHuman, true), btn('现在', () => { ts.value = String(Date.now()); unit.value = 'ms'; toHuman(); }))),
        human,
        field('日期 → 时间戳（按你的本地时区）', row(dt, btn('转换', toStamp))),
        back,
        note
      );
    },
  },

  json: {
    icon: '📋', name: 'JSON 格式化',
    build(box) {
      const src = ta('{"a":1,"b":[1,2]}', 7);
      const out = ta('结果', 8, true);
      const note = msg();

      const parse = () => JSON.parse(src.value);

      box.append(
        field('JSON 原文', src),
        row(
          btn('格式化（2 空格）', () => {
            try { out.value = JSON.stringify(parse(), null, 2); setMsg(note, '格式正确，已排版'); }
            catch (e) { setMsg(note, '解析失败：' + e.message, true); }
          }, true),
          btn('压缩成一行', () => {
            try { out.value = JSON.stringify(parse()); setMsg(note, '已压缩'); }
            catch (e) { setMsg(note, '解析失败：' + e.message, true); }
          }),
          btn('只校验', () => {
            try {
              const v = parse();
              const t = Array.isArray(v) ? `数组，${v.length} 项` : `对象，${Object.keys(v).length} 个键`;
              setMsg(note, '合法 JSON · ' + t);
            } catch (e) { setMsg(note, '不合法：' + e.message, true); }
          }),
          btn('清空', () => { src.value = ''; out.value = ''; setMsg(note, ''); })
        ),
        field('结果', out),
        row(btn('复制结果', () => copy(out.value, note))),
        note
      );
    },
  },

  hash: {
    icon: '#', name: '文本哈希',
    build(box) {
      const src = ta('要计算哈希的文本…', 5);
      const alg = el('select', 'tw-inp');
      alg.innerHTML = '<option value="SHA-256">SHA-256</option><option value="SHA-1">SHA-1</option>';
      const out = ta('结果', 3, true);
      const note = msg();

      box.append(
        field('原文', src),
        row(alg, btn('计算', async () => {
          const algorithm = alg.value || 'SHA-256';
          try {
            const buf = await crypto.subtle.digest(algorithm, new TextEncoder().encode(src.value));
            const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
            out.value = hex;
            setMsg(note, algorithm + ' 计算完成（长度 ' + hex.length + '）');
          } catch (e) {
            setMsg(note, '计算失败：' + e.message + '（浏览器需要在 https 或 localhost 下才提供 crypto）', true);
          }
        }, true), btn('小写显示', () => { out.value = out.value.toLowerCase(); })),
        field('结果（十六进制）', out),
        row(btn('复制结果', () => copy(out.value, note))),
        note
      );
    },
  },

  password: {
    icon: '🔐', name: '密码生成器',
    build(box) {
      const len = inp('长度', '16', 'number');
      len.min = 6;
      len.max = 64;
      const ck = (label, checked) => {
        const w = el('label', 'tw-check');
        const c = el('input');
        c.type = 'checkbox';
        c.checked = checked;
        w.append(c, el('span', null, label));
        w._c = c;
        return w;
      };
      const upper = ck('大写 A-Z', true);
      const lower = ck('小写 a-z', true);
      const digit = ck('数字 0-9', true);
      const symbol = ck('符号 !@#$', false);
      const out = ta('点"生成"…', 2, true);
      const stat = el('div', 'tw-stat', '');
      const note = msg();

      const gen = () => {
        let pool = '';
        if (upper._c.checked) pool += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (lower._c.checked) pool += 'abcdefghijklmnopqrstuvwxyz';
        if (digit._c.checked) pool += '0123456789';
        if (symbol._c.checked) pool += '!@#$%^&*()-_=+[]{};:,.?';
        if (!pool) return setMsg(note, '至少选一类字符', true);

        const n = Math.max(6, Math.min(64, Number(len.value) || 16));
        const buf = new Uint32Array(n);
        crypto.getRandomValues(buf);
        out.value = [...buf].map((x) => pool[x % pool.length]).join('');

        const bits = n * Math.log2(pool.length);
        const label = bits >= 128 ? '很强' : bits >= 90 ? '强' : bits >= 60 ? '够用' : '偏弱';
        stat.textContent = `长度 ${n} · 字符集 ${pool.length} 种 · 约 ${Math.round(bits)} 位熵 · ${label}`;
        setMsg(note, '已生成（用浏览器加密随机数，不是 Math.random）');
      };

      box.append(
        row(field('长度（6-64）', len), upper, lower, digit, symbol),
        row(btn('生成', gen, true), btn('用 24 位，四类全选', () => {
          len.value = '24'; upper._c.checked = lower._c.checked = digit._c.checked = symbol._c.checked = true; gen();
        })),
        field('结果', out),
        stat,
        row(btn('复制密码', () => copy(out.value, note))),
        note
      );
      gen();
    },
  },

  uuid: {
    icon: '🆔', name: 'UUID 生成',
    build(box) {
      const num = inp('条数', '5', 'number');
      num.min = 1;
      num.max = 100;
      const out = ta('结果', 6, true);
      const note = msg();

      const gen = () => {
        const n = Math.max(1, Math.min(100, Number(num.value) || 1));
        const list = [];
        for (let i = 0; i < n; i++) {
          if (crypto.randomUUID) list.push(crypto.randomUUID());
          else {
            const b = crypto.getRandomValues(new Uint8Array(16));
            b[6] = (b[6] & 0x0f) | 0x40;
            b[8] = (b[8] & 0x3f) | 0x80;
            const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
            list.push(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`);
          }
        }
        out.value = list.join('\n');
        setMsg(note, `已生成 ${n} 条`);
      };

      box.append(
        field('生成几条（1-100）', num),
        row(btn('生成', gen, true)),
        field('结果（每行一条）', out),
        row(btn('复制全部', () => copy(out.value, note))),
        note
      );
      gen();
    },
  },

  color: {
    icon: '🎨', name: '颜色转换',
    build(box) {
      const hex = inp('#26456e', '');
      const picker = inp('', '#26456e', 'color');
      const sw = el('div', 'tw-swatch');
      const out = el('div', 'tw-out');
      const note = msg();

      const sync = (value) => {
        const rgb = hexToRgb(value);
        if (!rgb) {
          out.innerHTML = '';
          sw.style.background = 'transparent';
          return setMsg(note, 'HEX 写错了，要 #rgb 或 #rrggbb', true);
        }
        const h = rgbToHsl(rgb);
        sw.style.background = rgbToHex(rgb);
        out.innerHTML = '';
        const lines = [
          'HEX  ' + rgbToHex(rgb).toUpperCase(),
          `RGB  ${rgb.r}, ${rgb.g}, ${rgb.b}`,
          `RGBa rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1)`,
          `HSL  hsl(${h.h}, ${h.s}%, ${h.l}%)`,
          '相对亮度 ' + relLum(rgb).toFixed(3),
        ];
        lines.forEach((t) => out.appendChild(el('div', 'tw-hit', t)));
        setMsg(note, '已转换');
      };

      hex.addEventListener('input', () => { picker.value = /^#[0-9a-f]{6}$/i.test(hex.value) ? hex.value : picker.value; sync(hex.value); });
      picker.addEventListener('input', () => { hex.value = picker.value; sync(picker.value); });

      box.append(
        field('HEX', row(hex, picker)),
        sw,
        out,
        row(btn('复制 HEX', () => copy(rgbToHex(hexToRgb(hex.value) || { r: 0, g: 0, b: 0 }), note))),
        note
      );
      sync(hex.value);
    },
  },

  contrast: {
    icon: '◐', name: '对比度检查',
    build(box) {
      const a = inp('', '#1c2b3a');
      const b = inp('', '#fbf7ee');
      const pa = inp('', '#1c2b3a', 'color');
      const pb = inp('', '#fbf7ee', 'color');
      const demo = el('div', 'tw-demo');
      const out = el('div', 'tw-out');
      const note = msg();

      const run = () => {
        const ca = hexToRgb(a.value), cb = hexToRgb(b.value);
        out.innerHTML = '';
        if (!ca || !cb) return setMsg(note, '两边都要合法的 HEX', true);
        const l1 = relLum(ca), l2 = relLum(cb);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        demo.style.background = rgbToHex(cb);
        demo.style.color = rgbToHex(ca);
        demo.textContent = '正文示例 Aa 一 二 三';
        const r = ratio.toFixed(2);
        const grades = [
          ['AAA 正文', ratio >= 7, 7],
          ['AA 正文', ratio >= 4.5, 4.5],
          ['AA 大字', ratio >= 3, 3],
        ];
        out.appendChild(el('div', 'tw-hit', '对比度 ' + r + ' : 1'));
        grades.forEach(([k, hit, need]) => {
          out.appendChild(el('div', 'tw-hit', (hit ? '✅ ' : '❌ ') + k + '（需 ≥ ' + need + '）'));
        });
        setMsg(note, ratio >= 7 ? '很稳，小字也清楚' : ratio >= 4.5 ? '正常可读，适合正文' : ratio >= 3 ? '只适合大字号' : '偏糊，建议换色', ratio < 3);
      };

      a.addEventListener('input', run);
      b.addEventListener('input', run);
      pa.addEventListener('input', () => { a.value = pa.value; run(); });
      pb.addEventListener('input', () => { b.value = pb.value; run(); });

      box.append(
        field('文字色', row(a, pa)),
        field('背景色', row(b, pb)),
        demo,
        out,
        row(btn('对调两色', () => {
          const t = a.value; a.value = b.value; b.value = t;
          pa.value = a.value; pb.value = b.value;
          run();
        })),
        note
      );
      run();
    },
  },
};

// ---------- 弹窗壳 ----------
let overlay = null;
let curBox = null;

function closeTool() {
  if (overlay) overlay.classList.remove('show');
}

function buildShell() {
  overlay = el('div', 'tw-overlay');
  overlay.innerHTML = `
    <div class="tw-box" role="dialog" aria-modal="true">
      <div class="tw-head">
        <span class="tw-ico" id="twIco"></span>
        <span class="tw-name" id="twName"></span>
        <button class="tw-close" id="twClose" title="关闭">✕</button>
      </div>
      <div class="tw-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  curBox = overlay.querySelector('.tw-body');
  overlay.querySelector('#twClose').addEventListener('click', closeTool);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeTool(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTool(); });
}

function openTool(id) {
  const t = TOOLS[id];
  if (!t) return;
  if (!overlay) buildShell();
  overlay.querySelector('#twIco').textContent = t.icon;
  overlay.querySelector('#twName').textContent = t.name;
  curBox.innerHTML = '';
  t.build(curBox);
  overlay.classList.add('show');
}

// ---------- 页面接线 ----------
function initCards() {
  document.querySelectorAll('.tool-card[data-tool]').forEach((card) => {
    const open = () => openTool(card.dataset.tool);
    card.addEventListener('click', open);
    // 卡片是 div，默认不能聚焦；补上键盘可达，回车/空格也能打开
    card.tabIndex = 0;
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

function initTabs() {
  const tabs = document.getElementById('toolTabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn');
    if (!b) return;
    const group = b.dataset.group;
    tabs.querySelectorAll('.tab-btn').forEach((x) => x.classList.toggle('active', x === b));

    document.querySelectorAll('#toolArea [data-cat]').forEach((n) => {
      const g = n.dataset.cat;
      const show = group === 'all' || group === g;
      n.style.display = show ? '' : 'none';
    });
    // 站点入口卡片没有 data-cat，跟着"全部 / site"一起显示
    document.querySelectorAll('#toolArea .tool-card[onclick]').forEach((n) => {
      n.style.display = group === 'all' || group === 'site' ? '' : 'none';
    });
  });
}

initCards();
initTabs();
