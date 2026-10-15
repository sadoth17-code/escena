// AudioBufferSource-compatible transport for independently stored PCM chunks.
// All positions are integer frames in the descriptor's sample rate. Chunk boundaries
// share the same AudioContext clock, including after a seek or an underrun.
export class StreamSource {
  constructor(ctx, descriptor, options = {}) {
    this.context = ctx;
    this.descriptor = descriptor;
    this.sampleRate = Number(descriptor.sampleRate);
    if (!Number.isFinite(this.sampleRate) || this.sampleRate <= 0) throw new RangeError('Invalid stream sample rate');
    this.chunkFrames = Math.max(1, Math.round((Number(descriptor.chunkSeconds) || 2) * this.sampleRate));
    this.realFrames = Math.max(0, Math.round(Number(descriptor.length) || Number(descriptor.duration) * this.sampleRate || 0));
    this.totalFrames = Math.max(this.realFrames, Math.round((Number(descriptor.playbackDuration) || 0) * this.sampleRate));
    this.onended = null;
    this._loop = false;
    this._loopStart = 0;
    this._loopEnd = 0;
    this._output = ctx.createGain();
    this._nodes = new Set();
    this._loading = new Map();
    this._started = false;
    this._ended = false;
    this._generation = 0;
    this._stopFrame = Infinity;
    this._stopAt = Infinity;
    this._lookAhead = Math.min(6, Math.max(4, Number(options.lookAheadSeconds) || 6));
    this._tickMs = Math.max(10, Number(options.tickMs) || 100);
    this._setInterval = options.setInterval || globalThis.setInterval.bind(globalThis);
    this._clearInterval = options.clearInterval || globalThis.clearInterval.bind(globalThis);
    this._timer = null;
  }

  get loop() { return this._loop; }
  set loop(value) { this._loop = Boolean(value); this._queueLoopChange(); }
  get loopStart() { return this._loopStart; }
  set loopStart(value) { this._loopStart = Math.max(0, Number(value) || 0); this._queueLoopChange(); }
  get loopEnd() { return this._loopEnd; }
  set loopEnd(value) { this._loopEnd = Math.max(0, Number(value) || 0); this._queueLoopChange(); }

  connect(target, ...args) {
    return this._output.connect(target, ...args);
  }

  disconnect(...args) {
    this._output.disconnect(...args);
  }

  start(when = 0, offset = 0) {
    if (this._started) throw new DOMException('Stream source already started', 'InvalidStateError');
    if (!Number.isFinite(Number(when)) || Number(when) < 0 || !Number.isFinite(Number(offset)) || Number(offset) < 0) {
      throw new RangeError('Invalid stream start time or offset');
    }
    this._started = true;
    this._when = Math.max(this.context.currentTime, Number(when));
    this._anchorFrame = 0;
    this._anchorMedia = Math.min(this.totalFrames, Math.round(Number(offset) * this.sampleRate));
    this._mappingLoop = this._readLoop();
    this._cursor = 0;
    this._timer = this._setInterval(() => this._pump(), this._tickMs);
    this._pump();
  }

  stop(when = this.context.currentTime) {
    if (!this._started) throw new DOMException('Stream source has not started', 'InvalidStateError');
    if (!Number.isFinite(Number(when)) || Number(when) < 0) throw new RangeError('Invalid stream stop time');
    if (this._ended) return;
    // A transport that is already fading out must never be revived by a later
    // stop request. Every asynchronous completion checks this final boundary.
    this._stopAt = Math.min(this._stopAt, Math.max(this.context.currentTime, Number(when)));
    this._stopFrame = Math.max(0, Math.round((this._stopAt - this._when) * this.sampleRate));
    for (const entry of this._nodes) {
      try { entry.node.stop(this._stopAt); } catch (error) { void error; }
    }
    this._pump();
  }

  _readLoop() {
    const start = Math.min(this.totalFrames, Math.round(this._loopStart * this.sampleRate));
    const end = this._loopEnd > 0
      ? Math.min(this.totalFrames, Math.round(this._loopEnd * this.sampleRate))
      : this.totalFrames;
    return this._loop && end > start ? { start, end } : null;
  }

  _mediaAt(elapsed) {
    let media = this._anchorMedia + elapsed - this._anchorFrame;
    const loop = this._mappingLoop;
    if (loop && media >= loop.end) media = loop.start + ((media - loop.end) % (loop.end - loop.start));
    return media;
  }

  _nowFrame() {
    // Ceil rather than round: after an asynchronous read, never replay a frame
    // whose timestamp has already passed. A tiny epsilon avoids float artifacts.
    return Math.max(0, Math.ceil((this.context.currentTime - this._when) * this.sampleRate - 1e-7));
  }

  _endFrame() {
    const natural = this._mappingLoop ? Infinity : this._anchorFrame + this.totalFrames - this._anchorMedia;
    return Math.max(0, Math.min(natural, this._stopFrame));
  }

