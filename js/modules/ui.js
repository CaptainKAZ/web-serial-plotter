// js/modules/ui.js (Complete Revised File)
import { debounce } from '../utils.js';
// Config import might be needed if defaults are used here (e.g., for reset values)
// import { DEFAULT_MAX_BUFFER_POINTS } from '../config.js';

// --- DOM Element References ---
// Get only top-level placeholders initially, or elements guaranteed to exist in index.html
// These can be used to find elements inside them later if needed.
export const controlPanelPlaceholder = document.getElementById('control-panel-placeholder');
export const plotModulePlaceholder = document.getElementById('plot-module-placeholder');
export const textModulePlaceholder = document.getElementById('text-module-placeholder');
export const quaternionModulePlaceholder = document.getElementById('quaternion-module-placeholder');
export const displayAreaContainer = document.getElementById('displayAreaContainer'); // Main container exists initially
export const bottomRow = document.getElementById('bottomRow'); // Exists initially

// --- HTML Partial Loading (Revised to return elements) ---
/**
 * Loads HTML into a target element and returns the element.
 * @param {string} partialUrl - The URL of the HTML partial file.
 * @param {string} targetElementId - The ID of the element to load the content into.
 * @returns {Promise<HTMLElement|null>} A promise resolving to the target element or null on error.
 */
async function loadHtmlPartialById(partialUrl, targetElementId) {
    const targetElement = document.getElementById(targetElementId);
    if (!targetElement) {
        console.error(`Target element #${targetElementId} not found for partial ${partialUrl}`);
        return null; // Return null if target doesn't exist
    }
    try {
        const response = await fetch(partialUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const html = await response.text();
        targetElement.innerHTML = html;
        console.log(`Loaded partial ${partialUrl} into #${targetElementId}`);
        return targetElement; // Return the element reference on success
    } catch (error) {
        console.error(`Failed to load partial ${partialUrl} into #${targetElementId}:`, error);
        if (targetElement) { // Check again in case it existed but fetch failed
            targetElement.innerHTML = `<p class="text-red-500 p-4">Error loading content.</p>`;
        }
        return null; // Return null on error
    }
}

/**
 * Loads all HTML partials into their respective placeholders.
 */
export async function loadAllPartials() {
    try {
        // Wait for all loading promises to settle
        const results = await Promise.allSettled([
            loadHtmlPartialById('html_partials/control_panel.html', 'control-panel'),
            loadHtmlPartialById('html_partials/plot_module.html', 'plotModule'),
            loadHtmlPartialById('html_partials/text_module.html', 'textModule'),
            loadHtmlPartialById('html_partials/quaternion_module.html', 'quatModule')
        ]);

        console.log("All partial loading promises settled.");

        // Check results and extract element references
        const loadedElements = {
            controlPanel: results[0].status === 'fulfilled' ? results[0].value : null,
            plotModule: results[1].status === 'fulfilled' ? results[1].value : null,
            textModule: results[2].status === 'fulfilled' ? results[2].value : null,
            quatModule: results[3].status === 'fulfilled' ? results[3].value : null,
        };

        // Check if essential elements failed to load
        if (!loadedElements.plotModule || !loadedElements.textModule || !loadedElements.quatModule) {
            console.error("Essential modules failed to load. Cannot proceed reliably.");
            throw new Error("Essential module loading failed."); // Throw error to stop initialization
        }

        // Render icons *after* ensuring elements are loaded
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            console.log("Rendering Lucide icons after partial load...");
            try { lucide.createIcons(); } catch (e) { console.error("Error rendering Lucide icons:", e); }
        }

        return loadedElements; // Return the found elements

    } catch (error) {
        console.error("Error during loadAllPartials:", error);
        return null; // Indicate failure
    }
}

// --- UI Update Functions ---

/**
 * Updates the main status message text.
 * @param {string} text - The message to display.
 */
export function updateStatusMessage(text = "状态：空闲") { // Default message
    // Query the element *when needed* as it's loaded dynamically
    const statusMessageEl = document.getElementById('statusMessage');
    if (statusMessageEl) {
        statusMessageEl.textContent = text;
    }
}

/**
 * Updates the visibility of control sections based on the selected data source.
 * @param {string} currentDataSource - The value ('simulated' or 'webserial').
 */
