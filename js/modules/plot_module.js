// js/modules/plot_module.js
// Merges timechart.js logic and handles dynamic channel addition.

import {
  DEFAULT_MAX_BUFFER_POINTS,
  DEFAULT_SIM_CHANNELS,
  seriesColors,
  ZOOM_FACTOR,
} from "../config.js";

// --- Module State ---
let chartInstance = null;
let followToggleElement = null;
let dataRateDisplayElement = null;
let customInteractionPluginInstance = null;
let isInitialized = false;
let moduleElementId = null; // Store the ID of the container element
let internalConfig = {
  follow: true,
  numChannels: DEFAULT_SIM_CHANNELS, // Tracks the *expected* number of channels
  maxBufferPoints: DEFAULT_MAX_BUFFER_POINTS,
};

// Data Rate Calculation State
let dataPointCounter = 0;
let lastRateCheckTime = 0;
let currentDataRateHz = 0;

// --- Internal TimeChart Interaction Plugin ---
class CustomInteractionPlugin {
  chart = null;
  eventEl = null;
  isPanning = false;
  lastPointerPos = { x: 0, y: 0 };
  startPanDomains = { x: null, y: null };
  updateFollowStateCallback = null;
  shouldEnableFollowCheck = null;

  constructor(options = {}) {
    this.updateFollowStateCallback =
      options.onFollowStateChange || function () {};
    this.shouldEnableFollowCheck =
      options.shouldEnableFollowCheck || (() => true);
  }

  apply(chartInstance) {
    this.chart = chartInstance;
    this.eventEl =
      chartInstance.contentBoxDetector?.node || chartInstance.containerEl;
    if (!this.eventEl) {
      console.error("Plot Module: Cannot get interaction event element!");
      return this;
    }
    this.eventEl.style.outline = "none";
    this.eventEl.tabIndex = -1;
    this.onWheel = this.onWheel.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerLeave = this.onPointerUp.bind(this);
    this.onPointerCancel = this.onPointerUp.bind(this);
    this.onDoubleClick = this.onDoubleClick.bind(this);
    this.eventEl.addEventListener("wheel", this.onWheel, { passive: false });
    this.eventEl.addEventListener("pointerdown", this.onPointerDown);
    this.eventEl.addEventListener("pointermove", this.onPointerMove);
    this.eventEl.addEventListener("pointerup", this.onPointerUp);
    this.eventEl.addEventListener("pointerleave", this.onPointerLeave);
    this.eventEl.addEventListener("pointercancel", this.onPointerCancel);
    this.eventEl.addEventListener("dblclick", this.onDoubleClick);
    chartInstance.model.disposing.on(() => {
      if (!this.eventEl) return;
      this.eventEl.removeEventListener("wheel", this.onWheel);
      this.eventEl.removeEventListener("pointerdown", this.onPointerDown);
      this.eventEl.removeEventListener("pointermove", this.onPointerMove);
      this.eventEl.removeEventListener("pointerup", this.onPointerUp);
      this.eventEl.removeEventListener("pointerleave", this.onPointerLeave);
      this.eventEl.removeEventListener("pointercancel", this.onPointerCancel);
      this.eventEl.removeEventListener("dblclick", this.onDoubleClick);
      this.chart = null;
      this.eventEl = null;
    });
    return this;
  }

  _disableFollow(needsUpdate = true) {
    if (this.chart.options.realTime) {
      this.chart.options.realTime = false;
      this.updateFollowStateCallback(false);
      if (needsUpdate) this.chart.update();
    }
  }

  onWheel(event) {
    if (!this.chart) return;
    event.preventDefault();
    event.stopPropagation();
    this._disableFollow(false);
    const rect = this.eventEl.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const zoomCenterX = this.chart.model.xScale.invert(mouseX);
    const zoomCenterY = this.chart.model.yScale.invert(mouseY);
    const scaleFactor = event.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
    let domainChanged = false;
    if (event.shiftKey) {
      const currentYDomain = this.chart.model.yScale.domain();
      const [newYMin, newYMax] = this._calculateNewDomain(
        currentYDomain,
        scaleFactor,
        zoomCenterY
      );
      this.chart.model.yScale.domain([newYMin, newYMax]);
      this.chart.options.yRange = null;
      domainChanged = true;
    } else {
      const currentXDomain = this.chart.model.xScale.domain();
      const [newXMin, newXMax] = this._calculateNewDomain(
        currentXDomain,
        scaleFactor,
        zoomCenterX
      );
      this.chart.model.xScale.domain([newXMin, newXMax]);
      this.chart.options.xRange = null;
      domainChanged = true;
    }
    if (domainChanged) {
      this.chart.update();
      this._checkAutoFollow();
    }
  }

