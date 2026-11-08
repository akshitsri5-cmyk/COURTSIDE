// Configurable basketball rulesets. FIBA is the default. Rule thresholds that come from the
// rulebook (timing, steps, court) are separated from detector heuristics (`analysis`), which are
// engineering parameters that must be tuned/validated on labelled footage.
import { FIBA_COURT } from '../court-model.js';

export const FIBA = {
  id: 'FIBA', name: 'FIBA Official Basketball Rules (2024)',
  court: FIBA_COURT,
  timing: { periods: 4, periodSec: 600, overtimeSec: 300, shotClock: 24, shotClockOffensiveRebound: 14, stopClockAfterMadeBasketLastSec: 120, stopClockAfterMadeBasketPeriods: [4, 'OT'] },
  travelling: { stepsAfterGather: 2, allowZeroStep: true },          // Art. 25
  dribble: { doubleDribbleEnabled: true },                           // Art. 24
  fouls: { noChargeSemiCircle: true, personalFoulLimit: 5, teamFoulPenalty: 4 }, // Art. 33.10, 40, 41
  scoring: { threePoint: 3, fieldGoal: 2, freeThrow: 1 },
  analysis: {
    // decision thresholds: evidence scores are heuristic (uncalibrated) until validated on labelled footage
    autoScoreMinConfidence: 0.85, flagMinConfidence: 0.65,
    possessionContactDist: 0.12, possessionMinFrames: 2, controlLossSec: 0.3, gatherHoldSec: 0.35,
    shotMinUpwardSpeed: 1.2, contactDist: 0.035, contactMaxCourtDist: 0.8, impactDeltaV: 1.2,
    defenderStationarySpeed: 0.6, screenerMovingSpeed: 0.6, carryMinContactSec: 0.3, carryHandBelow: 0.4,
    boundaryUncertaintyMin: 0.08, threePointUncertaintyMin: 0.12,
  },
};

export const NBA = {
  ...FIBA, id: 'NBA', name: 'NBA (court & timing only — rule logic still FIBA-based)',
  court: { ...FIBA_COURT, name: 'NBA', length: 28.65, width: 15.24, threePointR: 7.24, threePointSideDist: 0.91, keyWidth: 4.88, ftLineFromEndline: 5.79, noChargeR: 1.22, centreCircleR: 1.83 },
  timing: { ...FIBA.timing, periodSec: 720, stopClockAfterMadeBasketLastSec: 120, stopClockAfterMadeBasketPeriods: [4, 'OT'] },
  fouls: { ...FIBA.fouls, personalFoulLimit: 6, teamFoulPenalty: 5 },
};

// Half-court formats (the only mode COURTSIDE currently targets)
export const FIBA_3X3 = {
  ...FIBA, id: '3X3', name: 'FIBA 3x3 half court (1 & 2 pts, to 21)',
  timing: { ...FIBA.timing, periods: 1, periodSec: 600, overtimeSec: 600, shotClock: 12, shotClockOffensiveRebound: 12, stopClockAfterMadeBasketLastSec: 60 },
  scoring: { threePoint: 2, fieldGoal: 1, freeThrow: 1 }, winScore: 21,
  fouls: { ...FIBA.fouls, teamFoulPenalty: 7 },
};
// 1v1 half court (current focus): two players, 1 & 2 points, first to 11, 12 s shot clock.
export const ONE_V_ONE = {
  ...FIBA_3X3, id: '1V1', name: '1v1 half court (1 & 2 pts, to 11)', winScore: 11, oneOnOne: true,
  sideNames: { home: 'PLAYER A', away: 'PLAYER B' },
};
export const HALF_2_3 = {
  ...FIBA, id: 'HALF23', name: 'Half court, 2 & 3 pts (FIBA lines)',
  timing: { ...FIBA.timing, periods: 1, periodSec: 600, overtimeSec: 300, stopClockAfterMadeBasketLastSec: 60 }, winScore: null,
};
export const RULESETS = { '1V1': ONE_V_ONE, '3X3': FIBA_3X3, HALF23: HALF_2_3, FIBA, NBA };
export function getRuleset(id = '1V1', overrides = {}) {
  const base = RULESETS[id] || FIBA;
  return { ...base, ...overrides, analysis: { ...base.analysis, ...(overrides.analysis || {}) }, timing: { ...base.timing, ...(overrides.timing || {}) } };
}