export function updateControlVisibility(currentDataSource) {
    // Get references inside the function, assuming partials are loaded
    const simControls = document.getElementById('simulatedControls');
    const wsControls = document.getElementById('webSerialControls');
    if (simControls) simControls.style.display = currentDataSource === 'simulated' ? 'block' : 'none';
    if (wsControls) wsControls.style.display = currentDataSource === 'webserial' ? 'block' : 'none';
}

// Note: updateButtonStates function now primarily resides in main.js
// as it needs access to the full appState.

// --- Splitter, Resize, Fullscreen ---

let verticalSplitInstance = null;
let horizontalSplitInstance = null;

/**
 * Initializes the Split.js layout using provided element references.
 * @param {object} elements - Object containing { plotElement, bottomRowElement, textElement, quatElement }.
 * @param {Function} onDragEndCallback - Callback function for drag end.
 */
export function initializeSplitLayout(elements, onDragEndCallback) {
    const { plotElement, bottomRowElement, textElement, quatElement } = elements;

    // Check if elements were provided correctly
    if (!plotElement || !bottomRowElement || !textElement || !quatElement) {
        console.error("Split.js initialization failed: One or more required elements were not provided.", elements);
        return;
    }
    if (typeof Split === 'undefined') {
        console.error("Split.js library not loaded.");
        return;
    }

    // Destroy existing splits
    if (verticalSplitInstance) { try { verticalSplitInstance.destroy(); } catch (e) { } }
    if (horizontalSplitInstance) { try { horizontalSplitInstance.destroy(); } catch (e) { } }
    verticalSplitInstance = null; horizontalSplitInstance = null;

    try {
        const plotMinHeight = 150; const bottomMinHeight = 150;
        const textMinWidth = 150; const quatMinWidth = 150;

        // Use direct element references passed in
        verticalSplitInstance = Split([plotElement, bottomRowElement], {
            sizes: [65, 35], minSize: [plotMinHeight, bottomMinHeight], direction: 'vertical',
            gutterSize: 8, cursor: 'row-resize', onDragEnd: onDragEndCallback
        });

        horizontalSplitInstance = Split([textElement, quatElement], {
            sizes: [50, 50], minSize: [textMinWidth, quatMinWidth], direction: 'horizontal',
            gutterSize: 8, cursor: 'col-resize', onDragEnd: onDragEndCallback
        });
        console.log("Split.js layout initialized successfully (using provided elements).");
    } catch (error) {
        console.error("Failed to initialize Split.js (using provided elements):", error, elements);
    }
}

/**
 * Handles window resize or split drag events, resizing chart/view components.
 * It receives necessary instances (like chart, renderer, camera) from main.js.
 * @param {object} dependencies - Object containing { timeChartInstance, threeRenderer, threeCamera }
 */
export function handleResizeUI(dependencies = {}) {
    const { timeChartInstance, threeRenderer, threeCamera } = dependencies;

    // Resize TimeChart
    if (timeChartInstance && typeof timeChartInstance.onResize === 'function') {
        timeChartInstance.onResize();
    }

    // Resize Three.js (Quaternion view)
    if (threeRenderer && threeCamera) {
        // Get quaternionViewDiv *now* to ensure it's the loaded one and visible
        const quatViewDiv = document.getElementById('quaternionView');
        if (quatViewDiv && quatViewDiv.offsetParent !== null) { // Check if visible
            try {
                const targetWidth = quatViewDiv.clientWidth;
                const targetHeight = quatViewDiv.clientHeight;
                if (targetWidth > 0 && targetHeight > 0) {
                    threeCamera.aspect = targetWidth / targetHeight;
                    threeCamera.updateProjectionMatrix();
                    threeRenderer.setSize(targetWidth, targetHeight);
                }
            } catch (e) { console.warn("Error resizing Three.js:", e); }
        }
    }
}

/**
 * Sets up a ResizeObserver to automatically handle resizing of key modules.
 * @param {Function} resizeHandler - The function to call on resize (e.g., the debounced version of handleResizeUI).
 */
