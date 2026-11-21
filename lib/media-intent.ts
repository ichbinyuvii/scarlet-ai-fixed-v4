export function imageIntent(text: string) {
  const request = text
    .trim()
    .replace(
      /^(?:(?:hey\s+)?s\.?c\.?a\.?r\.?l\.?e\.?t\.?[,!:\s]+)?(?:please\s+)?/i,
      "",
    );
  if (/^(?:draw|paint|illustrate|render|sketch)\b/i.test(request)) return true;
  return (
    /^(?:can you\s+)?(?:generate|create|make|design)\b/i.test(request) &&
    /\b(image|picture|photo|portrait|illustration|thumbnail|logo|poster|concept car|wallpaper|artwork|photograph|icon|landscape|scenery|painting|drawing|cartoon|banner|avatar)\b/i.test(
      request,
    ) &&
    !/^(?:generate|create|make|design)\s+(?:(?:me\s+)?an?\s+)?(?:prompt|caption|description|script|function|app|website)\b/i.test(
      request,
    )
  );
}
