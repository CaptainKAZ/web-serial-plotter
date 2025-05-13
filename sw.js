// sw.js

// 定义缓存名称，通常包含版本号以便更新
const CACHE_NAME = "web-serial-plotter-cache-v3.1"; // Increment version number
// 定义需要缓存的核心文件（应用外壳）和依赖项
const urlsToCache = [
  "/", // 根路径通常也需要缓存
  "index.html",
  "manifest.json", // Added manifest file
  "css/styles.css",
  // Core JS Modules
  "js/main.js",
  "js/config.js",
  "js/utils.js",
  "js/event_bus.js",
  "js/modules/ui.js",
  "js/modules/plot_module.js",
  "js/modules/terminal_module.js",
  "js/modules/quat_module.js",
  "js/modules/data_processing.js",
  "js/modules/serial.js",
  "js/modules/worker_service.js",
  "js/worker/data_worker.js", // Worker 脚本也需要缓存
  "js/modules/elf_analyzer_service.js",
  "js/modules/aresplot_protocol.js",
  // HTML Partials
  "html_partials/control_panel.html",
  "html_partials/plot_module.html",
  "html_partials/text_module.html",
  "html_partials/quaternion_module.html",
  // 外部库的 CDN URL
  // IMPORTANT: Caching root domains or '@latest' might be unreliable.
  // It's best to use specific file URLs if possible. These are based on index.html.
  "https://cdn.tailwindcss.com", // Tailwind CSS (might need specific file URL)
  "https://cdn.jsdelivr.net/npm/d3-array@3",
  "https://cdn.jsdelivr.net/npm/d3-color@3",
  "https://cdn.jsdelivr.net/npm/d3-format@3",
  "https://cdn.jsdelivr.net/npm/d3-interpolate@3",
  "https://cdn.jsdelivr.net/npm/d3-time@3",
  "https://cdn.jsdelivr.net/npm/d3-time-format@4",
  "https://cdn.jsdelivr.net/npm/d3-scale@4",
  "https://cdn.jsdelivr.net/npm/d3-selection@3",
  "https://cdn.jsdelivr.net/npm/d3-axis@3",
  "https://huww98.github.io/TimeChart/dist/timechart.min.js",
  "https://captainkaz.github.io/elf_analyzer_wasm/pkg/elf_analyzer_wasm.js",
  "https://captainkaz.github.io/elf_analyzer_wasm/pkg/elf_analyzer_wasm_bg.wasm", // Standard name for the wasm file
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js",
  "https://unpkg.com/split.js/dist/split.min.js",
  "https://unpkg.com/lucide@latest/dist/umd/lucide.min.js", // More specific Lucide URL if available, assuming UMD here
  "https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css",
  "https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js",
  "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js",

  // Icons and Assets
  "icons/icon-512x512.png",
  // Add any other static assets used by your CSS or JS if necessary
];

// 安装 Service Worker 时触发
self.addEventListener("install", (event) => {
  console.log("[Service Worker] Install event for cache:", CACHE_NAME);
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log("[Service Worker] Opened cache:", CACHE_NAME);
        const cachePromises = urlsToCache.map((urlToCache) => {
          // Use request object for more control, especially for wasm
          const request = new Request(urlToCache, { mode: "cors" }); // Try 'cors' first for external URLs
          return fetch(request)
            .then((response) => {
              if (!response.ok) {
                // If CORS fails for external, try no-cors as fallback (opaque response)
                if (new URL(urlToCache).origin !== self.location.origin) {
                  console.warn(
                    `[Service Worker] CORS fetch failed for ${urlToCache}. Trying no-cors.`
                  );
                  const noCorsRequest = new Request(urlToCache, {
                    mode: "no-cors",
                  });
                  return fetch(noCorsRequest).then((noCorsResponse) => {
                    if (noCorsResponse.type === "opaque") {
                      return cache.put(urlToCache, noCorsResponse); // Cache opaque response
                    } else {
                      console.error(
                        `[Service Worker] no-cors fetch for ${urlToCache} did not result in opaque response.`
                      );
                      return Promise.resolve(); // Don't block install
                    }
                  });
                } else {
                  // If same-origin fetch failed, log error
                  console.error(
                    `[Service Worker] Failed to fetch same-origin ${urlToCache}. Status: ${response.status}`
                  );
                  return Promise.resolve(); // Don't block install
                }
              }
              // Cache successful CORS response
              return cache.put(urlToCache, response);
            })
            .catch((error) => {
              console.error(
                `[Service Worker] Error fetching/caching ${urlToCache}:`,
                error
              );
              return Promise.resolve(); // Don't block install on individual file error
            });
        });
        return Promise.all(cachePromises);
      })
      .then(() => {
        console.log(
          "[Service Worker] Finished attempting to cache all specified URLs."
        );
        console.log(
          "[Service Worker] Installation finished, attempting to activate..."
        );
        return self.skipWaiting(); // Force activation
      })
      .catch((error) => {
        console.error(
          "[Service Worker] Cache opening or skipWaiting failed during install:",
          error
        );
      })
  );
});

