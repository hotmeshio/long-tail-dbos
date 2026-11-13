/**
 * machineUnitRoute on DBOS: one set of units through the line. Each hop parks
 * a handoff row for the receiver; a machine resolves it through the gateway,
 * a person resolves the last one on the dashboard. A hop that ends without a
 * receipt parks a row for the line's operator: retry the hop, finish the units
 * by hand, or scrap them. Units the sender finished as not ok are off the line,
 * and units split by a partial arrival are no longer all at the sender, so
 * those rows offer only manual and scrap.
 *
 * A split withdraws the receiver's job with a `cancel` command row, then a
 * person collects each group where it stopped. A cancelled handoff stops the
 * sender's started job with `stop`. Units a machine finished on hold wait for
 * the quality role: release runs the hop again, rework runs the route again
 * from a station it names, scrap ends the route.
 *
 * Same waits, signal keys and decisions as the HotMesh workflow. Each wait
 * also opens with its key as `signalKey`, so the signal-key surfaces reach it.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  DECISION, HANDOFF_ERROR, HOLD_DECISIONS, LINE_ROLE, ROW_TYPE, commandRow, handoffDecisions, signalKeys,
  type HandoffUnit, type OperatorResolution, type QualityResolution,
} from '@hotmeshio/long-tail/machines/contracts';

import { conditional, type LTAccumulatorResult, type LTEnvelope } from '../../src';
import {
  JOB_RESULT, OP, UNIT_ROUTE_WORKFLOW, hopFacets, hopRow, isMachineStep, jobIdFor, pickupRow, planHops, readHopOutcome, reworkHop, roleOf, stationKey,
  type Hop, type HopOutcome, type RouteStep, type UnitRouteInput,
} from './route';

const DEFAULT_HANDOFF_TIMEOUT = '30m';
const OPERATOR_TIMEOUT = '7d';
const PICKUP_WORKFLOW = 'machinePickup';

type HandoffResult = LTAccumulatorResult & { received?: boolean };

async function handoff(input: UnitRouteInput, hop: Hop, attempt: number, senderAttempt: number): Promise<HopOutcome> {
  const key = signalKeys.handoff(input.routeKey, hop.index, attempt);
  const result = await conditional<HandoffResult>(key, {
    ...hopRow(input, hop, attempt, senderAttempt),
    priority: 2,
    accumulate: {},
    timeout: input.handoffTimeout ?? DEFAULT_HANDOFF_TIMEOUT,
    signalKey: key,
  });
  return readHopOutcome(result, input.units.map((u) => u.unitId));
}

/** End a station's job for the route through a command row on its role: `stop` for started work, `cancel` for a job still queued. */
async function stopJob(input: UnitRouteInput, hop: Hop, attempt: number, step: RouteStep | null, jobAttempt: number, op: typeof OP.STOP | typeof OP.CANCEL): Promise<void> {
  if (!isMachineStep(step)) return;
  const target = { siteId: input.siteId, lineId: input.lineId, machineId: step.machineId, role: roleOf(input, step) };
  const key = signalKeys.jobStop(input.routeKey, hop.index, attempt);
  await conditional(key, { ...commandRow(target, op, { jobId: jobIdFor(input.routeKey, step, jobAttempt) }), signalKey: key });
}

/** One person collects one group of split units where it stopped. A child workflow, so every group's row is open at once. */
async function machinePickupFn(key: string, row: ReturnType<typeof pickupRow>): Promise<boolean> {
  const result = await conditional<HandoffResult>(key, { ...row, priority: 2, accumulate: {}, signalKey: key });
  return result?.received === true;
}

export const machinePickup = DBOS.registerWorkflow(machinePickupFn, { name: PICKUP_WORKFLOW });

/** Units split by a partial arrival: one group at the receiver, the rest where the hop started. */
function splitGroups(input: UnitRouteInput, hop: Hop, outcome: HopOutcome): { at: RouteStep; units: HandoffUnit[] }[] {
  const of = (ids: string[] = []) => input.units.filter((u) => ids.includes(u.unitId));
  return [{ at: hop.to!, units: of(outcome.arrived) }, ...(hop.from ? [{ at: hop.from, units: of(outcome.missing) }] : [])]
    .filter((g) => g.units.length);
}

