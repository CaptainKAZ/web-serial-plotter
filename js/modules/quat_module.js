// js/modules/quat_module.js
// Handles dynamic channel updates on select click and initial channel check.

import { QUAT_TARGET_INTERVAL } from '../config.js';

// --- Module State ---
export let threeRenderer = null;
export let threeCamera = null;
let threeScene, threeObject, threeAxesHelper, threeOrbitControls;
let lastValidQuaternion = null;
let quatAnimationRequest = null;
let isInitialized = false;
let isChannelSelectionConfirmed = false;

// DOM Elements
let containerElement = null;
let quatViewDivElement = null;
let quatDataErrorOverlayElement = null;
let selectorOverlayElement = null;
let wSelectElement = null;
let xSelectElement = null;
let ySelectElement = null;
let zSelectElement = null;
let confirmBtnElement = null;
let reSelectBtnElement = null;
let selectorErrorElement = null;
let selectorInfoElement = null; // Optional: For messages like "Need 4 channels"

let internalConfig = {
    selectedChannels: { w: null, x: null, y: null, z: null },
    availableChannels: 0
};

// --- Internal Helpers ---
function updateQuaternionViewInternal(w, x, y, z) { /* ... */ }
function animateQuaternion() { /* ... */ }
function setupScene() { /* ... */ }

// --- Internal Helpers (Modified/New) ---

function populateSelectors() {
    const numChannels = internalConfig.availableChannels;
    const selects = [wSelectElement, xSelectElement, ySelectElement, zSelectElement];
    if (selects.some(el => !el)) return;

    // Preserve *currently selected* values before clearing
    const currentValues = {
        w: wSelectElement.value, x: xSelectElement.value,
        y: ySelectElement.value, z: zSelectElement.value
    };

    const defaultOption = `<option value="">-- 选择 --</option>`;
    let options = defaultOption;
    for (let i = 0; i < numChannels; i++) {
        options += `<option value="${i}">通道 ${i + 1}</option>`;
    }

    selects.forEach((sel, index) => {
        const key = ['w', 'x', 'y', 'z'][index];
        // Store scroll position before changing innerHTML (might help reduce flicker)
        // const currentScrollTop = sel.scrollTop;
        sel.innerHTML = options;
        // Restore selection if it's still a valid channel index
        if (currentValues[key] !== '' && parseInt(currentValues[key]) < numChannels) {
            sel.value = currentValues[key];
        } else {
            sel.value = ''; // Reset if invalid
        }
        // Restore scroll position (experimental, may not be needed)
        // sel.scrollTop = currentScrollTop;
    });

    // Update button state after repopulating
    handleInternalSelectionChange(false); // Pass false to avoid clearing error message here
}

function handleInternalSelectionChange(clearError = true) {
    const allSelected = wSelectElement?.value !== '' && xSelectElement?.value !== '' &&
                        ySelectElement?.value !== '' && zSelectElement?.value !== '';

    const minChannelsMet = internalConfig.availableChannels >= 4;

    if (confirmBtnElement) {
        // Enable confirm only if >= 4 channels available AND all are selected
        confirmBtnElement.disabled = !allSelected || !minChannelsMet;
    }
    if (selectorErrorElement && clearError) {
        selectorErrorElement.style.display = 'none';
        selectorErrorElement.textContent = '';
    }
     // Update info message
     if (selectorInfoElement) {
         selectorInfoElement.textContent = minChannelsMet ? "请为 W, X, Y, Z 分配唯一的可用通道。" : "需要至少 4 个可用通道才能选择。";
         selectorInfoElement.style.color = minChannelsMet ? '#4b5563' : '#dc2626'; // Grey or Red
     }
}