  onDoubleClick(event) {
    if (!this.chart) return;
    event.preventDefault();
    const now = performance.now();
    this.chart.options.realTime = true;
    this.chart.options.yRange = "auto";
    this.chart.model.xScale.domain([now - 10000, now]);
    this.chart.options.xRange = null;
    this.updateFollowStateCallback(true);
    if (this.isPanning) {
      this.isPanning = false;
      this.eventEl.style.cursor = "";
      try {
        if (this.eventEl.hasPointerCapture(event.pointerId))
          this.eventEl.releasePointerCapture(event.pointerId);
      } catch (e) {}
    }
    this.chart.update();
  }

  onPointerDown(event) {
    if (!this.chart || !event.isPrimary || event.button !== 0) return;
    this._disableFollow(true);
    this.isPanning = true;
    const rect = this.eventEl.getBoundingClientRect();
    this.lastPointerPos = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    this.startPanDomains = {
      x: [...this.chart.model.xScale.domain()],
      y: [...this.chart.model.yScale.domain()],
    };
    this.eventEl.style.cursor = "grabbing";
    this.eventEl.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  onPointerMove(event) {
    if (!this.isPanning || !event.isPrimary || !this.chart) return;
    const rect = this.eventEl.getBoundingClientRect();
    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;
    const deltaX = currentX - this.lastPointerPos.x;
    const deltaY = currentY - this.lastPointerPos.y;
    let domainChanged = false;
    const xRange = this.chart.model.xScale.range();
    if (xRange[1] - xRange[0] !== 0) {
      const kx =
        (this.startPanDomains.x[1] - this.startPanDomains.x[0]) /
        (xRange[1] - xRange[0]);
      const dxDomain = deltaX * kx;
      const newXDomain = this.startPanDomains.x.map((d) => d - dxDomain);
      this.chart.model.xScale.domain(newXDomain);
      this.chart.options.xRange = null;
      domainChanged = true;
    }
    const yRange = this.chart.model.yScale.range();
    if (yRange[0] - yRange[1] !== 0) {
      const ky =
        (this.startPanDomains.y[1] - this.startPanDomains.y[0]) /
        (yRange[0] - yRange[1]);
      const dyDomain = deltaY * ky;
      const newYDomain = this.startPanDomains.y.map((d) => d + dyDomain);
      this.chart.model.yScale.domain(newYDomain);
      this.chart.options.yRange = null;
      domainChanged = true;
    }
    if (domainChanged) {
      this.chart.update();
    }
    this.lastPointerPos = { x: currentX, y: currentY };
    this.startPanDomains = {
      x: [...this.chart.model.xScale.domain()],
      y: [...this.chart.model.yScale.domain()],
    };
  }

  onPointerUp(event) {
    if (!event.isPrimary || !this.chart) return;
    if (this.isPanning) {
      this.isPanning = false;
      this.eventEl.style.cursor = "";
      try {
        if (this.eventEl.hasPointerCapture(event.pointerId))
          this.eventEl.releasePointerCapture(event.pointerId);
      } catch (e) {}
      this._checkAutoFollow();
    }
  }

  _calculateNewDomain(currentDomain, scaleFactor, zoomCenter) {
    const [min, max] = currentDomain;
    const newMin = zoomCenter - (zoomCenter - min) * scaleFactor;
    const newMax = zoomCenter + (max - zoomCenter) * scaleFactor;
    if (newMin >= newMax || Math.abs(newMax - newMin) < 1e-9)
      return currentDomain;
    return [newMin, newMax];
  }

  _checkAutoFollow() {
    if (
      !this.chart ||
      this.chart.options.realTime ||
      !this.shouldEnableFollowCheck()
    )
      return;
    const currentXDomain = this.chart.model.xScale.domain();
    let maxXData = -Infinity;
    this.chart.options.series.forEach((s) => {
      if (s.visible !== false && s.data.length > 0) {
        const seriesMaxX = s.data[s.data.length - 1].x;
        if (isFinite(seriesMaxX) && seriesMaxX > maxXData)
          maxXData = seriesMaxX;
      }
    });
    if (maxXData === -Infinity) return;
    const timeThreshold = 500;
    const viewEndX = currentXDomain[1];
    if (viewEndX >= maxXData - timeThreshold) {
      this.chart.options.realTime = true;
      this.updateFollowStateCallback(true);
      this.chart.update();
    }
  }
}

class DraggableLegend {
  chartElement;
  model;
  options;
  legendElement;
  items = new Map();

