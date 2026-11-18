// SPDX-License-Identifier: GPL-3.0-only OR AGPL-3.0-only
// Copyright (C) 2026 Melow Studio

const EQUALIZER_FREQUENCIES = [
  25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000,
];

const FILTER_NAMES = [
  'volume',
  'equalizer',
  'timescale',
  'karaoke',
  'tremolo',
  'vibrato',
  'lowPass',
  'highPass',
  'rotation',
  'channelMix',
];

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`"${label}" must be an object`);
  }
}

function assertNumber(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`"${label}" must be a number from ${min} to ${max}`);
  }
}

function hasValue(value) {
  return value !== undefined && value !== null;
}

function formatNumber(value) {
  return String(Number(value.toFixed(6)));
}

function validateFilterObject(filters) {
  assertObject(filters, 'filters');
  for (const key of Object.keys(filters)) {
    if (!FILTER_NAMES.includes(key)) throw new Error(`Unsupported audio filter "${key}"`);
  }
}

function addVolume(filters, output) {
  if (!hasValue(filters.volume)) return;
  assertNumber(filters.volume, 'volume', 0, 5);
  output.push(`volume=${formatNumber(filters.volume)}`);
}

function addEqualizer(filters, output) {
  if (!hasValue(filters.equalizer)) return;
  if (!Array.isArray(filters.equalizer)) throw new Error('"equalizer" must be an array');
  const bands = new Set();
  for (const band of filters.equalizer) {
    assertObject(band, 'equalizer band');
    if (!Number.isInteger(band.band) || band.band < 0 ||
        band.band >= EQUALIZER_FREQUENCIES.length) {
      throw new Error('"equalizer band" must be an integer from 0 to 14');
    }
    if (bands.has(band.band)) throw new Error(`Duplicate equalizer band ${band.band}`);
    bands.add(band.band);
    assertNumber(band.gain, 'equalizer gain', -0.25, 1);
    if (band.gain !== 0) {
      const gainDb = band.gain * 12;
      output.push(
        `equalizer=f=${EQUALIZER_FREQUENCIES[band.band]}:t=q:w=1:g=${formatNumber(gainDb)}`,
      );
    }
  }
}

function addTimescale(filters, output) {
  if (!hasValue(filters.timescale)) return;
  assertObject(filters.timescale, 'timescale');
  const { speed = 1, pitch = 1, rate = 1 } = filters.timescale;
  for (const [name, value] of Object.entries({ speed, pitch, rate })) {
    assertNumber(value, `timescale.${name}`, 0.01, 5);
  }

  const sampleRateFactor = pitch * rate;
  if (sampleRateFactor !== 1) {
    output.push(`asetrate=48000*${formatNumber(sampleRateFactor)}`);
    output.push('aresample=48000');
  }
  const tempo = speed / sampleRateFactor;
  if (Math.abs(tempo - 1) > 0.000001) {
    let remaining = tempo;
    while (remaining > 2) {
      output.push('atempo=2');
      remaining /= 2;
    }
    while (remaining < 0.5) {
      output.push('atempo=0.5');
      remaining /= 0.5;
    }
    output.push(`atempo=${formatNumber(remaining)}`);
  }
}

function addKaraoke(filters, output) {
  if (!hasValue(filters.karaoke)) return;
  assertObject(filters.karaoke, 'karaoke');
  const {
    level = 1,
    monoLevel = 1,
    filterBand = 220,
    filterWidth = 100,
  } = filters.karaoke;
  assertNumber(level, 'karaoke.level', 0, 1);
  assertNumber(monoLevel, 'karaoke.monoLevel', 0, 1);
  assertNumber(filterBand, 'karaoke.filterBand', 0, 20000);
  assertNumber(filterWidth, 'karaoke.filterWidth', 0, 20000);
  const center = 1 - level;
  output.push(
    `pan=stereo|c0=${formatNumber(monoLevel)}*FL-${formatNumber(center)}*FR|c1=${formatNumber(monoLevel)}*FR-${formatNumber(center)}*FL`,
  );
  if (filterWidth > 0) {
    const lower = Math.max(20, filterBand - filterWidth / 2);
    const upper = Math.min(20000, filterBand + filterWidth / 2);
    if (upper > lower) {
      output.push(`bandreject=f=${formatNumber((lower + upper) / 2)}:w=${formatNumber(upper - lower)}`);
    }
  }
}

