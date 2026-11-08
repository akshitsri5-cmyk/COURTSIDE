import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraManager } from '../../public/js/app/camera-manager.js';

function harness() {
  const originalDocument = globalThis.document;
  const originalRTC = globalThis.RTCPeerConnection;
  const peers = [];
  globalThis.document = { createElement: () => ({ muted: false, playsInline: false, autoplay: false, play: async () => {} }) };
  class FakePeer {
    constructor() { this.remoteDescription = null; this.localDescription = null; this.ice = []; this.connectionState = 'new'; peers.push(this); }
    addTrack() {}
    async setRemoteDescription(sdp) { this.remoteDescription = sdp; }
    async addIceCandidate(candidate) { assert.ok(this.remoteDescription, 'candidate before remote description'); this.ice.push(candidate); }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(sdp) { this.localDescription = sdp; }
    close() { this.connectionState = 'closed'; }
  }
  globalThis.RTCPeerConnection = FakePeer;
  const sent = [], mgr = new CameraManager({ send: x => sent.push(x) }, []);
  return { mgr, sent, peers, restore: () => { globalThis.document = originalDocument; globalThis.RTCPeerConnection = originalRTC; } };
}

test('ICE before offer is buffered, a camera is created from the offer, and the answer echoes its offer ID', async () => {
  const h = harness();
  try {
    const added = []; h.mgr.on(e => { if (e.type === 'added') added.push(e.cam.id); });
    await h.mgr.onSignal({ from: 'cam1', data: { candidate: { candidate: 'ice-a' }, offerId: 'offer-1' } });
    assert.deepEqual(added, ['cam1']);
    await h.mgr.onSignal({ from: 'cam1', data: { sdp: { type: 'offer', sdp: 'a' }, offerId: 'offer-1' } });
    assert.equal(h.peers[0].ice.length, 1);
    assert.equal(h.sent[0].data.offerId, 'offer-1');
    assert.equal(h.sent[0].data.sdp.type, 'answer');
  } finally { h.restore(); }
});

test('new offer supersedes old peer; late ICE for the old offer is ignored', async () => {
  const h = harness();
  try {
    await h.mgr.onSignal({ from: 'cam1', data: { sdp: { type: 'offer', sdp: 'a' }, offerId: 'a' } });
    const first = h.peers[0];
    await h.mgr.onSignal({ from: 'cam1', data: { sdp: { type: 'offer', sdp: 'b' }, offerId: 'b' } });
    const second = h.peers[1];
    assert.equal(first.connectionState, 'closed');
    await h.mgr.onSignal({ from: 'cam1', data: { candidate: { candidate: 'stale' }, offerId: 'a' } });
    await h.mgr.onSignal({ from: 'cam1', data: { candidate: { candidate: 'fresh' }, offerId: 'b' } });
    assert.deepEqual(second.ice.map(x => x.candidate), ['fresh']);
  } finally { h.restore(); }
});
