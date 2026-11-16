import {fail} from './errors.mjs';

// ElevenLabs speaks the agent's voice notes (Ogg Opus, Telegram's voice format) and transcribes received ones.
// The key appears only in a request header and never in an error.
export class Voice {
  constructor(config, options = {}) {
    this.config = config;
    this.base = options.base ?? 'https://api.elevenlabs.io';
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  async request(path, init, timeoutMs) {
    let response;
    try { response = await this.fetch(`${this.base}${path}`, {...init, headers: {'xi-api-key': this.config.elevenlabsApiKey, ...init.headers}, signal: AbortSignal.timeout(timeoutMs)}); }
    catch { throw fail('VOICE_UNAVAILABLE', 'ElevenLabs did not answer', 2, {definitive: false}); }
    // A refused request (4xx) definitely made nothing; a 5xx may be retried.
    if (!response.ok) throw fail('VOICE_REJECTED', `ElevenLabs answered ${response.status}`, 2, {definitive: response.status < 500, providerCode: response.status});
    return response;
  }
  async speak(text) {
    const response = await this.request(`/v1/text-to-speech/${this.config.voiceId}?output_format=opus_48000_64`,
      {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text, model_id: this.config.model})}, 60000);
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.subarray(0, 4).toString() !== 'OggS') throw fail('VOICE_RESPONSE', 'ElevenLabs did not return Ogg audio', 2, {definitive: false});
    return audio;
  }
  async transcribe(bytes, name = 'voice.ogg') {
    const form = new FormData();
    form.set('model_id', 'scribe_v1');
    form.set('file', new Blob([bytes]), name);
    const result = await (await this.request('/v1/speech-to-text', {method: 'POST', body: form}, 120000)).json();
    if (typeof result?.text !== 'string') throw fail('VOICE_RESPONSE', 'ElevenLabs returned no transcript', 2, {definitive: false});
    return result.text.trim();
  }
}
