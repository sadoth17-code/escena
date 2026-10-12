import { renderPitchChannels } from './pitch-dsp.js';

self.onmessage = async ({ data }) => {
  try {
    const channels = await renderPitchChannels(data.channels, data.sampleRate, data.semitones,
      progress => self.postMessage({ progress }));
    self.postMessage({ channels }, channels.map(channel => channel.buffer));
  } catch (error) {
    self.postMessage({ error: error.message || 'No se pudo procesar el audio' });
  }
};
