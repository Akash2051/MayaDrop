import { RTC_CONFIG, CHUNK_SIZE, MAX_INFLIGHT, RELAY_FALLBACK, getWsUrl } from './config.js';
import { log, humanSize, deviceId } from './util.js';
import { encryptChunk, decryptChunk, getSalt, hasAppKey, setSalt, setPassphrase } from './crypto.js';

async function* readBlobChunks(blob, chunkSize) {
  let offset = 0;
  while (offset < blob.size) {
    const slice = blob.slice(offset, Math.min(offset + chunkSize, blob.size));
    const buf = await new Response(slice).arrayBuffer();
    yield new Uint8Array(buf);
    offset += chunkSize;
    await new Promise(r => setTimeout(r, 0));
  }
}

function makeAdaptiveSizer(base = 128 * 1024, max = 512 * 1024) {
  let size = base;
  let lastAdj = performance.now();
  return {
    next(dcOrWs) {
      const now = performance.now();
      const buffered = dcOrWs?.bufferedAmount || 0;
      if (buffered < 1 * 1024 * 1024 && now - lastAdj > 300) {
        size = Math.min(max, size * 2);
        lastAdj = now;
      } else if (buffered > 8 * 1024 * 1024) {
        size = Math.max(32 * 1024, Math.floor(size / 2));
        lastAdj = now;
      }
      return size;
    }
  };
}

