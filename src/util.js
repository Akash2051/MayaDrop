export function humanSize(bytes) {
  if (bytes === 0) return '0 B';
  const thresh = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(thresh));
  return (bytes / Math.pow(thresh, i)).toFixed(2) + ' ' + units[i];
}

export function deviceId() {
  let id = localStorage.getItem('mayadrop:deviceId');
  if (!id) {
    id = crypto.getRandomValues(new Uint32Array(4)).join('-');
    localStorage.setItem('mayadrop:deviceId', id);
  }
  return id;
}

export function deviceName() {
  return localStorage.getItem('mayadrop:name') || 'Anonymous';
}

export function log(msg) {
  const box = document.getElementById('activity');
  const ts = new Date().toLocaleTimeString();
  console.log(msg);
  if (box) {
    const line = document.createElement('div');
    line.textContent = `[${ts}] ${msg}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }
}
