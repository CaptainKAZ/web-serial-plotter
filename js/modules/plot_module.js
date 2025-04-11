// js/modules/plot_module.js
// Merges timechart.js logic and handles dynamic channel addition.

import { DEFAULT_MAX_BUFFER_POINTS, DEFAULT_SIM_CHANNELS, seriesColors, ZOOM_FACTOR } from '../config.js';

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
    maxBufferPoints: DEFAULT_MAX_BUFFER_POINTS
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
        this.updateFollowStateCallback = options.onFollowStateChange || function () { };
        this.shouldEnableFollowCheck = options.shouldEnableFollowCheck || (() => true);
    }

    apply(chartInstance) {
        this.chart = chartInstance;
        this.eventEl = chartInstance.contentBoxDetector?.node || chartInstance.containerEl;
        if (!this.eventEl) { console.error("Plot Module: Cannot get interaction event element!"); return this; }
        this.eventEl.style.outline = 'none'; this.eventEl.tabIndex = -1;
        this.onWheel = this.onWheel.bind(this);
        this.onPointerDown = this.onPointerDown.bind(this);
        this.onPointerMove = this.onPointerMove.bind(this);
        this.onPointerUp = this.onPointerUp.bind(this);
        this.onPointerLeave = this.onPointerUp.bind(this);
        this.onPointerCancel = this.onPointerUp.bind(this);
        this.onDoubleClick = this.onDoubleClick.bind(this);
        this.eventEl.addEventListener('wheel', this.onWheel, { passive: false });
        this.eventEl.addEventListener('pointerdown', this.onPointerDown);
        this.eventEl.addEventListener('pointermove', this.onPointerMove);
        this.eventEl.addEventListener('pointerup', this.onPointerUp);
        this.eventEl.addEventListener('pointerleave', this.onPointerLeave);
        this.eventEl.addEventListener('pointercancel', this.onPointerCancel);
        this.eventEl.addEventListener('dblclick', this.onDoubleClick);
        chartInstance.model.disposing.on(() => {
            if (!this.eventEl) return;
            this.eventEl.removeEventListener('wheel', this.onWheel);
            this.eventEl.removeEventListener('pointerdown', this.onPointerDown);
            this.eventEl.removeEventListener('pointermove', this.onPointerMove);
            this.eventEl.removeEventListener('pointerup', this.onPointerUp);
            this.eventEl.removeEventListener('pointerleave', this.onPointerLeave);
            this.eventEl.removeEventListener('pointercancel', this.onPointerCancel);
            this.eventEl.removeEventListener('dblclick', this.onDoubleClick);
            this.chart = null; this.eventEl = null;
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
        event.preventDefault(); event.stopPropagation();
        this._disableFollow(false);
        const rect = this.eventEl.getBoundingClientRect(); const mouseX = event.clientX - rect.left; const mouseY = event.clientY - rect.top;
        const zoomCenterX = this.chart.model.xScale.invert(mouseX); const zoomCenterY = this.chart.model.yScale.invert(mouseY);
        const scaleFactor = event.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR; let domainChanged = false;
        if (event.shiftKey) {
            const currentYDomain = this.chart.model.yScale.domain();
            const [newYMin, newYMax] = this._calculateNewDomain(currentYDomain, scaleFactor, zoomCenterY);
            this.chart.model.yScale.domain([newYMin, newYMax]); this.chart.options.yRange = null; domainChanged = true;
        } else {
            const currentXDomain = this.chart.model.xScale.domain();
            const [newXMin, newXMax] = this._calculateNewDomain(currentXDomain, scaleFactor, zoomCenterX);
            this.chart.model.xScale.domain([newXMin, newXMax]); this.chart.options.xRange = null; domainChanged = true;
        }
        if (domainChanged) { this.chart.update(); this._checkAutoFollow(); }
    }

    onDoubleClick(event) {
        if (!this.chart) return;
        event.preventDefault();
        this.chart.options.realTime = true;
        this.chart.options.yRange = "auto";
        this.updateFollowStateCallback(true);
        if (this.isPanning) {
            this.isPanning = false; this.eventEl.style.cursor = '';
            try { if (this.eventEl.hasPointerCapture(event.pointerId)) this.eventEl.releasePointerCapture(event.pointerId); } catch (e) { }
        }
        this.chart.update();
    }

    onPointerDown(event) {
        if (!this.chart || !event.isPrimary || event.button !== 0) return;
        this._disableFollow(true);
        this.isPanning = true; const rect = this.eventEl.getBoundingClientRect();
        this.lastPointerPos = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        this.startPanDomains = { x: [...this.chart.model.xScale.domain()], y: [...this.chart.model.yScale.domain()] };
        this.eventEl.style.cursor = 'grabbing'; this.eventEl.setPointerCapture(event.pointerId);
        event.preventDefault(); event.stopPropagation();
    }

    onPointerMove(event) {
        if (!this.isPanning || !event.isPrimary || !this.chart) return;
        const rect = this.eventEl.getBoundingClientRect();
        const currentX = event.clientX - rect.left; const currentY = event.clientY - rect.top;
        const deltaX = currentX - this.lastPointerPos.x; const deltaY = currentY - this.lastPointerPos.y;
        let domainChanged = false;
        const xRange = this.chart.model.xScale.range();
        if (xRange[1] - xRange[0] !== 0) {
            const kx = (this.startPanDomains.x[1] - this.startPanDomains.x[0]) / (xRange[1] - xRange[0]);
            const dxDomain = deltaX * kx;
            const newXDomain = this.startPanDomains.x.map(d => d - dxDomain);
            this.chart.model.xScale.domain(newXDomain); this.chart.options.xRange = null; domainChanged = true;
        }
        const yRange = this.chart.model.yScale.range();
        if (yRange[0] - yRange[1] !== 0) {
            const ky = (this.startPanDomains.y[1] - this.startPanDomains.y[0]) / (yRange[0] - yRange[1]);
            const dyDomain = deltaY * ky;
            const newYDomain = this.startPanDomains.y.map(d => d + dyDomain);
            this.chart.model.yScale.domain(newYDomain); this.chart.options.yRange = null; domainChanged = true;
        }
        if (domainChanged) { this.chart.update(); }
        this.lastPointerPos = { x: currentX, y: currentY };
        this.startPanDomains = { x: [...this.chart.model.xScale.domain()], y: [...this.chart.model.yScale.domain()] };
    }

    onPointerUp(event) {
        if (!event.isPrimary || !this.chart) return;
        if (this.isPanning) {
            this.isPanning = false; this.eventEl.style.cursor = '';
            try { if (this.eventEl.hasPointerCapture(event.pointerId)) this.eventEl.releasePointerCapture(event.pointerId); } catch (e) { }
            this._checkAutoFollow();
        }
    }

    _calculateNewDomain(currentDomain, scaleFactor, zoomCenter) {
        const [min, max] = currentDomain; const newMin = zoomCenter - (zoomCenter - min) * scaleFactor; const newMax = zoomCenter + (max - zoomCenter) * scaleFactor;
        if (newMin >= newMax || Math.abs(newMax - newMin) < 1e-9) return currentDomain;
        return [newMin, newMax];
    }

    _checkAutoFollow() {
        if (!this.chart || this.chart.options.realTime || !this.shouldEnableFollowCheck()) return;
        const currentXDomain = this.chart.model.xScale.domain();
        let maxXData = -Infinity;
        this.chart.options.series.forEach(s => {
            if (s.visible !== false && s.data.length > 0) {
                const seriesMaxX = s.data[s.data.length - 1].x;
                if (isFinite(seriesMaxX) && seriesMaxX > maxXData) maxXData = seriesMaxX;
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

// --- Internal Plot Module Helpers ---

function handleInternalFollowChange(event) {
    const isChecked = event.target.checked;
    if (internalConfig.follow !== isChecked) {
        internalConfig.follow = isChecked;
        if (chartInstance) {
            chartInstance.options.realTime = internalConfig.follow;
            if (internalConfig.follow) chartInstance.options.yRange = 'auto';
            chartInstance.update();
        }
    }
}

function updateDataRateDisplay() {
    if (dataRateDisplayElement) {
        dataRateDisplayElement.textContent = `速率: ${currentDataRateHz.toFixed(1)} Hz`;
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
    if (!containerElement) { console.error(`Plot Module: Container #${elementId} not found.`); return false; }
    const targetDiv = containerElement.querySelector('#lineChart');
    followToggleElement = containerElement.querySelector('#followToggle');
    dataRateDisplayElement = containerElement.querySelector('#dataRateDisplay');
    if (!targetDiv || !followToggleElement || !dataRateDisplayElement) { console.error("Plot Module: Could not find internal elements."); return false; }
    if (typeof window.TimeChart === 'undefined') { console.error("TimeChart library not loaded!"); return false; }

    internalConfig = { ...internalConfig, ...initialState };
    moduleElementId = elementId;
    lastRateCheckTime = performance.now();
    dataPointCounter = 0;
    currentDataRateHz = 0;

    let initialSeries = [];
    for (let i = 0; i < internalConfig.numChannels; i++) {
        initialSeries.push({ name: `Ch ${i + 1}`, data: [], lineWidth: 1.5, color: seriesColors[i % seriesColors.length] });
    }

    try {
        const now = performance.now();
        const performanceTimeToDateEpochOffset = Date.now() - now;
        customInteractionPluginInstance = new CustomInteractionPlugin({ onFollowStateChange: setInternalFollowState, shouldEnableFollowCheck: () => true });

        chartInstance = new TimeChart.core(targetDiv, {
            series: initialSeries,
            lineWidth: 1.5,
            xRange: { min: now - 10000, max: now },
            yRange: 'auto',
            realTime: internalConfig.follow,
            renderPaddingLeft: 45, renderPaddingRight: 10, renderPaddingTop: 10, renderPaddingBottom: 20,
            plugins: {
                lineChart: TimeChart.plugins.lineChart,
                d3Axis: TimeChart.plugins.d3Axis,
                legend: TimeChart.plugins.legend,
                tooltip: new TimeChart.plugins.TimeChartTooltipPlugin({
                    enabled: true, xLabel: 'Time',
                    xFormatter: (x) => new Date(x + performanceTimeToDateEpochOffset).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }),
                    yFormatter: (y) => (typeof y === 'number' ? y.toFixed(4) : 'N/A'),
                }),
                nearestPoint: TimeChart.plugins.nearestPoint,
                crosshair: TimeChart.plugins.crosshair,
                customInteraction: customInteractionPluginInstance
            }
        });

        followToggleElement.checked = internalConfig.follow;
        followToggleElement.addEventListener('change', handleInternalFollowChange);
        updateDataRateDisplay();
        isInitialized = true;
        console.log("Plot Module Created.");
        return true;

    } catch (error) {
        console.error("Error initializing TimeChart within Plot Module:", error);
        targetDiv.innerHTML = `<p class="text-red-500">初始化图表时出错: ${error.message}</p>`;
        isInitialized = false; chartInstance = null; customInteractionPluginInstance = null;
        if (followToggleElement) followToggleElement.removeEventListener('change', handleInternalFollowChange);
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
            maxChannelsSeenInBatch = Math.max(maxChannelsSeenInBatch, item.values.length);
        }
    }

    // Add new series if maxChannelsSeenInBatch > current series count
    if (maxChannelsSeenInBatch > series.length) {
        const currentSeriesCount = series.length;
        for (let i = currentSeriesCount; i < maxChannelsSeenInBatch; i++) {
            console.log(`Plot Module: Dynamically adding series for Channel ${i + 1}`);
            series.push({
                name: `Ch ${i + 1}`,
                data: [],
                lineWidth: 1.5,
                color: seriesColors[i % seriesColors.length]
            });
            needsSeriesUpdate = true; // Flag that series structure changed
        }
        // Update internal config if necessary (though numChannels might represent expected channels)
        // internalConfig.numChannels = maxChannelsSeenInBatch;
        // Consider notifying main.js about the channel change
        console.warn(`Plot Module: Number of channels increased to ${maxChannelsSeenInBatch}. Other modules might need updating.`);
        // Example: dispatchEvent(new CustomEvent('plot:channelsChanged', { detail: maxChannelsSeenInBatch }));
    }

    // Second pass: Add data points
    for (const item of batch) {
        if (!item || typeof item.timestamp !== 'number' || !Array.isArray(item.values)) continue;
        const { timestamp, values } = item;
        if (timestamp > latestTimestamp) latestTimestamp = timestamp;

        // Now iterate up to the potentially increased series length
        for (let i = 0; i < Math.min(values.length, series.length); i++) { // Use current series.length
            if (series[i]?.data) {
                const seriesData = series[i].data;
                const yValue = (typeof values[i] === 'number' && isFinite(values[i])) ? values[i] : NaN;
                if (seriesData.length === 0 || timestamp >= seriesData[seriesData.length - 1].x) {
                    seriesData.push({ x: timestamp, y: yValue });
                    pointsAdded++;
                }
            }
        }
    }

    dataPointCounter += batch.length;

    // Trim data AFTER adding new points
    if (pointsAdded > 0 || needsSeriesUpdate) { // Also trim if series structure changed
        for (let i = 0; i < series.length; i++) {
            const seriesData = series[i]?.data;
            if (seriesData) {
                const pointsToRemove = seriesData.length - internalConfig.maxBufferPoints;
                if (pointsToRemove > 0) {
                    seriesData.splice(0, pointsToRemove);
                }
            }
        }
        // Update chart view if data was added or series structure changed
        chartInstance.update();
    }

    // Update data rate calculation
    const now = latestTimestamp;
    const rateDelta = now - lastRateCheckTime;
    if (rateDelta >= 1000) {
        currentDataRateHz = (dataPointCounter * 1000) / rateDelta;
        dataPointCounter = 0;
        lastRateCheckTime = now;
        updateDataRateDisplay();
    } else if (performance.now() - lastRateCheckTime > 2000 && pointsAdded === 0 && !needsSeriesUpdate) {
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
    if (newConfig.follow !== undefined && newConfig.follow !== internalConfig.follow) {
        internalConfig.follow = newConfig.follow;
        if (followToggleElement) followToggleElement.checked = internalConfig.follow;
        if (chartInstance) {
            chartInstance.options.realTime = internalConfig.follow;
            if (internalConfig.follow) chartInstance.options.yRange = 'auto';
            needsChartUpdate = true;
        }
    }

    // Handle 'maxBufferPoints' update
    if (newConfig.maxBufferPoints !== undefined && newConfig.maxBufferPoints > 0 && newConfig.maxBufferPoints !== internalConfig.maxBufferPoints) {
        internalConfig.maxBufferPoints = newConfig.maxBufferPoints;
        // Trimming is handled within processDataBatch using this new value
    }

    // Handle 'numChannels' update (expected number of channels)
    if (newConfig.numChannels !== undefined && newConfig.numChannels > 0 && newConfig.numChannels !== internalConfig.numChannels) {
        internalConfig.numChannels = newConfig.numChannels; // Update the expected count

        if (chartInstance) {
            const currentSeriesCount = chartInstance.options.series.length;
            if (internalConfig.numChannels < currentSeriesCount) {
                // Configured channels decreased, but chart still has more series
                console.warn(`Plot module configured for ${internalConfig.numChannels} channels, but chart currently shows ${currentSeriesCount}. Extra series will remain until cleared.`);
                // If strict adherence is needed, chart clearing or series removal could be triggered here.
            } else if (internalConfig.numChannels > currentSeriesCount) {
                // Configured channels increased; dynamic addition in processDataBatch will handle it.
                console.log(`Plot module configured for ${internalConfig.numChannels} channels. New series will be added dynamically if data arrives.`);
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
    const currentConfigSnapshot = { ...internalConfig };
    const currentElementId = moduleElementId;

    destroy();

    if (currentElementId) {
        create(currentElementId, currentConfigSnapshot);
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
        followToggleElement.removeEventListener('change', handleInternalFollowChange);
    }
    followToggleElement = null;
    dataRateDisplayElement = null;
    chartInstance?.dispose();
    chartInstance = null;
    customInteractionPluginInstance = null;
    internalConfig = { follow: true, numChannels: DEFAULT_SIM_CHANNELS, maxBufferPoints: DEFAULT_MAX_BUFFER_POINTS };
    isInitialized = false;
    console.log("Plot Module Destroyed.");
}