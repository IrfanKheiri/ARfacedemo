/*
  main.js

  This module orchestrates the face replacement demo. It requests
  camera access, runs MediaPipe FaceMesh on each frame, computes
  alignment between the detected face and a predefined slot on the
  character image, and composites the result in a canvas. It also
  allows the user to capture the current composite and download
  it as a PNG. The implementation stays entirely on-device and
  does not send any image data to a server.

  Note: this demo relies on external scripts hosted via jsDelivr
  to load the MediaPipe FaceMesh and Camera utilities. These URLs
  are versioned and can be updated if newer releases are desired.
*/

// Import MediaPipe modules. We use dynamic imports to fetch
// the face mesh and camera utilities from a CDN. These modules
// expose global constructors that we can instantiate.
import { FaceMesh } from 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js';
import { Camera } from 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js';

// Grab DOM elements. The video element shows the live camera
// stream; the preview canvas shows the composite of the character
// and the detected face. Control buttons handle camera start,
// capture and saving.
const video = document.getElementById('video');
const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('start-btn');
const captureBtn = document.getElementById('capture-btn');
const saveBtn = document.getElementById('save-btn');

// Load asset metadata. The slot JSON describes where the eyes
// and chin of the face should be positioned relative to the
// character image. We fetch it once at load time.
const slotData = await fetch('./assets/slot.json').then(res => res.json());

// Load the character and mask images. These images are used to
// composite the face into the character art. The mask defines
// the region of the face to keep when drawing over the character.
const characterImg = new Image();
characterImg.src = './assets/character_base.png';
const maskImg = new Image();
maskImg.src = './assets/mask_oval.png';
await Promise.all([characterImg.decode(), maskImg.decode()]);

// Initialise the MediaPipe FaceMesh solution. We specify a locateFile
// function so that the dependent WASM files can be resolved from
// the same CDN. The options set maxNumFaces to 1 (we only care
// about a single face) and refineLandmarks to true to get more
// accurate eyes and lips.
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});
faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  selfieMode: true
});

let latestResults = null;
let camera = null;

faceMesh.onResults(results => {
  latestResults = results;
  drawPreview();
});

// Handle camera start. When the user taps the Start button, we
// request the camera and begin sending frames to FaceMesh. On
// some browsers (especially mobile Safari) the camera will not
// start until a user gesture has occurred.
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  captureBtn.disabled = false;
  // Initialise camera using MediaPipe camera utils. We specify
  // desired dimensions; the utilities handle aspect ratio.
  camera = new Camera(video, {
    onFrame: async () => {
      if (faceMesh) {
        await faceMesh.send({ image: video });
      }
    },
    width: 640,
    height: 480
  });
  await camera.start();
});

