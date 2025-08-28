import './style.css';
import { connectWS, PeerManager } from './webrtc.js';
import { deviceId, deviceName, log } from './util.js';
import { setPassphrase } from './crypto.js';

const state = { peers: [], selectedFiles: [] };

const transferMap = new Map();
function transferKey(dir, name){ return `${dir}:${name}`; }
function ensureTransferCard(dir, name, size) {
  const key = transferKey(dir, name);
  if (transferMap.has(key)) return transferMap.get(key);
  const host = document.getElementById('transfers') || ensureContainers().transfers;
  const row = document.createElement('div');
  row.style.display='grid'; row.style.gridTemplateColumns='1fr 80px 1fr';
  row.style.alignItems='center'; row.style.gap='8px'; row.style.margin='6px 0';
  const title = document.createElement('div');
  title.textContent = `${dir==='send'?'Sending':'Receiving'}: ${name} ${(size? '('+ (size/1024/1024).toFixed(2) +' MB)':'')}`;
  const pct = document.createElement('div'); pct.style.textAlign='right'; pct.textContent = '0%';
  const bar = document.createElement('progress'); bar.max = 100; bar.value = 0;
  row.appendChild(title); row.appendChild(pct); row.appendChild(bar);
  host.appendChild(row);
  const rec = { row, bar, pct, title };
  transferMap.set(key, rec);
  return rec;
}
function updateTransfer(dir, name, sent, total) {
  const rec = ensureTransferCard(dir, name, total);
  const p = total ? Math.min(100, Math.round(sent/total*100)) : 0;
  rec.bar.value = p; rec.pct.textContent = p + '%';
}
function completeTransfer(dir, name) {
  const key = transferKey(dir, name); const rec = transferMap.get(key); if (!rec) return;
  rec.bar.value = 100; rec.pct.textContent = '100%';
  rec.title.textContent = rec.title.textContent.replace(/^(.+?):/, '$1 (Done):');
}

function $(id) { return document.getElementById(id); }
function domReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}
function ensureContainers() {
  let main = document.querySelector('main');
  if (!main) { main = document.createElement('main'); document.body.appendChild(main); }
  const need = (id, title) => {
    let el = $(id);
    if (!el) {
      const section = document.createElement('section');
      section.className = 'card';
      const h2 = document.createElement('h2'); h2.textContent = title;
      el = document.createElement('div'); el.id = id;
      section.appendChild(h2); section.appendChild(el);
      main.appendChild(section);
    }
    return el;
  };
  return {
    dropzone: $('dropzone') || need('dropzone', 'Drop files'),
    files: $('files') || need('files', 'Selected files'),
    devices: $('devices') || need('devices', 'Devices'),
    transfers: $('transfers') || need('transfers', 'Transfers'),
    activity: $('activity') || need('activity', 'Activity'),
  };
}

