// js/modules/timechart.js (Revised based on original plotter.html usage)
import { seriesColors, ZOOM_FACTOR } from '../config.js';

// --- Custom Interaction Plugin for TimeChart ---
// This class likely remains the same as it defines the custom behavior
class CustomInteractionPlugin {
    chart = null;
    eventEl = null;
    isPanning = false;
    lastPointerPos = { x: 0, y: 0 };
    startPanDomains = { x: null, y: null };
    updateFollowStateCallback = null;
    shouldEnableFollow = () => true;

    constructor(options = {}) {
        this.updateFollowStateCallback = options.onFollowStateChange || function(){};
        this.shouldEnableFollow = options.shouldEnableFollow || (() => true);
    }

    apply(chartInstance) {
        console.log("Applying Custom Interaction Plugin...");
        this.chart = chartInstance;
        this.eventEl = chartInstance.contentBoxDetector?.node || chartInstance.containerEl;
        if (!this.eventEl) { console.error("Cannot get interaction event element!"); return this; }
        this.eventEl.style.outline = 'none'; this.eventEl.tabIndex = -1;
        // Bind methods
        this.onWheel = this.onWheel.bind(this); this.onPointerDown = this.onPointerDown.bind(this);
        this.onPointerMove = this.onPointerMove.bind(this); this.onPointerUp = this.onPointerUp.bind(this);
        this.onPointerLeave = this.onPointerUp.bind(this); this.onPointerCancel = this.onPointerUp.bind(this);
        this.onDoubleClick = this.onDoubleClick.bind(this);
        // Add listeners
        this.eventEl.addEventListener('wheel', this.onWheel, { passive: false });
        this.eventEl.addEventListener('pointerdown', this.onPointerDown); this.eventEl.addEventListener('pointermove', this.onPointerMove);
        this.eventEl.addEventListener('pointerup', this.onPointerUp); this.eventEl.addEventListener('pointerleave', this.onPointerLeave);
        this.eventEl.addEventListener('pointercancel', this.onPointerCancel); this.eventEl.addEventListener('dblclick', this.onDoubleClick);
        // Cleanup
        chartInstance.model.disposing.on(() => {
             if (!this.eventEl) return; console.log("Removing custom interaction listeners...");
             this.eventEl.removeEventListener('wheel', this.onWheel); this.eventEl.removeEventListener('pointerdown', this.onPointerDown); this.eventEl.removeEventListener('pointermove', this.onPointerMove); this.eventEl.removeEventListener('pointerup', this.onPointerUp); this.eventEl.removeEventListener('pointerleave', this.onPointerLeave); this.eventEl.removeEventListener('pointercancel', this.onPointerCancel); this.eventEl.removeEventListener('dblclick', this.onDoubleClick); this.chart = null; this.eventEl = null;
        });
        return this;
    }

    _disableFollow(needsUpdate = true) {
        // Add Log
        console.log(`_disableFollow called. Current realTime: ${this.chart.options.realTime}`);
        if (this.chart.options.realTime) {
            console.log("--> Disabling Follow");
            this.chart.options.realTime = false;
            this.updateFollowStateCallback(false); // Notify main state
            if (needsUpdate) {
                this.chart.update();
            }
        }
    }

    onWheel(event) {
        if (!this.chart) return;
        event.preventDefault(); event.stopPropagation();
        console.log("Interaction: Wheel"); // Log interaction type
        this._disableFollow(false); // Disable follow, update happens with zoom
        const rect = this.eventEl.getBoundingClientRect(); const mouseX = event.clientX - rect.left; const mouseY = event.clientY - rect.top;
        const zoomCenterX = this.chart.model.xScale.invert(mouseX); const zoomCenterY = this.chart.model.yScale.invert(mouseY);
        const scaleFactor = event.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR; let domainChanged = false;
        if (event.shiftKey) { // Zoom Y
            const currentYDomain = this.chart.model.yScale.domain(); const [newYMin, newYMax] = this._calculateNewDomain(currentYDomain, scaleFactor, zoomCenterY);
            this.chart.model.yScale.domain([newYMin, newYMax]); this.chart.options.yRange = null; domainChanged = true;
            console.log(`Zoom Y: factor=${scaleFactor.toFixed(2)}, center=${zoomCenterY.toFixed(2)}, newDomain=[${newYMin.toFixed(2)}, ${newYMax.toFixed(2)}]`); // Log zoom details
        } else { // Zoom X
            const currentXDomain = this.chart.model.xScale.domain(); const [newXMin, newXMax] = this._calculateNewDomain(currentXDomain, scaleFactor, zoomCenterX);
            this.chart.model.xScale.domain([newXMin, newXMax]); this.chart.options.xRange = null; domainChanged = true;
             console.log(`Zoom X: factor=${scaleFactor.toFixed(2)}, center=${zoomCenterX.toFixed(0)}, newDomain=[${newXMin.toFixed(0)}, ${newXMax.toFixed(0)}]`); // Log zoom details
        }
        if (domainChanged) { this.chart.update(); this._checkAutoFollow(); }
    }

