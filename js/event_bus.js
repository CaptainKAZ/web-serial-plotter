// js/event_bus.js
/**
 * 简单的全局事件总线 (基于 EventTarget)
 * 用于模块间解耦通信。
 *
 * 使用方法:
 * import { eventBus } from './event_bus.js';
 *
 * // 触发事件
 * eventBus.emit('some-event', { detail: 'some data' });
 *
 * // 监听事件
 * eventBus.on('some-event', (event) => {
 * console.log('Event received:', event.detail);
 * });
 *
 * // 移除监听
 * // eventBus.off('some-event', listenerFunction);
 */
class EventBus extends EventTarget {
  on(eventName, listener) {
    this.addEventListener(eventName, listener);
  }

  off(eventName, listener) {
    this.removeEventListener(eventName, listener);
  }

  emit(eventName, detail) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));
  }
}

export const eventBus = new EventBus();
console.log("EventBus initialized.");
