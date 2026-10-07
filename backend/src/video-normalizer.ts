import { copyFile, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const MAX_VIDEO_SIZE = 40 * 1024 * 1024;
// Igual que el compresor del navegador (maxSeconds = 90): un clip válido allí no puede ser rechazado aquí.
export const MAX_VIDEO_DURATION_SECONDS = 90;
export const COMMAND_TIMEOUT_MS = 180_000;
export const MAX_VIDEO_SIDE = 1280;
export const MAX_VIDEO_FPS = 30.5;
const ACCEPTED_PROFILES = /baseline|main/i;

export type VideoProbe = {
  format?: { format_name?: string; duration?: string | number };
  streams?: Array<{
    index?: number;
    codec_type?: string;
    codec_name?: string;
    profile?: string;
    level?: number;
    pix_fmt?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }>;
};

export type VideoInfo = {
  container: string;
  codec: string | null;
  profile: string | null;
  level: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  pixelFormat: string | null;
  hasAudio: boolean;
  fragmented: boolean;
  moovBeforeMdat: boolean;
  sizeBytes: number;
  needsNormalize: boolean;
  reasons: string[];
};

export type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export function runCommand(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Un ffmpeg colgado no debe dejar el script (ni, más adelante, una petición de subida) esperando para siempre.
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timeout.unref();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      finish(() => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new Error(`${command} no está instalado o no está disponible en PATH`));
        else reject(error);
      });
    });
    child.on('close', (code, signal) => {
      finish(() => {
        if (timedOut || signal === 'SIGKILL') return reject(new Error(`${command} superó el tiempo máximo de ${Math.round(timeoutMs / 1000)} s y se canceló`));
        if (code === 0) return resolve({ stdout, stderr });
        reject(new Error(`${command} terminó con código ${code}: ${stderr.trim()}`));
      });
    });
  });
}

export function fraction(value: string | number | null | undefined): number | null {
  if (!value || value === '0/0') return null;
  const [numerator, denominator] = String(value).split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

export function topLevelMp4Boxes(bytes: Buffer) {
  const boxes: Array<{ type: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const start = offset;
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    offset += 8;
    if (size === 1) {
      if (offset + 8 > bytes.length) break;
      const high = bytes.readUInt32BE(offset);
      const low = bytes.readUInt32BE(offset + 4);
      size = high * 2 ** 32 + low;
      offset += 8;
    } else if (size === 0) {
      size = bytes.length - start;
    }
    if (!Number.isSafeInteger(size) || size < offset - start || start + size > bytes.length) break;
    boxes.push({ type, start, end: start + size });
    offset = start + size;
  }
  return boxes;
}

export async function probeVideo(file: string, runner: CommandRunner = runCommand): Promise<VideoProbe> {
  const { stdout } = await runner('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height,avg_frame_rate,r_frame_rate',
    file
  ]);
  return JSON.parse(stdout) as VideoProbe;
}

function isMp4Container(formatName: string) {
  return formatName.split(',').some(name => ['mp4', 'mov', '3gp', '3g2', 'mj2'].includes(name));
}

export function inspectVideo(bytes: Buffer, metadata: VideoProbe): VideoInfo {
  const formatName = String(metadata.format?.format_name || '');
  const video = (metadata.streams || []).find(stream => stream.codec_type === 'video') || {};
  const audio = (metadata.streams || []).some(stream => stream.codec_type === 'audio');
  const isMp4 = isMp4Container(formatName);
  const boxes = isMp4 ? topLevelMp4Boxes(bytes) : [];
  const moov = boxes.find(box => box.type === 'moov');
  const mdat = boxes.find(box => box.type === 'mdat');
  const fragmented = boxes.some(box => box.type === 'moof');
  const duration = Number(metadata.format?.duration);
  const fps = fraction(video.avg_frame_rate) ?? fraction(video.r_frame_rate);
  const width = Number(video.width) || null;
  const height = Number(video.height) || null;
  const maxSide = Math.max(width || 0, height || 0);
  const reasons: string[] = [];
  if (!isMp4) reasons.push('contenedor no es MP4');
  if (video.codec_name !== 'h264') reasons.push(`códec ${video.codec_name || 'desconocido'}`);
  if (!ACCEPTED_PROFILES.test(String(video.profile || ''))) reasons.push(`perfil ${video.profile || 'desconocido'}`);
  if (Number(video.level) > 40) reasons.push(`nivel ${video.level}`);
  if (video.pix_fmt !== 'yuv420p') reasons.push(`píxel ${video.pix_fmt || 'desconocido'}`);
  if (!Number.isFinite(duration) || duration <= 0) reasons.push('duración ausente o inválida');
  if (fragmented) reasons.push('MP4 fragmentado (moof)');
  if (!moov || !mdat || moov.start > mdat.start) reasons.push('moov no está antes de mdat');
  if (audio) reasons.push('contiene audio');
  if ((width || 0) % 2 || (height || 0) % 2) reasons.push('dimensiones impares');
  if (maxSide > MAX_VIDEO_SIDE) reasons.push(`lado mayor ${maxSide}px`);
  if (fps && fps > MAX_VIDEO_FPS) reasons.push(`frecuencia ${fps.toFixed(2)} fps`);
  if (bytes.length > MAX_VIDEO_SIZE) reasons.push(`supera 40 MB (${bytes.length} bytes)`);
  return {
    container: isMp4 ? 'mp4' : formatName || 'desconocido',
    codec: video.codec_name || null,
    profile: video.profile || null,
    level: video.level ?? null,
    duration: Number.isFinite(duration) ? duration : null,
    width,
    height,
    fps,
    pixelFormat: video.pix_fmt || null,
    hasAudio: audio,
    fragmented,
    moovBeforeMdat: Boolean(moov && mdat && moov.start < mdat.start),
    sizeBytes: bytes.length,
    needsNormalize: reasons.length > 0,
    reasons
  };
}