function ensureModal() {
  let root = $('modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    root.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);z-index:9999;';
    root.innerHTML = `
      <div id="modal-card" style="max-width:520px;width:92%;background:#fff;color:#000;border-radius:14px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);">
        <div id="modal-title" style="font-weight:600;font-size:18px;margin-bottom:8px;">Incoming transfer</div>
        <div id="modal-body" style="font-size:14px;margin-bottom:12px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="modal-decline" style="padding:10px 14px;border-radius:12px;background:#ef4444;color:#fff;border:none;cursor:pointer;">Decline</button>
          <button id="modal-accept" style="padding:10px 14px;border-radius:12px;background:#10b981;color:#fff;border:none;cursor:pointer;">Accept</button>
        </div>
      </div>`;
    document.body.appendChild(root);
  }
  ['modal-title','modal-body','modal-accept','modal-decline'].forEach(id=>{
    if (!$(id)) {
      root.innerHTML = `
        <div id="modal-card" style="max-width:520px;width:92%;background:#fff;color:#000;border-radius:14px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);">
          <div id="modal-title" style="font-weight:600;font-size:18px;margin-bottom:8px;">Incoming transfer</div>
          <div id="modal-body" style="font-size:14px;margin-bottom:12px;"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="modal-decline" style="padding:10px 14px;border-radius:12px;background:#ef4444;color:#fff;border:none;cursor:pointer;">Decline</button>
            <button id="modal-accept" style="padding:10px 14px;border-radius:12px;background:#10b981;color:#fff;border:none;cursor:pointer;">Accept</button>
          </div>
        </div>`;
    }
  });
  return root;
}
function showModal({ title, html }) {
  const root = ensureModal();
  $('modal-title').textContent = title || 'Notice';
  $('modal-body').innerHTML = html || '';
  root.style.display = 'flex';
}
function hideModal() { const root = $('modal-root'); if (root) root.style.display = 'none'; }
function confirmModal({ title, html, acceptText='Accept', declineText='Decline' }) {
  ensureModal();
  return new Promise((resolve) => {
    showModal({ title, html });
    const acceptBtn = $('modal-accept');
    const declineBtn = $('modal-decline');
    function cleanup(){ acceptBtn.removeEventListener('click', onAccept); declineBtn.removeEventListener('click', onDecline); declineBtn.style.display=''; hideModal(); }
    function onAccept(){ cleanup(); resolve(true); }
    function onDecline(){ cleanup(); resolve(false); }
    acceptBtn.textContent = acceptText; declineBtn.textContent = declineText;
    acceptBtn.addEventListener('click', onAccept); declineBtn.addEventListener('click', onDecline);
  });
}
function toast(msg) {
  ensureModal();
  return new Promise((resolve)=> {
    const html = `<div style="margin:8px 0;">${msg}</div>`;
    showModal({ title: 'Mayadrop', html });
    const okBtn = $('modal-accept');
    const cancelBtn = $('modal-decline');
    cancelBtn.style.display = 'none';
    okBtn.textContent = 'OK';
    const onOk = () => { okBtn.removeEventListener('click', onOk); cancelBtn.style.display=''; hideModal(); resolve(); };
    okBtn.addEventListener('click', onOk);
  });
}
document.addEventListener('DOMContentLoaded', ensureModal);

function renderPeers(ui, peers, selfId) {
  const { devices } = ensureContainers();
  const box = devices;
  box.innerHTML = '';

  // Header/status
  const status = document.createElement('div');
  status.className = 'text-xs text-gray-500 mb-2';
  status.textContent = `Connected room: ${ui.room} • Devices online: ${Math.max(0, peers.length - 1)}`;
  box.appendChild(status);

  const others = peers.filter(p => p.id !== selfId);
  if (others.length === 0) {
    const info = document.createElement('div');
    info.className = 'text-sm text-gray-500';
    info.innerHTML = 'No other devices yet. Open Mayadrop on another device <em>with the same room name</em>.';
    box.appendChild(info);
    return;
  }

  others.forEach(p => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between p-3 rounded-lg border border-sky-200 bg-white';

    const left = document.createElement('div');
    left.className = 'font-medium';
    left.textContent = p.name + (ui.selectedPeerId === p.id ? ' (selected)' : '');

    const right = document.createElement('div');
    right.className = 'flex items-center gap-2';

    const selectBtn = document.createElement('button');
    selectBtn.className = 'px-3 py-1 rounded bg-sky-500 text-white hover:bg-sky-600';
    selectBtn.textContent = 'Select';
    selectBtn.onclick = (ev) => {
      ev.stopPropagation();
      ui.selectedPeerId = p.id;
      renderPeers(ui, peers, selfId);
      log(`Selected device: ${p.name}`);
    };

    const sendBtn = document.createElement('button');
    sendBtn.className = 'px-3 py-1 rounded bg-sky-500 text-white hover:bg-sky-600';
    sendBtn.textContent = 'Send';
    sendBtn.onclick = async (ev) => {
      ev.stopPropagation();
      ui.selectedPeerId = p.id;
      renderPeers(ui, peers, selfId);
      if (!state.selectedFiles.length) { return toast('Choose at least one file to send.'); }
      await startSendFlowForPeer(ui, p.id);
    };

    right.appendChild(selectBtn);
    right.appendChild(sendBtn);
    row.appendChild(left);
    row.appendChild(right);
    box.appendChild(row);
  });
}