async function startFileSink(meta) {
  if (window.showSaveFilePicker) {
    const handle = await showSaveFilePicker({
      suggestedName: meta?.name || 'download.bin',
      types: [{ description: 'File', accept: { [meta?.type || 'application/octet-stream']: ['.' + (meta?.name?.split('.').pop() || 'bin')] } }]
    });
    const stream = await handle.createWritable();
    return { write: (chunk) => stream.write(chunk), close: () => stream.close() };
  }

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    const token = Math.random().toString(36).slice(2);
    navigator.serviceWorker.controller.postMessage({ type: 'stream-open', token });
    const url = `/stream/${token}?name=${encodeURIComponent(meta?.name || 'download.bin')}&type=${encodeURIComponent(meta?.type || 'application/octet-stream')}`;
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    document.body.appendChild(iframe);

    return {
      write: (chunk) => {
        const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        navigator.serviceWorker.controller.postMessage({ type: 'stream-chunk', token, chunk: buf }, [buf]);
      },
      close: () => {
        navigator.serviceWorker.controller.postMessage({ type: 'stream-close', token });
        setTimeout(() => { try { document.body.removeChild(iframe); } catch {} }, 2000);
      }
    };
  }

  const buffers = [];
  return {
    write: (chunk) => buffers.push(chunk),
    close: () => {
      const blob = new Blob(buffers, { type: meta?.type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = meta?.name || 'download.bin'; a.click();
      URL.revokeObjectURL(url);
    }
  };
}

export class PeerManager {
  constructor(ws, ui) {
    this.ws = ws; this.ui = ui;
    this.pc = null; this.dc = null;
    this.connectedTo = null;
    this.relayMode = false;
    this.fileSink = null;
    this.fileMeta = null;
    this.receivedBytes = 0;
  }

  _makePC() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        this.ws.send(JSON.stringify({ type:'signal', to:this.connectedTo, from:deviceId(), payload:{ type:'ice', candidate:e.candidate } }));
      }
    });
    pc.addEventListener('connectionstatechange', () => log(`Peer connection state: ${pc.connectionState}`));
    return pc;
  }

  async connectTo(peerId) {
    this.connectedTo = peerId; this.relayMode = false; this.pc = this._makePC();
    this.dc = this.pc.createDataChannel('file', { ordered: true }); this._attachDC();
    const offer = await this.pc.createOffer(); await this.pc.setLocalDescription(offer);
    this.ws.send(JSON.stringify({ type:'signal', to:peerId, from:deviceId(), payload:{ type:'offer', sdp:offer.sdp, salt: hasAppKey()? Array.from(getSalt()||[]) : null } }));
  }

  async onOffer(from, payload) {
    this.connectedTo = from; this.relayMode = false; this.pc = this._makePC();
    this.pc.addEventListener('datachannel', (e) => { this.dc = e.channel; this._attachDC(); });
    if (payload.salt && window.__MAYADROP_TMP_PASSPHRASE__) {
      setSalt(payload.salt);
      await setPassphrase(window.__MAYADROP_TMP_PASSPHRASE__, payload.salt);
    }
    await this.pc.setRemoteDescription({ type:'offer', sdp: payload.sdp });
    const answer = await this.pc.createAnswer(); await this.pc.setLocalDescription(answer);
    this.ws.send(JSON.stringify({ type:'signal', to:from, from:deviceId(), payload:{ type:'answer', sdp:answer.sdp, salt: payload.salt || null } }));
  }

  async onAnswer(payload){
    if (payload.salt && window.__MAYADROP_TMP_PASSPHRASE__) {
      setSalt(payload.salt);
      await setPassphrase(window.__MAYADROP_TMP_PASSPHRASE__, payload.salt);
    }
    await this.pc.setRemoteDescription({ type:'answer', sdp:payload.sdp });
  }

  async onIce(payload){ try { await this.pc.addIceCandidate(payload.candidate); } catch(e){ console.warn(e); } }

  _attachDC(){
    this.dc.binaryType='arraybuffer';
    this.dc.onopen=()=>log('DataChannel open');
    this.dc.onclose=()=>log('DataChannel closed');
    this.dc.onmessage=async(e)=>{
      const msg=e.data;
      if(typeof msg==='string'){
        const obj=JSON.parse(msg);
        if(obj.type==='file-meta'){
          this.fileMeta=obj.meta; this.receivedBytes=0;
          this.fileSink = await startFileSink(this.fileMeta);
          if(this.ui?.onReceiveStart) this.ui.onReceiveStart(this.fileMeta);
          log(`Incoming file: ${this.fileMeta.name} (${humanSize(this.fileMeta.size)})`);
        }
        else if(obj.type==='eof'){
          await this.fileSink?.close();
          log(`Received file: ${this.fileMeta?.name} (${humanSize(this.receivedBytes)}) ✅`);
          if(this.ui?.onReceiveComplete) this.ui.onReceiveComplete(this.fileMeta?.name||'');
        }
        return;
      }
      const view=new DataView(msg);
      const ivLen=view.getUint8(4);
      let offset=5;
      let iv=null; if(ivLen>0){ iv=new Uint8Array(msg.slice(offset,offset+ivLen)); offset+=ivLen; }
      const cipher=new Uint8Array(msg.slice(offset));
      const plain=await decryptChunk(cipher,iv);
      await this.fileSink?.write(plain);
      this.receivedBytes+=plain.byteLength;
      this.ui.updateReceiveProgress(this.receivedBytes, this.fileMeta?.size||0);
    };
  }

  isDCOpen(){ return this.dc && this.dc.readyState==='open'; }
  waitForDCOpen(timeoutMs=12000){ if(this.isDCOpen()) return Promise.resolve(); return new Promise((resolve,reject)=>{ const t=setTimeout(()=>reject(new Error('DataChannel open timeout')),timeoutMs); const onOpen=()=>{clearTimeout(t); this.dc.removeEventListener('open', onOpen); resolve();}; if(this.dc) this.dc.addEventListener('open', onOpen); else reject(new Error('DataChannel not created')); }); }

  async sendFiles(files){
    if(!files?.length) return;
    if(this.dc && this.dc.readyState==='open'){ for(const f of files) await this._sendOneFile(f); return; }
    if(!this.relayMode && RELAY_FALLBACK){ log('P2P not ready; falling back to WebSocket relay.'); this.relayMode=true; for(const f of files) await this._sendOneFileRelay(f); return; }
    log('No connection available.');
  }

  async _sendOneFile(file){
    if(this.ui?.onSendStart) this.ui.onSendStart(file.name, file.size);
    this.dc.send(JSON.stringify({ type:'file-meta', meta:{ name:file.name, size:file.size, type:file.type } }));

    let seq=0, sent=0;
    const sizer = makeAdaptiveSizer(128*1024, 512*1024);

    for await (const plainChunk of readBlobChunks(file, sizer.next(this.dc))) {
      const {cipher, iv}=await encryptChunk(plainChunk);
      const ivLen=iv?iv.byteLength:0;
      const buf=new ArrayBuffer(4+1+ivLen+cipher.byteLength);
      const view=new DataView(buf);
      view.setUint32(0, seq, true);
      view.setUint8(4, ivLen);
      const u8=new Uint8Array(buf);
      let p=5; if(ivLen){ u8.set(iv,p); p+=ivLen;} u8.set(cipher,p);

      while(this.dc.bufferedAmount>16*1024*1024){ await new Promise(r=>setTimeout(r,20)); }
      this.dc.send(buf);

      sent+=plainChunk.byteLength; seq+=1;
      this.ui.updateSendProgress(sent, file.size, file.name);
    }

    this.dc.send(JSON.stringify({ type:'eof' }));
    log(`Sent file: ${file.name} (${humanSize(file.size)}) ✅`);
    if(this.ui?.onSendComplete) this.ui.onSendComplete(file.name);
  }

  async _sendOneFileRelay(file){
    if(this.ui?.onSendStart) this.ui.onSendStart(file.name, file.size);
    const meta={ name:file.name, size:file.size, type:file.type };
    this.ws.send(JSON.stringify({ type:'relay-chunk', to:this.connectedTo, from:deviceId(), done:false, fileMeta:meta }));

    let seq=0, sent=0;
    const sizer = makeAdaptiveSizer(64*1024, 256*1024);

    for await (const plainChunk of readBlobChunks(file, sizer.next(this.ws))) {
      const {cipher, iv}=await encryptChunk(plainChunk);
      const ivLen=iv?iv.byteLength:0;
      const buf=new ArrayBuffer(1+4+1+ivLen+cipher.byteLength);
      const view=new DataView(buf);
      let o=0;
      view.setUint8(o, 1); o+=1; // kind=1 (binary relay chunk)
      view.setUint32(o, seq, true); o+=4;
      view.setUint8(o, ivLen); o+=1;
      const u8=new Uint8Array(buf);
      if(ivLen){ u8.set(iv,o); o+=ivLen; }
      u8.set(cipher,o);

      while(this.ws.bufferedAmount>8*1024*1024){ await new Promise(r=>setTimeout(r,10)); }
      this.ws.send(buf);

      sent+=plainChunk.byteLength; seq+=1;
      this.ui.updateSendProgress(sent, file.size, file.name);
    }

    this.ws.send(JSON.stringify({ type:'relay-chunk', to:this.connectedTo, from:deviceId(), done:true }));
    log(`Sent (relay): ${file.name} (${humanSize(file.size)}) ✅`);
    if(this.ui?.onSendComplete) this.ui.onSendComplete(file.name);
  }

  handleRelayMessage(msg){
    if(msg.fileMeta){
      this.fileMeta=msg.fileMeta; this.receivedBytes=0;
      startFileSink(this.fileMeta).then(sink => { this.fileSink = sink; });
      if(this.ui?.onReceiveStart) this.ui.onReceiveStart(this.fileMeta);
      log(`Incoming file (relay): ${this.fileMeta.name} (${humanSize(this.fileMeta.size)})`);
      return;
    }
    if(msg.done){
      (async ()=>{ await this.fileSink?.close(); })();
      log(`Received (relay): ${this.fileMeta?.name} (${humanSize(this.receivedBytes)}) ✅`);
      if(this.ui?.onReceiveComplete) this.ui.onReceiveComplete(this.fileMeta?.name||'');
      return;
    }
  }

  handleRelayBinaryChunk({ seq, iv, cipher }){
    decryptChunk(cipher, iv).then(async (plain)=>{
      await this.fileSink?.write(plain);
      this.receivedBytes += plain.byteLength;
      this.ui.updateReceiveProgress(this.receivedBytes, this.fileMeta?.size || 0);
    });
  }
}

export function connectWS(onMessage, onOpen){
  const url=getWsUrl();
  const ws=new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', ()=>{ log(`WS connected: ${url}`); if(typeof onOpen==='function') onOpen(ws); });
  ws.addEventListener('close', ()=>log('WS disconnected'));
  ws.addEventListener('message', (e)=>{
    if (e.data instanceof ArrayBuffer) {
      const view = new DataView(e.data);
      let o=0;
      const kind = view.getUint8(o); o+=1;
      if (kind === 1) {
        const seq = view.getUint32(o, true); o+=4;
        const ivLen = view.getUint8(o); o+=1;
        let iv = null;
        if (ivLen){ iv = new Uint8Array(e.data.slice(o, o+ivLen)); o+=ivLen; }
        const cipher = new Uint8Array(e.data.slice(o));
        if (window.__ui) window.__ui.pm.handleRelayBinaryChunk({ seq, iv, cipher });
        return;
      }
    }
    try {
      const data=JSON.parse(e.data);
      onMessage(data, ws);
    } catch (err) {
      console.warn('WS message parse error', err);
    }
  });
  return ws;
}
