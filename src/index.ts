export { conditional, waitSeconds } from './conditional';
export { configureLongTail } from './config';
export { LongTailRequestError } from './lt-client';
export { toMs } from './duration';
export { STEP, WAIT_DEFAULTS } from './constants';
export type {
  LTAccumulateConfig, LTAccumulatedItem, LTAccumulatorResult, LTBatchMarkers, LTCollectionConfig,
  LTConditionalConfig, LTEnvelope, LTFilledEntry, LTWaitOutcome, LongTailConnection, OpenedWait,
} from './types';