  // Dragging state
  isDragging = false; // Flag to indicate if a drag operation is in progress
  pointerDown = false; // Flag to indicate if pointer is currently down
  startX = 0; // Initial X position on pointerdown
  startY = 0; // Initial Y position on pointerdown
  threshold = 5; // Movement threshold in pixels to initiate drag
  offsetX = 0;
  offsetY = 0;
  boundDragMove;
  boundDragEnd;

  constructor(chartElement, model, options) {
    this.chartElement = chartElement;
    this.model = model;
    this.options = options;

    this.legendElement = document.createElement("div");
    this.legendElement.className = "timechart-draggable-legend";

    const ls = this.legendElement.style;
    ls.position = "absolute";
    ls.top = `${options.renderPaddingTop + 10 ?? 10}px`;
    ls.left = `${options.renderPaddingLeft + 20 ?? 10}px`;
    ls.zIndex = "20";
    ls.cursor = "move";
    ls.backgroundColor = "rgba(255, 255, 255, 0.85)";
    ls.border = "1px solid #ccc";
    ls.borderRadius = "4px";
    ls.padding = "5px 10px";
    ls.fontFamily = "sans-serif";
    ls.fontSize = "12px";
    ls.userSelect = "none";

    this.update(); // Populate content first

    const shadowRoot = this.chartElement.shadowRoot;
    if (shadowRoot) {
      shadowRoot.appendChild(this.legendElement);
    } else {
      console.error("DraggableLegend: Chart element missing Shadow DOM root!");
      return;
    }

    // Bind event handlers
    this.boundDragMove = this.onDragMove.bind(this);
    this.boundDragEnd = this.onDragEnd.bind(this);

    // Add pointerdown listener to the whole legend for potential drag start
    this.legendElement.addEventListener(
      "pointerdown",
      this.onDragStart.bind(this)
    );

    // Add model listeners
    this.model.updated.on(() => this.update());
    this.model.disposing.on(() => this.destroy(shadowRoot));
  }

  update() {
    this.legendElement.style.display = this.options.legend ? "" : "none";
    if (!this.options.legend) return;

    const seriesToShow = this.options.series;
    const currentKeys = new Set(this.items.keys());

    for (const s of seriesToShow) {
      currentKeys.delete(s);
      let elements;
      if (!this.items.has(s)) {
        const item = document.createElement("div");
        item.style.display = "flex";
        item.style.alignItems = "center";
        item.style.marginBottom = "3px";
        item.style.cursor = "pointer"; // Keep pointer cursor on item
        item.style.padding = "2px 0";

        const example = document.createElement("div");
        const squareSize = "10px";
        example.style.width = squareSize;
        example.style.height = squareSize;
        example.style.marginRight = "6px";
        example.style.flexShrink = "0";
        example.style.border = "1px solid #999";

        const name = document.createElement("span");
        name.textContent = s.name ?? `Series ${this.items.size + 1}`;
        name.style.whiteSpace = "nowrap";
        name.style.overflow = "hidden";
        name.style.textOverflow = "ellipsis";
        // Prevent pointer events on text/square to simplify target check in click? No, click listener is on item.

        item.appendChild(example);
        item.appendChild(name);
        this.legendElement.appendChild(item);

        // --- Click Listener on Item ---
        item.addEventListener("click", (ev) => {
          // *** Check if a drag operation just occurred ***
          if (this.isDragging) {
            // If dragging flag is true, it means a drag happened, so ignore this click.
            // The flag will be reset in onDragEnd.
            return;
          }

          // If not dragging, proceed with toggling visibility
          s.visible = s.visible === undefined ? false : !s.visible; // Default visible=true
          this.model.update();
        });
        // --- End Click Listener ---

        elements = { item, example, name };
        this.items.set(s, elements);
      } else {
        elements = this.items.get(s);
      }

      // Update styles (visibility, color)
      const isVisible = s.visible !== false;
      elements.item.style.opacity = isVisible ? "1" : "0.5";
      elements.name.style.textDecoration = isVisible ? "none" : "line-through";
      elements.example.style.backgroundColor = (
        s.color ??
        this.options.color ??
        "black"
      ).toString();
    }

    for (const s of currentKeys) {
      const elements = this.items.get(s);
      if (elements) {
        this.legendElement.removeChild(elements.item);
        this.items.delete(s);
      }
    }
  }