/** A person collects each group where it stopped; the route ends once every group is off the line. */
async function collectSplit(input: UnitRouteInput, firstIndex: number, groups: { at: RouteStep; units: HandoffUnit[] }[]) {
  const handles = [];
  for (const [i, g] of groups.entries()) {
    const key = signalKeys.handoff(input.routeKey, firstIndex + i, 1);
    handles.push(await DBOS.startWorkflow(machinePickup, { workflowID: `${DBOS.workflowID}-pickup-${firstIndex + i}` })(key, pickupRow(input, firstIndex + i, g.at, g.units)));
  }
  const received: boolean[] = [];
  for (const handle of handles) received.push(await handle.getResult());
  return groups.map((g, i) => ({ at: stationName(g.at), units: g.units.map((u) => u.unitId), received: received[i] }));
}

/** Ask until the operator picks one of the decisions this failure allows. */
async function askOperator(input: UnitRouteInput, hop: Hop, attempt: number, senderAttempt: number, outcome: HopOutcome): Promise<OperatorResolution> {
  const where = stationName(hop.from, 'line entry');
  const decisions = handoffDecisions(outcome.errorCode);
  let refused = '';
  for (let round = 1; ; round++) {
    const key = signalKeys.handoffError(input.routeKey, hop.index, attempt, round);
    const answer = await conditional<OperatorResolution>(key, {
      role: input.operatorRole ?? LINE_ROLE.OPERATOR,
      type: ROW_TYPE.HANDOFF_ERROR,
      subtype: outcome.errorCode,
      description: `${refused}${unitList(input)} stopped at ${where}: ${outcome.errorCode}. ${outcome.detail ?? ''} Choose ${decisions.join(', ')}.`.replace(/\s+/g, ' ').trim(),
      priority: 1,
      metadata: { ...hopFacets(input, hop, attempt, senderAttempt), errorCode: outcome.errorCode, detail: outcome.detail ?? null, decisions, round },
      timeout: input.operatorTimeout ?? OPERATOR_TIMEOUT,
      signalKey: key,
    });
    if (!answer) return { decision: DECISION.SCRAP, note: 'no decision before the timeout' };
    if (decisions.includes(answer.decision)) return answer;
    refused = `${answer.decision} is not available here. `;
  }
}

/** Ask the quality role what to do with units the sender finished on hold. */
async function askQuality(input: UnitRouteInput, hop: Hop, attempt: number, senderAttempt: number, outcome: HopOutcome): Promise<QualityResolution> {
  const where = stationName(hop.from, 'line entry');
  let refused = '';
  for (let round = 1; ; round++) {
    const key = signalKeys.hold(input.routeKey, hop.index, attempt, round);
    const answer = await conditional<QualityResolution>(key, {
      role: input.qualityRole ?? LINE_ROLE.QUALITY,
      type: ROW_TYPE.QUALITY_HOLD,
      subtype: JOB_RESULT.HOLD,
      description: `${refused}${unitList(input)} held at ${where}. ${outcome.detail ?? ''} Choose ${HOLD_DECISIONS.join(', ')}.`.replace(/\s+/g, ' ').trim(),
      priority: 1,
      metadata: {
        ...hopFacets(input, hop, attempt, senderAttempt), errorCode: outcome.errorCode, result: outcome.result, detail: outcome.detail ?? null, decisions: HOLD_DECISIONS, round,
      },
      timeout: input.operatorTimeout ?? OPERATOR_TIMEOUT,
      signalKey: key,
    });
    if (!answer) return { decision: DECISION.SCRAP, note: 'no decision before the timeout' };
    if (HOLD_DECISIONS.includes(answer.decision)) return answer;
    refused = `${answer.decision} is not available here. `;
  }
}

