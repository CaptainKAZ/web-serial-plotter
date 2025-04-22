// js/utils.js

/**
 * Debounce function to limit the rate at which a function can fire.
 * @param {Function} func - The function to debounce.
 * @param {number} wait - The debounce interval in milliseconds.
 * @returns {Function} The debounced function.
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Formats a total number of seconds into a human-readable string (H:M:S, M:S, or S.s).
 * @param {number|null} totalSeconds - The total seconds to format.
 * @returns {string} The formatted time string or "-".
 */
export function formatSecondsToHMS(totalSeconds) {
  if (totalSeconds === null || totalSeconds < 0 || !isFinite(totalSeconds)) {
    return "-";
  }
  if (totalSeconds === Infinity) {
    return "∞";
  }

  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);

  const sStr = String(seconds).padStart(2, "0");
  const mStr = String(minutes).padStart(2, "0");

  if (hours > 0) {
    return `${hours}h ${mStr}m ${sStr}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${sStr}s`;
  } else {
    // Show one decimal for small values for better precision indication
    if (totalSeconds < 10) {
      return `${totalSeconds.toFixed(1)}s`;
    }
    return `${seconds}s`;
  }
}

console.log("utils.js loaded"); // For debugging load order