function handleConfirmSelection() {
    if (!wSelectElement || !xSelectElement || !ySelectElement || !zSelectElement || !selectorErrorElement) return;

    // Ensure at least 4 channels are available before confirming
    if (internalConfig.availableChannels < 4) {
        selectorErrorElement.textContent = "可用通道不足 4 个，无法确认。";
        selectorErrorElement.style.display = 'block';
        confirmBtnElement.disabled = true;
        return;
    }

    const w = wSelectElement.value === '' ? null : parseInt(wSelectElement.value);
    const x = xSelectElement.value === '' ? null : parseInt(xSelectElement.value);
    const y = ySelectElement.value === '' ? null : parseInt(ySelectElement.value);
    const z = zSelectElement.value === '' ? null : parseInt(zSelectElement.value);

    const hasAllIndices = w !== null && x !== null && y !== null && z !== null;
    if (!hasAllIndices) {
        selectorErrorElement.textContent = "所有 W, X, Y, Z 通道都必须选择。";
        selectorErrorElement.style.display = 'block';
        return;
    }

    const selectionSet = new Set([w, x, y, z]);
    if (selectionSet.size !== 4) {
        selectorErrorElement.textContent = "W, X, Y, Z 必须选择不同的通道。";
        selectorErrorElement.style.display = 'block';
        return;
    }

    // Selection is valid
    internalConfig.selectedChannels = { w, x, y, z };
    isChannelSelectionConfirmed = true;
    selectorErrorElement.style.display = 'none';
    if (selectorOverlayElement) selectorOverlayElement.style.display = 'none';
    if (reSelectBtnElement) reSelectBtnElement.style.display = 'inline-flex';
    if (quatDataErrorOverlayElement) quatDataErrorOverlayElement.style.display = 'none';

    console.log("Quaternion channels confirmed:", internalConfig.selectedChannels);
}

function handleShowSelectorOverlay() {
    if (selectorOverlayElement) {
        populateSelectors(); // Refresh options when button is clicked
        selectorOverlayElement.style.display = 'flex';
    }
     if (reSelectBtnElement) reSelectBtnElement.style.display = 'none';
    isChannelSelectionConfirmed = false;
    handleInternalSelectionChange(); // Update button state based on current selections
}

// Define the handler that refreshes selectors on click/focus
function handleDropdownInteraction() {
    console.log("Dropdown interaction, repopulating selectors...");
    populateSelectors();
}


// --- Display Module Interface Implementation ---

