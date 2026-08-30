// Compresión de video en el navegador, antes de subir.
//
// Un clip de 15 segundos grabado con un teléfono moderno sale en 4K y pesa
// decenas de megabytes. Cuarenta ejercicios así llenan el bucket y, peor, cada
// cliente que abre su rutina se los descarga con datos móviles. Comprimir en el
// servidor costaría CPU por cada clip y obligaría a meter ffmpeg en la imagen;
// aquí es gratis y el archivo pesado nunca sale del teléfono.
//
// El método es re-dibujar el video en un canvas del tamaño de destino y grabar
// ese canvas con MediaRecorder. No se agrega pista de audio a propósito: una
// demostración de sentadilla no necesita el ruido del gimnasio, y quitarlo baja
// el peso sin tocar la calidad de imagen.
//
// Corre en tiempo real: un clip de 20 segundos tarda unos 20 segundos.
(() => {
  const preferredTypes = [
    // Safari (iPhone) sólo graba MP4; Chrome y Firefox prefieren WebM. Se prueba
    // en este orden para que el iPhone de la entrenadora produzca algo que su
    // cliente en Android también pueda reproducir.
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

  const supported = () => typeof MediaRecorder !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && preferredTypes.some(type => MediaRecorder.isTypeSupported(type));

  const pickType = () => preferredTypes.find(type => MediaRecorder.isTypeSupported(type)) || '';
  const baseType = type => (type.startsWith('video/mp4') ? 'video/mp4' : 'video/webm');

  function loadVideo(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.src = url;
      video.onloadedmetadata = () => resolve({ video, url });
      video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer el video')); };
    });
  }

  // El lado más largo se limita a maxSide y las dimensiones se vuelven pares:
  // los codificadores de video rechazan anchos o altos impares.
  function targetSize(width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const even = value => Math.max(2, Math.round(value * scale / 2) * 2);
    return { width: even(width), height: even(height) };
  }

  async function compress(file, options = {}) {
    const { maxSide = 720, videoBitsPerSecond = 1_200_000, fps = 30, maxSeconds = 90, onProgress } = options;
    if (!supported()) return { skipped: 'unsupported', blob: file, contentType: file.type, durationSeconds: null };

    const { video, url } = await loadVideo(file);
    try {
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      if (duration && duration > maxSeconds) {
        throw new Error(`El clip dura ${Math.round(duration)} s y el máximo son ${maxSeconds} s. Recórtalo antes de subirlo.`);
      }

      const { width, height } = targetSize(video.videoWidth, video.videoHeight, maxSide);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });

      const mimeType = pickType();
      const stream = canvas.captureStream(fps);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond });
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };

      const finished = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = () => reject(new Error('Falló la compresión del video'));
      });

      recorder.start(1000);
      await video.play();

      await new Promise(resolve => {
        const draw = () => {
          if (video.ended || video.paused) { resolve(); return; }
          context.drawImage(video, 0, 0, width, height);
          if (onProgress && duration) onProgress(Math.min(0.99, video.currentTime / duration));
          requestAnimationFrame(draw);
        };
        video.onended = resolve;
        requestAnimationFrame(draw);
      });

      recorder.stop();
      await finished;
      stream.getTracks().forEach(track => track.stop());
      if (onProgress) onProgress(1);

      const blob = new Blob(chunks, { type: baseType(mimeType) });
      // Si el original ya venía liviano, comprimir puede engordarlo. En ese
      // caso se sube tal cual: el objetivo es que pese menos, no re-codificar.
      if (blob.size >= file.size) {
        return { skipped: 'larger', blob: file, contentType: file.type, durationSeconds: duration, width: video.videoWidth, height: video.videoHeight, originalSize: file.size, finalSize: file.size };
      }
      return { blob, contentType: baseType(mimeType), durationSeconds: duration, width, height, originalSize: file.size, finalSize: blob.size };
    } finally {
      video.pause();
      URL.revokeObjectURL(url);
    }
  }

  window.VideoCompressor = { compress, supported };
})();
