import { api } from 'sdk';

export async function botIdentity() {
  const user = await api.getMe();
  if (!Number.isSafeInteger(user?.id) || user.id <= 0 || user.id >= 2 ** 52
    || user.is_bot !== true || (user.username !== undefined
      && (typeof user.username !== 'string' || !/^[a-zA-Z0-9_]{5,32}$/u.test(user.username)))) {
    throw new Error('Invalid Bot API identity.');
  }
  return { id: user.id, username: user.username ?? '' };
}
