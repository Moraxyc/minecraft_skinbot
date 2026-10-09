const messages = {
  en: {
    sharedSkin: 'Shared Minecraft skin',
    model: 'Model',
    classic: 'Classic',
    slim: 'Slim',
    unknown: 'Unknown',
    head: 'Head',
    front: 'Front',
    back: 'Back',
    'three-view': 'Three-view',
    '3d': 'Open 3D',
    original: 'Original skin',
    skin: 'Original skin',
    cape: 'Original cape',
    share: 'Share',
    help: 'Send <code>Notch</code> or a Minecraft UUID to look up a skin.\nUse <code>head Notch</code> or <code>view Notch</code> to choose a view.\nIn groups and channels, mention this bot before the query.\nView buttons change the preview of a fixed skin; Original skin sends its unchanged PNG. Open 3D for layers, cape and animation.',
    inlineHelp: 'Use <code>@{botUsername} Notch</code> to share cached previews and the original PNG. If a view is being prepared, repeat the query.',
    preparing: 'Preparing missing previews. Repeat the inline query in a moment.',
    unsupportedBytes: 'The server cannot read PNG bytes from this texture transport. No preview was uploaded.',
    unsupportedPreview: 'This texture is not a supported 64×32 or 64×64 skin PNG.',
    cacheUnconfigured: 'Configure a cache group or channel ID where this bot can upload photos and documents.',
    cachePermission: 'The bot cannot upload to its cache chat. Check membership and photo/document permissions.',
    invalidReference: 'Send a Minecraft username (3–16 letters, numbers or underscores), UUID, or fixed skin reference.',
    playerNotFound: 'No Minecraft profile was found for this name or UUID.',
    skinUnavailable: 'This Minecraft profile has no usable skin.',
    busy: 'The skin service is busy. Try again in a moment.',
    actionUnavailable: 'This skin link is unavailable. Send the player name again.',
    unconfigured: 'The bot\'s Telegram-hosted viewer URL has not been configured.',
    errorTitle: 'Skin unavailable',
  },
  'zh-Hans': {
    sharedSkin: '分享的 Minecraft 皮肤',
    model: '模型',
    classic: '经典',
    slim: '纤细',
    unknown: '未知',
    head: '头像',
    front: '正面',
    back: '背面',
    'three-view': '三视图',
    '3d': '打开 3D',
    original: '原始皮肤',
    skin: '原始皮肤',
    cape: '原始披风',
    share: '分享',
    help: '发送 <code>Notch</code> 或 Minecraft UUID 查询皮肤。\n使用 <code>head Notch</code> 或 <code>view Notch</code> 选择视图。\n在群组和频道中，请先提及此 Bot。\n视图按钮切换固定皮肤的预览；原始皮肤提供未经修改的 PNG。打开 3D 后可使用图层、披风和动画。',
    inlineHelp: '使用 <code>@{botUsername} Notch</code> 分享缓存预览与原始 PNG。若视图正在准备，请稍后重复查询。',
    preparing: '正在准备缺失的预览，请稍后重复 Inline 查询。',
    unsupportedBytes: '服务端无法通过当前传输读取 PNG 字节，未上传预览。',
    unsupportedPreview: '此纹理不是受支持的 64×32 或 64×64 皮肤 PNG。',
    cacheUnconfigured: '请配置允许此 Bot 上传照片和文件的缓存群组或频道 ID。',
    cachePermission: '此 Bot 无法向缓存聊天上传文件，请检查成员身份及照片、文件权限。',
    invalidReference: '请发送 Minecraft 用户名（3–16 个字母、数字或下划线）、UUID 或固定皮肤引用。',
    playerNotFound: '找不到对应用户名或 UUID 的 Minecraft 玩家。',
    skinUnavailable: '此 Minecraft 玩家没有可用的皮肤。',
    busy: '皮肤服务繁忙，请稍后再试。',
    actionUnavailable: '此皮肤链接不可用，请重新发送玩家名称。',
    unconfigured: '此 Bot 尚未配置 Telegram 托管的查看器地址。',
    errorTitle: '皮肤不可用',
  },
};

export function localeFromUser(user) {
  const tag = (user?.language_code ?? '').replaceAll('_', '-').toLowerCase();
  const parts = tag.split('-');
  if (parts[0] === 'zh' && !parts.includes('hant')) {
    if (parts.includes('hans') || tag === 'zh' || /^(zh-cn|zh-sg)$/.test(tag)) {
      return 'zh-Hans';
    }
  }
  return 'en';
}

export function translate(locale, key) {
  return (messages[locale] ?? messages.en)[key];
}