/** Tell the holding machine the decision, when its codec has a command for it. */
async function sendDisposition(input: UnitRouteInput, hop: Hop, attempt: number, senderAttempt: number, quality: QualityResolution): Promise<void> {
  if (!input.dispositionOp || !isMachineStep(hop.from)) return;
  const target = { siteId: input.siteId, lineId: input.lineId, machineId: hop.from.machineId, role: roleOf(input, hop.from) };
  const args = { jobId: jobIdFor(input.routeKey, hop.from, senderAttempt), unitIds: input.units.map((u) => u.unitId), decision: quality.decision, note: quality.note ?? null };
  const key = signalKeys.disposition(input.routeKey, hop.index, attempt);
  await conditional(key, { ...commandRow(target, input.dispositionOp, args), signalKey: key });
}

function stationName(step: RouteStep | null, end = 'exit'): string {
  return step ? stationKey(step) : end;
}

const unitList = (input: UnitRouteInput) => input.units.map((u) => u.unitId).join(', ');

async function machineUnitRouteFn(envelope: LTEnvelope<UnitRouteInput>) {
  const input = envelope.data;
  const hops = planHops(input.steps);
  const history: Record<string, unknown>[] = [];
  const ended = (status: string, at: RouteStep | null, extra: Record<string, unknown> = {}) =>
    ({ data: { status, at: stationName(at, 'entry'), ...extra, history } });

  // The attempt that brought the units to the current sender: its job is the one to release them.
  let senderAttempt = 1;
  // Every attempt of a hop mints a fresh signal key, across reruns of the hop after a rework.
  const attempts = new Map<number, number>();
  const nextAttempt = (hop: Hop) => {
    const n = (attempts.get(hop.index) ?? 0) + 1;
    attempts.set(hop.index, n);
    return n;
  };
  for (let h = 0; h < hops.length; ) {
    const hop = hops[h];
    let next = h + 1;
    for (;;) {
      const attempt = nextAttempt(hop);
      const outcome = await handoff(input, hop, attempt, senderAttempt);
      history.push({ hop: hop.index, to: stationName(hop.to), attempt, ...outcome });
      if (outcome.received) {
        senderAttempt = attempt;
        break;
      }
      if (outcome.errorCode === HANDOFF_ERROR.SENDER_REJECTED && outcome.result === JOB_RESULT.HOLD && hop.from) {
        const quality = await askQuality(input, hop, attempt, senderAttempt, outcome);
        await sendDisposition(input, hop, attempt, senderAttempt, quality);
        history.push({ hop: hop.index, held: true, decision: quality.decision, station: quality.station ?? null });
        if (quality.decision === DECISION.RELEASE) continue;
        if (quality.decision === DECISION.REWORK) {
          // The units run again from the station named, carried there from the holding machine.
          const again = reworkHop(hops, hop, quality.station);
          if (again.index === hop.index) continue;
          hops[again.index] = { ...again, from: hop.from };
          next = again.index;
          break;
        }
        return ended('scrapped', hop.from, { note: quality.note });
      }
      // The sender's job is started work: its units are there. The receiver's never started: not every unit arrived.
      if (outcome.errorCode === HANDOFF_ERROR.CANCELLED) await stopJob(input, hop, attempt, hop.from, senderAttempt, OP.STOP);
      const { decision, note } = await askOperator(input, hop, attempt, senderAttempt, outcome);
      if (decision === DECISION.RETRY) continue;
      if (outcome.errorCode === HANDOFF_ERROR.PARTIAL_ARRIVAL && hop.to) {
        await stopJob(input, hop, attempt, hop.to, attempt, OP.CANCEL);
        if (decision === DECISION.SCRAP) return ended('scrapped', hop.from, { note });
        const pickups = await collectSplit(input, hops.length, splitGroups(input, hop, outcome));
        return ended('manual', hop.from, { received: pickups.every((p) => p.received), pickups, note });
      }
      if (decision === DECISION.MANUAL) {
        // The units leave automation; a person takes them from where they stopped.
        const manual = await handoff(input, { index: hops.length, from: hop.from, to: null }, 1, senderAttempt);
        return ended('manual', hop.from, { received: manual.received, note });
      }
      return ended('scrapped', hop.from, { note });
    }
    h = next;
  }
  return { data: { status: 'complete', units: input.units.map((u) => u.unitId), history } };
}

export const machineUnitRoute = DBOS.registerWorkflow(machineUnitRouteFn, { name: UNIT_ROUTE_WORKFLOW });