export function create(elementId, initialState = {}) {
    if (isInitialized) return true;
    containerElement = document.getElementById(elementId);
    if (!containerElement) { console.error(`Quat Module: Container #${elementId} not found.`); return false; }

    // Find all elements
    quatViewDivElement = containerElement.querySelector('#quaternionView');
    quatDataErrorOverlayElement = containerElement.querySelector('#quatDataErrorOverlay');
    selectorOverlayElement = containerElement.querySelector('#quatChannelSelectorOverlay');
    wSelectElement = containerElement.querySelector('#quatWChannelInternal');
    xSelectElement = containerElement.querySelector('#quatXChannelInternal');
    ySelectElement = containerElement.querySelector('#quatYChannelInternal');
    zSelectElement = containerElement.querySelector('#quatZChannelInternal');
    confirmBtnElement = containerElement.querySelector('#quatConfirmSelectionBtn');
    reSelectBtnElement = containerElement.querySelector('#quatReSelectBtn');
    selectorErrorElement = containerElement.querySelector('#quatSelectorError');
    selectorInfoElement = selectorOverlayElement?.querySelector('p.text-xs'); // Get the info paragraph

    if (!quatViewDivElement || !quatDataErrorOverlayElement || !selectorOverlayElement || !wSelectElement || !xSelectElement || !ySelectElement || !zSelectElement || !confirmBtnElement || !reSelectBtnElement || !selectorErrorElement || !selectorInfoElement) {
        console.error("Quat Module: Could not find all internal elements.");
        return false;
    }
    if (typeof THREE === 'undefined') { console.error("THREE library not loaded."); return false; }

    internalConfig = { ...internalConfig, ...initialState };
    lastValidQuaternion = new THREE.Quaternion();

    try {
        // Basic Three.js setup
        const width = quatViewDivElement.clientWidth; const height = quatViewDivElement.clientHeight;
        threeCamera = new THREE.PerspectiveCamera(75, width > 0 && height > 0 ? width / height : 1, 0.1, 1000);
        threeCamera.position.set(0, 1.5, 3);
        threeRenderer = new THREE.WebGLRenderer({ antialias: true });
        if (width > 0 && height > 0) threeRenderer.setSize(width, height);
        while (quatViewDivElement.firstChild && quatViewDivElement.firstChild !== quatDataErrorOverlayElement) {
            quatViewDivElement.removeChild(quatViewDivElement.firstChild);
        }
        quatViewDivElement.insertBefore(threeRenderer.domElement, quatDataErrorOverlayElement);
        setupScene();
        if (typeof THREE.OrbitControls === 'function') { /* ... setup OrbitControls ... */
             threeOrbitControls = new THREE.OrbitControls(threeCamera, threeRenderer.domElement);
             threeOrbitControls.enableDamping = true; threeOrbitControls.dampingFactor = 0.1;
             threeOrbitControls.screenSpacePanning = false; threeOrbitControls.minDistance = 1; threeOrbitControls.maxDistance = 10;
        }

        // Initial UI State & Listeners
        populateSelectors(); // Populate based on initial availableChannels
        confirmBtnElement.addEventListener('click', handleConfirmSelection);
        reSelectBtnElement.addEventListener('click', handleShowSelectorOverlay);
        // Add listeners for selection change AND interaction (mousedown)
        [wSelectElement, xSelectElement, ySelectElement, zSelectElement].forEach(sel => {
             sel.addEventListener('change', handleInternalSelectionChange);
             sel.addEventListener('mousedown', handleDropdownInteraction); // Refresh on click
             // sel.addEventListener('focus', handleDropdownInteraction); // Alternative: refresh on focus
        });

        // Initial visibility based on channel count
        if (internalConfig.availableChannels < 4) {
            selectorOverlayElement.style.display = 'flex';
            reSelectBtnElement.style.display = 'none';
            confirmBtnElement.disabled = true;
            isChannelSelectionConfirmed = false;
            selectorInfoElement.textContent = "需要至少 4 个可用通道才能选择。";
            selectorInfoElement.style.color = '#dc2626'; // Red
        } else {
            selectorOverlayElement.style.display = 'flex'; // Start visible anyway
            reSelectBtnElement.style.display = 'none';
            isChannelSelectionConfirmed = false;
            handleInternalSelectionChange(); // Set initial button state
        }
        quatDataErrorOverlayElement.style.display = 'none';

        isInitialized = true;
        if (!quatAnimationRequest) animateQuaternion();
        console.log("Quaternion Module Created.");
        return true;

    } catch (error) {
        console.error("Error initializing Quat Module:", error);
        destroy(); return false;
    }
}

export function processDataBatch(batch) {
    if (!isInitialized || !isChannelSelectionConfirmed || !threeObject || batch.length === 0) {
         if (!isChannelSelectionConfirmed && quatDataErrorOverlayElement) quatDataErrorOverlayElement.style.display = 'none';
         return;
    }
    const lastItem = batch[batch.length - 1];
    if (!lastItem || !Array.isArray(lastItem.values)) return;
    const { values } = lastItem;
    const { w, x, y, z } = internalConfig.selectedChannels;
    const wVal = values[w]; const xVal = values[x]; const yVal = values[y]; const zVal = values[z];

    if (!isNaN(wVal) && !isNaN(xVal) && !isNaN(yVal) && !isNaN(zVal)) {
         updateQuaternionViewInternal(wVal, xVal, yVal, zVal);
         if (quatDataErrorOverlayElement) quatDataErrorOverlayElement.style.display = 'none';
    } else {
        if (quatDataErrorOverlayElement) {
             quatDataErrorOverlayElement.textContent = "接收到无效 (NaN) 四元数数据。";
             quatDataErrorOverlayElement.style.display = 'flex';
         }
    }
}