  onDragStart(event) {
    if (event.button !== 0) return; // Only main button

    // Record start position and time
    this.pointerDown = true;
    this.isDragging = false; // Reset dragging flag
    this.startX = event.clientX;
    this.startY = event.clientY;

    // Calculate initial offset relative to the legend's current position
    const rect = this.legendElement.getBoundingClientRect();
    this.offsetX = event.clientX - rect.left;
    this.offsetY = event.clientY - rect.top;

    // Add move/up listeners to the document to capture events globally
    document.addEventListener("pointermove", this.boundDragMove);
    document.addEventListener("pointerup", this.boundDragEnd, { once: true });

    // DO NOT call preventDefault() or stopPropagation() here immediately,
    // as it might interfere with the click event generation if no drag occurs.
  }

  onDragMove(event) {
    if (!this.pointerDown) return; // Only react if pointer is down

    // Check if movement exceeds threshold to initiate drag
    if (!this.isDragging) {
      const dx = event.clientX - this.startX;
      const dy = event.clientY - this.startY;
      if (Math.sqrt(dx * dx + dy * dy) >= this.threshold) {
        this.isDragging = true; // Mark as dragging
        this.legendElement.style.cursor = "grabbing"; // Change cursor
        this.legendElement.setPointerCapture(event.pointerId); // Capture pointer for smooth dragging
        // Now prevent default actions like text selection during drag
        event.preventDefault();
        event.stopPropagation();
      }
    }

    // If dragging is active, move the element
    if (this.isDragging) {
      // Prevent default during active drag move as well
      event.preventDefault();
      event.stopPropagation();

      const parentRect = this.chartElement.getBoundingClientRect();
      const legendRect = this.legendElement.getBoundingClientRect(); // Re-evaluate size

      let newLeftPx = event.clientX - parentRect.left - this.offsetX;
      let newTopPx = event.clientY - parentRect.top - this.offsetY;

      const padLeft = this.options.renderPaddingLeft ?? 10;
      const padRight = this.options.renderPaddingRight ?? 10;
      const padTop = this.options.renderPaddingTop ?? 10;
      const padBottom = this.options.renderPaddingBottom ?? 20;

      const minLeft = padLeft;
      const minTop = padTop;
      const maxLeft =
        this.chartElement.clientWidth - padRight - legendRect.width;
      const maxTop =
        this.chartElement.clientHeight - padBottom - legendRect.height;

      newLeftPx = Math.max(
        minLeft,
        Math.min(newLeftPx, Math.max(minLeft, maxLeft))
      );
      newTopPx = Math.max(minTop, Math.min(newTopPx, Math.max(minTop, maxTop)));

      this.legendElement.style.left = `${newLeftPx}px`;
      this.legendElement.style.top = `${newTopPx}px`;
    }
  }

  onDragEnd(event) {
    if (!this.pointerDown) return; // Ignore if pointer wasn't down

    this.pointerDown = false; // Pointer is up

    if (this.isDragging) {
      // If it was a drag, release capture and reset cursor
      this.legendElement.style.cursor = "move";
      try {
        // Use try-catch for releasePointerCapture
        this.legendElement.releasePointerCapture(event.pointerId);
      } catch (e) {
        /* Ignore error if capture was already lost */
      }
    }
    // Important: Reset the isDragging flag *after* the click handler potentially checks it.
    // Using a microtask (setTimeout 0) ensures this runs after the click event (if any).
    setTimeout(() => {
      this.isDragging = false;
    }, 0);

    // Remove document listeners added in onDragStart
    document.removeEventListener("pointermove", this.boundDragMove);
    // pointerup listener was added with { once: true }, no need to remove manually
  }

