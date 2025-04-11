// js/modules/quaternion.js (Revised to fix import error)
// Assume THREE is available globally via CDN script
import { QUAT_TARGET_INTERVAL } from '../config.js';
// **REMOVED direct DOM element imports from ui.js**
// import { ... } from './ui.js'; // No longer importing specific elements like quatFpsDisplay

// --- Module State ---
let threeScene, threeCameraInternal, threeRendererInternal, threeObject, threeAxesHelper, threeOrbitControls;
let lastValidQuaternion = null;
let quatAnimationRequest = null;
let quatLastRenderTime = 0;
let quatFrameCount = 0, quatLastFpsCalcTime = 0, quatActualFps = 0;

// Store references needed by external modules (like resize handler)
export let threeRenderer = null;
export let threeCamera = null; // Export the camera instance

/**
 * Initializes the Three.js scene, camera, renderer, object, and controls.
 */
export function initializeQuaternionView() {
    console.log("Initializing Three.js view...");
    // Query elements *inside* the function, assuming partials are loaded
    const quaternionViewDiv = document.getElementById('quaternionView');
    const quaternionErrorOverlay = document.getElementById('quaternionErrorOverlay');

    if (!quaternionViewDiv) {
        console.error("Quaternion view container #quaternionView not found.");
        // Attempt to show error in a generic way if overlay isn't found either
        const statusMsg = document.getElementById('statusMessage');
        if (statusMsg) statusMsg.textContent = "错误：无法找到四元数视图容器。";
        return;
    }
    if (typeof THREE === 'undefined') {
        console.error("THREE library is not loaded.");
        if (quaternionErrorOverlay) {
            quaternionErrorOverlay.textContent = "Error: THREE.js library not loaded.";
            quaternionErrorOverlay.style.display = 'flex';
        } else {
            console.error("Cannot display THREE.js load error: overlay not found.");
        }
        return;
    }
    // OrbitControls check remains the same (optional)
    if (typeof THREE.OrbitControls === 'undefined') {
        console.warn("THREE.OrbitControls not loaded. View will not be interactive.");
    }


    // --- Cleanup previous instance ---
    if (quatAnimationRequest) cancelAnimationFrame(quatAnimationRequest);
    quatAnimationRequest = null;
    const existingCanvas = quaternionViewDiv.querySelector('canvas');
    if (existingCanvas) quaternionViewDiv.removeChild(existingCanvas);
    if (threeRendererInternal) threeRendererInternal.dispose();
    if (threeOrbitControls) threeOrbitControls.dispose();
    threeRendererInternal = null; threeOrbitControls = null; threeRenderer = null; threeCamera = null; threeCameraInternal = null;
    quatLastRenderTime = 0;
    lastValidQuaternion = new THREE.Quaternion();
    // --- End Cleanup ---


    try {
        const width = quaternionViewDiv.clientWidth;
        const height = quaternionViewDiv.clientHeight;
        if (width <= 0 || height <= 0) {
            console.warn("Quaternion view dimensions invalid on init (0x0). Will retry on resize.");
            return;
        }

        // Scene, Camera, Renderer
        threeScene = new THREE.Scene();
        threeScene.background = new THREE.Color(0xe5e7eb);
        threeCameraInternal = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
        threeCameraInternal.position.set(0, 1.5, 3);
        threeRendererInternal = new THREE.WebGLRenderer({ antialias: true });
        threeRendererInternal.setSize(width, height);
        quaternionViewDiv.insertBefore(threeRendererInternal.domElement, quaternionErrorOverlay); // Insert before overlay

        // Update exported references
        threeRenderer = threeRendererInternal;
        threeCamera = threeCameraInternal;

        // Object, Axes, Lighting (same as before)
        const geometry = new THREE.BoxGeometry(0.8, 1.2, 0.4);
        const materials = [new THREE.MeshStandardMaterial({ color: 0xff0000 }), new THREE.MeshStandardMaterial({ color: 0xffa500 }), new THREE.MeshStandardMaterial({ color: 0x00ff00 }), new THREE.MeshStandardMaterial({ color: 0x0000ff }), new THREE.MeshStandardMaterial({ color: 0xffffff }), new THREE.MeshStandardMaterial({ color: 0x808080 })];
        threeObject = new THREE.Mesh(geometry, materials);
        threeScene.add(threeObject);
        threeAxesHelper = new THREE.AxesHelper(1.5);
        threeScene.add(threeAxesHelper);
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7); threeScene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.9); directionalLight.position.set(1, 2, 1.5).normalize(); threeScene.add(directionalLight);


        // OrbitControls setup
        if (typeof THREE.OrbitControls === 'function') {
            threeOrbitControls = new THREE.OrbitControls(threeCameraInternal, threeRendererInternal.domElement);
            threeOrbitControls.enableDamping = true; threeOrbitControls.dampingFactor = 0.1;
            threeOrbitControls.screenSpacePanning = false; threeOrbitControls.minDistance = 1; threeOrbitControls.maxDistance = 10;
        }

        // Hide error overlay on successful init
        if (quaternionErrorOverlay) quaternionErrorOverlay.style.display = 'none';

        // Start animation loop
        quatLastFpsCalcTime = performance.now();
        if (!quatAnimationRequest) {
            animateQuaternion();
        }
        console.log("Three.js view initialized successfully.");

    } catch (error) {
        console.error("Error initializing Three.js:", error);
        if (quaternionErrorOverlay) {
            quaternionErrorOverlay.textContent = `Three.js initialization failed: ${error.message}`;
            quaternionErrorOverlay.style.display = 'flex';
        }
        threeRenderer = null; threeCamera = null; // Clear exported refs on error
    }
}

