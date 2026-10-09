import { BotApiError } from 'sdk';
import { MinecraftError } from '../minecraft/errors.js';
import { translate } from './i18n.js';

export function lookupErrorText(error, locale) {
  if (!(error instanceof MinecraftError)) throw error;
  if (error.code === 'INVALID_REFERENCE') return translate(locale, 'invalidReference');
  if (error.code === 'NOT_FOUND') return translate(locale, 'playerNotFound');
  return translate(locale, 'busy');
}

// Telegram sends no parameter distinguishing these 400 sub-cases (only 429 carries
// `retry_after`): `.code` decides, the description only refines it.
function failureText(error) {
  const text = typeof error.description === 'string' ? error.description : '';
  return text.toLowerCase().replace(/^bad request:\s*/u, '').trim();
}

function badRequest(error) {
  return error instanceof BotApiError && error.code === 400;
}

export function floodLimited(error) {
  return error instanceof BotApiError && error.code === 429;
}

export function expiredQuery(error) {
  if (!badRequest(error)) return false;
  const text = failureText(error);
  return text.startsWith('query is too old') || text.startsWith('query id is invalid')
    || text.startsWith('response timeout expired');
}

export function unchangedEdit(error) {
  return badRequest(error) && failureText(error).startsWith('message is not modified');
}

export function unavailableEdit(error) {
  return badRequest(error)
    && ["message can't be edited", 'message to edit not found'].includes(failureText(error));
}

export function staleFileReference(error) {
  if (!badRequest(error)) return false;
  const text = failureText(error);
  return ['wrong file identifier', 'wrong remote file identifier', 'wrong remote file id', 'file reference expired']
    .some((prefix) => text.startsWith(prefix));
}
