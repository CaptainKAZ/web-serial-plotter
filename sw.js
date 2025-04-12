// sw.js

// 定义缓存名称，通常包含版本号以便更新
const CACHE_NAME = 'web-serial-plotter-cache-v1';
// 定义需要缓存的核心文件（应用外壳）
const urlsToCache = [
  '/', // 根路径通常也需要缓存
  '/index.html',
  '/css/styles.css',
  '/js/main.js',
  '/js/config.js',
  '/js/utils.js',
  '/js/modules/ui.js',
  '/js/modules/plot_module.js',
  '/js/modules/terminal_module.js',
  '/js/modules/quat_module.js',
  '/js/modules/data_processing.js',
  '/js/modules/serial.js',
  '/js/modules/worker_comms.js',
  '/js/worker/data_worker.js', // Worker 脚本也需要缓存
  // HTML Partials (如果它们是动态加载的，也可以缓存fetch请求，但直接缓存文件更简单)
  '/html_partials/control_panel.html',
  '/html_partials/plot_module.html',
  '/html_partials/text_module.html',
  '/html_partials/quaternion_module.html',
  // 外部库的 CDN URL (非常重要！)
  'https://cdn.tailwindcss.com', // 注意：缓存根域名可能不够精确，最好缓存具体文件，但CDN可能不允许
  'https://cdn.jsdelivr.net/npm/d3-array@3',
  'https://cdn.jsdelivr.net/npm/d3-color@3',
  'https://cdn.jsdelivr.net/npm/d3-format@3',
  'https://cdn.jsdelivr.net/npm/d3-interpolate@3',
  'https://cdn.jsdelivr.net/npm/d3-time@3',
  'https://cdn.jsdelivr.net/npm/d3-time-format@4',
  'https://cdn.jsdelivr.net/npm/d3-scale@4',
  'https://cdn.jsdelivr.net/npm/d3-selection@3',
  'https://cdn.jsdelivr.net/npm/d3-axis@3',
  'https://huww98.github.io/TimeChart/dist/timechart.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
  'https://unpkg.com/split.js/dist/split.min.js',
  'https://unpkg.com/lucide@latest', // 同样，最好缓存具体版本
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css',
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js',
  'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js',
  '/icons/icon-512x512.png'
];

// 安装 Service Worker 时触发
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Install event');
  // 执行安装步骤
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Opened cache:', CACHE_NAME);
        // 添加所有需要缓存的 URL 到缓存中
        // addAll 是原子操作，如果任何一个文件下载失败，整个操作都会失败
        return cache.addAll(urlsToCache).catch(error => {
          console.error('[Service Worker] Failed to cache urls during install:', error);
          // 考虑在这里抛出错误，阻止 Service Worker 安装，
          // 因为如果核心文件缓存失败，应用可能无法离线工作。
          // throw error;
        });
      })
      .then(() => {
        console.log('[Service Worker] All specified URLs cached successfully.');
        // 强制新安装的 Service Worker 立即激活 (可选)
        return self.skipWaiting();
      })
  );
});

// 激活 Service Worker 时触发
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activate event');
  // 清理旧缓存
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // 如果缓存名称不是当前的缓存名称，则删除它
          if (cacheName !== CACHE_NAME) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[Service Worker] Claiming clients');
      // 让 Service Worker 立即控制当前打开的页面 (clients)
      return self.clients.claim();
    })
  );
});

// 拦截网络请求
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // 仅处理 GET 请求，且协议为 http 或 https
  if (event.request.method !== 'GET' || !requestUrl.protocol.startsWith('http')) {
    return; // 非 GET 请求或非 HTTP/HTTPS 请求，直接由浏览器处理
  }

  // 对于同源请求（或我们明确要缓存的 CDN 请求），采用 Cache First 策略
  // 注意：对于跨域请求（如 CDN），需要确保服务器设置了正确的 CORS 头
  // 否则 fetch 可能会失败，或者得到不透明响应 (Opaque Response) 而无法判断是否成功。
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // 如果在缓存中找到匹配的响应
        if (response) {
          // console.log(`[Service Worker] Serving from cache: ${event.request.url}`);
          return response; // 直接返回缓存的响应
        }

        // 如果缓存中没有找到，则尝试从网络获取
        // console.log(`[Service Worker] Fetching from network: ${event.request.url}`);
        return fetch(event.request).then(
          (networkResponse) => {
            // 检查是否收到了有效的响应
            // 对于基本类型请求（同源），检查 response.ok
            // 对于跨域请求，如果得到不透明响应 (status=0, type='opaque')，我们无法检查其内容
            // 但仍然可以尝试缓存它。如果 CDN 配置了 CORS，则可以检查 response.ok
            if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
              // 克隆响应，因为响应体只能被读取一次
              const responseToCache = networkResponse.clone();

              // 尝试将网络响应添加到缓存中
              caches.open(CACHE_NAME)
                .then((cache) => {
                  // console.log(`[Service Worker] Caching new response: ${event.request.url}`);
                  cache.put(event.request, responseToCache);
                });
            } else if (!networkResponse) {
               console.error(`[Service Worker] Network fetch failed for: ${event.request.url}, received null/undefined response.`);
            } else {
               console.warn(`[Service Worker] Network fetch failed or received non-OK response for: ${event.request.url}, Status: ${networkResponse.status}`);
            }

            // 返回从网络获取的原始响应
            return networkResponse;
          }
        ).catch(error => {
          console.error(`[Service Worker] Fetch failed for: ${event.request.url}`, error);
          // 可选：在这里提供一个通用的离线回退页面或资源
          // return caches.match('/offline.html'); // 如果您有一个离线页面
          // 对于此应用，如果核心 JS/CSS 加载失败，页面可能无法正常工作，
          // 因此返回错误或不返回任何内容可能更合适。
        });
      })
  );
});