  destroy(parentNode) {
    // ... (Cleanup logic as before, ensuring document listeners are removed) ...
    document.removeEventListener("pointermove", this.boundDragMove);
    document.removeEventListener("pointerup", this.boundDragEnd); // Remove just in case {once: true} failed
    const parent =
      parentNode || this.chartElement.shadowRoot || this.chartElement;
    if (this.legendElement.parentNode === parent) {
      try {
        parent.removeChild(this.legendElement);
      } catch (e) {}
    }
    this.items.clear();
  }
}
// --- Internal Plot Module Helpers ---

function handleInternalFollowChange(event) {
  const isChecked = event.target.checked;
  if (internalConfig.follow !== isChecked) {
    internalConfig.follow = isChecked;
    if (chartInstance) {
      chartInstance.options.realTime = internalConfig.follow;
      if (internalConfig.follow) chartInstance.options.yRange = "auto";
      chartInstance.update();
    }
  }
}

function updateDataRateDisplay() {
  if (dataRateDisplayElement) {
    dataRateDisplayElement.textContent = `速率: ${currentDataRateHz.toFixed(
      1
    )} Hz`;
  }
}

function setInternalFollowState(newFollowState) {
  if (internalConfig.follow !== newFollowState) {
    internalConfig.follow = newFollowState;
    if (followToggleElement) followToggleElement.checked = newFollowState;
  }
}

// --- Display Module Interface Implementation ---

export function create(elementId, initialState = {}) {
  if (isInitialized) return true; // Idempotent create
  const containerElement = document.getElementById(elementId);
  if (!containerElement) {
    console.error(`Plot Module: Container #${elementId} not found.`);
    return false;
  }
  const targetDiv = containerElement.querySelector("#lineChart");
  followToggleElement = containerElement.querySelector("#followToggle");
  dataRateDisplayElement = containerElement.querySelector("#dataRateDisplay");
  if (!targetDiv || !followToggleElement || !dataRateDisplayElement) {
    console.error("Plot Module: Could not find internal elements.");
    return false;
  }
  if (typeof window.TimeChart === "undefined") {
    console.error("TimeChart library not loaded!");
    return false;
  }

  internalConfig = { ...internalConfig, ...initialState };
  moduleElementId = elementId;
  lastRateCheckTime = performance.now();
  dataPointCounter = 0;
  currentDataRateHz = 0;

  let initialSeries = [];
  for (let i = 0; i < internalConfig.numChannels; i++) {
    initialSeries.push({
      name: `Ch ${i + 1}`,
      data: [],
      lineWidth: 1.5,
      color: seriesColors[i % seriesColors.length],
    });
  }

  try {
    const now = performance.now();
    const performanceTimeToDateEpochOffset = Date.now() - now;
    customInteractionPluginInstance = new CustomInteractionPlugin({
      onFollowStateChange: setInternalFollowState,
      shouldEnableFollowCheck: () => true,
    });

    chartInstance = new TimeChart.core(targetDiv, {
      baseTime: performanceTimeToDateEpochOffset,
      series: initialSeries,
      lineWidth: 1.5,
      xRange: { min: now - 10000, max: now },
      yRange: "auto",
      realTime: internalConfig.follow,
      renderPaddingLeft: 45,
      renderPaddingRight: 10,
      renderPaddingTop: 10,
      renderPaddingBottom: 20,
      plugins: {
        lineChart: TimeChart.plugins.lineChart,
        d3Axis: TimeChart.plugins.d3Axis,
        draggableLegend: {
          apply(chart) {
            // Pass the chart's container element (targetDiv), model, and options
            return new DraggableLegend(targetDiv, chart.model, chart.options);
          },
        },
        tooltip: new TimeChart.plugins.TimeChartTooltipPlugin({
          enabled: true,
          xLabel: "Time",
          xFormatter: (x) =>
            new Date(x + performanceTimeToDateEpochOffset).toLocaleTimeString(
              "en-US",
              {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                fractionalSecondDigits: 3,
              }
            ),
          yFormatter: (y) => (typeof y === "number" ? y.toFixed(4) : "N/A"),
        }),
        nearestPoint: TimeChart.plugins.nearestPoint,
        crosshair: TimeChart.plugins.crosshair,
        customInteraction: customInteractionPluginInstance,
      },
    });

    followToggleElement.checked = internalConfig.follow;
    followToggleElement.addEventListener("change", handleInternalFollowChange);
    updateDataRateDisplay();
    isInitialized = true;
    console.log("Plot Module Created.");
    return true;
  } catch (error) {
    console.error("Error initializing TimeChart within Plot Module:", error);
    targetDiv.innerHTML = `<p class="text-red-500">初始化图表时出错: ${error.message}</p>`;
    isInitialized = false;
    chartInstance = null;
    customInteractionPluginInstance = null;
    if (followToggleElement)
      followToggleElement.removeEventListener(
        "change",
        handleInternalFollowChange
      );
    return false;
  }
}

export function processDataBatch(batch) {
  if (!chartInstance || !isInitialized || batch.length === 0) return;

  const series = chartInstance.options?.series;
  if (!series) return;

  let pointsAdded = 0;
  let latestTimestamp = lastRateCheckTime;
  let maxChannelsSeenInBatch = series.length; // Start with current number of series
  let needsSeriesUpdate = false;

  // First pass: Check max channels needed and add new series if required
  for (const item of batch) {
    if (item && Array.isArray(item.values)) {
      maxChannelsSeenInBatch = Math.max(
        maxChannelsSeenInBatch,
        item.values.length
      );
    }
  }

  // Add new series if maxChannelsSeenInBatch > current series count
  if (maxChannelsSeenInBatch > series.length) {
    const currentSeriesCount = series.length;
    for (let i = currentSeriesCount; i < maxChannelsSeenInBatch; i++) {
      console.log(
        `Plot Module: Dynamically adding series for Channel ${i + 1}`
      );
      series.push({
        name: `Ch ${i + 1}`,
        data: [],
        lineWidth: 1.5,
        color: seriesColors[i % seriesColors.length],
      });
      needsSeriesUpdate = true; // Flag that series structure changed
    }
    // Update internal config if necessary (though numChannels might represent expected channels)
    // internalConfig.numChannels = maxChannelsSeenInBatch;
    // Consider notifying main.js about the channel change
    console.warn(
      `Plot Module: Number of channels increased to ${maxChannelsSeenInBatch}. Other modules might need updating.`
    );
    // Example: dispatchEvent(new CustomEvent('plot:channelsChanged', { detail: maxChannelsSeenInBatch }));
  }

  // Second pass: Add data points
  for (const item of batch) {
    if (
      !item ||
      typeof item.timestamp !== "number" ||
      !Array.isArray(item.values)
    )
      continue;
    const { timestamp, values } = item;
    if (timestamp > latestTimestamp) latestTimestamp = timestamp;

    // Now iterate up to the potentially increased series length
    for (let i = 0; i < Math.min(values.length, series.length); i++) {
      // Use current series.length
      if (series[i]?.data) {
        const seriesData = series[i].data;
        const yValue =
          typeof values[i] === "number" && isFinite(values[i])
            ? values[i]
            : NaN;
        if (
          seriesData.length === 0 ||
          timestamp >= seriesData[seriesData.length - 1].x
        ) {
          seriesData.push({ x: timestamp, y: yValue });
          pointsAdded++;
        }
      }
    }
  }

  dataPointCounter += batch.length;

  if (pointsAdded > 0 || needsSeriesUpdate) {
    // Define a threshold factor (e.g., 1.05 = trim when 5% over buffer size)
    // Adjust this factor based on performance needs. Larger factor = less frequent trims.
    const TRIM_THRESHOLD_FACTOR = 1.01;
    const trimThreshold = Math.floor(
      internalConfig.maxBufferPoints * TRIM_THRESHOLD_FACTOR
    );
    let needsChartUpdate = false; // Track if chart update is needed

    for (let i = 0; i < series.length; i++) {
      const seriesData = series[i]?.data;
      if (seriesData) {
        // Check if length exceeds the *threshold*, not just maxBufferPoints
        if (seriesData.length > trimThreshold) {
          // Calculate how many points to remove to get back to maxBufferPoints
          const pointsToRemove =
            seriesData.length - internalConfig.maxBufferPoints;
          if (pointsToRemove > 0) {
            // console.log(`Trimming series ${i}: length ${seriesData.length} > threshold ${trimThreshold}. Removing ${pointsToRemove}`);
            seriesData.splice(0, pointsToRemove); // Perform the trim
            needsChartUpdate = true; // Trimming occurred, need update
          }
        } else if (pointsAdded > 0 || needsSeriesUpdate) {
          // If no trimming occurred but data was added/series changed, still need update
          needsChartUpdate = true;
        }
      }
    }

    // Update chart view only if data was added/changed or trimming occurred
    if (needsChartUpdate) {
      chartInstance.update();
    }
  }

  // Update data rate calculation
  const now = latestTimestamp;
  const rateDelta = now - lastRateCheckTime;
  if (rateDelta >= 1000) {
    currentDataRateHz = (dataPointCounter * 1000) / rateDelta;
    dataPointCounter = 0;
    lastRateCheckTime = now;
    updateDataRateDisplay();
  } else if (
    performance.now() - lastRateCheckTime > 2000 &&
    pointsAdded === 0 &&
    !needsSeriesUpdate
  ) {
    if (currentDataRateHz !== 0) {
      currentDataRateHz = 0;
      dataPointCounter = 0;
      lastRateCheckTime = performance.now();
      updateDataRateDisplay();
    }
  }
}

export function resize() {
  if (!isInitialized) return;
  chartInstance?.onResize();
}

export function updateConfig(newConfig) {
  if (!isInitialized) return;
  let needsChartUpdate = false;

  // Handle 'follow' state update
  if (
    newConfig.follow !== undefined &&
    newConfig.follow !== internalConfig.follow
  ) {
    internalConfig.follow = newConfig.follow;
    if (followToggleElement)
      followToggleElement.checked = internalConfig.follow;
    if (chartInstance) {
      chartInstance.options.realTime = internalConfig.follow;
      if (internalConfig.follow) chartInstance.options.yRange = "auto";
      needsChartUpdate = true;
    }
  }

  // Handle 'maxBufferPoints' update
  if (
    newConfig.maxBufferPoints !== undefined &&
    newConfig.maxBufferPoints > 0 &&
    newConfig.maxBufferPoints !== internalConfig.maxBufferPoints
  ) {
    internalConfig.maxBufferPoints = newConfig.maxBufferPoints;
    // Trimming is handled within processDataBatch using this new value
  }

  // Handle 'numChannels' update (expected number of channels)
  if (
    newConfig.numChannels !== undefined &&
    newConfig.numChannels > 0 &&
    newConfig.numChannels !== internalConfig.numChannels
  ) {
    internalConfig.numChannels = newConfig.numChannels; // Update the expected count

    if (chartInstance) {
      const currentSeriesCount = chartInstance.options.series.length;
      if (internalConfig.numChannels < currentSeriesCount) {
        // Configured channels decreased, but chart still has more series
        console.warn(
          `Plot module configured for ${internalConfig.numChannels} channels, but chart currently shows ${currentSeriesCount}. Extra series will remain until cleared.`
        );
        // If strict adherence is needed, chart clearing or series removal could be triggered here.
      } else if (internalConfig.numChannels > currentSeriesCount) {
        // Configured channels increased; dynamic addition in processDataBatch will handle it.
        console.log(
          `Plot module configured for ${internalConfig.numChannels} channels. New series will be added dynamically if data arrives.`
        );
      }
      // No 'needsRecreate' flag set here, relies on dynamic addition or eventual clear.
    }
  }

  // Apply updates to the chart if needed
  if (needsChartUpdate && chartInstance) {
    chartInstance.update();
  }
}

export function clear() {
  console.log("Clearing Plot Module (via Destroy & Recreate)...");
  const currentElementId = moduleElementId;

  destroy();

  if (currentElementId) {
    create(currentElementId);
  } else {
    console.error("Cannot re-create plot module: Element ID was not stored.");
  }

  dataPointCounter = 0;
  lastRateCheckTime = performance.now();
  currentDataRateHz = 0;
  updateDataRateDisplay();
}
export function destroy() {
  if (!isInitialized) return;
  if (followToggleElement && handleInternalFollowChange) {
    followToggleElement.removeEventListener(
      "change",
      handleInternalFollowChange
    );
  }
  followToggleElement = null;
  dataRateDisplayElement = null;
  chartInstance?.dispose();
  chartInstance = null;
  customInteractionPluginInstance = null;
  internalConfig = {
    follow: true,
    numChannels: DEFAULT_SIM_CHANNELS,
    maxBufferPoints: DEFAULT_MAX_BUFFER_POINTS,
  };
  isInitialized = false;
  console.log("Plot Module Destroyed.");
}