export function resize() { /* ... unchanged ... */
    if (!isInitialized || !threeRenderer || !threeCamera || !quatViewDivElement) return;
    try { const width = quatViewDivElement.clientWidth; const height = quatViewDivElement.clientHeight;
        if (width > 0 && height > 0) { threeCamera.aspect = width / height; threeCamera.updateProjectionMatrix(); threeRenderer.setSize(width, height); }
    } catch (e) { console.warn("Error resizing Quat view:", e); }
}

export function updateConfig(newConfig) {
    if (!isInitialized) return;
    let needsRepopulate = false;
    let previouslyConfirmed = isChannelSelectionConfirmed; // Store state before update

    if (newConfig.availableChannels !== undefined && newConfig.availableChannels !== internalConfig.availableChannels) {
        internalConfig.availableChannels = newConfig.availableChannels;
        needsRepopulate = true;
    }

    if (needsRepopulate) {
        populateSelectors(); // Repopulate with new channel count

        // Check validity of *current* selections after repopulate
        const selections = [
             internalConfig.selectedChannels.w, internalConfig.selectedChannels.x,
             internalConfig.selectedChannels.y, internalConfig.selectedChannels.z
        ];
        const currentSelectionStillValid = selections.every(idx => idx !== null && idx < internalConfig.availableChannels);
        const minChannelsMet = internalConfig.availableChannels >= 4;

        // If previously confirmed, but now invalid OR not enough channels, force re-selection.
        if (previouslyConfirmed && (!currentSelectionStillValid || !minChannelsMet)) {
             console.warn("Available channels changed, forcing re-selection.");
             handleShowSelectorOverlay(); // This also sets isChannelSelectionConfirmed = false
        } else {
            // Just update button state based on new channel count / selections
            handleInternalSelectionChange();
        }
    }
}

export function clear() { /* ... unchanged ... */
    if (!isInitialized) return;
    if (threeObject && lastValidQuaternion) { lastValidQuaternion.identity(); threeObject.setRotationFromQuaternion(lastValidQuaternion); }
    threeOrbitControls?.reset(); if (quatDataErrorOverlayElement) quatDataErrorOverlayElement.style.display = 'none';
}

export function destroy() {
    if (!isInitialized) return;
    isInitialized = false;
    if (quatAnimationRequest) cancelAnimationFrame(quatAnimationRequest);
    quatAnimationRequest = null;

    // Remove listeners
    confirmBtnElement?.removeEventListener('click', handleConfirmSelection);
    reSelectBtnElement?.removeEventListener('click', handleShowSelectorOverlay);
    [wSelectElement, xSelectElement, ySelectElement, zSelectElement].forEach(sel => {
         if(sel) {
             sel.removeEventListener('change', handleInternalSelectionChange);
             sel.removeEventListener('mousedown', handleDropdownInteraction);
             // sel.removeEventListener('focus', handleDropdownInteraction);
         }
    });

    // Dispose Three.js resources
    threeOrbitControls?.dispose();
    if(threeObject) { /* ... dispose geometry/material ... */
        if(threeObject.geometry) threeObject.geometry.dispose();
        if(threeObject.material) {
             if (Array.isArray(threeObject.material)) threeObject.material.forEach(m => m?.dispose());
             else threeObject.material?.dispose();
        }
        threeScene?.remove(threeObject);
    }
    if(threeAxesHelper) threeScene?.remove(threeAxesHelper);
    threeRenderer?.dispose();

    // Clear DOM/State refs
    containerElement = null; quatViewDivElement = null; quatDataErrorOverlayElement = null;
    selectorOverlayElement = null; wSelectElement = null; xSelectElement = null;
    ySelectElement = null; zSelectElement = null; confirmBtnElement = null;
    reSelectBtnElement = null; selectorErrorElement = null; selectorInfoElement = null;
    threeRenderer = null; threeCamera = null; threeScene = null; threeObject = null;
    threeAxesHelper = null; threeOrbitControls = null; lastValidQuaternion = null;
    internalConfig = { selectedChannels: { w: null, x: null, y: null, z: null }, availableChannels: 0 };
    isChannelSelectionConfirmed = false;

    console.log("Quaternion Module Destroyed.");
}

console.log("quat_module.js (with internal UI and dynamic refresh) loaded.");