// 激活 Service Worker 时触发
self.addEventListener("activate", (event) => {
  console.log("[Service Worker] Activate event for cache:", CACHE_NAME);
  // 清理旧缓存
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            // 如果缓存名称不是当前的缓存名称，则删除它
            if (cacheName !== CACHE_NAME) {
              console.log("[Service Worker] Deleting old cache:", cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log("[Service Worker] Claiming clients");
        // 让 Service Worker 立即控制当前打开的页面 (clients)
        // 这对于确保 PWA 立即使用新缓存至关重要
        return self.clients.claim();
      })
      .catch((error) => {
        console.error(
          "[Service Worker] Cache cleanup or claiming clients failed during activate:",
          error
        );
      })
  );
});

// 拦截网络请求
self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);

  // 仅处理 GET 请求，且协议为 http 或 https
  if (
    event.request.method !== "GET" ||
    !requestUrl.protocol.startsWith("http")
  ) {
    // 对于非 GET 或非 HTTP(S) 请求，直接由浏览器处理
    // console.log(`[Service Worker] Ignoring non-GET/non-HTTP(S) request: ${event.request.method} ${event.request.url}`);
    return;
  }

  // 采用 Cache First 策略
  event.respondWith(
    caches
      .match(event.request, { ignoreVary: true }) // ignoreVary can help match opaque responses
      .then((cachedResponse) => {
        // 如果在缓存中找到匹配的响应
        if (cachedResponse) {
          // console.log(`[Service Worker] Serving from cache: ${event.request.url}`);
          return cachedResponse; // 直接返回缓存的响应
        }

        // 如果缓存中没有找到，则尝试从网络获取
        // console.log(`[Service Worker] Fetching from network: ${event.request.url}`);
        return fetch(event.request)
          .then((networkResponse) => {
            // 检查是否收到了有效的响应 (ok or opaque)
            if (
              networkResponse &&
              (networkResponse.ok || networkResponse.type === "opaque")
            ) {
              // 克隆响应，因为响应体只能被读取一次
              const responseToCache = networkResponse.clone();

              // 尝试将网络响应添加到缓存中 (异步操作，不阻塞返回网络响应)
              caches.open(CACHE_NAME).then((cache) => {
                // console.log(`[Service Worker] Caching new response: ${event.request.url}`);
                cache
                  .put(event.request, responseToCache)
                  .catch((cachePutError) => {
                    console.warn(
                      `[Service Worker] Failed to cache response for ${event.request.url}:`,
                      cachePutError
                    );
                    // Especially handle QuotaExceededError if storage is full
                    if (cachePutError.name === "QuotaExceededError") {
                      console.error(
                        "[Service Worker] Cache storage quota exceeded. Cannot cache new items."
                      );
                      // Optionally, implement cache cleanup logic here
                    }
                  });
              });
            } else {
              console.warn(
                `[Service Worker] Network fetch failed or received non-OK response for: ${event.request.url}, Status: ${networkResponse?.status}, Type: ${networkResponse?.type}`
              );
            }

            // 返回从网络获取的原始响应 (即使缓存失败)
            return networkResponse;
          })
          .catch((error) => {
            console.error(
              `[Service Worker] Fetch failed entirely for: ${event.request.url}`,
              error
            );
            // 如果网络请求失败，可以尝试返回一个离线占位符页面或资源
            // 例如: return caches.match('/offline.html');
            // 对于 JS/CSS 等关键资源，失败可能导致应用无法工作，所以可能返回错误更合适
            // 对于 API 请求，可能返回一个表示离线的 JSON
            // 对于此应用，若核心资源加载失败，直接失败可能更清晰
            // 返回一个基本的错误响应
            return new Response(`Network error: ${error.message}`, {
              status: 408, // Request Timeout
              headers: { "Content-Type": "text/plain" },
            });
          });
      })
  );
});
