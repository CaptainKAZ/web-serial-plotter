// js/modules/ui.js

import { formatSecondsToHMS } from '../utils.js'; // Assuming updateBufferStatusUI is here

// --- Top-level element references (if needed for layout/split) ---
export const displayAreaContainer = document.getElementById('displayAreaContainer');
export const bottomRow = document.getElementById('bottomRow');

// --- HTML Partial Loading ---
async function loadHtmlIntoElement(partialUrl, targetElement) {
    if (!targetElement) {
        console.error(`Target element missing for partial ${partialUrl}`);
        return null;
    }
    try {
        const response = await fetch(partialUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const html = await response.text();
        targetElement.innerHTML = html;
        console.log(`Loaded partial ${partialUrl} into #${targetElement.id || 'element'}`);
        return targetElement;
    } catch (error) {
        console.error(`Failed to load partial ${partialUrl}:`, error);
        targetElement.innerHTML = `<p class="text-red-500 p-4">Error loading content.</p>`;
        return null;
    }
}

export async function loadAllPartials() {
    try {
        // Find placeholders by ID first
        const controlPanelPlaceholder = document.getElementById('control-panel');
        const plotModulePlaceholder = document.getElementById('plotModule');
        const textModulePlaceholder = document.getElementById('textModule');
        const quatModulePlaceholder = document.getElementById('quatModule'); // Use the specific ID from quat partial

        // Load content into the found placeholders
        const results = await Promise.allSettled([
            loadHtmlIntoElement('html_partials/control_panel.html', controlPanelPlaceholder),
            loadHtmlIntoElement('html_partials/plot_module.html', plotModulePlaceholder),
            loadHtmlIntoElement('html_partials/text_module.html', textModulePlaceholder),
            loadHtmlIntoElement('html_partials/quaternion_module.html', quatModulePlaceholder)
        ]);

        console.log("All partial loading promises settled.");

        const loadedElements = {
            controlPanel: results[0].status === 'fulfilled' ? results[0].value : null,
            plotModule: results[1].status === 'fulfilled' ? results[1].value : null,
            textModule: results[2].status === 'fulfilled' ? results[2].value : null,
            quatModule: results[3].status === 'fulfilled' ? results[3].value : null,
        };

        if (!loadedElements.controlPanel || !loadedElements.plotModule || !loadedElements.textModule || !loadedElements.quatModule) {
            console.error("Essential UI components failed to load.");
            throw new Error("Essential UI loading failed.");
        }

        // Render icons *after* HTML is loaded
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            try { lucide.createIcons(); } catch (e) { console.error("Error rendering Lucide icons:", e); }
        }

        return loadedElements; // Return references to the container elements

    } catch (error) {
        console.error("Error during loadAllPartials:", error);
        updateStatusMessage("错误：无法加载 UI 组件。"); // Update status on error
        return null;
    }
}

// --- UI Update Functions ---

export function updateStatusMessage(text = "状态：空闲") {
    const statusMessageEl = document.getElementById('statusMessage');
    if (statusMessageEl) {
        statusMessageEl.textContent = text;
    }
}

export function updateControlVisibility(currentDataSource) {
    const simControls = document.getElementById('simulatedControls');
    const wsControls = document.getElementById('webSerialControls');
    if (simControls) simControls.style.display = currentDataSource === 'simulated' ? 'block' : 'none';
    if (wsControls) wsControls.style.display = currentDataSource === 'webserial' ? 'block' : 'none';
    // Also update parser visibility based on initial protocol selection if webserial is shown
    if (currentDataSource === 'webserial') {
        updateParserVisibility();
    }
}

// Moved from data_processing: Updates the buffer usage bar and status text
export function updateBufferStatusUI(currentPoints, maxPoints, collecting, estimateRemainingSec, estimateTotalSec) {
    const bufferUsageBarEl = document.getElementById('bufferUsageBar');
    const bufferStatusEl = document.getElementById('bufferStatus');
    if (!bufferUsageBarEl || !bufferStatusEl) return;

    const usagePercent = maxPoints > 0 ? Math.min(100, (currentPoints / maxPoints) * 100) : 0;
    bufferUsageBarEl.style.width = `${usagePercent.toFixed(1)}%`;

    let statusText = `缓冲点数: ${currentPoints.toLocaleString()} / ${maxPoints.toLocaleString()}`;
    if (collecting) {
        if (estimateRemainingSec !== null && estimateRemainingSec >= 0 && estimateTotalSec !== null && estimateTotalSec > 0) {
            if (usagePercent >= 99.9 || estimateRemainingSec <= 0.1) { statusText += ` <br /> 已满 (约 ${formatSecondsToHMS(estimateTotalSec)})`; }
            else { statusText += `<br /> 预计剩余: ${formatSecondsToHMS(estimateRemainingSec)} / ${formatSecondsToHMS(estimateTotalSec)}`; }
        } else { statusText += `<br /> 预计剩余: 计算中...`; }
    }
    bufferStatusEl.innerHTML = statusText; // Use innerHTML for <br>
}


// --- Splitter, Resize ---

let verticalSplitInstance = null;
let horizontalSplitInstance = null;