export function setupResizeObserver(resizeHandler) {
    // Use placeholder elements as observation targets, as their size dictates content size
    const plotTarget = plotModulePlaceholder;
    const quatTarget = quaternionModulePlaceholder; // Observe the quat placeholder

    if (!plotTarget || !quatTarget) {
        console.warn("ResizeObserver setup skipped: plot or quat placeholder elements not found.");
        return;
    }
    // Basic check if ResizeObserver is supported
    if (typeof ResizeObserver === 'undefined') {
        console.warn("ResizeObserver not supported. Layout might not adjust automatically on resize.");
        // Fallback: Attach resize handler to window resize event
        window.addEventListener('resize', resizeHandler);
        return;
    }

    const observer = new ResizeObserver(resizeHandler); // Directly use the (debounced) handler
    observer.observe(plotTarget);
    observer.observe(quatTarget); // Observe the quat placeholder's size
    console.log("ResizeObserver setup complete.");
}

/**
 * Toggles fullscreen mode for a specific module.
 * Uses event delegation from a parent container set up in main.js.
 * @param {Event} event - The click event from the fullscreen button.
 */
// export function toggleFullscreen(event) {
//     const button = event.currentTarget; // Assumes the listener passes the button correctly
//     // Ensure data-target exists before proceeding
//     const targetId = button.dataset.target; // e.g., "plotModule", "textModule", "quatModule"
//     if (!targetId) {
//         console.error("Fullscreen button missing data-target attribute.", button);
//         return;
//     }

//     // Find the actual module element by its ID - it should exist now
//     const moduleElement = document.getElementById(targetId);

//     if (!moduleElement || !displayAreaContainer) { // displayAreaContainer is the parent controlling visibility
//          console.error(`Target module element #${targetId} or displayAreaContainer not found.`);
//         return;
//     }

//     const isCurrentlyFullscreen = moduleElement.classList.contains('module-fullscreen');
//     let nextIconName = '';

//     // --- Exit Fullscreen ---
//     if (isCurrentlyFullscreen) {
//         moduleElement.classList.remove('module-fullscreen');
//         displayAreaContainer.classList.remove('fullscreen-active'); // Allow other modules to show
//         document.body.style.overflow = ''; // Restore body scroll if needed
//         nextIconName = 'maximize';
//         button.title = "全屏"; // Set title for entering fullscreen
//         console.log(`Exiting fullscreen for ${targetId}`);
//     }
//     // --- Enter Fullscreen ---
//     else {
//         console.log(`Entering fullscreen for ${targetId}`);
//         // Exit any OTHER fullscreen modules first
//         const currentlyFullscreen = document.querySelector('.module-fullscreen');
//         if (currentlyFullscreen && currentlyFullscreen !== moduleElement) {
//             currentlyFullscreen.classList.remove('module-fullscreen');
//             // Find the button within the *other* module to reset its icon
//             const otherButton = currentlyFullscreen.querySelector(`.header-fullscreen-button[data-target="${currentlyFullscreen.id}"]`);
//             if (otherButton) {
//                 otherButton.innerHTML = `<i data-lucide="maximize"></i>`; // Reset icon
//                 otherButton.title = "全屏";
//                  if (typeof lucide !== 'undefined' && lucide.createIcons) {
//                      lucide.createIcons({ nodes: [otherButton] }); // Render the reset icon
//                  }
//             }
//         }

//         // Apply fullscreen to the target module
//         moduleElement.classList.add('module-fullscreen');
//         displayAreaContainer.classList.add('fullscreen-active'); // Hide other modules
//         document.body.style.overflow = 'hidden'; // Prevent body scroll when module is fullscreen
//         nextIconName = 'minimize';
//         button.title = "退出全屏"; // Set title for exiting fullscreen
//     }

//     // Update the *clicked* button's icon
//     button.innerHTML = `<i data-lucide="${nextIconName}"></i>`;
//     if (typeof lucide !== 'undefined' && lucide.createIcons) {
//         lucide.createIcons({ nodes: [button] }); // Render icon for the *clicked* button
//     } else {
//         console.error("Lucide library not available to update icons.");
//     }

//     // Trigger resize after a short delay to allow CSS transition and layout reflow
//     // Using a global resize event trigger is simplest here
//     setTimeout(() => {
//         window.dispatchEvent(new Event('resize'));
//         console.log(`Resize triggered after fullscreen toggle for ${targetId}`);
//     }, 50); // Adjust delay if needed
// }


/**
 * Sets up initial event listeners for UI elements *after* partials are loaded.
 * Relies on handlers passed from main.js.
 * @param {object} handlers - Object containing handler functions for various events.
 */