// Compute the similarity transform that maps the user’s face onto
// the character slot. We use three landmarks: the outer corners
// of the eyes (indices 33 and 263) and the chin tip (index 152).
// These indices come from the MediaPipe FaceMesh landmark map.
function computeTransform(landmarks) {
  // Source landmarks in the video frame (normalized coordinates)
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const chin = landmarks[152];
  // Compute distances between key points
  const dx = rightEye.x - leftEye.x;
  const dy = rightEye.y - leftEye.y;
  const eyeDist = Math.hypot(dx, dy);
  // Midpoint between the eyes
  const eyeMid = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
  // Target positions in the character image (normalized to [0,1])
  const slot = slotData.slot;
  const imgW = slotData.image_size[0];
  const imgH = slotData.image_size[1];
  const targetEyeLeft = { x: slot.eye_left[0] / imgW, y: slot.eye_left[1] / imgH };
  const targetEyeRight = { x: slot.eye_right[0] / imgW, y: slot.eye_right[1] / imgH };
  const targetChin = { x: slot.chin[0] / imgW, y: slot.chin[1] / imgH };
  const tDx = targetEyeRight.x - targetEyeLeft.x;
  const tDy = targetEyeRight.y - targetEyeLeft.y;
  const targetEyeDist = Math.hypot(tDx, tDy);
  // Scale factor: ratio of target eye distance to detected eye distance
  // Multiply by canvas dimensions because our video and canvas units differ
  const scale = (targetEyeDist * canvas.width) / (eyeDist * video.videoWidth);
  // Rotation: difference in angles between eye lines
  const sourceAngle = Math.atan2(dy, dx);
  const targetAngle = Math.atan2(tDy * canvas.height, tDx * canvas.width);
  const rotation = targetAngle - sourceAngle;
  // Compute target midpoint in canvas coordinates
  const targetEyeMidX = ((slot.eye_left[0] + slot.eye_right[0]) / 2) / imgW * canvas.width;
  const targetEyeMidY = ((slot.eye_left[1] + slot.eye_right[1]) / 2) / imgH * canvas.height;
  // Current eye midpoint in video pixel coordinates
  const currentX = eyeMid.x * video.videoWidth;
  const currentY = eyeMid.y * video.videoHeight;
  // Translation needed to move the scaled/rotated face to the slot
  const tx = targetEyeMidX - (currentX * scale);
  const ty = targetEyeMidY - (currentY * scale);
  // Mask dimensions and position relative to the slot; this determines
  // how much of the face is visible when compositing. ROI scale
  // expands the mask beyond the eye distance to include cheeks and chin.
  const roiW = slot.roi_scale * (slot.eye_right[0] - slot.eye_left[0]) / imgW * canvas.width;
  const roiH = slot.roi_scale * (slot.chin[1] - slot.eye_left[1]) / imgH * canvas.height;
  const maskX = targetEyeMidX - roiW / 2;
  const maskY = targetEyeMidY - (slot.eye_left[1] / imgH * canvas.height);
  return {
    scale, rotation, tx, ty,
    maskX, maskY, maskW: roiW, maskH: roiH,
    cx: eyeMid.x * video.videoWidth,
    cy: eyeMid.y * video.videoHeight
  };
}

// Draw the live preview. This function composes the character
// image and the user’s face in real time. It reads the latest
// FaceMesh results, computes the transform, and uses an
// offscreen canvas to apply the mask before drawing onto the
// visible preview canvas.
function drawPreview() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return;
  // Resize the preview canvas to match the video aspect ratio
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  // Draw the character base as the background
  ctx.drawImage(characterImg, 0, 0, width, height);
  // No face detected? exit early
  if (!latestResults || !latestResults.multiFaceLandmarks || !latestResults.multiFaceLandmarks[0]) {
    return;
  }
  const landmarks = latestResults.multiFaceLandmarks[0];
  const transform = computeTransform(landmarks);
  // Create an offscreen canvas to draw the transformed face
  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = width;
  faceCanvas.height = height;
  const fctx = faceCanvas.getContext('2d');
  // Save context and apply transform: translate, rotate and scale
  fctx.save();
  fctx.translate(transform.tx, transform.ty);
  fctx.rotate(transform.rotation);
  fctx.scale(transform.scale, transform.scale);
  // Draw the video frame onto the offscreen canvas. We translate
  // such that the face’s centre (between the eyes) becomes the
  // origin for rotation and scaling.
  fctx.translate(-transform.cx, -transform.cy);
  fctx.drawImage(video, 0, 0, width, height);
  fctx.restore();
  // Apply the mask: destination-in keeps only the masked region
  fctx.globalCompositeOperation = 'destination-in';
  fctx.drawImage(maskImg, transform.maskX, transform.maskY, transform.maskW, transform.maskH);
  // Composite the masked face over the character on the main canvas
  ctx.drawImage(faceCanvas, 0, 0);
}

// Capture button handler. When clicked, it freezes the current
// preview and enables the Save button. The Save button will
// generate a high‑resolution PNG of the composite.
captureBtn.addEventListener('click', () => {
  captureBtn.disabled = true;
  // Enable save button
  saveBtn.style.display = 'inline-block';
  generateOutputImage();
});

// Generate output PNG at a higher resolution (3:4 ratio). We
// scale the current preview canvas up to 1200×1600 pixels and
// convert it to a Blob. The resulting object URL is assigned
// to the Save button’s href so the browser downloads it when
// clicked.
function generateOutputImage() {
  const outW = 1200;
  const outH = 1600;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const octx = outCanvas.getContext('2d');
  // Draw scaled preview onto output canvas
  octx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, outW, outH);
  outCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    saveBtn.href = url;
    saveBtn.download = 'face_composite.png';
  }, 'image/png');
}