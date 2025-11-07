/* Face Replacement Demo — main.js (globals build)
   Loads FaceMesh and Camera from <script> tags in index.html
*/

(() => {
  const els = {
    video: document.getElementById('cam'),
    canvas: document.getElementById('preview'),
    startBtn: document.getElementById('startBtn'),
    captureBtn: document.getElementById('captureBtn'),
    saveBtn: document.getElementById('saveBtn'),
    resetBtn: document.getElementById('resetBtn'),
    banner: document.getElementById('banner'),
  };
  const ctx = els.canvas.getContext('2d', { alpha: true });

  // Assets & metadata
  const META_URL = './assets/slot.json';
  const baseImg = new Image();
  baseImg.src = './assets/character_base.png'; // should be same aspect as meta.preview
  const maskImg = new Image();
  maskImg.src = './assets/mask_oval.png';

  const state = {
    meta: null,
    faceMesh: null,
    camera: null,
    running: false,
    capturedUrl: null,
  };

  // ---------- Layout / sizing ----------
  function fitPreviewCanvas() {
    const cssW = Math.min(window.innerWidth, 1024);
    const aspect = state?.meta?.preview
      ? state.meta.preview.height / state.meta.preview.width
      : (960 / 720);
    const maxH = Math.max(200, window.innerHeight - 32 - 78 - 16);
    const cssH = Math.min(Math.round(cssW * aspect), maxH);

    els.canvas.style.width = cssW + 'px';
    els.canvas.style.height = 'auto';
    els.canvas.width  = cssW;
    els.canvas.height = cssH;
  }
  window.addEventListener('resize', fitPreviewCanvas);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fitPreviewCanvas(); });

  // Scale a point from meta.image_size space to current canvas space
  function scalePt([x, y]) {
    const [iw, ih] = state.meta.image_size;
    const sx = els.canvas.width  / iw;
    const sy = els.canvas.height / ih;
    return [x * sx, y * sy];
  }

  // ---------- Helpers ----------
  async function loadMeta(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Failed to load character metadata');
    return res.json();
  }

  function waitImage(img) {
    return new Promise((resolve, reject) => {
      if (img.complete) return resolve();
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image failed to load: ' + img.src));
    });
  }

  async function exportPNG() {
    return new Promise((resolve) => {
      els.canvas.toBlob((blob) => resolve(blob), 'image/png', 0.92);
    });
  }

  // ---------- FaceMesh ----------
  async function initFaceMesh() {
    return new Promise((resolve) => {
      const fm = new FaceMesh({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      fm.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      fm.onResults((results) => {
        if (!state.running) return;
        drawComposite(results);
      });
      state.faceMesh = fm;
      resolve();
    });
  }

  function pickKeypoints(lm, vw, vh) {
    // FaceMesh landmark indices
    const L = 33, R = 263, C = 152; // left eye outer, right eye outer, chin approx
    const eyeL = [lm[L].x * vw, lm[L].y * vh];
    const eyeR = [lm[R].x * vw, lm[R].y * vh];
    const chin = [lm[C].x * vw, lm[C].y * vh];
    return { eyeL, eyeR, chin };
  }

  // ---------- Drawing ----------
  function drawSlotGuide() {
    if (!state?.meta) return;
    const dstL = scalePt(state.meta.slot.eye_left);
    const dstR = scalePt(state.meta.slot.eye_right);
    const midX = (dstL[0] + dstR[0]) / 2;
    const midY = (dstL[1] + dstR[1]) / 2;

    const rx = Math.hypot(dstR[0] - dstL[0], dstR[1] - dstL[1]) * 0.75; // ellipse radii
    const ry = rx * 1.2;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(midX, midY + ry * 0.1, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawComposite(results) {
    const { multiFaceLandmarks } = results || {};

    // Clear and draw character base
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    if (baseImg.complete) {
      ctx.drawImage(baseImg, 0, 0, els.canvas.width, els.canvas.height);
    }

    // Guide
    drawSlotGuide();

    if (!multiFaceLandmarks || multiFaceLandmarks.length === 0) return;

    const lm = multiFaceLandmarks[0];
    const vw = els.video.videoWidth  || 640;
    const vh = els.video.videoHeight || 480;

    const src = pickKeypoints(lm, vw, vh);

    // Destination anchors in canvas space
    const dstL = scalePt(state.meta.slot.eye_left);
    const dstR = scalePt(state.meta.slot.eye_right);
    const dMid = [(dstL[0] + dstR[0]) / 2, (dstL[1] + dstR[1]) / 2];

    // Source eye vector
    const sdx = src.eyeR[0] - src.eyeL[0];
    const sdy = src.eyeR[1] - src.eyeL[1];

    // Destination eye vector
    const ddx = dstR[0] - dstL[0];
    const ddy = dstR[1] - dstL[1];

    // Rotation and scale
    const angle = Math.atan2(ddy, ddx) - Math.atan2(sdy, sdx);
    const sDist = Math.hypot(sdx, sdy) || 1;
    const dDist = Math.hypot(ddx, ddy) || 1;
    const scale = dDist / sDist;

    // Source ROI around mid-eyes
    const sMid = [(src.eyeL[0] + src.eyeR[0]) / 2, (src.eyeL[1] + src.eyeR[1]) / 2];
    const roiScale = state.meta.slot.roi_scale || 1.5;
    const roiSize = Math.max(64, (Math.hypot(sdx, sdy) * roiScale));

    const off = document.createElement('canvas');
    const offCtx = off.getContext('2d');
    off.width = roiSize;
    off.height = roiSize;

    const sx = sMid[0] - roiSize / 2;
    const sy = sMid[1] - roiSize / 2;
    offCtx.drawImage(els.video, sx, sy, roiSize, roiSize, 0, 0, roiSize, roiSize);

    // Place ROI onto preview at destination
    ctx.save();
    ctx.translate(dMid[0], dMid[1]);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    ctx.translate(-roiSize / 2, -roiSize / 2);
    ctx.drawImage(off, 0, 0, roiSize, roiSize);

    if (maskImg.complete) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(maskImg, 0, 0, roiSize, roiSize);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  // ---------- Camera start ----------
  async function startCamera() {
    await Promise.all([waitImage(baseImg), waitImage(maskImg)]);
    fitPreviewCanvas();

    if (typeof Camera !== 'undefined') {
      state.camera = new Camera(els.video, {
        onFrame: async () => { if (state.running) await state.faceMesh.send({ image: els.video }); },
        width: 640,
        height: 480,
        facingMode: 'user',
      });
      await state.camera.start();
      return;
    }

    // Fallback
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' }, audio: false
    });
    els.video.srcObject = stream;
    els.video.setAttribute('playsinline', 'true');
    await els.video.play();

    const loop = async () => {
      if (!state.running) return;
      await state.faceMesh.send({ image: els.video });
      (els.video.requestVideoFrameCallback
        ? els.video.requestVideoFrameCallback(loop)
        : requestAnimationFrame(loop));
    };
    loop();
  }

  // ---------- UI ----------
  els.startBtn.addEventListener('click', async () => {
    try {
      els.startBtn.disabled = true;
      els.banner.textContent = 'Initializing… grant camera permission if prompted.';

      // Secure-context guard
      if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.protocol === 'file:')) {
        throw new Error('Page must be served over HTTPS / localhost / file://');
      }

      if (!state.meta) state.meta = await loadMeta(META_URL);
      if (!state.faceMesh) await initFaceMesh();

      state.running = true;
      await startCamera();

      els.captureBtn.disabled = false;
      els.resetBtn.disabled = false;
      els.banner.textContent = 'Align your face with the guide area.';
    } catch (err) {
      console.error(err);
      els.banner.textContent = 'Error: ' + err.message;
      els.startBtn.disabled = false;
    }
  });

  els.captureBtn.addEventListener('click', () => {
    els.saveBtn.disabled = false;
    els.banner.textContent = 'Captured. Tap Save to download.';
  });

  els.saveBtn.addEventListener('click', async () => {
    try {
      const blob = await exportPNG();
      if (!blob) return;

      if (state.capturedUrl) URL.revokeObjectURL(state.capturedUrl);
      state.capturedUrl = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = state.capturedUrl;
      a.download = 'face-replacement.png';
      document.body.appendChild(a);
