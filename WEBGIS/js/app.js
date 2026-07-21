/* ===========================================================
   سامانه برداشت میدانی — MVP
   کاملاً Config-Driven: افزودن لایه = افزودن GeoJSON + یک
   ورودی در config/layers.json — بدون نیاز به تغییر این فایل.
   =========================================================== */

(function () {
  "use strict";

  const els = {
    onlineDot: document.getElementById("onlineDot"),
    brandTitle: document.getElementById("brandTitle"),
    tileSpinner: document.getElementById("tileSpinner"),
    tileErrorChip: document.getElementById("tileErrorChip"),
    tileErrorCount: document.getElementById("tileErrorCount"),
    gpsQualityDot: document.getElementById("gpsQualityDot"),
    gpsAccuracyText: document.getElementById("gpsAccuracyText"),
    btnMeasure: document.getElementById("btnMeasure"),
    btnLocate: document.getElementById("btnLocate"),
    btnLayers: document.getElementById("btnLayers"),
    measureBadge: document.getElementById("measureBadge"),
    coordLatLon: document.getElementById("coordLatLon"),
    coordUtm: document.getElementById("coordUtm"),
    zoomLevel: document.getElementById("zoomLevel"),
    btnCopyCoords: document.getElementById("btnCopyCoords"),
    scrim: document.getElementById("scrim"),
    layersPanel: document.getElementById("layersPanel"),
    btnClosePanel: document.getElementById("btnClosePanel"),
    panelBody: document.getElementById("panelBody"),
  };

  let map;
  let appConfig = {};
  const registry = {};   // id -> layer entry
  let order = [];        // display / z-order, index 0 = topmost
  let loadingTiles = new Set();
  const tileErrors = []; // { basemapId, url }[] — capped list for diagnostics

  const UTM_DEF = "+proj=utm +zone=40 +datum=WGS84 +units=m +no_defs";
  proj4.defs("UTM40N", UTM_DEF);

  const TRANSPARENT_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  init();

  async function init() {
    appConfig = await fetchJson("config/app.json").catch(() => ({}));
    if (appConfig.title) {
      els.brandTitle.textContent = appConfig.title;
      document.title = appConfig.title;
    }

    map = L.map("map", {
      center: appConfig.mapCenter || [35.2853, 57.9014],
      zoom: appConfig.defaultZoom || 15,
      zoomControl: false, // pinch/scroll zoom still works; custom FAB UI used instead of +/- buttons
      preferCanvas: true,
      attributionControl: true,
      maxZoom: 22,
    });
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

    map.createPane("pane-measure").style.zIndex = 500;
    map.createPane("pane-gps").style.zIndex = 550;

    map.on("zoomend", () => {
      els.zoomLevel.textContent = "زوم " + map.getZoom();
    });
    els.zoomLevel.textContent = "زوم " + map.getZoom();

    map.on("move", updateCoordDisplay);
    updateCoordDisplay();

    updateOnlineStatus();
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    await loadBasemaps();
    await loadVectorLayers();
    renderPanel();
    initSortable();

    bindUI();
  }

  function fetchJson(url) {
    return fetch(url, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.json();
    });
  }

  /* ---------------- Basemaps ---------------- */
  async function loadBasemaps() {
    let list = [];
    try {
      list = await fetchJson("config/basemaps.json");
    } catch (e) {
      console.warn("basemaps.json در دسترس نیست:", e);
      return;
    }
    list.forEach((cfg) => {
      const paneName = "pane-" + cfg.id;
      map.createPane(paneName);
      const layer = L.tileLayer(cfg.url, {
        pane: paneName,
        maxZoom: cfg.maxZoom || 19,
        maxNativeZoom: cfg.maxNativeZoom || cfg.maxZoom || 19,
        tms: cfg.tms === true,
        attribution: cfg.attribution || "",
        opacity: cfg.opacity ?? 1,
        errorTileUrl: TRANSPARENT_PNG,
      });
      layer.on("loading", () => setTileLoading(cfg.id, true));
      layer.on("load", () => setTileLoading(cfg.id, false));
      layer.on("tileerror", (e) => {
        setTileLoading(cfg.id, false);
        recordTileError(cfg.title, layer.getTileUrl(e.coords));
      });

      registry[cfg.id] = {
        id: cfg.id,
        kind: "basemap",
        title: cfg.title || cfg.id,
        config: cfg,
        leafletLayer: layer,
        visible: cfg.visible !== false,
        opacity: cfg.opacity ?? 1,
      };
      if (registry[cfg.id].visible) layer.addTo(map);
      order.push(cfg.id);
    });
  }

  function setTileLoading(id, isLoading) {
    if (isLoading) loadingTiles.add(id);
    else loadingTiles.delete(id);
    els.tileSpinner.classList.toggle("active", loadingTiles.size > 0);
  }

  function recordTileError(basemapTitle, url) {
    tileErrors.push({ basemapTitle, url });
    if (tileErrors.length > 30) tileErrors.shift();
    els.tileErrorChip.style.display = "flex";
    els.tileErrorCount.textContent = tileErrors.length;
  }

  /* ---------------- Vector (GeoJSON) layers ---------------- */
  async function loadVectorLayers() {
    let list = [];
    try {
      list = await fetchJson("config/layers.json");
    } catch (e) {
      console.warn("layers.json در دسترس نیست:", e);
      return;
    }

    // vector layers rendered on top of basemaps -> unshift into order
    const newIds = [];
    for (const cfg of list) {
      try {
        const data = await fetchJson("layers/" + cfg.file);
        const paneName = "pane-" + cfg.id;
        map.createPane(paneName);

        const color = cfg.color || "#2FA4FF";
        const geoLayer = L.geoJSON(data, {
          pane: paneName,
          style: () => baseStyleFor(cfg, color),
          pointToLayer: (feature, latlng) =>
            L.circleMarker(latlng, {
              radius: cfg.radius || 6,
              color: color,
              weight: 2,
              fillColor: color,
              fillOpacity: 0.85,
            }),
          onEachFeature: (feature, lyr) => {
            lyr.bindPopup(buildPopupHtml(feature.properties));
          },
        });

        registry[cfg.id] = {
          id: cfg.id,
          kind: "vector",
          title: cfg.title || cfg.id,
          config: cfg,
          leafletLayer: geoLayer,
          visible: cfg.visible !== false,
          opacity: 1,
          showLabel: false,
        };
        if (registry[cfg.id].visible) geoLayer.addTo(map);
        newIds.push(cfg.id);
      } catch (e) {
        console.warn("لایه بارگذاری نشد:", cfg.file, e);
      }
    }
    order = [...newIds.reverse(), ...order];
    updateZOrder();
  }

  function baseStyleFor(cfg, color) {
    const fillOpacity = cfg.geometryType === "polygon" ? cfg.fillOpacity ?? 0.3 : 0;
    return {
      color: color,
      weight: cfg.weight || 3,
      fillColor: color,
      fillOpacity: fillOpacity,
      opacity: 1,
    };
  }

  function buildPopupHtml(props) {
    if (!props) return "<em>بدون اطلاعات</em>";
    const rows = Object.entries(props)
      .filter(([k, v]) => v !== null && v !== undefined && !k.startsWith("_"))
      .map(
        ([k, v]) =>
          `<tr><td class="key">${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`
      )
      .join("");
    return `<table class="popup-table">${rows}</table>`;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ---------------- Z-order management ---------------- */
  function updateZOrder() {
    const base = 210;
    order.forEach((id, idx) => {
      const pane = map.getPane("pane-" + id);
      if (pane) pane.style.zIndex = base + (order.length - idx);
    });
  }

  /* ---------------- Panel rendering ---------------- */
  function renderPanel() {
    const html = order
      .map((id) => {
        const e = registry[id];
        if (!e) return "";
        const swatch = e.kind === "basemap" ? "#8892A0" : e.config.color;
        const opacityPct = Math.round((e.opacity ?? 1) * 100);
        const hasLabel = e.kind === "vector" && !!e.config.labelField;
        const hasZoomTo = e.kind === "vector";
        return `
        <div class="layer-card ${e.visible ? "" : "dim"}" data-id="${id}">
          <span class="drag-handle">⋮⋮</span>
          <span class="swatch" style="background:${swatch}"></span>
          <div class="main">
            <div class="row1">
              <input type="checkbox" class="chk-visible" ${e.visible ? "checked" : ""} />
              <span class="title">${escapeHtml(e.title)}</span>
              ${hasZoomTo ? `<button class="label-btn" data-action="zoomto" title="زوم به این لایه">🎯</button>` : ""}
              ${hasLabel ? `<button class="label-btn ${e.showLabel ? "active" : ""}" data-action="label" title="نمایش/عدم نمایش برچسب">🔤</button>` : ""}
            </div>
            <div class="opacity-row">
              <span style="font-size:11px;color:#6B7280;">🎚</span>
              <input type="range" min="0" max="100" value="${opacityPct}" class="rng-opacity" />
              <span class="opacity-value">${opacityPct}%</span>
            </div>
          </div>
        </div>`;
      })
      .join("");
    els.panelBody.innerHTML = `<div id="layerList">${html}</div>`;
    attachCardEvents();
  }

  function attachCardEvents() {
    els.panelBody.querySelectorAll(".layer-card").forEach((card) => {
      const id = card.dataset.id;
      const e = registry[id];

      card.querySelector(".chk-visible").addEventListener("change", (ev) => {
        e.visible = ev.target.checked;
        if (e.visible) map.addLayer(e.leafletLayer);
        else map.removeLayer(e.leafletLayer);
        card.classList.toggle("dim", !e.visible);
      });

      card.querySelector(".rng-opacity").addEventListener("input", (ev) => {
        const val = Number(ev.target.value) / 100;
        e.opacity = val;
        setLayerOpacity(e, val);
        card.querySelector(".opacity-value").textContent = ev.target.value + "%";
      });

      const labelBtn = card.querySelector('[data-action="label"]');
      if (labelBtn) {
        labelBtn.addEventListener("click", () => {
          e.showLabel = !e.showLabel;
          labelBtn.classList.toggle("active", e.showLabel);
          applyLabels(e);
        });
      }

      const zoomBtn = card.querySelector('[data-action="zoomto"]');
      if (zoomBtn) {
        zoomBtn.addEventListener("click", () => {
          if (!e.visible) {
            e.visible = true;
            map.addLayer(e.leafletLayer);
            card.classList.remove("dim");
            card.querySelector(".chk-visible").checked = true;
          }
          try {
            const bounds = e.leafletLayer.getBounds();
            if (bounds.isValid()) {
              map.fitBounds(bounds, { padding: [40, 40], maxZoom: 20 });
            } else {
              alert("این لایه هیچ عارضه‌ای برای نمایش ندارد (فایل GeoJSON خالی است یا مختصات نامعتبر دارد).");
            }
          } catch (err) {
            alert("امکان زوم به این لایه نبود. مختصات فایل GeoJSON را بررسی کن (باید [طول جغرافیایی, عرض جغرافیایی] باشد، نه برعکس).");
          }
        });
      }
    });
  }

  function setLayerOpacity(entry, val) {
    if (entry.kind === "basemap") {
      entry.leafletLayer.setOpacity(val);
    } else {
      const fillFactor = entry.config.geometryType === "polygon"
        ? (entry.config.fillOpacity ?? 0.3)
        : (entry.config.geometryType === "point" ? 0.85 : 0);
      entry.leafletLayer.setStyle({ opacity: val, fillOpacity: val * fillFactor });
    }
  }

  function applyLabels(entry) {
    const field = entry.config.labelField;
    entry.leafletLayer.eachLayer((lyr) => {
      if (entry.showLabel) {
        const val = lyr.feature && lyr.feature.properties ? lyr.feature.properties[field] : null;
        if (val && !lyr.getTooltip()) {
          lyr.bindTooltip(String(val), {
            permanent: true,
            direction: "top",
            className: "feature-label",
            offset: [0, -6],
          });
        }
      } else if (lyr.getTooltip()) {
        lyr.unbindTooltip();
      }
    });
  }

  function initSortable() {
    const list = document.getElementById("layerList");
    if (!list || !window.Sortable) return;
    Sortable.create(list, {
      handle: ".drag-handle",
      animation: 150,
      onEnd: () => {
        order = Array.from(list.children).map((c) => c.dataset.id);
        updateZOrder();
      },
    });
  }

  /* ---------------- Coordinates & zoom ---------------- */
  function updateCoordDisplay() {
    const c = map.getCenter();
    els.coordLatLon.textContent = `Lat: ${c.lat.toFixed(6)}  Lon: ${c.lng.toFixed(6)}`;
    try {
      const [x, y] = proj4("WGS84", "UTM40N", [c.lng, c.lat]);
      els.coordUtm.textContent = `UTM 40N:  ${x.toFixed(1)}  ${y.toFixed(1)}`;
    } catch (e) {
      els.coordUtm.textContent = "UTM 40N: —";
    }
  }

  /* ---------------- Online / offline ---------------- */
  function updateOnlineStatus() {
    els.onlineDot.classList.toggle("online", navigator.onLine);
  }

  /* ---------------- GPS ---------------- */
  let watchId = null;
  let gpsMarker = null;
  let gpsCircle = null;
  let firstFix = true;

  function toggleLocate() {
    if (watchId !== null) {
      stopLocate();
      return;
    }
    if (!navigator.geolocation) {
      alert("مرورگر شما از موقعیت‌یابی پشتیبانی نمی‌کند.");
      return;
    }
    els.btnLocate.classList.add("active");
    firstFix = true;
    watchId = navigator.geolocation.watchPosition(onGpsSuccess, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000,
    });
  }

  function stopLocate() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    els.btnLocate.classList.remove("active");
    if (gpsMarker) { map.removeLayer(gpsMarker); gpsMarker = null; }
    if (gpsCircle) { map.removeLayer(gpsCircle); gpsCircle = null; }
    els.gpsQualityDot.className = "gps-quality";
    els.gpsAccuracyText.textContent = "GPS";
  }

  function onGpsSuccess(pos) {
    const latlng = [pos.coords.latitude, pos.coords.longitude];
    const acc = pos.coords.accuracy;

    if (!gpsMarker) {
      gpsMarker = L.circleMarker(latlng, {
        pane: "pane-gps", radius: 8, color: "#fff", weight: 2,
        fillColor: "#2FA4FF", fillOpacity: 1,
      }).addTo(map);
      gpsCircle = L.circle(latlng, {
        pane: "pane-gps", radius: acc, color: "#2FA4FF",
        weight: 1, fillColor: "#2FA4FF", fillOpacity: 0.12,
      }).addTo(map);
    } else {
      gpsMarker.setLatLng(latlng);
      gpsCircle.setLatLng(latlng);
      gpsCircle.setRadius(acc);
    }

    let cls = "bad";
    if (acc <= 10) cls = "good";
    else if (acc <= 25) cls = "ok";
    els.gpsQualityDot.className = "gps-quality " + cls;
    els.gpsAccuracyText.textContent = Math.round(acc) + " m";

    if (firstFix) {
      map.setView(latlng, Math.max(map.getZoom(), 17));
      firstFix = false;
    }
  }

  function onGpsError() {
    alert("دسترسی به موقعیت مکانی امکان‌پذیر نشد. لطفاً مجوز GPS را بررسی کنید.");
    stopLocate();
  }

  /* ---------------- Measurement ---------------- */
  const measureGroup = L.featureGroup();
  let measureActive = false;

  function initMeasurePane() {
    map.createPane("pane-measure-draw").style.zIndex = 520;
    measureGroup.addTo(map);
  }

  function openMeasureChooser() {
    els.measureBadge.innerHTML = `
      <span style="margin-inline-end:10px;">اندازه‌گیری:</span>
      <button id="mChooseLine" style="margin-inline-end:6px;background:#2FA4FF;border:none;color:#fff;padding:5px 10px;border-radius:8px;font-family:inherit;">📏 خط</button>
      <button id="mChoosePoly" style="background:#2FA4FF;border:none;color:#fff;padding:5px 10px;border-radius:8px;font-family:inherit;">▱ مساحت</button>`;
    els.measureBadge.classList.add("active");
    document.getElementById("mChooseLine").onclick = () => startMeasure("Line");
    document.getElementById("mChoosePoly").onclick = () => startMeasure("Polygon");
  }

  function startMeasure(shape) {
    measureGroup.clearLayers();
    measureActive = true;
    els.btnMeasure.classList.add("active");
    els.measureBadge.textContent = shape === "Line"
      ? "روی نقشه رسم کنید، برای پایان دو‌بار کلیک کنید"
      : "چندضلعی را رسم کنید، برای پایان دو‌بار کلیک کنید";
    els.measureBadge.classList.add("active");

    map.pm.enableDraw(shape, {
      finishOn: "dblclick",
      continueDrawing: false,
      templineStyle: { color: "#2FA4FF" },
      hintlineStyle: { color: "#2FA4FF", dashArray: [5, 5] },
      pathOptions: { color: "#2FA4FF", weight: 3, pane: "pane-measure-draw" },
    });
  }

  function stopMeasureDraw() {
    if (map.pm) map.pm.disableDraw();
    measureActive = false;
    els.btnMeasure.classList.remove("active");
  }

  function onMeasureCreate(e) {
    e.layer.options.pane = "pane-measure-draw";
    measureGroup.addLayer(e.layer);
    let resultText = "";
    try {
      if (e.shape === "Line") {
        const latlngs = e.layer.getLatLngs();
        const line = turf.lineString(latlngs.map((p) => [p.lng, p.lat]));
        const km = turf.length(line, { units: "kilometers" });
        resultText = km < 1 ? (km * 1000).toFixed(1) + " متر" : km.toFixed(3) + " کیلومتر";
      } else if (e.shape === "Polygon") {
        const ring = e.layer.getLatLngs()[0].map((p) => [p.lng, p.lat]);
        ring.push(ring[0]);
        const poly = turf.polygon([ring]);
        const area = turf.area(poly);
        resultText = area < 10000 ? area.toFixed(1) + " متر مربع" : (area / 10000).toFixed(3) + " هکتار";
      }
    } catch (err) {
      resultText = "خطا در محاسبه";
    }
    els.measureBadge.innerHTML = `نتیجه: <b>${resultText}</b> &nbsp; <button id="mClear" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:#fff;padding:3px 9px;border-radius:8px;font-family:inherit;">پاک کردن</button>`;
    document.getElementById("mClear").onclick = () => {
      measureGroup.clearLayers();
      els.measureBadge.classList.remove("active");
    };
    stopMeasureDraw();
  }

  /* ---------------- UI bindings ---------------- */
  function bindUI() {
    initMeasurePane();
    map.on("pm:create", onMeasureCreate);

    els.btnLayers.addEventListener("click", () => {
      els.layersPanel.classList.add("open");
      els.scrim.classList.add("open");
    });
    const closePanel = () => {
      els.layersPanel.classList.remove("open");
      els.scrim.classList.remove("open");
    };
    els.btnClosePanel.addEventListener("click", closePanel);
    els.scrim.addEventListener("click", closePanel);

    els.btnLocate.addEventListener("click", toggleLocate);

    els.btnMeasure.addEventListener("click", () => {
      if (measureActive) {
        stopMeasureDraw();
        els.measureBadge.classList.remove("active");
      } else {
        openMeasureChooser();
      }
    });

    els.btnCopyCoords.addEventListener("click", () => {
      const text = `${els.coordLatLon.textContent}\n${els.coordUtm.textContent}`;
      copyToClipboard(text, els.btnCopyCoords);
    });

    els.tileErrorChip.addEventListener("click", () => {
      if (tileErrors.length === 0) return;
      const last = tileErrors.slice(-8);
      const grouped = {};
      last.forEach((t) => {
        grouped[t.basemapTitle] = grouped[t.basemapTitle] || [];
        if (grouped[t.basemapTitle].length < 3) grouped[t.basemapTitle].push(t.url);
      });
      let msg = `آدرس Tileهایی که پیدا نشدند (نمونه):\n\n`;
      Object.entries(grouped).forEach(([title, urls]) => {
        msg += `— ${title} —\n` + urls.join("\n") + "\n\n";
      });
      msg += "این آدرس دقیقی است که مرورگر دنبالش گشته؛ آن را با مسیر واقعی فایل‌های خودت مقایسه کن.";
      alert(msg);
    });
  }

  function copyToClipboard(text, btn) {
    const done = () => {
      const original = btn.textContent;
      btn.textContent = "کپی شد ✓";
      setTimeout(() => (btn.textContent = original), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) {}
    document.body.removeChild(ta);
  }
})();
