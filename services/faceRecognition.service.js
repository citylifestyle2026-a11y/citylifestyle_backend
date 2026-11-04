// services/faceRecognition.service.js
//
// Face "fingerprint" (128 numbers) of a person's photo, computed on the
// server with @vladmandic/face-api running on the pure-JS WASM backend of
// TensorFlow.js - no native build step, so it installs on the Windows/IIS
// server exactly like every other npm package.
//
// The mobile scanner app uses the SAME model weights, so a descriptor made
// from a live camera frame can be compared directly (Euclidean distance)
// with the descriptor stored for the registered photo.
//
// Everything here is best-effort: if the packages / models are missing or
// the photo has no clear face, the function returns null and the normal QR
// flow keeps working untouched.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { UPLOAD_ROOT } = require("../config/uploadPaths");

// Distance below which two faces count as the same person. Lower = stricter.
// 0.6 is the library default; 0.5 is a safer gate-entry value. The scanner
// app also asks the staff to confirm the match, so this is a second safety.
const MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD) || 0.55;
// Upper limit for "please compare carefully" candidates (glasses / mask).
const LOOSE_THRESHOLD = Number(process.env.FACE_LOOSE_THRESHOLD) || 0.68;
const DESCRIPTOR_LENGTH = 128;

let faceapi = null;
let tf = null;
let readyPromise = null;
let disabledReason = "";

const init = () => {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    try {
      tf = require("@tensorflow/tfjs");
      require("@tensorflow/tfjs-backend-wasm");
      faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");

      await tf.setBackend("wasm");
      await tf.ready();

      const modelDir = path.join(
        path.dirname(require.resolve("@vladmandic/face-api/package.json")),
        "model"
      );
      await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);
      return true;
    } catch (error) {
      disabledReason = error.message;
      console.error("[face] Face recognition disabled:", error.message);
      return false;
    }
  })();

  return readyPromise;
};

// One photo at a time - keeps CPU / memory use predictable.
let queue = Promise.resolve();
const runExclusive = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

const detect = async (buffer, inputSize, scoreThreshold) => {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], "int32");
  try {
    return await faceapi
      .detectSingleFace(tensor, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold }))
      .withFaceLandmarks()
      .withFaceDescriptor();
  } finally {
    tensor.dispose();
  }
};

// Image buffer -> array of 128 numbers, or null (no face / disabled).
const getDescriptorFromBuffer = (buffer) =>
  runExclusive(async () => {
    if (!(await init())) return null;
    try {
      let result = await detect(buffer, 416, 0.5);
      // Second, more tolerant try for small / dark / side-on faces.
      if (!result) result = await detect(buffer, 608, 0.3);
      return result ? Array.from(result.descriptor) : null;
    } catch (error) {
      console.error("[face] Could not read face:", error.message);
      return null;
    }
  });

// `publicId` is the relative path saved as attendee.profileImagePublicId
// (e.g. "register-user/1730000000-abc.webp"). Never throws.
const getDescriptorFromStoredPhoto = async (publicId) => {
  try {
    if (!publicId) return null;
    const absolutePath = path.join(UPLOAD_ROOT, publicId);
    if (!absolutePath.startsWith(UPLOAD_ROOT)) return null;
    const buffer = await fs.promises.readFile(absolutePath);
    return await getDescriptorFromBuffer(buffer);
  } catch (error) {
    console.error(`[face] Stored photo unreadable (${publicId}):`, error.message);
    return null;
  }
};

const isValidDescriptor = (value) =>
  Array.isArray(value) &&
  value.length === DESCRIPTOR_LENGTH &&
  value.every((n) => typeof n === "number" && Number.isFinite(n));

const distance = (a, b) => {
  let sum = 0;
  for (let i = 0; i < DESCRIPTOR_LENGTH; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
};

module.exports = {
  MATCH_THRESHOLD,
  LOOSE_THRESHOLD,
  DESCRIPTOR_LENGTH,
  getDescriptorFromBuffer,
  getDescriptorFromStoredPhoto,
  isValidDescriptor,
  distance,
  getStatus: () => ({ disabledReason }),
};