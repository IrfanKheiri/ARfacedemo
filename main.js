/* Face Replacement Demo (globals build)
   - Uses MediaPipe FaceMesh and Camera Utils loaded via <script> tags in index.html
   - No ES module imports here.
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
  const metaUrl = './assets/slot.json';
  const baseImg = new Image();
  baseImg.src = './assets/character_base.png';
  const maskImg = new Image();
  maskImg.src = './assets/mask_oval.png';

  const state = {
    meta: null,
    faceMesh: null,
    camera: null,
    running: false,
    lastResults: null,
    capturedBlob: null,
  };

  // Utility: load JSON
  async function loadMeta(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Failed to load character metadata');
    return res.json();
  }

  // Draw the live composite
  function drawComposite(results) {
    const { multiFaceLandmarks } = results || {};
    // Clear
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    // Base character layer
    ctx.drawImage(baseImg, 0, 0, els.canvas.width, els.canvas.height);

    if (!multiFaceLandmarks || multiFaceLandmarks.length === 0) return;

    const lm = multiFaceLandmarks[0]; // largest face already ensured by FaceMesh
    const pts = pickKeypoints(lm); // {eyeL:[x,y], eyeR:[x,y], chin:[x,y]} in video space

    // Project / transform the video’s face ROI into the slot coordinates
    placeFaceIntoSlot(pts);
  }

  // Pick left/right eye outer corners and chin from FaceMesh landmarks.
  // Indices (using MediaPipe FaceMesh):
  // Left eye outer: 33, Right eye outer: 263, Chin tip (approx): 152
  function pickKeypoints(lm) {
    // Landmarks are in normalized coordinates [0..1] for x/y
    const vx = els.video.videoWidth;
    const vy = els.video.videoHeight;

    const idx = { L: 33, R: 263, C: 152 };
    const eyeL = [lm[idx.L].x * vx, lm[idx.L].y * vy];
    const eyeR = [lm[idx.R].x * vx, lm[idx.R].y * vy];
    const chin = [lm[idx.C].x * vx, lm[idx.C].y * vy];
    return { eyeL, eyeR, chin };
  }

  // Compute similarity transform and composite the face
  function placeFaceIntoSlot(src) {
    const meta = state.meta;
    const slot = meta.slot;
    const cvw = els.canvas.width;
    const cvh = els.canvas.height;

    // Target anchors (in canvas/output space)
    const dstL = slot.eye_left;
    const dstR = slot.eye_right;
    const dstC = slot.chin;

    // Compute transforms based on eye vector
    const sdx = src.eyeR[0] - src.eyeL[0];
    const sdy = src.eyeR[1] - src.eyeL[1];
    const ddx = dstR[0] - dstL[0];
    const ddy = dstR[1] - dstL[1];

    const sAngle = Math.atan2(sdy, sdx);
    const dAngle = Math.atan2(ddy, ddx);
    const angle = dAngle - sAngle;

    const sDist = Math.hypot(sdx, sdy);
    const dDist = Math.hypot(ddx, ddy);
    const scale = dDist / (sDist || 1);

    // Compute centers
    const sMid = [(src.eyeL[0] + src.eyeR[0]) / 2, (src.eyeL[1] + src.eyeR[1]) / 2];
    const dMid = [(dstL[0] + dstR[0]) / 2, (dstL[1] + dstR[1]) / 2];

    // ROI box around source face (eye center to chin)
    const eyeToChin = Math.hypot(src.chin[0] - sMid[0], src.chin[1] - sMid[1]);
    const roiSize = Math.max(1, eyeToChin * (state.meta.slot.roi_scale || 1.5));

    // Offscreen buffer: grab face ROI from video
    const off = document.createElement('canvas');
    const offCtx = off.getContext('2d');
    off.width = roiSize * 2;
    off.height = roiSize * 2;

    // Source rect in video coords
    const sx = sMid[0] - roiSize;
    const sy = sMid[1] - roiSize;
    offCtx.drawImage(els.video, sx, sy, roiSize * 2, roiSize * 2, 0, 0, off.width, off.height);

    // Place the ROI onto preview canvas with rotation + scaling
    ctx.save();

    // Destination transform: translate to target midpoint, rotate, scale, then center the ROI
    ctx.translate(dMid[0], dMid[1]);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    ctx.translate(-off.width / 2, -off.height / 2);

    // Draw the face ROI
    ctx.drawImage(off, 0, 0);

    // Soft mask
    if (maskImg.complete) {
      ctx.globalCompositeOperation = 'destination-in';
      // Scale mask to match ROI size (already scaled by ctx.scale)
      ctx.drawImage(maskImg, 0, 0, off.width, off.height);
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();
  }

  // Export current canvas to PNG
  async function exportPNG() {
    return new Promise((resolve) => {
      els.canvas.toBlob((blob) => resolve(blob), 'image/png', 0.92);
    });
  }

  // FaceMesh init
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
        state.lastResults = results;
        if (state.running) drawComposite(results);
      });
      state.faceMesh = fm;
      resolve();
    });
  }

  // Start camera using MediaPipe Camera helper if available; fallback to getUserMedia
  async function startCamera() {
    // Prepare canvas size to meta.preview or image_size fallback
    const w = (state.meta.preview && state.meta.preview.width) || 720;
    const h = (state.meta.preview && state.meta.preview.height) || 960;
    els.canvas.width = w;
    els.canvas.height = h;

    // Ensure assets are ready
    await Promise.all([
      waitImage(baseImg),
      waitImage(maskImg),
    ]);

    // Use Camera helper if present (global)
    if (typeof Camera !== 'undefined') {
      state.camera = new Camera(els.video, {
        onFrame: async () => {
          await state.faceMesh.send({ image: els.video });
        },
        width: 640,
        height: 480,
        facingMode: 'user',
      });
      await state.camera.start();
    } else {
      // Fallback to plain getUserMedia
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      els.video.srcObject = stream;
      await els.video.play();

      // Manual frame loop
      const loop = async () => {
        if (!state.running) return;
        await state.faceMesh.send({ image: els.video });
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  function waitImage(img) {
    return new Promise((resolve, reject) => {
      if (img.complete) return resolve();
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image failed to load: ' + img.src));
    });
  }

  // UI wiring
  els.startBtn.addEventListener('click', async () => {
    try {
      els.startBtn.disabled = true;
      els.banner.textContent = 'Initializing… grant camera permission if prompted.';
      // Guard: secure context
      if (
        !(location.protocol === 'https:' ||
          location.hostname === 'localhost' ||
          location.protocol === 'file:')
      ) {
        throw new Error('Page must be served over HTTPS / localhost / file://');
      }

      if (!state.meta) state.meta = await loadMeta(metaUrl);
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

  els.captureBtn.addEventListener('click', async () => {
    // Freeze current composite (do nothing extra: the canvas already shows it)
    els.saveBtn.disabled = false;
    els.banner.textContent = 'Captured. Tap Save to download.';
  });

  els.saveBtn.addEventListener('click', async () => {
    try {
      const blob = await exportPNG();
      if (!blob) return;

      if (state.capturedBlob) URL.revokeObjectURL(state.capturedBlob);
      const url = URL.createObjectURL(blob);
      state.capturedBlob = url;

      // Trigger download
      const a = document.createElement('a');
      a.href = url;
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
      // Stop tracks if any
      const stream = els.video.srcObject;
      if (stream && stream.getTracks) {
        stream.getTracks().forEach(t => t.stop());
      }
      els.video.srcObject = null;

      // Clear canvas
      ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);

      // UI
      els.captureBtn.disabled = true;
      els.saveBtn.disabled = true;
      els.resetBtn.disabled = true;
      els.startBtn.disabled = false;
      els.banner.textContent = 'Reset. Tap Start Camera to begin again.';
    } catch (e) {
      console.error(e);
      els.banner.textContent = 'Reset failed.';
    }
  });
})();