    onDoubleClick(event) {
        if (!this.chart) return;
        console.log("Interaction: Double click - Enabling Follow"); // Log interaction
        event.preventDefault();
        this.chart.options.realTime = true; this.chart.options.yRange = "auto";
        this.updateFollowStateCallback(true);
        if (this.isPanning) { this.isPanning = false; this.eventEl.style.cursor = ''; try { this.eventEl.releasePointerCapture(event.pointerId); } catch (e) {} }
        this.chart.update();
    }

    onPointerDown(event) {
        if (!this.chart || !event.isPrimary || event.button !== 0) return;
        console.log("Interaction: Pointer Down (Pan Start)"); // Log interaction
        this._disableFollow(true);
        this.isPanning = true; const rect = this.eventEl.getBoundingClientRect(); this.lastPointerPos = { x: event.clientX - rect.left, y: event.clientY - rect.top }; this.startPanDomains = { x: [...this.chart.model.xScale.domain()], y: [...this.chart.model.yScale.domain()] }; this.eventEl.style.cursor = 'grabbing'; this.eventEl.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
    }

    onPointerMove(event) {
        if (!this.isPanning || !event.isPrimary || !this.chart) return;
        const rect = this.eventEl.getBoundingClientRect(); const currentX = event.clientX - rect.left; const currentY = event.clientY - rect.top;
        const deltaX = currentX - this.lastPointerPos.x; const deltaY = currentY - this.lastPointerPos.y; let domainChanged = false;

        // Pan X
        const xRange = this.chart.model.xScale.range();
        if (xRange[1] - xRange[0] !== 0) {
            const kx = (this.startPanDomains.x[1] - this.startPanDomains.x[0]) / (xRange[1] - xRange[0]);
            const dxDomain = deltaX * kx;
            const newXDomain = this.startPanDomains.x.map(d => d - dxDomain);
            this.chart.model.xScale.domain(newXDomain); this.chart.options.xRange = null; domainChanged = true;
        }
        // Pan Y
        const yRange = this.chart.model.yScale.range();
        if (yRange[0] - yRange[1] !== 0) {
            const ky = (this.startPanDomains.y[1] - this.startPanDomains.y[0]) / (yRange[0] - yRange[1]);
            const dyDomain = deltaY * ky;
            // ** FIX ATTEMPT for inverted Y Panning: Change '-' to '+' **
            const newYDomain = this.startPanDomains.y.map(d => d + dyDomain);
            // Debug Log for Y Pan
            // console.log(`Pan Y: deltaY=${deltaY.toFixed(0)}, ky=${ky.toFixed(4)}, dyDomain=${dyDomain.toFixed(2)}, start=[${this.startPanDomains.y[0].toFixed(2)}, ${this.startPanDomains.y[1].toFixed(2)}], new=[${newYDomain[0].toFixed(2)}, ${newYDomain[1].toFixed(2)}]`)

            this.chart.model.yScale.domain(newYDomain); this.chart.options.yRange = null; domainChanged = true;
        }

        if (domainChanged) { this.chart.update(); }
        this.lastPointerPos = { x: currentX, y: currentY }; this.startPanDomains = { x: [...this.chart.model.xScale.domain()], y: [...this.chart.model.yScale.domain()] };
    }

    onPointerUp(event) {
        if (!event.isPrimary || !this.chart) return;
        if (this.isPanning) {
            console.log("Interaction: Pointer Up (Pan End)"); // Log interaction
            this.isPanning = false; this.eventEl.style.cursor = 'grab';
            try { if (this.eventEl.hasPointerCapture(event.pointerId)) this.eventEl.releasePointerCapture(event.pointerId); } catch (e) {}
            this._checkAutoFollow(); // Check if follow should re-engage
        }
    }

    _calculateNewDomain(currentDomain, scaleFactor, zoomCenter) {
        const [min, max] = currentDomain; const newMin = zoomCenter - (zoomCenter - min) * scaleFactor; const newMax = zoomCenter + (max - zoomCenter) * scaleFactor; if (newMin >= newMax || Math.abs(newMax - newMin) < 1e-9) return currentDomain; return [newMin, newMax];
    }

