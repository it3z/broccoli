import balanceJson from '../../content/balance/balance.json';
import springMeadow from '../../content/maps/spring_meadow.json';
import deepForest from '../../content/maps/deep_forest.json';
import type { Balance, MapDef } from './types';

export * from './types';
export { Match } from './sim';
export { AIController, type Difficulty } from './ai';
export { Rng } from './rng';
export { B_PASS, buildNetwork, buildPaths, pointAt, segHitsCircle, type Network, type Path } from './paths';

export const BALANCE = balanceJson as Balance;
export const MAPS: MapDef[] = [springMeadow as MapDef, deepForest as MapDef];