export function setupEventListeners(handlers) {
    console.log("Setting up event listeners (post-load query)...");

    // Query elements required for listeners *now*
    const dsSelect = document.getElementById('dataSourceSelect');
    const startBtn = document.getElementById('startStopButton');
    const connectBtn = document.getElementById('connectSerialButton');
    const updateParserBtn = document.getElementById('updateParserButton');
    const bufferInput = document.getElementById('bufferDurationInput');
    const downloadBtn = document.getElementById('downloadCsvButton');
    const clearBtn = document.getElementById('clearDataButton');
    const followTgl = document.getElementById('followToggle');
    const simChanInput = document.getElementById('simNumChannels');
    const simFreqInput = document.getElementById('simFrequency');
    const simAmpInput = document.getElementById('simAmplitude');
    const rawStr = document.getElementById('rawStrBtn');
    const rawHex = document.getElementById('rawHexBtn');
    const quatW = document.getElementById('quatWChannel');
    const quatX = document.getElementById('quatXChannel');
    const quatY = document.getElementById('quatYChannel');
    const quatZ = document.getElementById('quatZChannel');

    // Attach listeners only if element exists and handler provided
    if (dsSelect && handlers.handleDataSourceChange) dsSelect.addEventListener('change', handlers.handleDataSourceChange);
    if (startBtn && handlers.handleStartStop) startBtn.addEventListener('click', handlers.handleStartStop);
    if (connectBtn && handlers.handleConnectSerial) connectBtn.addEventListener('click', handlers.handleConnectSerial);
    if (updateParserBtn && handlers.handleUpdateParser) updateParserBtn.addEventListener('click', handlers.handleUpdateParser);
    if (bufferInput && handlers.handleBufferDurationChange) bufferInput.addEventListener('change', handlers.handleBufferDurationChange);
    if (downloadBtn && handlers.handleDownloadCsv) downloadBtn.addEventListener('click', handlers.handleDownloadCsv);
    if (clearBtn && handlers.handleClearData) clearBtn.addEventListener('click', handlers.handleClearData);
    if (followTgl && handlers.handleFollowToggleChange) followTgl.addEventListener('change', handlers.handleFollowToggleChange);
    if (simChanInput && handlers.handleSimChannelChange) simChanInput.addEventListener('change', handlers.handleSimChannelChange);
    if (simFreqInput && handlers.handleSimFrequencyChange) simFreqInput.addEventListener('change', handlers.handleSimFrequencyChange);
    if (simAmpInput && handlers.handleSimAmplitudeChange) simAmpInput.addEventListener('change', handlers.handleSimAmplitudeChange);
    if (rawStr && handlers.handleRawFormatChange) rawStr.addEventListener('click', () => handlers.handleRawFormatChange('str'));
    if (rawHex && handlers.handleRawFormatChange) rawHex.addEventListener('click', () => handlers.handleRawFormatChange('hex'));

    // Quaternion selectors
    [quatW, quatX, quatY, quatZ].forEach(sel => {
        if (sel && handlers.handleQuaternionSelectChange) sel.addEventListener('change', handlers.handleQuaternionSelectChange);
    });

    // Fullscreen buttons - Use event delegation on a persistent parent container
    // Attach listener to 'displayAreaContainer' which exists initially
    //  if (displayAreaContainer && handlers.handleToggleFullscreen) {
    //      // Remove previous listener if any (safety net)
    //      // displayAreaContainer.removeEventListener('click', fullscreenDelegationHandler); // Need a way to reference the specific handler if removing
    //      // Add listener
    //       const fullscreenDelegationHandler = (event) => {
    //          // Find the closest ancestor button with the specific class
    //          const button = event.target.closest('.header-fullscreen-button');
    //          // Ensure the button exists and has the required attribute before calling handler
    //          if (button && button.hasAttribute('data-target')) {
    //              // Pass the event, the handler can get the button via event.currentTarget IF attached directly
    //              // Or in this case, we pass the event, and toggleFullscreen uses event.currentTarget (which *is* the button)
    //               handlers.handleToggleFullscreen(event); // Pass the event object
    //          }
    //      };
    //       // Attach the specifically defined handler
    //      displayAreaContainer.addEventListener('click', fullscreenDelegationHandler);

    //      console.log("Fullscreen listener attached to displayAreaContainer (delegated).");
    //  } else {
    //      console.error("Cannot attach fullscreen delegated listener: displayAreaContainer or handler not found.");
    //  }


    console.log("Event listeners setup process complete.");
}


console.log("ui.js loaded (complete revised)");