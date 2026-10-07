import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { inspectVideoFile, normalizeVideo, runCommand } from '../dist/video-normalizer.js';

const exec = promisify(execFile);

async function hasFfmpeg() {
  try {
    await Promise.all([exec('ffmpeg', ['-version']), exec('ffprobe', ['-version'])]);
    return true;
  } catch {
    return false;
  }
}

const ffmpegAvailable = await hasFfmpeg();
const skipWithoutFfmpeg = { skip: ffmpegAvailable ? false : 'ffmpeg/ffprobe no están instalados; se omite la prueba de conversión' };

async function fixture(directory, name, args) {
  const file = join(directory, name);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, file]);
  return file;
}

test('detecta MP4 normal, MP4 fragmentado y WebM generados por ffmpeg', skipWithoutFfmpeg, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-normalizer-test-'));
  try {
    const normal = await fixture(directory, 'normal.mp4', [
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=480x360:rate=24',
      '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart'
    ]);
    const fragmented = await fixture(directory, 'fragmented.mp4', [
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=480x360:rate=24',
      '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-an',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof'
    ]);
    const webm = await fixture(directory, 'web.webm', [
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=480x360:rate=24',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-an'
    ]);

    const normalInfo = await inspectVideoFile(normal);
    const fragmentedInfo = await inspectVideoFile(fragmented);
    const webmInfo = await inspectVideoFile(webm);
    assert.equal(normalInfo.needsNormalize, false);
    assert.equal(fragmentedInfo.fragmented, true);
    assert.equal(fragmentedInfo.needsNormalize, true);
    assert.equal(webmInfo.container, 'matroska,webm');
    assert.equal(webmInfo.needsNormalize, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('normaliza MP4 fragmentado y WebM a MP4 H.264 sin audio', skipWithoutFfmpeg, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-normalizer-test-'));
  try {
    const fragmented = await fixture(directory, 'fragmented.mp4', [
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=481x361:rate=24',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-an',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof'
    ]);
    const webm = await fixture(directory, 'web.webm', [
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=480x360:rate=24',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-an'
    ]);
    const normalizedFragmented = join(directory, 'fragmented-normalized.mp4');
    const normalizedWebm = join(directory, 'web-normalized.mp4');

    const fragmentedResult = await normalizeVideo(fragmented, normalizedFragmented);
    const webmResult = await normalizeVideo(webm, normalizedWebm);
    assert.equal(fragmentedResult.changed, true);
    assert.equal(webmResult.changed, true);
    assert.equal(fragmentedResult.normalized.needsNormalize, false);
    assert.equal(webmResult.normalized.needsNormalize, false);
    assert.equal(fragmentedResult.normalized.codec, 'h264');
    assert.equal(webmResult.normalized.codec, 'h264');
    assert.equal(fragmentedResult.normalized.hasAudio, false);
    assert.equal(webmResult.normalized.hasAudio, false);
    assert.equal(fragmentedResult.normalized.fragmented, false);
    assert.equal(webmResult.normalized.fragmented, false);
    assert.equal(fragmentedResult.normalized.moovBeforeMdat, true);
    assert.equal(webmResult.normalized.moovBeforeMdat, true);
    assert.equal(fragmentedResult.normalized.width % 2, 0);
    assert.equal(fragmentedResult.normalized.height % 2, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('un MP4 universal no se toca y la ausencia de ffmpeg falla de forma controlada', skipWithoutFfmpeg, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-normalizer-test-'));
  try {
    const normal = await fixture(directory, 'normal.mp4', [
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=480x360:rate=24',
      '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart'
    ]);
    const output = join(directory, 'should-not-be-created.mp4');
    const result = await normalizeVideo(normal, output);
    assert.equal(result.changed, false);
    await assert.rejects(access(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(runCommand('/ruta/que/no/existe/ffmpeg', []), /no está instalado|disponible en PATH/);
});