function addTremolo(filters, output) {
  if (!hasValue(filters.tremolo)) return;
  assertObject(filters.tremolo, 'tremolo');
  const { frequency = 2, depth = 0.5 } = filters.tremolo;
  assertNumber(frequency, 'tremolo.frequency', 0.1, 20);
  assertNumber(depth, 'tremolo.depth', 0, 1);
  output.push(`tremolo=f=${formatNumber(frequency)}:d=${formatNumber(depth)}`);
}

function addVibrato(filters, output) {
  if (!hasValue(filters.vibrato)) return;
  assertObject(filters.vibrato, 'vibrato');
  const { frequency = 2, depth = 0.5 } = filters.vibrato;
  assertNumber(frequency, 'vibrato.frequency', 0.1, 14);
  assertNumber(depth, 'vibrato.depth', 0, 1);
  output.push(`vibrato=f=${formatNumber(frequency)}:d=${formatNumber(depth)}`);
}

function addPassFilter(filters, output, key, filterName) {
  if (!hasValue(filters[key])) return;
  assertObject(filters[key], key);
  const { smoothing = 20 } = filters[key];
  assertNumber(smoothing, `${key}.smoothing`, 0, 20000);
  const frequency = Math.max(20, smoothing);
  output.push(`${filterName}=f=${formatNumber(frequency)}`);
}

function addRotation(filters, output) {
  if (!hasValue(filters.rotation)) return;
  assertObject(filters.rotation, 'rotation');
  const { rotationHz = 0 } = filters.rotation;
  assertNumber(rotationHz, 'rotation.rotationHz', 0, 10);
  if (rotationHz > 0) {
    const hz = formatNumber(rotationHz);
    output.push(
      `aeval=exprs=val(0)*cos(2*PI*${hz}*t)-val(1)*sin(2*PI*${hz}*t)|val(0)*sin(2*PI*${hz}*t)+val(1)*cos(2*PI*${hz}*t)`,
    );
  }
}

function addChannelMix(filters, output) {
  if (!hasValue(filters.channelMix)) return;
  assertObject(filters.channelMix, 'channelMix');
  const {
    leftToLeft = 1,
    leftToRight = 0,
    rightToLeft = 0,
    rightToRight = 1,
  } = filters.channelMix;
  for (const [name, value] of Object.entries({
    leftToLeft,
    leftToRight,
    rightToLeft,
    rightToRight,
  })) {
    assertNumber(value, `channelMix.${name}`, -2, 2);
  }
  const expression = (left, right) => [
    left === 0 ? '' : `${left < 0 ? '-' : ''}${formatNumber(Math.abs(left))}*FL`,
    right === 0 ? '' : `${right < 0 ? '-' : ''}${formatNumber(Math.abs(right))}*FR`,
  ].filter(Boolean).join('+').replace(/\+-/g, '-') || '0';
  output.push(`pan=stereo|c0=${expression(leftToLeft, rightToLeft)}|c1=${expression(leftToRight, rightToRight)}`);
}

export function buildAudioFilterChain(filters = {}) {
  validateFilterObject(filters);
  const output = [];
  addVolume(filters, output);
  addEqualizer(filters, output);
  addTimescale(filters, output);
  addKaraoke(filters, output);
  addTremolo(filters, output);
  addVibrato(filters, output);
  addPassFilter(filters, output, 'lowPass', 'lowpass');
  addPassFilter(filters, output, 'highPass', 'highpass');
  addRotation(filters, output);
  addChannelMix(filters, output);
  return output;
}

export function activeFilterNames(filters = {}) {
  validateFilterObject(filters);
  return FILTER_NAMES.filter((name) => {
    if (!hasValue(filters[name])) return false;
    if (name === 'volume') return filters.volume !== 1;
    if (name === 'equalizer') {
      return filters.equalizer.some((band) => band.gain !== 0);
    }
    if (name === 'timescale') {
      const { speed = 1, pitch = 1, rate = 1 } = filters.timescale;
      return speed !== 1 || pitch !== 1 || rate !== 1;
    }
    if (name === 'rotation') return (filters.rotation.rotationHz ?? 0) > 0;
    return true;
  });
}

export const SUPPORTED_FILTERS = Object.freeze([...FILTER_NAMES]);
export const LAVALINK_FILTERS = Object.freeze([
  'volume',
  'equalizer',
  'karaoke',
  'timescale',
  'tremolo',
  'vibrato',
  'rotation',
  'channelMix',
  'lowPass',
]);
export const MELINK_ONLY_FILTERS = Object.freeze(['highPass']);
