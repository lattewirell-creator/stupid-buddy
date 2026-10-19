/* The Stupid Buddy for Android: the Mac app's screens (ui/) talk to the phone through this bridge.
 * Loaded before ai.js. The phone has no Ollama, so Buddy's brain is an online AI with a free key. */
window.webkit = { messageHandlers: { buddy: { postMessage: (m) => StupidBuddyNative.post(JSON.stringify(m)) } } };
window.__platform = 'android';
document.documentElement.classList.add('android');