async function requestReceiverConsent(ws, ui, targetId, files) {
  const filesMeta = files.map(f => ({ name: f.name, size: f.size, type: f.type }));
  ws.send(JSON.stringify({ type:'transfer-offer', to: targetId, from: ui.selfId, files: filesMeta, senderName: deviceName() }));
  return new Promise((resolve) => {
    const handler = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'transfer-response' && data.from === targetId) {
          ws.removeEventListener('message', handler);
          resolve(!!data.accepted);
        }
      } catch {}
    };
    ws.addEventListener('message', handler);
    setTimeout(() => { ws.removeEventListener('message', handler); resolve(false); }, 15000);
  });
}

async function startSendFlowForPeer(ui, peerId) {
  if (!ui?.selectedPeerId) { ui.selectedPeerId = peerId; }
  if (!state.selectedFiles.length) { return toast('Choose at least one file to send.'); }
  const accepted = await requestReceiverConsent(ui.ws, ui, peerId, state.selectedFiles);
  if (!accepted) { await toast('Receiver declined the transfer.'); return; }
  try {
    if (!ui.pm.connectedTo || ui.pm.connectedTo !== peerId || !ui.pm.isDCOpen()) {
      ui.pm.connectTo(peerId);
      await ui.pm.waitForDCOpen(12000);
    }
    await ui.pm.sendFiles(state.selectedFiles);
  } catch (err) {
    log(`P2P failed (${err?.message || err}). Falling back to relay if enabled.`);
    ui.pm.connectedTo = peerId;
    await ui.pm.sendFiles(state.selectedFiles);
  }
}

class UI {
  constructor(ws) {
    this.ws = ws; this.pm = new PeerManager(ws, this);
    this.selfId = deviceId();
    this.room = localStorage.getItem('mayadrop:room') || 'public';
    this.passphrase=''; this.selectedPeerId = null;
    this.currentReceivingName = null; this.currentReceivingTotal = 0;
    this._setup();
  }
  _setup() {
    const c = ensureContainers();
    if ($('name')) $('name').value = deviceName();
    if ($('saveName')) $('saveName').onclick = () => { const n=$('name').value.trim() || 'Anonymous'; localStorage.setItem('mayadrop:name', n); this.hello(); };

    if ($('room')) $('room').value = this.room === 'public' ? '' : this.room;
    if ($('joinRoom')) $('joinRoom').onclick = () => { const r=$('room').value.trim() || 'public'; this.room=r; localStorage.setItem('mayadrop:room', r); this.hello(); };

    if ($('savePass')) $('savePass').onclick = async () => {
      const pass=$('passphrase')?.value || '';
      await setPassphrase(pass);
      this.hello();
      log(pass ? 'Passphrase set for this session.' : 'Passphrase cleared.');
    };

    const dz = c.dropzone;
    dz.addEventListener('click', () => {
      const picker = document.createElement('input'); picker.type='file'; picker.multiple=true;
      picker.style.position='fixed'; picker.style.left='-9999px'; picker.style.opacity='0';
      document.body.appendChild(picker);
      picker.addEventListener('change', (e) => {
        const files = Array.from(e.target.files||[]);
        state.selectedFiles = files; renderFiles(files);
        document.body.removeChild(picker);
        log(`Selected ${files.length} file(s) via picker.`);
      }, { once:true });
      picker.click();
    });

    ['dragenter','dragover','dragleave','drop'].forEach(evt => {
      dz.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); });
    });
    dz.addEventListener('dragover', () => { dz.style.background='rgba(14,165,233,0.1)'; });
    dz.addEventListener('dragleave', () => { dz.style.background=''; });
    dz.addEventListener('drop', (e) => {
      dz.style.background='';
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) { log('Drop contained no files (maybe text/link)'); return; }
      state.selectedFiles = files; renderFiles(files); log(`Dropped ${files.length} file(s).`);
    });

    dz.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const files = items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (files.length) { state.selectedFiles = files; renderFiles(files); log(`Pasted ${files.length} file(s).`); }
    });
  }
  hello(){ this.ws.send(JSON.stringify({ type:'hello', id:this.selfId, name:deviceName(), room:this.room })); }

  updateSendProgress(sent, total, name){
    updateTransfer('send', name, sent, total);
    const pct = total ? Math.round(sent/total*100) : 0;
    log(`Sending ${name}: ${pct}%`);
  }
  onSendStart(name, size){ ensureTransferCard('send', name, size); }
  onSendComplete(name){ completeTransfer('send', name); }

  updateReceiveProgress(have, total){
    if (this.currentReceivingName) updateTransfer('recv', this.currentReceivingName, have, total);
    const pct = total ? Math.round(have/total*100) : 0;
    log(`Receiving: ${pct}%`);
  }
  onReceiveStart(meta){
    this.currentReceivingName = meta?.name || 'download.bin';
    this.currentReceivingTotal = meta?.size || 0;
    ensureTransferCard('recv', this.currentReceivingName, this.currentReceivingTotal);
  }
  onReceiveComplete(name){
    completeTransfer('recv', name || this.currentReceivingName || 'download.bin');
    this.currentReceivingName = null; this.currentReceivingTotal = 0;
  }
}

