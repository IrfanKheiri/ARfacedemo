/* Face Replacement Demo — main.js (globals build)
   Requires in index.html BEFORE this file:
     <script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js"></script>
     <script src="https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js"></script>
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
    fallback: document.getElementById('fallback'),
    openInBrowser: document.getElementById('openInBrowser'),
  };
  const ctx = els.canvas.getContext('2d', { alpha: true });

  const META_URL = './assets/slot.json';
  const baseImg = new Image(); baseImg.src = './assets/character_base.png';
  const maskImg = new Image(); maskImg.src = './assets/mask_oval.png';

  const state = {
    meta: null,
    faceMesh: null,
    camera: null,
    running: false,
    capturedUrl: null,
  };

  // ---------- Environment ----------
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (els.openInBrowser) {
    els.openInBrowser.addEventListener('click', () => {
      window.open(window.location.href, '_blank', 'noopener,noreferrer');
    });
  }

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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fitPreviewCanvas();
  });

  // Scale a meta point (image_size space) to current canvas space
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
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
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
    const L = 33, R = 263, C = 152; // outer eye corners + chin
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

    const rx = Math.hypot(dstR[0] - dstL[0], dstR[1] - dstL[1]) * 0.75;
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
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    if (baseImg.complete) ctx.drawImage(baseImg, 0, 0, els.canvas.width, els.canvas.height);
    drawSlotGuide();
    if (!multiFaceLandmarks || multiFaceLandmarks.length === 0) return;

    const lm = multiFaceLandmarks[0];
    const vw = els.video.videoWidth  || 640;
    const vh = els.video.videoHeight || 480;
    const src = pickKeypoints(lm, vw, vh);

    const dstL = scalePt(state.meta.slot.eye_left);
    const dstR = scalePt(state.meta.slot.eye_right);
    const dMid = [(dstL[0] + dstR[0]) / 2, (dstL[1] + dstR[1]) / 2];

    // Rotation + scale from eye vectors
    const sdx = src.eyeR[0] - src.eyeL[0];
    const sdy = src.eyeR[1] - src.eyeL[1];
    const ddx = dstR[0] - dstL[0];
    const ddy = dstR[1] - dstL[1];

    const angle = Math.atan2(ddy, ddx) - Math.atan2(sdy, sdx);
    const sDist = Math.hypot(sdx, sdy) || 1;
    const dDist = Math.hypot(ddx, ddy) || 1;
    const scale = dDist / sDist;

    // Source ROI around mid-eyes
    const sMid = [(src.eyeL[0] + src.eyeR[0]) / 2, (src.eyeL[1] + src.eyeR[1]) / 2];
    const roiScale = state.meta.slot.roi_scale || 1.5;
    const roiSize = Math.max(64, Math.hypot(sdx, sdy) * roiScale);

    // Extract ROI from video to offscreen
    const off = document.createElement('canvas');
    const offCtx = off.getContext('2d');
    off.width = roiSize;
    off.height = roiSize;

    const sx = sMid[0] - roiSize / 2;
    const sy = sMid[1] - roiSize / 2;
    offCtx.drawImage(els.video, sx, sy, roiSize, roiSize, 0, 0, roiSize, roiSize);

    // Place ROI onto preview
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

  // ---------- Camera start with fallbacks ----------
  let lastGumError = null;

  async function startCamera() {
    await Promise.all([waitImage(baseImg), waitImage(maskImg)]);
    fitPreviewCanvas();

    // Try MediaPipe helper first
    if (typeof Camera !== 'undefined') {
      try {
        state.camera = new Camera(els.video, {
          onFrame: async () => {
            if (state.running) await state.faceMesh.send({ image: els.video });
          },
          width: 640,
          height: 480,
          facingMode: 'user',
        });
        await state.camera.start();
        return true;
      } catch (e) {
        console.warn('Camera helper failed; falling back:', e);
      }
    }

    // Fallback attempts
    const attempts = [
      { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: 'user', width: 640, height: 480 }, audio: false },
      { video: true, audio: false },
    ];

    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
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
        return true;
      } catch (err) {
        console.warn('getUserMedia failed with', constraints, err);
        lastGumError = err;
      }
    }

    return false;
  }

  // ---------- UI ----------
  els.startBtn.addEventListener('click', async () => {
    try {
      els.startBtn.disabled = true;
      els.banner.textContent = 'Initializing… grant camera permission if prompted.';

      // Secure context guard
      if (
        !(
          location.protocol === 'https:' ||
          location.hostname === 'localhost' ||
          location.protocol === 'file:'
        )
      ) {
        throw new Error('Page must be served over HTTPS / localhost / file://');
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API not available in this browser.');
      }

      if (!state.meta) state.meta = await loadMeta(META_URL);
      if (!state.faceMesh) await initFaceMesh();

      state.running = true;
      const ok = await startCamera();

      if (!ok) {
        let msg = 'Camera failed to start.';
        if (lastGumError) {
          if (lastGumError.name === 'NotAllowedError') {
            msg = 'Camera permission blocked. Allow in browser/site settings.';
          } else if (lastGumError.name === 'NotFoundError') {
            msg = 'No camera found. Check hardware/permissions.';
          } else if (lastGumError.name === 'NotReadableError') {
            msg = 'Camera in use by another app.';
          }
        }
        els.banner.textContent = msg;
        if (isStandalone && els.fallback) els.fallback.style.display = 'block';
        els.startBtn.disabled = false;
        state.running = false;
        return;
      }

      els.captureBtn.disabled = false;
      els.resetBtn.disabled = false;
      els.banner.textContent = 'Align your face with the guide area.';
    } catch (err) {
      console.error(err);
      els.banner.textContent = 'Error: ' + err.message;
      els.startBtn.disabled = false;
      state.running = false;
      if (isStandalone && els.fallback) els.fallback.style.display = 'block';
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
      a.click();
      a.remove();

      els.banner.textContent = 'Saved PNG.';
    } catch (e) {
      console.error(e);
      els.banner.textContent = 'Save failed.';
    }
  });

  els.resetBtn.addEventListener('click', () => {
    try {
      state.running = false;
      const stream = els.video.srcObject;
      if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
      els.video.srcObject = null;

      ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);

      els.captureBtn.disabled = true;
      els.saveBtn.disabled = true;
      els.resetBtn.disabled = true;
      els.startBtn.disabled = false;
      els.banner.textContent = 'Reset. Tap Start Camera to begin again.';
      if (els.fallback) els.fallback.style.display = 'none';
    } catch (e) {
      console.error(e);
      els.banner.textContent = 'Reset failed.';
    }
  });

  // Initial size for correct first paint
  fitPreviewCanvas();
})();
