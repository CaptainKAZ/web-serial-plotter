// js/modules/elf_analyzer_service.js

// --- Static Import ---
// Import Wasm binding functions statically at the top.
// Ensure the path is correct relative to where this module will be bundled/served from,
// OR use the full URL if importing directly in the browser without bundling.
// Using the full URL as specified in the documentation:
import { default as wasmInit, analyze_elf_recursively } from 'https://captainkaz.github.io/elf_analyzer_wasm/pkg/elf_analyzer_wasm.js';
// --- End Static Import ---

// Module state
let isWasmInitialized = false;
let isWasmInitializing = false;
let allParsedSymbols = [];
let wasmInitializationPromise = null; // Stores the promise during initialization

/**
 * Initializes the Wasm module. Should be called once during app startup.
 * Uses the statically imported init function.
 * @returns {Promise<void>} A promise that resolves when initialization is complete or rejects on error.
 */
export async function initWasmModule() {
    // Prevent concurrent or repeated initialization
    if (isWasmInitialized || isWasmInitializing) {
        // If already initialized, return resolved promise
        // If initializing, return the existing promise
        return wasmInitializationPromise || Promise.resolve();
    }

    isWasmInitializing = true;
    console.log("Starting Wasm module initialization...");

    wasmInitializationPromise = (async () => {
        try {
            if (typeof wasmInit !== 'function') {
                throw new Error("Wasm module's default export (init function) not found or not a function.");
            }
            if (typeof analyze_elf_recursively !== 'function') { // Check the named export too
                throw new Error("Wasm module did not export 'analyze_elf_recursively' function.");
            }

            await wasmInit(); // Call the statically imported init function

            isWasmInitialized = true;
            isWasmInitializing = false;
            console.log("ELF Analyzer Wasm Module initialized successfully (proactively).");
        } catch (error) {
            isWasmInitialized = false;
            isWasmInitializing = false;
            wasmInitializationPromise = null; // Clear promise on error
            console.error("Failed to initialize ELF Analyzer Wasm Module:", error);
            // Re-throw so the initial caller in main.js can potentially handle it (e.g., disable aresplot option)
            throw error;
        }
    })();

    return wasmInitializationPromise;
}


/**
 * Ensures the Wasm module has completed its initialization.
 * Relies on initWasmModule being called beforehand during app startup.
 * @returns {Promise<void>} A promise that resolves when initialization is complete, or rejects if it failed.
 */
export async function ensureInitialized() {
    if (isWasmInitialized) {
        return Promise.resolve();
    }
    // If initialization hasn't been kicked off somehow, or failed, this will reject.
    // If it's in progress, this will wait for it to finish.
    if (!wasmInitializationPromise) {
        // This case ideally shouldn't happen if initWasmModule is called on startup.
        console.warn("ensureInitialized called before initWasmModule was attempted. Trying to init now.");
        return initWasmModule(); // Attempt to initialize now
    }
    return wasmInitializationPromise;
}

/**
 * Analyzes an ELF file using the loaded Wasm module.
 * @param {Uint8Array} elfFileBytes - The ELF file content as a Uint8Array.
 * @returns {Promise<Array<object>>} A promise that resolves with an array of symbol objects,
 * or rejects if analysis fails or Wasm module is not ready.
 */
export async function analyzeElf(elfFileBytes) {
    await ensureInitialized(); // Wait for initialization if it's still in progress

    if (!isWasmInitialized || typeof analyze_elf_recursively !== 'function') {
        throw new Error("Wasm module not ready or analyze function unavailable.");
    }

    console.log(`Analyzing ELF data (${elfFileBytes.byteLength} bytes)...`);
    try {
        // Call the statically imported Wasm function
        const results = analyze_elf_recursively(elfFileBytes);
        allParsedSymbols = results || [];
        console.log(`ELF analysis complete. Found ${allParsedSymbols.length} symbols.`);
        return allParsedSymbols;
    } catch (error) {
        console.error("Error during Wasm analyze_elf_recursively call:", error);
        allParsedSymbols = [];
        throw new Error(`ELF Analysis Failed: ${error.message || error}`);
    }
}

// --- Functions below remain the same ---

/**
 * Checks if the Wasm module has been initialized and an ELF file loaded.
 * @returns {boolean} True if symbols are available, false otherwise.
 */
export function isElfLoadedAndAnalyzed() {
    // Ensure wasm is initialized *and* symbols have been loaded
    return isWasmInitialized && allParsedSymbols.length > 0;
}

/**
 * Searches the currently parsed symbols by name (case-insensitive).
 * Detects duplicates within the results and adds a flag for UI disambiguation.
 * @param {string} searchTerm - The term to search for in symbol names.
 * @param {number} [limit=50] - The maximum number of results to return.
 * @returns {Array<object>} An array of matching symbol objects, limited by the limit.
 * Each object might have an added 'needsDisambiguation' boolean flag.
 */
export function searchSymbols(searchTerm, limit = 50) {
    if (!isElfLoadedAndAnalyzed()) {
        return [];
    }
    const trimmedSearchTerm = searchTerm.trim();
    if (trimmedSearchTerm === '') {
        return [];
    }

    const lowerSearchTerm = trimmedSearchTerm.toLowerCase();
    const matched = [];

    // First pass: find all matches up to the limit
    for (const symbol of allParsedSymbols) {
        if (symbol && symbol.name && symbol.name.toLowerCase().includes(lowerSearchTerm)) {
            // Add a copy to avoid modifying the original allParsedSymbols
            matched.push({ ...symbol, needsDisambiguation: false });
            if (matched.length >= limit) {
                break;
            }
        }
    }

    // Second pass: detect names duplicated *within the matched results*
    if (matched.length > 1) {
        const nameCounts = {};
        matched.forEach(symbol => {
            nameCounts[symbol.name] = (nameCounts[symbol.name] || 0) + 1;
        });

        matched.forEach(symbol => {
            if (nameCounts[symbol.name] > 1) {
                // Only mark if file and line info is available to actually disambiguate
                if (symbol.file_name && symbol.line_number) {
                    symbol.needsDisambiguation = true;
                }
                // If file/line is missing for a duplicate, it cannot be uniquely identified by this method.
                // Consider how to handle this - maybe exclude them or show a generic duplicate marker?
                // For now, we only set the flag if disambiguation info exists.
            }
        });
    }

    return matched;
}

/**
 * Gets all parsed symbols. Use cautiously due to potentially large size.
 * @returns {Array<object>} A copy of the parsed symbols array.
 */
export function getAllParsedSymbols() {
    return [...allParsedSymbols];
}

/**
 * Clears the stored symbols. Called when data is cleared or protocol changes.
 */
export function clearParsedSymbols() {
    allParsedSymbols = [];
    console.log("Cleared stored ELF symbols.");
}

/**
 * Gets the initialization status of the Wasm module.
 * @returns {boolean}
 */
export function isWasmReady() {
    return isWasmInitialized;
}