  _queueLoopChange() {
    if (!this._started || this._ended || this._loopChangeQueued) return;
    this._loopChangeQueued = true;
    // SongPlayer changes loopStart, loopEnd and loop together. Read their final
    // values once, then replace only the future part of the audio timeline.
    queueMicrotask(() => {
      this._loopChangeQueued = false;
      if (this._ended) return;
      const frame = this.context.currentTime < this._when ? 0
        : this._nowFrame() + Math.ceil(128 * this.sampleRate / (this.context.sampleRate || this.sampleRate));
      const at = this._when + frame / this.sampleRate;
      const media = this._mediaAt(frame);
      this._generation++;
      this._loading.clear();
      for (const entry of this._nodes) {
        if (entry.end <= frame) continue;
        try { entry.node.stop(at); } catch (error) { void error; }
      }
      this._anchorFrame = frame;
      this._anchorMedia = Math.min(this.totalFrames, media);
      this._mappingLoop = this._readLoop();
      this._cursor = frame;
      this._pump();
    });
  }

  _pump() {
    if (!this._started || this._ended) return;
    const now = this._nowFrame();
    const end = this._endFrame();
    if (this.context.currentTime >= this._stopAt || (this.context.currentTime >= this._when && now >= end)) {
      this._finish();
      return;
    }
    if (this._cursor < now) {
      const media = this._mediaAt(this._cursor);
      this._report({ index: Math.floor(media / this.chunkFrames), media }, now - this._cursor);
      // If a browser suspended the main thread, jump straight to today's audio
      // frame instead of reading all the missed chunks in one memory burst.
      this._cursor = now;
    }
    const horizon = Math.min(end, now + Math.ceil(this._lookAhead * this.sampleRate));
    // Each segment ends exactly at a chunk, loop, horizon or transport boundary.
    // No fade is applied between chunks: these are adjacent PCM frames.
    let scheduled = 0;
    while (this._cursor < horizon && scheduled++ < 4096) {
      const start = this._cursor;
      const media = this._mediaAt(start);
      const index = Math.floor(media / this.chunkFrames);
      const boundary = this._mappingLoop ? this._mappingLoop.end : this.totalFrames;
      const frames = Math.min(end - start, (index + 1) * this.chunkFrames - media, boundary - media);
      if (frames <= 0) break;
      this._cursor += frames;
      if (media >= this.realFrames) continue; // A shorter stem remains silent without I/O.
      this._schedule({ start, end: start + frames, media, index, generation: this._generation });
    }
  }

  _schedule(segment) {
    let cached;
    try { cached = this.descriptor.peekChunk?.(segment.index); }
    catch (error) { this._report(segment, 0, error); return; }
    if (cached) {
      this._activate(segment, cached);
      return;
    }
    let pending = this._loading.get(segment.index);
    if (!pending) {
      // A generated block can do CPU work synchronously. Keep that work outside
      // commitSources so every stem's cached head is armed at the same clock time.
      pending = Promise.resolve().then(() => {
        if (this._ended || segment.generation !== this._generation || segment.start >= this._endFrame()) return null;
        return this.descriptor.getChunk(segment.index);
      });
      this._loading.set(segment.index, pending);
      const clear = () => {
        if (this._loading.get(segment.index) === pending) this._loading.delete(segment.index);
      };
      // Both branches are handled; a failed storage read never becomes an
      // unhandled rejection, including when stop/dispose races with the read.
      pending.then(clear, clear);
    }
    pending.then(buffer => this._activate(segment, buffer), error => {
      if (!this._ended && segment.generation === this._generation) this._report(segment, 0, error);
    });
  }

  _activate(segment, buffer) {
    if (this._ended || segment.generation !== this._generation) return;
    const end = Math.min(segment.end, this._endFrame());
    if (segment.start >= end) return;
    const start = Math.max(segment.start, this._nowFrame());
    const skipped = Math.min(end, start) - segment.start;
    if (skipped > 0) this._report(segment, skipped);
    if (!buffer || start >= end) return;
    const media = segment.media + start - segment.start;
    const chunkStart = segment.index * this.chunkFrames;
    const bufferFrames = Number.isFinite(buffer.duration)
      ? Math.round(buffer.duration * this.sampleRate) : buffer.length;
    const mediaEnd = Math.min(segment.media + end - segment.start, this.realFrames, chunkStart + bufferFrames);
    const frames = mediaEnd - media;
    if (frames <= 0) return;
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this._output);
    const entry = { node, start, end: start + frames };
    this._nodes.add(entry);
    node.onended = () => {
      this._nodes.delete(entry);
      try { node.disconnect(); } catch (error) { void error; }
      this._pump();
    };
    try {
      node.start(this._when + start / this.sampleRate, (media - chunkStart) / this.sampleRate, frames / this.sampleRate);
    } catch (error) {
      this._nodes.delete(entry);
      try { node.disconnect(); } catch (ignored) { void ignored; }
      this._report(segment, frames, error);
    }
  }

  _report(segment, skippedFrames, error) {
    try {
      this.descriptor.onUnderrun?.({
        chunkIndex: segment.index,
        skippedFrames,
        skippedSeconds: skippedFrames / this.sampleRate,
        at: this.context.currentTime,
        offset: segment.media / this.sampleRate,
        ...(error ? { error } : {}),
      });
    } catch (ignored) { void ignored; }
  }

  _finish() {
    if (this._ended) return;
    this._ended = true;
    this._generation++;
    if (this._timer !== null) this._clearInterval(this._timer);
    this._timer = null;
    this._loading.clear();
    for (const entry of this._nodes) {
      entry.node.onended = null;
      try { entry.node.stop(); entry.node.disconnect(); } catch (error) { void error; }
    }
    this._nodes.clear();
    try { this._output.disconnect(); } catch (error) { void error; }
    if (typeof this.onended === 'function') this.onended({ type: 'ended', target: this });
  }
}