/**
 * Updates the 3D object's rotation based on new quaternion values.
 */
export function updateQuaternionView(w, x, y, z) {
    // Query overlay here in case it wasn't found during init
    const errorOverlay = document.getElementById('quaternionErrorOverlay');

    if (!threeObject || !lastValidQuaternion) return;

    if (isNaN(w) || isNaN(x) || isNaN(y) || isNaN(z)) {
        if (errorOverlay) {
            errorOverlay.textContent = "接收到无效 (NaN) 四元数数据。"; // Changed message to Chinese
            errorOverlay.style.display = 'flex';
        }
        return;
    }

    if (errorOverlay) errorOverlay.style.display = 'none'; // Hide if valid data received

    lastValidQuaternion.set(x, y, z, w).normalize();
    threeObject.setRotationFromQuaternion(lastValidQuaternion);
}

/**
 * The animation loop for the Three.js scene. Renders the scene and updates controls.
 */
function animateQuaternion() {
    quatAnimationRequest = requestAnimationFrame(animateQuaternion);

    if (!threeRendererInternal || !threeScene || !threeCameraInternal) {
        if (quatAnimationRequest) cancelAnimationFrame(quatAnimationRequest);
        quatAnimationRequest = null;
        return;
    }

    const now = performance.now();
    const elapsed = now - quatLastRenderTime;

    if (elapsed >= QUAT_TARGET_INTERVAL) {
        quatLastRenderTime = now - (elapsed % QUAT_TARGET_INTERVAL);
        threeOrbitControls?.update();
        threeRendererInternal.render(threeScene, threeCameraInternal);
    }
}

/**
 * Updates the channel selection dropdowns for quaternion components.
 */
export function updateQuaternionSelectors(numChannels, currentIndices, onIndexChangeCallback) {
    // Query selectors inside the function
    const quatW = document.getElementById('quatWChannel');
    const quatX = document.getElementById('quatXChannel');
    const quatY = document.getElementById('quatYChannel');
    const quatZ = document.getElementById('quatZChannel');
    const selectors = [quatW, quatX, quatY, quatZ];

    if (selectors.some(sel => !sel)) {
        console.warn("Quaternion select elements not found.");
        return;
    }

    const defaultOption = `<option value="">-- 选择通道 --</option>`; // Changed label to Chinese
    let options = defaultOption;
    for (let i = 0; i < numChannels; i++) {
        options += `<option value="${i}">通道 ${i + 1}</option>`; // Changed label to Chinese
    }

    selectors.forEach((sel, idx) => {
        const key = ['w', 'x', 'y', 'z'][idx];
        const currentValue = currentIndices[key];
        sel.innerHTML = options;
        if (currentValue !== null && currentValue < numChannels) {
            sel.value = String(currentValue);
        } else {
            sel.value = '';
        }
    });

    onIndexChangeCallback(); // Notify main state that selectors are updated
}

/**
 * Reads the current values from the quaternion select dropdowns and updates the state object.
 */
export function updateQuaternionIndices(indicesState) {
    // Query elements inside the function
    const quatW = document.getElementById('quatWChannel');
    const quatX = document.getElementById('quatXChannel');
    const quatY = document.getElementById('quatYChannel');
    const quatZ = document.getElementById('quatZChannel');

    const getIndex = (selectElement) => {
        if (!selectElement) return null;
        const val = parseInt(selectElement.value);
        return isNaN(val) ? null : val;
    };
    indicesState.w = getIndex(quatW);
    indicesState.x = getIndex(quatX);
    indicesState.y = getIndex(quatY);
    indicesState.z = getIndex(quatZ);
}


console.log("quaternion.js loaded (revised)");