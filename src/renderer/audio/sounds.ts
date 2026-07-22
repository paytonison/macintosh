type Note = { frequency: number; start: number; duration: number; gain: number };

let audioContext: AudioContext | null = null;

const context = (): AudioContext | null => {
  try {
    audioContext ??= new AudioContext();
    return audioContext;
  } catch {
    return null;
  }
};

const playNotes = (notes: Note[], wave: OscillatorType = 'square'): void => {
  const audio = context();
  if (!audio) return;
  if (audio.state === 'suspended') void audio.resume();
  const origin = audio.currentTime + 0.015;
  for (const note of notes) {
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(note.frequency, origin + note.start);
    envelope.gain.setValueAtTime(0.0001, origin + note.start);
    envelope.gain.exponentialRampToValueAtTime(note.gain, origin + note.start + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, origin + note.start + note.duration);
    oscillator.connect(envelope);
    envelope.connect(audio.destination);
    oscillator.start(origin + note.start);
    oscillator.stop(origin + note.start + note.duration + 0.02);
  }
};

export const playStartupSound = (): void =>
  playNotes(
    [
      { frequency: 523.25, start: 0, duration: 0.12, gain: 0.035 },
      { frequency: 659.25, start: 0.1, duration: 0.14, gain: 0.035 },
      { frequency: 783.99, start: 0.21, duration: 0.22, gain: 0.04 },
    ],
    'triangle',
  );

export const playMenuTick = (): void =>
  playNotes([{ frequency: 1100, start: 0, duration: 0.025, gain: 0.018 }]);

export const playEjectSound = (): void =>
  playNotes([
    { frequency: 740, start: 0, duration: 0.08, gain: 0.045 },
    { frequency: 554, start: 0.08, duration: 0.08, gain: 0.045 },
    { frequency: 392, start: 0.16, duration: 0.13, gain: 0.05 },
    { frequency: 196, start: 0.3, duration: 0.2, gain: 0.04 },
  ]);
