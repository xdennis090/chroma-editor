(function () {
  /**
   * ------------------------------------------------------------
   *  Core DOM lookups (guarded so we fail early if something's missing)
   * ------------------------------------------------------------
   */
  var display   = document.getElementById('display');   // main drawing canvas
  var stage     = document.getElementById('stage');     // container around the canvas
  var stageWrap = document.getElementById('stage-wrap');// outer wrapper (used for drag & drop)
  var checker   = document.getElementById('checker');   // checkerboard backdrop behind canvas
  var fileInput = document.getElementById('fileInput'); // hidden <input type="file">
  var openBtn   = document.getElementById('openBtn');   // "Open" label/button
  var panH      = document.getElementById('panH');      // bottom horizontal pan slider
  var panV      = document.getElementById('panV');      // right vertical pan slider

  if (!display || !stage || !checker) {
    console.error('Chroma boot error: missing core DOM nodes', { display, stage, checker });
    return;
  }

  /**
   * ------------------------------------------------------------
   *  Core state (canvas size, zoom/pan, current tool, layers, etc.)
   * ------------------------------------------------------------
   */
  var ctx = display.getContext('2d');

  // Canvas logical size (in canvas pixels)
  var canvasW = 1200, canvasH = 800;

  // Viewport and interaction
  var zoom = 1, minZoom = 0.1, maxZoom = 8;
  var panX = 0, panY = 0;
  var isPanning = false;
  var lastPan = { x: 0, y: 0 };

  // Active tool + drawing state
  var tool = 'move';
  var drawing = false;
  var last  = { x: 0, y: 0 };
  var start = { x: 0, y: 0 };

  // Brush/ink settings and colors
  var brushSize = 24, hardness = 0.8, alpha = 1;
  var sizeByTool = {
    brush: 24,
    eraser: 24,
    'ink-eraser': 24,
    line: 4,
    rect: 4,
    ellipse: 4
  };

  var primary   = '#ff4d4d', secondary = '#1ec8ff';

  // Shape/text options
  var isStroke = false;

  // Crop/transform state
  var cropRect  = null;
  var transform = null;

  // History
  var history = [];
  var redoStack = [];

  // Layers UI + model
  var layersEl = document.getElementById('layers');
  var layers   = [];
  var active   = -1;

  // Right dock panels and their user-visibility flags
  var filtersPanel = document.getElementById('filters');
  var layersPanel  = document.getElementById('layersPanel');
  var canvasPanel  = document.getElementById('canvasPanel');
  var vis = { filters: true, layers: true, canvas: true };
  var isRestoring = false;

  /**
   * ------------------------------------------------------------
   *  Tool Options UI hooks (Size, Hardness, Opacity, Stroke/Fill)
   * ------------------------------------------------------------
   */
  var sizeInput     = document.getElementById('size');
  var hardnessInput = document.getElementById('hardness');
  var opacityInput  = document.getElementById('opacity');
  var strokeBtn     = document.getElementById('strokeBtn');
  var fillBtn       = document.getElementById('fillBtn');

  if (sizeInput) {
    sizeInput.addEventListener('input', function () {
      brushSize = clamp(parseInt(sizeInput.value || '24', 10), 1, 300);
      var key = (tool === 'ink-eraser') ? 'eraser' : tool;
      if (sizeByTool[key] != null) sizeByTool[key] = brushSize;
    });
  }

  if (hardnessInput) {
    hardnessInput.addEventListener('input', function () {
      hardness = clamp(parseFloat(hardnessInput.value || '0.8'), 0, 1);
    });
  }

  if (opacityInput) {
    opacityInput.addEventListener('input', function () {
      alpha = clamp(parseFloat(opacityInput.value || '1'), 0, 1);
    });
  }

  function syncShapeModeUI() {
    if (strokeBtn) strokeBtn.setAttribute('aria-pressed', String(isStroke));
    if (fillBtn)   fillBtn.setAttribute('aria-pressed', String(!isStroke));
  }
  if (strokeBtn) strokeBtn.addEventListener('click', function () { isStroke = true;  syncShapeModeUI(); });
  if (fillBtn)   fillBtn.addEventListener('click',   function () { isStroke = false; syncShapeModeUI(); });
  syncShapeModeUI();

  /**
   * ------------------------------------------------------------
   *  Colors panel hooks (keep JS state in sync with the UI)
   * ------------------------------------------------------------
   */
  var primInput = document.getElementById('colorPrimary');
  var secInput  = document.getElementById('colorSecondary');
  var swapBtn   = document.getElementById('swapColors');

  if (primInput) primInput.addEventListener('input', function () {
    primary = primInput.value;
  });

  if (secInput) secInput.addEventListener('input', function () {
    secondary = secInput.value;
  });

  if (swapBtn) swapBtn.addEventListener('click', function () {
    var t = primary;
    primary   = secondary;
    secondary = t;

    if (primInput) primInput.value = primary;
    if (secInput)  secInput.value  = secondary;
  });

  /**
   * ------------------------------------------------------------
   *  Utilities
   * ------------------------------------------------------------
   */
  function $(sel)    { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function toCanvas(clientX, clientY) {
    var r  = stage.getBoundingClientRect();
    var sx = clientX - r.left;
    var sy = clientY - r.top;
    return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
  }

  /**
   * ------------------------------------------------------------
   *  Export helpers (feature detect supported formats, name files)
   * ------------------------------------------------------------
   */
  var _fmtCache = {};

  function supportsFormat(type) {
    if (_fmtCache[type] != null) return _fmtCache[type];
    var c = document.createElement('canvas');
    try {
      var ok = c.toDataURL(type).indexOf('data:' + type) === 0;
      _fmtCache[type] = ok;
      return ok;
    } catch (e) {
      _fmtCache[type] = false;
      return false;
    }
  }

  function filenameFor(type) {
    return type === 'image/jpeg' ? 'chroma.jpg'
         : type === 'image/webp' ? 'chroma.webp'
         :                           'chroma.png';
  }

  /**
   * ------------------------------------------------------------
   *  History (snapshots via data-URLs; limited to last 50 by default)
   * ------------------------------------------------------------
   */
  function pushHistory(desc) {
    if (desc === undefined) desc = 'edit';
    var snap = layers.map(function (L) {
      return {
        name:    L.name,
        visible: L.visible,
        opacity: L.opacity,
        x:       L.x,
        y:       L.y,
        bmp:     L.canvas.toDataURL(),
        isInk:   !!L.isInk
      };
    });
    history.push({ desc: desc, snap: snap, w: canvasW, h: canvasH, active: active });
    if (history.length > 50) history.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    var u = document.getElementById('undoBtn');
    var r = document.getElementById('redoBtn');
    if (u) u.disabled = isRestoring || history.length === 0;
    if (r) r.disabled = isRestoring || redoStack.length === 0;
  }

  function restore(entry) {
    if (!entry) return;
    isRestoring = true;
    updateHistoryButtons();
    fxReset(true);

    canvasW = entry.w;
    canvasH = entry.h;
    syncCanvasInputs();
    resizeDisplay();

    layers.length = 0;
    layersEl.innerHTML = '';

    if (entry.snap.length === 0) {
      active = -1;
      isRestoring = false;
      updateHistoryButtons();
      render();
      updateContextPanels();
      return;
    }

    var remaining = entry.snap.length;
    entry.snap.forEach(function (s) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        var cctx = c.getContext('2d');
        cctx.drawImage(img, 0, 0);

        var L = addLayer({
          name: s.name,
          canvas: c,
          ctx: cctx,
          visible: s.visible,
          opacity: s.opacity,
          x: s.x,
          y: s.y
        }, false);

        if (s.isInk) L.isInk = true;
        remaining--;

        if (remaining === 0) {
          isRestoring = false;
          updateHistoryButtons();
          if (typeof entry.active === 'number' && entry.active >= 0 && entry.active < layers.length) {
            setActive(entry.active);
          } else {
            setActive(layers.length - 1);
          }
          render();
          updateContextPanels();
        }
      };
      img.src = s.bmp;
    });
  }

  function snapshotCurrent() {
    return {
      desc: 'live',
      snap: layers.map(function (L) {
        return {
          name: L.name,
          visible: L.visible,
          opacity: L.opacity,
          x: L.x,
          y: L.y,
          bmp: L.canvas.toDataURL(),
          isInk: !!L.isInk
        };
      }),
      w: canvasW,
      h: canvasH,
      active: active
    };
  }

  /**
   * ------------------------------------------------------------
   *  Layers (model + list UI)
   * ------------------------------------------------------------
   */
  function addLayer(options, push) {
    if (options == null) options = {};
    if (push === undefined) push = true;

    if (push) pushHistory('add layer');

    var c = options.canvas || document.createElement('canvas');
    if (!options.canvas) { c.width = canvasW; c.height = canvasH; }
    var cctx = options.ctx || c.getContext('2d');

    var L = {
      canvas: c,
      ctx: cctx,
      name: options.name || ('Layer ' + (layers.length + 1)),
      visible: options.visible !== false,
      opacity: options.opacity != null ? options.opacity : 1,
      x: options.x || 0,
      y: options.y || 0
    };
    layers.push(L);
    captureLayerBase(L);

    var row = document.createElement('div');
    row.className = 'layer';
    row.innerHTML =
      '<input type="checkbox" ' + (L.visible ? 'checked' : '') + ' title="Toggle visibility"/>' +
      '<input type="range" min="0" max="1" step="0.05" value="' + L.opacity + '" title="Opacity" style="width:60px">' +
      '<span class="pill">' + layers.length + '</span>' +
      '<input type="text" value="' + L.name + '"/>';

    row.querySelector('input[type=checkbox]').addEventListener('input', function (e) { L.visible = e.target.checked; render(); });
    row.querySelector('input[type=range]').addEventListener('input',    function (e) { L.opacity = parseFloat(e.target.value); render(); });
    row.querySelector('input[type=text]').addEventListener('change',    function (e) { L.name = e.target.value; });
    row.addEventListener('click', function () { setActive(layers.indexOf(L)); });

    layersEl.prepend(row);
    setActive(layers.length - 1);
    return L;
  }

  function refreshLayersUI() {
    Array.prototype.forEach.call(layersEl.children, function (el, i) {
      el.setAttribute('data-active', String((layers.length - 1 - i) === active));
    });
  }

  function setActive(i) {
    if (fxPreview && fxPreview.layer !== i) { fxReset(true); }
    active = i;
    refreshLayersUI();
  }

  function ensureInkLayer() {
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].isInk) return layers[i];
    }
    var old = active;
    var L = addLayer({ name: 'Brush Strokes' }, false);
    L.isInk = true;
    L.x = 0; L.y = 0;
    setActive(old);
    return L;
  }

  function captureLayerBase(L) {
    try {
      L.baseW = L.canvas.width;  L.baseH = L.canvas.height;
      L.baseX = L.x || 0;        L.baseY = L.y || 0;
      L.baseData = L.ctx.getImageData(0, 0, L.canvas.width, L.canvas.height);
    } catch (e) {
      L.baseData = null;
    }
  }

  /**
   * ------------------------------------------------------------
   *  View / render (size the canvas element, draw all visible layers)
   * ------------------------------------------------------------
   */
  function syncCanvasInputs() {
    var wEl = document.getElementById('canvasW');
    var hEl = document.getElementById('canvasH');
    if (wEl) wEl.value = String(canvasW);
    if (hEl) hEl.value = String(canvasH);
  }

  function resizeDisplay() {
    var w = Math.round(canvasW * zoom), h = Math.round(canvasH * zoom);
    display.width  = w; display.height = h;
    display.style.width  = w + 'px';
    display.style.height = h + 'px';
    checker.style.width  = w + 'px';
    checker.style.height = h + 'px';
    render();
    updateZoom();
    syncPanSliders();
  }

  function fitOnScreen() {
    var rect   = stage.getBoundingClientRect();
    var scaleX = (rect.width  - 40) / canvasW;
    var scaleY = (rect.height - 40) / canvasH;
    zoom = clamp(Math.min(scaleX, scaleY), 0.05, 4);
    panX = rect.width  / 2 - (canvasW * zoom) / 2;
    panY = rect.height / 2 - (canvasH * zoom) / 2;
    resizeDisplay();
  }

  function render() {
    ctx.clearRect(0, 0, display.width, display.height);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (!L.visible) continue;
      ctx.globalAlpha = L.opacity;

      if (transform && transform.dragging && i === active && tool === 'transform') {
        var b = normalizeBox(transform.box);
        ctx.drawImage(L.canvas, b.x, b.y, b.w, b.h);
      } else {
        ctx.drawImage(L.canvas, L.x, L.y);
      }
    }

    if (tool === 'crop' && cropRect) {
      ctx.save();
      ctx.strokeStyle = '#5ea0ff';
      ctx.lineWidth   = 1.5 / zoom;
      ctx.setLineDash([8 / zoom, 6 / zoom]);
      ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      ctx.restore();
    }

    if (tool === 'transform' && active >= 0) {
      var L  = layers[active];
      var box = (transform && transform.dragging)
        ? transform.box
        : { x: L.x, y: L.y, w: L.canvas.width, h: L.canvas.height };
      drawTransformGizmos(box);
    }

    ctx.restore();
    syncPanSliders();
  }

  function updateZoom() {
    display.style.left = '0px'; display.style.top  = '0px';
    checker.style.left = panX + 'px'; checker.style.top = panY + 'px';
  }

  /**
   * ------------------------------------------------------------
   *  Pan sliders
   * ------------------------------------------------------------
   */
  function panLimits() {
    var r  = stage.getBoundingClientRect();
    var cw = canvasW * zoom, ch = canvasH * zoom;
    return {
      minX: Math.min(0, r.width  - cw), maxX: 0,
      minY: Math.min(0, r.height - ch), maxY: 0
    };
  }

  function syncPanSliders() {
    if (!panH && !panV) return;
    var lim = panLimits();
    var dx  = (lim.maxX - lim.minX) || 1;
    var dy  = (lim.maxY - lim.minY) || 1;

    if (panH) {
      var tX = (panX - lim.minX) / dx;
      panH.value = String(Math.round(100 * (1 - clamp(tX, 0, 1))));
    }
    if (panV) {
      var tY = (panY - lim.minY) / dy;
      panV.value = String(Math.round(100 * clamp(tY, 0, 1)));
    }
  }

  function onPanSlider(e) {
    var lim = panLimits();
    if (e && e.target === panH) {
      var tX = (100 - parseFloat(panH.value || '50')) / 100;
      panX = lim.minX + (lim.maxX - lim.minX) * tX;
    } else if (e && e.target === panV) {
      var tY = (parseFloat(panV.value || '50')) / 100;
      panY = lim.minY + (lim.maxY - lim.minY) * tY;
    }
    render();
  }

  if (panH) panH.addEventListener('input', onPanSlider);
  if (panV) panV.addEventListener('input', onPanSlider);

  /**
   * ------------------------------------------------------------
   *  Context panels (right side): show/hide depending on active tool
   * ------------------------------------------------------------
   */
  function updateContextPanels() {
    $all('.context-panel').forEach(function (p) {
      var allow = (p.getAttribute('data-tools') || '')
        .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

      var showForTool = (allow.length === 0) || (allow.indexOf(tool) >= 0);
      if (showForTool) p.classList.remove('context-hidden');
      else             p.classList.add('context-hidden');

      if (p.id === 'panelTool') {
        $all('#panelTool .tool-opt').forEach(function (row) {
          var opts = (row.getAttribute('data-opt') || '')
            .split(',').map(function (s) { return s.trim(); });
          row.style.display = opts.indexOf(tool) >= 0 ? '' : 'none';
        });
      }
    });
    updateDockPanels();
  }

  function updateDockPanels() {
    if (filtersPanel) {
      var filtersAllowed = !filtersPanel.classList.contains('context-hidden');
      filtersPanel.style.display = (vis.filters && filtersAllowed) ? '' : 'none';
    }
    if (layersPanel) layersPanel.style.display = vis.layers ? '' : 'none';
    if (canvasPanel) canvasPanel.style.display = vis.canvas ? '' : 'none';

    if (toggleFiltersBtn) toggleFiltersBtn.setAttribute('aria-pressed', String(vis.filters));
    if (toggleLayersBtn)  toggleLayersBtn.setAttribute('aria-pressed', String(vis.layers));
    if (toggleCanvasBtn)  toggleCanvasBtn.setAttribute('aria-pressed', String(vis.canvas));
  }

  /**
   * ------------------------------------------------------------
   *  Reload app
   * ------------------------------------------------------------
   */
  var reloadBtn = document.getElementById('reloadBtn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', function () {
      if (!confirm('Reset the workspace? Unsaved changes will be lost.')) return;
      window.location.reload();
    });
  }

  function setTool(t) {
    if (t === 'brush' || t === 'eraser' || t === 'ink-eraser' ||
        t === 'text'  || t === 'fill'   || t === 'line' ||
        t === 'rect'  || t === 'ellipse') {
      fxReset(false);
    }

    tool = t;
    $all('#toolbar button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-tool') === t));
    });

    var key = (t === 'ink-eraser') ? 'eraser' : t;
    if (sizeInput && sizeByTool[key] != null) {
      sizeInput.value = String(sizeByTool[key]);
      brushSize = sizeByTool[key];
    }

    setActive(active);
    updateContextPanels();
    render();
  }

  $all('#toolbar button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTool(btn.getAttribute('data-tool'));
    });
  });

  /* ------------------------------------------------------------
   * Brush / eraser helpers
   * ----------------------------------------------------------*/
  function hexToRgba(hex, a) {
    if (a === undefined) a = 1;
    var v = hex.replace('#', '');
    var bigint = parseInt(v.length === 3 ? v.split('').map(function (ch) { return ch + ch; }).join('') : v, 16);
    var r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function drawDot(L, x, y) {
    var c = L.ctx;
    var r = brushSize / 2;
    c.save();
    c.globalAlpha = alpha;
    c.fillStyle = primary;
    c.beginPath();

    if (hardness >= 0.999) {
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    } else {
      var g = c.createRadialGradient(x, y, r * hardness, x, y, r);
      g.addColorStop(0, primary);
      g.addColorStop(1, hexToRgba(primary, 0));
      c.fillStyle = g;
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  function drawLine(L, x1, y1, x2, y2) {
    var steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / Math.max(1, brushSize * 0.25)));
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      drawDot(L, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
    }
  }

  function eraseLine(L, x1, y1, x2, y2) {
    var c = L.ctx;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.globalAlpha = alpha;
    var steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / Math.max(1, brushSize * 0.25)));
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      c.beginPath();
      c.arc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, brushSize / 2, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  /* ------------------------------------------------------------
   * Bucket fill (4-way flood fill on the active layer)
   * ----------------------------------------------------------*/
  function bucketFill(L, x, y, newColor) {
    var width = L.canvas.width, height = L.canvas.height;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    var c = L.ctx;
    var img = c.getImageData(0, 0, width, height);
    var data = img.data;

    var idx = function (ix, iy) { return (iy * width + ix) * 4; };
    var target = data.slice(idx(x, y), idx(x, y) + 4);
    var nc = hexToRgbArr(newColor);
    nc[3] = Math.round(255 * alpha);

    if (equals(target, nc)) return;

    var q = [[x, y]];
    var seen = new Uint8Array(width * height);

    while (q.length) {
      var pt = q.pop();
      var cx = pt[0], cy = pt[1];
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;

      var flat = cy * width + cx;
      if (seen[flat]) continue;

      var i = flat * 4;
      if (equal4(data, i, target)) {
        data[i]     = nc[0];
        data[i + 1] = nc[1];
        data[i + 2] = nc[2];
        data[i + 3] = nc[3];

        seen[flat] = 1;
        q.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
    }

    c.putImageData(img, 0, 0);
  }

  function hexToRgbArr(hex) {
    var v = hex.replace('#', '');
    var bigint = parseInt(v.length === 3 ? v.split('').map(function (ch) { return ch + ch; }).join('') : v, 16);
    return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255, 255];
  }
  function equals(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }
  function equal4(data, i, tar) { return data[i] === tar[0] && data[i + 1] === tar[1] && data[i + 2] === tar[2] && data[i + 3] === tar[3]; }

  /* ------------------------------------------------------------
   * Transform helpers (resize/move handles)
   * ----------------------------------------------------------*/
  function normalizeBox(b) {
    var x = b.x, y = b.y, w = b.w, h = b.h;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    return { x: x, y: y, w: w, h: h };
  }

  function drawTransformGizmos(b) {
    var box = normalizeBox(b);
    var hs = 8 / zoom;
    ctx.save();
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = '#5ea0ff';
    ctx.setLineDash([6 / zoom, 6 / zoom]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#e7edf6';
    ctx.strokeStyle = '#0a1220';

    var pts = [
      [box.x, box.y], [box.x + box.w, box.y],
      [box.x, box.y + box.h], [box.x + box.w, box.y + box.h],
      [box.x + box.w / 2, box.y], [box.x + box.w / 2, box.y + box.h],
      [box.x, box.y + box.h / 2], [box.x + box.w, box.y + box.h / 2]
    ];
    for (var i = 0; i < pts.length; i++) {
      var px = pts[i][0] - hs / 2, py = pts[i][1] - hs / 2;
      ctx.fillRect(px, py, hs, hs);
      ctx.strokeRect(px, py, hs, hs);
    }
    ctx.restore();
  }

  function hitHandle(b, p) {
    var box = normalizeBox(b);
    var hs = 10 / zoom;
    function near(x, y) { return (p.x >= x - hs && p.x <= x + hs && p.y >= y - hs && p.y <= y + hs); }

    if (near(box.x, box.y)) return 'nw';
    if (near(box.x + box.w, box.y)) return 'ne';
    if (near(box.x, box.y + box.h)) return 'sw';
    if (near(box.x + box.w, box.y + box.h)) return 'se';
    if (near(box.x + box.w / 2, box.y)) return 'n';
    if (near(box.x + box.w / 2, box.y + box.h)) return 's';
    if (near(box.x, box.y + box.h / 2)) return 'w';
    if (near(box.x + box.w, box.y + box.h / 2)) return 'e';
    if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) return 'move';
    return null;
  }

  function boxFromHandle(orig, handle, p, keepAR, startPt) {
    var x = orig.x, y = orig.y, w = orig.w, h = orig.h;
    var ar = orig.w / Math.max(1, orig.h);

    switch (handle) {
      case 'nw': x = p.x; y = p.y; w = orig.x + orig.w - p.x; h = orig.y + orig.h - p.y; break;
      case 'ne': x = orig.x; y = p.y; w = p.x - orig.x;       h = orig.y + orig.h - p.y; break;
      case 'sw': x = p.x;  y = orig.y; w = orig.x + orig.w - p.x; h = p.y - orig.y;      break;
      case 'se': x = orig.x; y = orig.y; w = p.x - orig.x;    h = p.y - orig.y;          break;
      case 'n':  y = p.y;  h = orig.y + orig.h - p.y;                                    break;
      case 's':  h = p.y - orig.y;                                                       break;
      case 'w':  x = p.x;  w = orig.x + orig.w - p.x;                                    break;
      case 'e':  w = p.x - orig.x;                                                       break;
      case 'move': x = orig.x + (p.x - startPt.x); y = orig.y + (p.y - startPt.y);       break;
    }

    if (keepAR && (handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se')) {
      var signW = w < 0 ? -1 : 1, signH = h < 0 ? -1 : 1;
      w = Math.abs(w); h = Math.abs(h);
      if (w / h > ar) { w = h * ar; } else { h = w / ar; }
      w *= signW; h *= signH;

      if (handle === 'nw') { x = orig.x + (orig.w - w); y = orig.y + (orig.h - h); }
      if (handle === 'ne') { y = orig.y + (orig.h - h); }
      if (handle === 'sw') { x = orig.x + (orig.w - w); }
    }
    return { x: x, y: y, w: w, h: h };
  }

  /* ------------------------------------------------------------
   * FX (stackable filters) — state + preview management
   * ----------------------------------------------------------*/
  var fxState = {
    adjust:   { on: true, br: 0, ct: 0, st: 0 },
    grayscale: false,
    invert:    false,
    sepia:     false,
    blur:      { on: false, radius: 2 },
    sharpen:   false,
    pixelate:  { on: false, size: 12 },
    posterize: { on: false, levels: 6 },
    vignette:  { on: false, strength: 0.35, radius: 0.85 }
  };

  var fxPreview = null;

  function fxEnsure() {
    if (active < 0) return null;
    if (!fxPreview || fxPreview.layer !== active) {
      var L = layers[active];
      try {
        fxPreview = { layer: active, orig: L.ctx.getImageData(0, 0, L.canvas.width, L.canvas.height) };
      } catch (e) {
        fxPreview = null;
      }
    }
    return fxPreview;
  }

  function fxReset(restoreOrig) {
    if (!fxPreview) return;
    if (restoreOrig && active === fxPreview.layer && layers[active]) {
      layers[active].ctx.putImageData(fxPreview.orig, 0, 0);
      render();
    }
    fxPreview = null;
  }

  function readFxUI() {
    var g = function (id) { var el = document.getElementById(id); return el ? el.checked : false; };
    var v = function (id) { var el = document.getElementById(id); return el ? el.value   : null;  };

    fxState.adjust.on = g('fx_on_adjust');
    fxState.adjust.br = parseInt(v('fx_bright')     || '0', 10);
    fxState.adjust.ct = parseInt(v('fx_contrast')   || '0', 10);
    fxState.adjust.st = parseInt(v('fx_saturation') || '0', 10);

    fxState.grayscale        = g('fx_on_grayscale');
    fxState.invert           = g('fx_on_invert');
    fxState.sepia            = g('fx_on_sepia');
    fxState.sharpen          = g('fx_on_sharpen');
    fxState.blur.on          = g('fx_on_blur');
    fxState.blur.radius      = parseInt(v('fx_blurRadius')      || '2', 10);
    fxState.pixelate.on      = g('fx_on_pixelate');
    fxState.pixelate.size    = parseInt(v('fx_pxBlock')         || '12', 10);
    fxState.posterize.on     = g('fx_on_posterize');
    fxState.posterize.levels = parseInt(v('fx_posterizeLevels') || '6', 10);
    fxState.vignette.on      = g('fx_on_vignette');
    fxState.vignette.strength= parseFloat(v('fx_vStrength')     || '0.35');
    fxState.vignette.radius  = parseFloat(v('fx_vRadius')       || '0.85');
  }

  function convolveImageData(src, w, h, kernel, divisor, offset) {
    if (divisor == null || divisor === 0) divisor = 1;
    if (offset  == null) offset  = 0;

    var out = new ImageData(w, h);
    var sd = src.data, od = out.data;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var r = 0, g = 0, b = 0, a = 0;

        for (var ky = -1; ky <= 1; ky++) {
          var yy = Math.min(h - 1, Math.max(0, y + ky));
          for (var kx = -1; kx <= 1; kx++) {
            var xx = Math.min(w - 1, Math.max(0, x + kx));
            var wt = kernel[(ky + 1) * 3 + (kx + 1)];
            var idx = (yy * w + xx) * 4;
            r += sd[idx]     * wt;
            g += sd[idx + 1] * wt;
            b += sd[idx + 2] * wt;
            a += sd[idx + 3] * wt;
          }
        }

        var i = (y * w + x) * 4;
        od[i]     = clamp(Math.round(r / divisor + offset), 0, 255);
        od[i + 1] = clamp(Math.round(g / divisor + offset), 0, 255);
        od[i + 2] = clamp(Math.round(b / divisor + offset), 0, 255);
        od[i + 3] = clamp(Math.round(a / divisor),          0, 255);
      }
    }
    return out;
  }

  function fxPreviewNow() {
    if (active < 0) return;
    fxEnsure();
    var L = layers[active], w = L.canvas.width, h = L.canvas.height;

    var work = document.createElement('canvas');
    work.width = w; work.height = h;
    var wx = work.getContext('2d');
    wx.putImageData(fxPreview.orig, 0, 0);

    function pixelPass(mod) {
      var img = wx.getImageData(0, 0, w, h);
      mod(img.data);
      wx.putImageData(img, 0, 0);
    }

    if (fxState.adjust.on && (fxState.adjust.br || fxState.adjust.ct || fxState.adjust.st)) {
      var br = fxState.adjust.br | 0;
      var ct = (fxState.adjust.ct | 0) / 100;
      var st = (fxState.adjust.st | 0) / 100;
      var avg = 128, cfac = (1 + ct);

      pixelPass(function (d) {
        for (var i = 0; i < d.length; i += 4) {
          var r = d[i], g = d[i + 1], b = d[i + 2];

          r = (r + br - avg) * cfac + avg;
          g = (g + br - avg) * cfac + avg;
          b = (b + br - avg) * cfac + avg;

          var gray = 0.2989 * r + 0.587 * g + 0.114 * b;
          r = gray + (r - gray) * (1 + st);
          g = gray + (g - gray) * (1 + st);
          b = gray + (b - gray) * (1 + st);

          d[i]     = clamp(r, 0, 255);
          d[i + 1] = clamp(g, 0, 255);
          d[i + 2] = clamp(b, 0, 255);
        }
      });
    }

    if (fxState.grayscale) {
      pixelPass(function (d) {
        for (var i = 0; i < d.length; i += 4) {
          var v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      });
    }

    if (fxState.invert) {
      pixelPass(function (d) {
        for (var i = 0; i < d.length; i += 4) {
          d[i]     = 255 - d[i];
          d[i + 1] = 255 - d[i + 1];
          d[i + 2] = 255 - d[i + 2];
        }
      });
    }

    if (fxState.sepia) {
      pixelPass(function (d) {
        for (var i = 0; i < d.length; i += 4) {
          var r = d[i], g = d[i + 1], b = d[i + 2];
          d[i]     = clamp(0.393 * r + 0.769 * g + 0.189 * b, 0, 255);
          d[i + 1] = clamp(0.349 * r + 0.686 * g + 0.168 * b, 0, 255);
          d[i + 2] = clamp(0.272 * r + 0.534 * g + 0.131 * b, 0, 255);
        }
      });
    }

    if (fxState.blur.on) {
      var passes = Math.max(1, Math.min(12, fxState.blur.radius | 0));
      for (var p = 0; p < passes; p++) {
        var imgB = wx.getImageData(0, 0, w, h);
        var outB = convolveImageData(imgB, w, h, [1, 2, 1, 2, 4, 2, 1, 2, 1], 16, 0);
        wx.putImageData(outB, 0, 0);
      }
    }

    if (fxState.sharpen) {
      var imgS = wx.getImageData(0, 0, w, h);
      var outS = convolveImageData(imgS, w, h, [0, -1, 0, -1, 5, -1, 0, -1, 0], 1, 0);
      wx.putImageData(outS, 0, 0);
    }

    if (fxState.pixelate.on) {
      var block = Math.max(2, fxState.pixelate.size | 0);
      var sw = Math.max(1, Math.floor(w / block));
      var sh = Math.max(1, Math.floor(h / block));
      var off = document.createElement('canvas');
      off.width = sw; off.height = sh;
      var ox = off.getContext('2d');
      ox.imageSmoothingEnabled = false;
      ox.drawImage(work, 0, 0, sw, sh);

      wx.clearRect(0, 0, w, h);
      wx.imageSmoothingEnabled = false;
      wx.drawImage(off, 0, 0, sw, sh, 0, 0, w, h);
      wx.imageSmoothingEnabled = true;
    }

    if (fxState.posterize.on) {
      var levels = Math.max(2, fxState.posterize.levels | 0);
      var step = 255 / (levels - 1);
      pixelPass(function (d) {
        for (var i = 0; i < d.length; i += 4) {
          d[i]     = Math.round(Math.round(d[i]     / step) * step);
          d[i + 1] = Math.round(Math.round(d[i + 1] / step) * step);
          d[i + 2] = Math.round(Math.round(d[i + 2] / step) * step);
        }
      });
    }

    L.ctx.clearRect(0, 0, w, h);
    L.ctx.drawImage(work, 0, 0);
    render();
  }

  function fxApply() {
    if (active < 0 || !fxPreview) return;
    var L = layers[active];
    var w = L.canvas.width, h = L.canvas.height;
    var current = L.ctx.getImageData(0, 0, w, h);
    L.ctx.putImageData(fxPreview.orig, 0, 0);
    pushHistory('apply filters');
    L.ctx.putImageData(current, 0, 0);
    captureLayerBase(L);
    fxPreview = null;
    render();
  }

  function fxClear() {
    if (active < 0) return;

    if (fxPreview) {
      layers[active].ctx.putImageData(fxPreview.orig, 0, 0);
      fxPreview = null;
      render();
    } else {
      var L = layers[active];
      if (L && L.baseData) {
        L.ctx.putImageData(L.baseData, 0, 0);
        render();
      }
    }

    var resets = [
      'fx_on_adjust', 'fx_bright', 'fx_contrast', 'fx_saturation',
      'fx_on_grayscale', 'fx_on_invert', 'fx_on_sepia',
      'fx_on_blur', 'fx_blurRadius',
      'fx_on_sharpen',
      'fx_on_pixelate', 'fx_pxBlock',
      'fx_on_posterize', 'fx_posterizeLevels'
    ];
    resets.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = (id === 'fx_on_adjust');
      if (id === 'fx_bright' || id === 'fx_contrast' || id === 'fx_saturation') el.value = '0';
      if (id === 'fx_blurRadius')      el.value = '1';
      if (id === 'fx_pxBlock')         el.value = '2';
      if (id === 'fx_posterizeLevels') el.value = '12';
    });

    readFxUI();
  }

  (function () {
    var ids = [
      'fx_on_adjust', 'fx_bright', 'fx_contrast', 'fx_saturation',
      'fx_on_grayscale', 'fx_on_invert', 'fx_on_sepia',
      'fx_on_blur', 'fx_blurRadius',
      'fx_on_sharpen',
      'fx_on_pixelate', 'fx_pxBlock',
      'fx_on_posterize', 'fx_posterizeLevels'
    ];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', function () {
        readFxUI();
        fxPreviewNow();
      });
    });

    var applyBtn = document.getElementById('fxApply');
    if (applyBtn) applyBtn.addEventListener('click', fxApply);

    var clearBtn = document.getElementById('fxClear');
    if (clearBtn) clearBtn.addEventListener('click', fxClear);

    readFxUI();
  })();

  /* =====================================================================
   * Pointer input: mouse down/move/up on the stage (tools & gestures)
   * ===================================================================*/
  stage.addEventListener('mousedown', function (e) {
    var p = toCanvas(e.clientX, e.clientY);

    if (tool === 'hand' ||
        (tool !== 'text' && e.button === 1) ||
        (e.button === 0 && e.shiftKey && tool !== 'crop' && tool !== 'transform')) {
      isPanning = true;
      lastPan = { x: e.clientX, y: e.clientY };
      return;
    }

    if (active < 0) return;
    var L = layers[active];

    if (tool === 'transform') {
      var box = { x: L.x, y: L.y, w: L.canvas.width, h: L.canvas.height };
      var h = hitHandle(box, p);
      if (!h) return;
      transform = {
        layer: active, handle: h, dragging: true,
        start: { x: p.x, y: p.y },
        orig: box, box: box,
        keepAR: e.shiftKey
      };
      render();
      return;
    }

    drawing = true;
    var lx = p.x - L.x, ly = p.y - L.y;
    last = { x: lx, y: ly };
    start = { x: lx, y: ly };

    if (tool === 'brush') {
      pushHistory('brush'); fxReset(false);
      var T = ensureInkLayer();
      var lx2 = p.x - T.x, ly2 = p.y - T.y;
      drawDot(T, lx2, ly2);
      last  = { x: lx2, y: ly2 };
      start = { x: lx2, y: ly2 };
      render();
    }
    else if (tool === 'ink-eraser') {
      pushHistory('ink erase'); fxReset(false);
      var E = ensureInkLayer();
      var ex = p.x - E.x, ey = p.y - E.y;
      eraseLine(E, ex, ey, ex, ey);
      last  = { x: ex, y: ey };
      start = { x: ex, y: ey };
      render();
    }
    else if (tool === 'eraser') {
      pushHistory('erase'); fxReset(false);
      eraseLine(L, lx, ly, lx, ly);
      render();
    }
    else if (tool === 'fill') {
      pushHistory('fill'); fxReset(false);
      bucketFill(L, Math.floor(lx), Math.floor(ly), primary);
      render();
      drawing = false;
    }
    else if (tool === 'picker') {
      var sx = Math.floor(p.x), sy = Math.floor(p.y);
      if (sx >= 0 && sy >= 0 && sx < canvasW && sy < canvasH) {
        var sample = ctx.getImageData(Math.floor(sx * zoom + panX), Math.floor(sy * zoom + panY), 1, 1).data;
        primary = '#' + [sample[0], sample[1], sample[2]]
          .map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
        if (primInput) primInput.value = primary;
      }
      drawing = false;
    }
    else if (tool === 'text') {
      pushHistory('text'); fxReset(false);
      var txt = $('#textInput').value || 'Text';
      L.ctx.save();
      L.ctx.globalAlpha  = alpha;
      L.ctx.fillStyle    = primary;
      L.ctx.font         = $('#fontSelect').value;
      L.ctx.textBaseline = 'top';
      L.ctx.fillText(txt, lx, ly);
      L.ctx.restore();
      render();
      drawing = false;
    }
    else if (tool === 'move') {
      pushHistory('move layer');
    }
    else if (tool === 'crop') {
      cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
    }
  });

  stage.addEventListener('mousemove', function (e) {
    if (isPanning) {
      var dx = e.clientX - lastPan.x, dy = e.clientY - lastPan.y;
      panX += dx; panY += dy;
      lastPan = { x: e.clientX, y: e.clientY };
      render();
      return;
    }

    if (tool === 'transform' && transform && transform.dragging) {
      var p = toCanvas(e.clientX, e.clientY);
      transform.keepAR = e.shiftKey;
      transform.box = boxFromHandle(transform.orig, transform.handle, p, transform.keepAR, transform.start);
      render();
      return;
    }

    if (!drawing || active < 0) return;
    var L = layers[active];
    var p = toCanvas(e.clientX, e.clientY);
    var lx = p.x - L.x, ly = p.y - L.y;

    if (tool === 'brush') {
      var T = ensureInkLayer();
      var bx = p.x - T.x, by = p.y - T.y;
      drawLine(T, last.x, last.y, bx, by);
      last = { x: bx, y: by };
      render();
    }
    else if (tool === 'ink-eraser') {
      var E = ensureInkLayer();
      var ex = p.x - E.x, ey = p.y - E.y;
      eraseLine(E, last.x, last.y, ex, ey);
      last = { x: ex, y: ey };
      render();
    }
    else if (tool === 'eraser') {
      eraseLine(L, last.x, last.y, lx, ly);
      last = { x: lx, y: ly };
      render();
    }
    else if (tool === 'line' || tool === 'rect' || tool === 'ellipse' || tool === 'move' || tool === 'crop') {
      render();
      ctx.save();
      ctx.translate(panX, panY);
      ctx.scale(zoom, zoom);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = primary;
      ctx.fillStyle   = primary;
      ctx.lineWidth   = brushSize;

      if (tool === 'line') {
        ctx.beginPath();
        ctx.moveTo(start.x + L.x, start.y + L.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      else if (tool === 'rect') {
        var x = Math.min(start.x + L.x, p.x),
            y = Math.min(start.y + L.y, p.y),
            w = Math.abs(p.x - (start.x + L.x)),
            h = Math.abs(p.y - (start.y + L.y));
        if (isStroke) ctx.strokeRect(x, y, w, h);
        else          ctx.fillRect(x, y, w, h);
      }
      else if (tool === 'ellipse') {
        var ecx = ((start.x + L.x) + p.x) / 2,
            ecy = ((start.y + L.y) + p.y) / 2;
        var rx = Math.abs(p.x - (start.x + L.x)) / 2,
            ry = Math.abs(p.y - (start.y + L.y)) / 2;
        ctx.beginPath();
        ctx.ellipse(ecx, ecy, rx, ry, 0, 0, Math.PI * 2);
        if (isStroke) ctx.stroke(); else ctx.fill();
      }
      else if (tool === 'move') {
        var mdx = lx - start.x, mdy = ly - start.y;
        ctx.globalAlpha = 0.45;
        ctx.drawImage(L.canvas, L.x + mdx, L.y + mdy);
      }
      else if (tool === 'crop') {
        cropRect = {
          x: Math.min(p.x, start.x + L.x),
          y: Math.min(p.y, start.y + L.y),
          w: Math.abs(p.x - (start.x + L.x)),
          h: Math.abs(p.y - (start.y + L.y))
        };
      }
      ctx.restore();
    }
  });

  window.addEventListener('mouseup', function (e) {
    if (isPanning) { isPanning = false; return; }

    if (tool === 'transform' && transform && transform.dragging) {
      fxReset(true);
      var L = layers[active];
      var b = normalizeBox(transform.box);
      pushHistory('transform');
      var c = document.createElement('canvas');
      c.width  = Math.max(1, Math.round(b.w));
      c.height = Math.max(1, Math.round(b.h));
      var cctx = c.getContext('2d');
      cctx.drawImage(L.canvas, 0, 0, L.canvas.width, L.canvas.height, 0, 0, c.width, c.height);
      L.canvas = c; L.ctx = cctx; L.x = b.x; L.y = b.y;
      captureLayerBase(L);
      transform = null;
      render();
      return;
    }

    if (!drawing || active < 0) return;
    drawing = false;

    var L = layers[active];
    var p = toCanvas(e.clientX, e.clientY);
    var lx = p.x - L.x, ly = p.y - L.y;

    if (tool === 'line') {
      pushHistory('line');
      L.ctx.save();
      L.ctx.globalAlpha = alpha;
      L.ctx.strokeStyle = primary;
      L.ctx.lineWidth   = brushSize;
      L.ctx.beginPath();
      L.ctx.moveTo(start.x, start.y);
      L.ctx.lineTo(lx, ly);
      L.ctx.stroke();
      L.ctx.restore();
      render();
    }
    else if (tool === 'rect') {
      pushHistory('rect');
      L.ctx.save();
      L.ctx.globalAlpha = alpha;
      L.ctx.fillStyle = L.ctx.strokeStyle = primary;
      L.ctx.lineWidth = brushSize;
      var x = Math.min(start.x, lx),
          y = Math.min(start.y, ly),
          w = Math.abs(lx - start.x),
          h = Math.abs(ly - start.y);
      if (isStroke) L.ctx.strokeRect(x, y, w, h);
      else          L.ctx.fillRect(x, y, w, h);
      L.ctx.restore();
      render();
    }
    else if (tool === 'ellipse') {
      pushHistory('ellipse');
      L.ctx.save();
      L.ctx.globalAlpha = alpha;
      L.ctx.fillStyle = L.ctx.strokeStyle = primary;
      L.ctx.lineWidth = brushSize;
      var cx = (start.x + lx) / 2, cy = (start.y + ly) / 2;
      var rx = Math.abs(lx - start.x) / 2, ry = Math.abs(ly - start.y) / 2;
      L.ctx.beginPath();
      L.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (isStroke) L.ctx.stroke(); else L.ctx.fill();
      L.ctx.restore();
      render();
    }
    else if (tool === 'move') {
      var dx = lx - start.x, dy = ly - start.y;
      L.x += dx; L.y += dy;
      render();
    }
  });

  /* =====================================================================
   * Wheel zoom + global keyboard shortcuts
   * ===================================================================*/
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var delta = -Math.sign(e.deltaY) * (e.ctrlKey ? 0.2 : 0.1);
    var old = zoom;
    var rect = stage.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var wx = (mx - panX) / old, wy = (my - panY) / old;
    zoom = clamp(zoom * (1 + delta), minZoom, maxZoom);
    panX = mx - wx * zoom;
    panY = my - wy * zoom;
    resizeDisplay();
  }, { passive: false });

  document.addEventListener('keydown', function (e) {
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
      if (e.key === 'F1') { e.preventDefault(); openHelp(); }
      if (e.key === 'Escape') { closeHelp(); }
      return;
    }

    if (e.key === '+' || (e.ctrlKey && e.key === '=')) { zoom = clamp(zoom * 1.1, minZoom, maxZoom); resizeDisplay(); }
    if (e.key === '-' || (e.ctrlKey && e.key === '-')) { zoom = clamp(zoom / 1.1, minZoom, maxZoom); resizeDisplay(); }

    if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); exportImage(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); if (fileInput) fileInput.click(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }

    var map = {
      m: 'move',
      r: 'transform',
      c: 'crop',
      h: 'hand',
      b: 'brush',
      e: 'eraser',
      g: 'fill',
      i: 'picker',
      t: 'text',
      l: 'line',
      q: 'rect',
      s: 'ellipse'
    };
    var k = e.key ? e.key.toLowerCase() : '';
    if (!e.ctrlKey && !e.metaKey && map[k]) { setTool(map[k]); }
    if (k === 'f') { fitOnScreen(); }

    if (e.key === 'F1') { e.preventDefault(); openHelp(); }
    if (e.key === 'Escape') { closeHelp(); }
  });

  /* =====================================================================
   * Open image (file input + drag & drop)
   * ===================================================================*/
  function loadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    var img = new Image();
    var url = URL.createObjectURL(file);

    img.onload = function () {
      try {
        // If only the initial blank Background layer exists, adapt canvas size to the opened image
        if (layers.length === 1 && layers[0].name === 'Background' && history.length === 0) {
          canvasW = img.width;
          canvasH = img.height;
          layers[0].canvas.width = canvasW;
          layers[0].canvas.height = canvasH;
          syncCanvasInputs();
        }
        var c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        var cctx = c.getContext('2d');
        cctx.drawImage(img, 0, 0);

        addLayer({ name: file.name.replace(/\.[^.]+$/, ''), canvas: c, ctx: cctx });
        fitOnScreen();
        render();
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = function (err) { console.error('Image load failed', err); };
    img.src = url;
  }

  if (openBtn && fileInput) {
    openBtn.addEventListener('click', function () {
      if (openBtn.tagName !== 'LABEL') fileInput.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) loadImageFile(file);
      fileInput.value = '';
    });
  }

  if (stageWrap) {
    stageWrap.addEventListener('dragover', function (e) {
      e.preventDefault();
      stageWrap.classList.add('drop-active');
    });
    stageWrap.addEventListener('dragleave', function () {
      stageWrap.classList.remove('drop-active');
    });
    stageWrap.addEventListener('drop', function (e) {
      e.preventDefault();
      stageWrap.classList.remove('drop-active');
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadImageFile(file);
    });
  }

  /* ------------------------------- Export ------------------------------*/
  function exportImage() {
    var fmtSel = document.getElementById('exportFormat');
    var qEl    = document.getElementById('exportQuality');
    var bgEl   = document.getElementById('exportBg');

    var type    = (fmtSel && fmtSel.value) || 'image/png';
    var quality = qEl ? parseFloat(qEl.value || '0.92') : 0.92;
    var bg      = (bgEl && bgEl.value) || '#ffffff';

    if (!supportsFormat(type)) {
      type = 'image/png';
      if (fmtSel) fmtSel.value = 'image/png';
    }

    var out = document.createElement('canvas');
    out.width = canvasW; out.height = canvasH;
    var o = out.getContext('2d');

    if (type === 'image/jpeg') {
      o.fillStyle = bg;
      o.fillRect(0, 0, out.width, out.height);
    }

    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (!L.visible) continue;
      o.globalAlpha = L.opacity;
      o.drawImage(L.canvas, L.x, L.y);
    }

    var dataURL = (type === 'image/png')
      ? out.toDataURL('image/png')
      : out.toDataURL(type, quality);

    var a = document.createElement('a');
    a.href = dataURL;
    a.download = filenameFor(type);
    a.click();
  }
  document.getElementById('saveBtn').addEventListener('click', exportImage);

  (function setupExportUI() {
    var fmtSel = document.getElementById('exportFormat');
    var qEl    = document.getElementById('exportQuality');
    var qLbl   = document.getElementById('exportQualityLabel');
    var qTxt   = document.getElementById('exportQualityText');
    var bgEl   = document.getElementById('exportBg');
    var bgTxt  = document.getElementById('exportBgText');

    function syncVis() {
      var isPNG  = fmtSel.value === 'image/png';
      var isJPEG = fmtSel.value === 'image/jpeg';
      var showQ  = !isPNG;
      var showBG = isJPEG;

      if (qEl)   qEl.style.display   = showQ  ? 'inline-block' : 'none';
      if (qLbl)  qLbl.style.display  = showQ  ? 'inline-block' : 'none';
      if (qTxt)  qTxt.style.display  = showQ  ? 'inline-block' : 'none';
      if (bgEl)  bgEl.style.display  = showBG ? 'inline-block' : 'none';
      if (bgTxt) bgTxt.style.display = showBG ? 'inline-block' : 'none';
    }

    function syncLabel() {
      if (qLbl && qEl) {
        qLbl.textContent = Math.round(parseFloat(qEl.value || '0.92') * 100) + '%';
      }
    }

    if (fmtSel) fmtSel.addEventListener('change', syncVis);
    if (qEl)    qEl.addEventListener('input',  syncLabel);

    syncVis();
    syncLabel();
  })();

  /* ---------------------------- Rotate / Flip --------------------------*/
  document.getElementById('rotateL').addEventListener('click', function () { rotate(-90); });
  document.getElementById('rotateR').addEventListener('click', function () { rotate(90); });
  document.getElementById('flipH').addEventListener('click',   function () { flip(true,  false); });
  document.getElementById('flipV').addEventListener('click',   function () { flip(false, true); });

  function rotate(deg) {
    fxReset(true);
    if (active < 0) return;

    pushHistory('rotate');
    var L = layers[active];
    var isRightAngle = Math.abs(deg) % 180 === 90;
    var w = L.canvas.width, h = L.canvas.height;

    var c = document.createElement('canvas');
    c.width  = isRightAngle ? h : w;
    c.height = isRightAngle ? w : h;

    var cctx = c.getContext('2d');
    cctx.translate(c.width / 2, c.height / 2);
    cctx.rotate(deg * Math.PI / 180);
    cctx.drawImage(L.canvas, -w / 2, -h / 2);

    L.canvas = c; L.ctx = cctx;
    captureLayerBase(L);
    render();
  }

  function flip(h, v) {
    fxReset(true);
    if (active < 0) return;

    pushHistory('flip');
    var L = layers[active];

    var c = document.createElement('canvas');
    c.width = L.canvas.width; c.height = L.canvas.height;
    var cctx = c.getContext('2d');

    cctx.translate(h ? c.width : 0, v ? c.height : 0);
    cctx.scale(h ? -1 : 1, v ? -1 : 1);
    cctx.drawImage(L.canvas, 0, 0);

    L.canvas = c; L.ctx = cctx;
    captureLayerBase(L);
    render();
  }

  /* ------------------------------ Layer ops ----------------------------*/
  document.getElementById('addLayerBtn').addEventListener('click', function () { addLayer(); });

  document.getElementById('delLayer').addEventListener('click', function () {
    if (active < 0) return;
    pushHistory('delete layer');
    layers.splice(active, 1);
    active = Math.min(active, layers.length - 1);
    rebuildLayersUI();
    render();
  });

  document.getElementById('dupLayer').addEventListener('click', function () {
    if (active < 0) return;

    var L = layers[active];
    var c = document.createElement('canvas');
    c.width = L.canvas.width; c.height = L.canvas.height;
    var cctx = c.getContext('2d');
    cctx.drawImage(L.canvas, 0, 0);

    addLayer({
      name:    (L.name + ' copy'),
      canvas:  c,
      ctx:     cctx,
      visible: L.visible,
      opacity: L.opacity,
      x:       L.x,
      y:       L.y
    }, true);
    render();
  });

  document.getElementById('layerUp').addEventListener('click', function () {
    if (active < 0 || active === layers.length - 1) return;
    pushHistory('layer up');
    var L = layers.splice(active, 1)[0];
    layers.splice(active + 1, 0, L);
    active++;
    rebuildLayersUI();
    render();
  });

  document.getElementById('layerDown').addEventListener('click', function () {
    if (active <= 0) return;
    pushHistory('layer down');
    var L = layers.splice(active, 1)[0];
    layers.splice(active - 1, 0, L);
    active--;
    rebuildLayersUI();
    render();
  });

  function rebuildLayersUI() {
    layersEl.innerHTML = '';

    for (var i = 0; i < layers.length; i++) {
      (function (L, idx) {
        var row = document.createElement('div');
        row.className = 'layer';
        var number = idx + 1;

        row.innerHTML =
          '<input type="checkbox" ' + (L.visible ? 'checked' : '') + ' title="Toggle visibility"/>' +
          '<input type="range" min="0" max="1" step="0.05" value="' + L.opacity + '" title="Opacity" style="width:60px">' +
          '<span class="pill">' + number + '</span>' +
          '<input type="text" value="' + (L.name || '') + '"/>';

        row.querySelector('input[type=checkbox]').addEventListener('input', function (e) {
          L.visible = e.target.checked; render();
        });
        row.querySelector('input[type=range]').addEventListener('input', function (e) {
          L.opacity = parseFloat(e.target.value); render();
        });
        row.querySelector('input[type=text]').addEventListener('change', function (e) {
          L.name = e.target.value;
        });

        row.addEventListener('click', function () { setActive(idx); });

        layersEl.prepend(row);
      })(layers[i], i);
    }

    refreshLayersUI();
  }

  /* -------------------------- Canvas size / Crop -----------------------*/
  document.getElementById('resizeCanvas').addEventListener('click', function () {
    fxReset(true);
    var w = Math.max(1, parseInt(document.getElementById('canvasW').value, 10) || canvasW);
    var h = Math.max(1, parseInt(document.getElementById('canvasH').value, 10) || canvasH);

    pushHistory('resize canvas');

    layers.forEach(function (L) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var cctx = c.getContext('2d');
      cctx.drawImage(L.canvas, 0, 0);
      L.canvas = c; L.ctx = cctx;
      captureLayerBase(L);
    });

    canvasW = w; canvasH = h;
    resizeDisplay();
    render();
  });

  document.getElementById('cropApply').addEventListener('click', function () {
    fxReset(true);
    if (!cropRect || cropRect.w < 2 || cropRect.h < 2) return;

    pushHistory('crop');

    var x = cropRect.x, y = cropRect.y, w = cropRect.w, h = cropRect.h;

    layers.forEach(function (L) {
      var c = document.createElement('canvas');
      c.width  = Math.max(1, Math.round(w));
      c.height = Math.max(1, Math.round(h));
      var cctx = c.getContext('2d');
      cctx.drawImage(L.canvas, x - L.x, y - L.y, w, h, 0, 0, w, h);
      L.canvas = c; L.ctx = cctx;
      L.x = 0; L.y = 0;
      captureLayerBase(L);
    });

    canvasW = Math.max(1, Math.round(w));
    canvasH = Math.max(1, Math.round(h));
    cropRect = null;
    syncCanvasInputs();

    resizeDisplay();
    render();
  });

  /* --------------------------- Undo / Redo / Fit -----------------------*/
  function undo() {
    if (isRestoring || history.length === 0) return;
    var before = history.pop();
    redoStack.push(snapshotCurrent());
    restore(before);
  }

  function redo() {
    if (isRestoring || redoStack.length === 0) return;
    var after = redoStack.pop();
    history.push(snapshotCurrent());
    restore(after);
  }

  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('redoBtn').addEventListener('click', redo);
  document.getElementById('fitBtn').addEventListener('click',  fitOnScreen);

  /* ----------------------- Right-dock toggle buttons -------------------*/
  var toggleFiltersBtn = document.getElementById('toggleFiltersBtn');
  var toggleLayersBtn  = document.getElementById('toggleLayersBtn');
  var toggleCanvasBtn  = document.getElementById('toggleCanvasBtn');

  if (toggleFiltersBtn) toggleFiltersBtn.addEventListener('click', function () {
    vis.filters = !vis.filters;
    updateDockPanels();
  });
  if (toggleLayersBtn) toggleLayersBtn.addEventListener('click', function () {
    vis.layers = !vis.layers;
    updateDockPanels();
  });
  if (toggleCanvasBtn) toggleCanvasBtn.addEventListener('click', function () {
    vis.canvas = !vis.canvas;
    updateDockPanels();
  });

  /* ------------------------------ Help modal ---------------------------*/
  var helpFab      = document.getElementById('helpFab');
  var helpModal    = document.getElementById('helpModal');
  var helpClose    = document.getElementById('helpClose');
  var helpBackdrop = helpModal ? helpModal.querySelector('.backdrop') : null;
  var helpDialog   = helpModal ? helpModal.querySelector('.dialog')   : null;

  function openHelp() {
    if (!helpModal) return;
    helpModal.classList.add('open');
    helpModal.setAttribute('aria-hidden', 'false');
    if (helpDialog) helpDialog.focus();
  }
  function closeHelp() {
    if (!helpModal) return;
    helpModal.classList.remove('open');
    helpModal.setAttribute('aria-hidden', 'true');
  }

  if (helpFab)      helpFab.addEventListener('click', openHelp);
  if (helpClose)    helpClose.addEventListener('click', closeHelp);
  if (helpBackdrop) helpBackdrop.addEventListener('click', closeHelp);

  /* -------------------------------- Init --------------------------------*/
  function init() {
    checker.style.width  = canvasW + 'px';
    checker.style.height = canvasH + 'px';
    addLayer({ name: 'Background' }, false);
    updateHistoryButtons();
    fitOnScreen();
    setTool(tool);
    updateDockPanels();
  }
  init();
})();