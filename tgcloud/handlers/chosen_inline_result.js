import { bindChosenInlineResult } from '../lib/telegram/card-state.js';

export default async function chosenInlineResult(result) {
  await bindChosenInlineResult(result);
}