export async function inspectVideoFile(file: string, runner: CommandRunner = runCommand): Promise<VideoInfo> {
  const [bytes, metadata] = await Promise.all([readFile(file), probeVideo(file, runner)]);
  return inspectVideo(bytes, metadata);
}

function outputDimensions(info: VideoInfo) {
  const width = info.width || 2;
  const height = info.height || 2;
  const scale = Math.min(1, MAX_VIDEO_SIDE / Math.max(width, height));
  const even = (value: number) => Math.max(2, Math.floor(value * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

function isRemuxSafe(info: VideoInfo) {
  return info.container === 'mp4'
    && info.codec === 'h264'
    && Boolean(info.profile && ACCEPTED_PROFILES.test(info.profile))
    && (info.level == null || info.level <= 40)
    && info.pixelFormat === 'yuv420p'
    && !info.hasAudio
    && (info.width || 0) % 2 === 0
    && (info.height || 0) % 2 === 0
    && Math.max(info.width || 0, info.height || 0) <= MAX_VIDEO_SIDE
    && (!info.fps || info.fps <= MAX_VIDEO_FPS)
    && info.sizeBytes <= MAX_VIDEO_SIZE
    && Boolean(info.duration && info.duration > 0);
}

async function convertOnce(input: string, output: string, info: VideoInfo, runner: CommandRunner, crf: number) {
  const args = isRemuxSafe(info)
    ? ['-y', '-i', input, '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', output]
    : [
      '-y', '-i', input, '-map', '0:v:0', '-vf', `scale=${outputDimensions(info).width}:${outputDimensions(info).height}`,
      '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '3.1', '-pix_fmt', 'yuv420p', '-fpsmax', '30',
      '-preset', 'medium', '-crf', String(crf), '-an', '-movflags', '+faststart', output
    ];
  await runner('ffmpeg', args);
}

export async function normalizeVideo(
  input: string,
  output: string,
  options: { runner?: CommandRunner } = {}
) {
  const runner = options.runner || runCommand;
  const original = await inspectVideoFile(input, runner);
  if (!original.needsNormalize) return { changed: false, original, normalized: original };
  if (original.duration && original.duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(`El video dura ${original.duration.toFixed(2)} s y supera el máximo de ${MAX_VIDEO_DURATION_SECONDS} s`);
  }

  let last: VideoInfo | null = null;
  for (const crf of isRemuxSafe(original) ? [23] : [23, 27, 31, 35]) {
    await convertOnce(input, output, original, runner, crf);
    const normalized = await inspectVideoFile(output, runner);
    last = normalized;
    const durationOkay = Boolean(normalized.duration && original.duration
      && normalized.duration >= original.duration * 0.9
      && normalized.duration <= original.duration * 1.1);
    if (!normalized.needsNormalize && durationOkay) {
      return { changed: true, original, normalized, crf };
    }
    if (!normalized.needsNormalize && !durationOkay) {
      throw new Error(`La duración normalizada no coincide con la original (${original.duration ?? '—'} s → ${normalized.duration ?? '—'} s)`);
    }
  }
  throw new Error(`La salida no cumple el formato universal: ${last?.reasons.join('; ') || 'sin detalles'}`);
}

export async function copyVideo(input: string, output: string) {
  await copyFile(input, output);
}

export async function fileSize(file: string) {
  return (await stat(file)).size;
}
