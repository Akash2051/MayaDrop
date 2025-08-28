export const RELAY_FALLBACK = true;

export function getWsUrl() {
  const override = window.__WS_PUBLIC_URL__ || import.meta.env.VITE_WS_URL;
  if (override) return override;
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  if (import.meta?.env?.DEV) {
    return `${proto}://${loc.hostname}:3000/ws`;
  }
  return `${proto}://${loc.host}/ws`;
}

export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
  ]
};

export const CHUNK_SIZE = 128 * 1024;
export const MAX_INFLIGHT = 64;
