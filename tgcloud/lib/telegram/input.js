const views = {
  skin: 'front',
  head: 'head',
  front: 'front',
  back: 'back',
  view: 'three-view',
  'three-view': 'three-view',
  '3d': '3d',
};

export function addressedQuery(message, botUsername) {
  if (typeof message.text !== 'string') return null;
  const username = botUsername.toLowerCase();
  const spans = (message.entities ?? []).filter((entity) => {
    if (!username || !Number.isInteger(entity.offset) || !Number.isInteger(entity.length)
      || entity.offset < 0 || entity.length <= 0
      || entity.offset + entity.length > message.text.length) return false;
    if (entity.type === 'mention') {
      return message.text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username}`;
    }
    return entity.type === 'text_mention' && entity.user?.is_bot === true
      && entity.user.username?.toLowerCase() === username;
  });
  let text = message.text;
  for (const entity of spans.sort((first, second) => second.offset - first.offset)) {
    text = `${text.slice(0, entity.offset)} ${text.slice(entity.offset + entity.length)}`;
  }
  text = text.trim();
  const command = text.split(/\s/, 1)[0];
  let targeted = false;
  if (command.startsWith('/') && command.includes('@')) {
    if (!username || command.split('@')[1].toLowerCase() !== username) return null;
    targeted = true;
  }
  if (message.chat.type !== 'private' && !spans.length && !targeted) return null;
  return text;
}

export function parseQuery(text) {
  const parts = text.trim().split(/\s+/);
  let view = 'front';
  if (parts.length === 2 && Object.hasOwn(views, parts[0].toLowerCase())) {
    view = views[parts.shift().toLowerCase()];
  }
  if (parts.length !== 1 || !parts[0]) return null;
  return { reference: parts[0], view };
}

export function parseCommand(text) {
  const match = /^\/(start|help|skin|head|view)(?:@[a-zA-Z0-9_]+)?(?:\s+(.+))?$/.exec(text);
  if (!match) return null;
  return { name: match[1], argument: match[2]?.trim() ?? '' };
}

export function parseCallback(data) {
  if (typeof data !== 'string') return null;
  const match = /^s:([1-9][0-9]{0,14}):(head|front|back|three-view|3d)$/.exec(data);
  return match ? { id: Number(match[1]), view: match[2] } : null;
}