function renderFiles(files) {
  const { files: box } = ensureContainers();
  box.innerHTML='';
  if (!files.length) { box.innerHTML = '<div class="muted">No files selected.</div>'; return; }
  files.forEach(f => {
    const row=document.createElement('div'); row.style.display='flex'; row.style.alignItems='center'; row.style.gap='8px';
    row.textContent = `${f.name} (${(f.size/1024/1024).toFixed(2)} MB)`;
    box.appendChild(row);
  });
}

function ensureUI(ws) {
  if (!window.__ui) {
    domReady(() => {
      if (!window.__ui) {
        window.__ui = new UI(ws);
        window.__ui.hello();
      }
    });
  }
}

const ws = connectWS(async (data, ws) => {
  ensureUI(ws);
  const ui = window.__ui;
  if (!ui) return;

  if (data.type === 'peers') {
    state.peers = data.peers;
    renderPeers(ui, state.peers, ui.selfId);
  } else if (data.type === 'signal') {
    const { from, payload } = data;
    if (payload.type === 'offer') { await ui.pm.onOffer(from, payload); }
    else if (payload.type === 'answer') { await ui.pm.onAnswer(payload); }
    else if (payload.type === 'ice') { await ui.pm.onIce(payload); }
  } else if (data.type === 'transfer-offer') {
    const sender = data.senderName || 'Someone';
    const list = (data.files || []).map(f => `<li>${f.name} (${(f.size/1024/1024).toFixed(2)} MB)</li>`).join('');
    const html = `<div><strong>${sender}</strong> wants to send you:</div><ul style="margin:8px 0 12px 18px;">${list || '<li>(no files listed)</li>'}</ul>`;
    const ok = await confirmModal({ title: 'Incoming transfer', html, acceptText:'Receive', declineText:'Decline' });
    ui.ws.send(JSON.stringify({ type:'transfer-response', to:data.from, from:ui.selfId, accepted:ok }));
    if (!ok) { log('You declined the incoming transfer.'); }
    else { log(`You accepted the transfer from ${sender}. Auto-downloading when data arrives…`); }
  } else if (data.type === 'transfer-response') {
    // handled by promise in requestReceiverConsent
  } else if (data.type === 'relay-chunk') {
    ui.pm.relayMode = true; ui.pm.connectedTo = data.from; ui.pm.handleRelayMessage(data);
  }
}, (ws) => {
  ensureUI(ws);
});

window.addEventListener('keydown', async (e) => {
  if (!(e instanceof KeyboardEvent)) return;
  const key = (typeof e.key === 'string') ? e.key.toLowerCase() : '';
  if (key !== 's') return;
  if (!(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  const ui = window.__ui;
  if (!ui?.selectedPeerId) { await toast('Select a device first from the list.'); return; }
  if (!state.selectedFiles.length) { await toast('Choose at least one file to send.'); return; }
  await startSendFlowForPeer(ui, ui.selectedPeerId);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/public_sw.js').catch(()=>{});
}
