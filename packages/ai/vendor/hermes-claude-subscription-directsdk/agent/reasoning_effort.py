def clamp_effort(effort, supported, overrides=None):
    ladder = ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
    requested = str(effort or '').strip().lower()
    if not requested or not supported:
        return effort
    levels = [level for level in (str(item).strip().lower() for item in supported) if level in ladder]
    if not levels or requested in levels:
        return effort
    if overrides and overrides.get(requested) in levels:
        return overrides[requested]
    if requested not in ladder:
        return effort
    candidates = [level for level in levels if level != 'none']
    if not candidates:
        return effort
    below = [level for level in candidates if ladder.index(level) < ladder.index(requested)]
    return max(below, key=ladder.index) if below else min(candidates, key=ladder.index)