    _checkAutoFollow() {
        // Add extensive logging here
        console.log(`_checkAutoFollow: chart=${!!this.chart}, realTime=${this.chart?.options?.realTime}, shouldEnable=${this.shouldEnableFollow()}`);
        if (!this.chart || this.chart.options.realTime || !this.shouldEnableFollow()) {
            console.log("--> Skipping auto follow check (already following or disabled).");
             return;
        }

        const currentXDomain = this.chart.model.xScale.domain();
        let maxXData = -Infinity;
        this.chart.options.series.forEach(s => {
            if (s.visible !== false && s.data.length > 0) { const seriesMaxX = s.data[s.data.length - 1].x; if (isFinite(seriesMaxX) && seriesMaxX > maxXData) maxXData = seriesMaxX; }
        });

        if (maxXData === -Infinity) {
            console.log("--> Skipping auto follow check (no data).");
            return; // No data
        }

        const timeThreshold = 500; // ms threshold
        const viewEndX = currentXDomain[1];
        const isNearEnd = viewEndX >= maxXData - timeThreshold;

        console.log(`--> Check: viewEnd=${viewEndX.toFixed(0)}, maxData=${maxXData.toFixed(0)}, threshold=${timeThreshold}, isNearEnd=${isNearEnd}`);

        if (isNearEnd) {
            console.log("--> View scrolled near end, auto-enabling Follow");
            this.chart.options.realTime = true;
            this.updateFollowStateCallback(true); // Update main state
            this.chart.update(); // Update chart to apply realTime change
        }
    }
} // End CustomInteractionPlugin



/**
 * Initializes the TimeChart instance using the main TimeChart constructor.
 */
export function initializeTimeChart(targetElement, numChannels, initialFollowState, onFollowStateChange, shouldEnableFollowCheck) {
    console.log(`Initializing TimeChart (using main constructor). Channels: ${numChannels}`);
    if (!targetElement) {
        console.error("TimeChart target element not provided!");
        return null;
    }
    // Check for the main TimeChart constructor
    if (typeof TimeChart === 'undefined') {
        console.error("TimeChart library not loaded!");
        return null;
    }

    let initialSeries = [];
    for (let i = 0; i < numChannels; i++) {
        initialSeries.push({ name: `Ch ${i + 1}`, data: [], lineWidth: 1.5, color: seriesColors[i % seriesColors.length] });
    }

    try {
        const now = performance.now();
        const baseTimeForChart = 0;
        // const performanceTimeToDateEpochOffset = Date.now() - now; // Needed only if tooltip uses Date formatting

        // Create instance of our custom plugin
        const customInteractionPlugin = new CustomInteractionPlugin({
            onFollowStateChange: onFollowStateChange,
            shouldEnableFollow: shouldEnableFollowCheck
        });

        // ** Use the main TimeChart constructor **
        const chartInstance = new TimeChart(targetElement, { // Use TimeChart, not TimeChart.core
            baseTime: baseTimeForChart,
            series: initialSeries,
            lineWidth: 1.5,
            xRange: { min: now - 10000, max: now }, // Initial 10s view
            yRange: 'auto',
            realTime: initialFollowState,
            // Padding options likely still work
            renderPaddingLeft: 50, renderPaddingRight: 15, renderPaddingTop: 10, renderPaddingBottom: 25,
            legend: { visible: true }, // Legend likely enabled by default, but explicit is ok
            zoom: { // **Disable default zoom/pan** which might conflict with our plugin
                x: { wheel: false, drag: false },
                y: { wheel: false, drag: false }
            },
            // ** REMOVED explicit list of default plugins **
            // Add *only* our custom plugin here if the library supports it this way
            // (Check TimeChart docs if this doesn't work)
            plugins: {
                customInteraction: customInteractionPlugin
            }
            // If the above plugins option doesn't work for the main constructor,
            // we might need to apply the plugin *after* initialization:
            // chartInstance.pluginManager.register(customInteractionPlugin); // Example, check actual API
        });
        console.log("TimeChart instance created successfully using main constructor.");

        // If applying plugin after init is needed:
        // customInteractionPlugin.apply(chartInstance); // Manually apply if not done via options

        return chartInstance;

    } catch (error) {
        console.error("Error initializing TimeChart:", error);
        if (targetElement) targetElement.innerHTML = `<p class="text-red-500">Error initializing chart: ${error.message}</p>`;
        return null;
    }
}


/**
 * Handles the change event of the Follow toggle switch.
 */
export function handleFollowToggleChange(event, chartInstance, setFollowStateCallback) {
    // This function remains the same
    if (!chartInstance) return;
    const isChecked = event.target.checked;
    console.log(`Follow toggle changed: ${isChecked}`);
    chartInstance.options.realTime = isChecked;
    if (isChecked) chartInstance.options.yRange = 'auto';
    setFollowStateCallback(isChecked);
    chartInstance.update();
}

console.log("timechart.js loaded (revised to use main TimeChart constructor)");