export function initializeSplitLayout(elements, onDragEndCallback) {
    const { plotElement, bottomRowElement, textElement, quatElement } = elements;

    if (!plotElement || !bottomRowElement || !textElement || !quatElement) {
        console.error("Split.js initialization failed: Required elements not provided.");
        return;
    }
    if (typeof Split === 'undefined') {
        console.error("Split.js library not loaded.");
        return;
    }

    if (verticalSplitInstance) { try { verticalSplitInstance.destroy(); } catch (e) { /* ignore */ } }
    if (horizontalSplitInstance) { try { horizontalSplitInstance.destroy(); } catch (e) { /* ignore */ } }
    verticalSplitInstance = null; horizontalSplitInstance = null;

    try {
        const plotMinHeight = 150; const bottomMinHeight = 150;
        const textMinWidth = 150; const quatMinWidth = 150;

        verticalSplitInstance = Split([plotElement, bottomRowElement], {
            sizes: [65, 35], minSize: [plotMinHeight, bottomMinHeight], direction: 'vertical',
            gutterSize: 8, cursor: 'row-resize', onDragEnd: onDragEndCallback
        });

        horizontalSplitInstance = Split([textElement, quatElement], {
            sizes: [50, 50], minSize: [textMinWidth, quatMinWidth], direction: 'horizontal',
            gutterSize: 8, cursor: 'col-resize', onDragEnd: onDragEndCallback
        });
        console.log("Split.js layout initialized.");
    } catch (error) {
        console.error("Failed to initialize Split.js:", error);
    }
}

export function setupResizeObserver(resizeHandler) {
    // Observe the containers passed to Split.js
    const plotTarget = document.getElementById('plotModule'); // ID from index.html
    const textTarget = document.getElementById('textModule'); // ID from index.html
    const quatTarget = document.getElementById('quatModuleContainer'); // ID from quat partial

    if (!plotTarget || !textTarget || !quatTarget) {
        console.warn("ResizeObserver setup skipped: One or more target elements not found.");
        return;
    }
    if (typeof ResizeObserver === 'undefined') {
        console.warn("ResizeObserver not supported. Attaching resize handler to window.");
        window.addEventListener('resize', resizeHandler);
        return;
    }

    const observer = new ResizeObserver(resizeHandler);
    observer.observe(plotTarget);
    observer.observe(textTarget); // Observe text container too
    observer.observe(quatTarget);
    console.log("ResizeObserver setup complete.");
}

// --- 新增: 更新自定义解析器部分的可见性 ---
export function updateParserVisibility() {
    const protocolSelect = document.getElementById('serialProtocolSelect');
    const customParserSection = document.getElementById('customParserSection');
    const builtInParserStatus = document.getElementById('builtInParserStatus'); // 新增状态行
    if (protocolSelect && customParserSection && builtInParserStatus) {
        const isCustom = protocolSelect.value === 'custom';
        customParserSection.style.display = isCustom ? 'block' : 'none';
        builtInParserStatus.style.display = isCustom ? 'none' : 'block'; // 显示内置状态或自定义部分

        // 根据当前选择更新状态文本
        if (!isCustom) {
            const selectedOptionText = protocolSelect.options[protocolSelect.selectedIndex].text;
            builtInParserStatus.textContent = `状态：使用内置协议 "${selectedOptionText}"。`;
            builtInParserStatus.classList.remove('text-red-600', 'text-green-600'); // 重置颜色
        } else {
            // 自定义区域内的 parserStatus 会显示 Worker 状态
        }
    }
}

// --- Event Listener Setup (修改) ---
export function setupEventListeners(handlers) {
    console.log("Setting up UI event listeners...");

    const get = (id) => document.getElementById(id);
    const addListener = (id, event, handler) => {
        const element = get(id);
        if (element && handler) {
            element.addEventListener(event, handler);
        } else if (!element) {
            // console.warn(`Element #${id} not found for event listener.`);
        }
    };

    // Control Panel Main
    addListener('dataSourceSelect', 'change', handlers.handleDataSourceChange);
    addListener('startStopButton', 'click', handlers.handleStartStop);

    // Simulation Controls
    addListener('simNumChannels', 'change', handlers.handleSimChannelChange);
    addListener('simFrequency', 'change', handlers.handleSimFrequencyChange);
    addListener('simAmplitude', 'change', handlers.handleSimAmplitudeChange);

    // WebSerial Controls
    addListener('connectSerialButton', 'click', handlers.handleConnectSerial);
    addListener('serialProtocolSelect', 'change', handlers.handleProtocolChange); // 新增协议选择处理
    addListener('updateParserButton', 'click', handlers.handleUpdateParser);
    // Listeners for baudRate, dataBits etc. might be needed if they trigger actions,
    // but usually their values are read when 'connect' is clicked.

    // Buffer & Export
    addListener('bufferDurationInput', 'change', handlers.handleBufferDurationChange);
    addListener('downloadCsvButton', 'click', handlers.handleDownloadCsv);
    addListener('clearDataButton', 'click', handlers.handleClearData);

    console.log("UI Event listeners setup process complete.");
}

// Removed updateParsedDataDisplay and updateDataRateDisplayUI if they were here

console.log("ui.js loaded.");