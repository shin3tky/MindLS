export {
  SEPARATORS,
  PARTICLES,
  isSeparator,
  isHiragana,
  foldWidthAndCase,
  analyzeWord,
  normalize,
  splitParticle,
  isNegativeForm,
} from './normalizer.js';
export type { WordAnalysis, ParticleSplit } from './normalizer.js';
