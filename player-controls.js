/**
 * Screen-space aim assistance for the existing world X/Y gameplay plane.
 * This module never mutates gameplay state or adds range/force to a shot.
 */
const EPSILON = 1e-8;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const hasPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const nonnegative = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;

function direction(x, y, fallback) {
  const length = Math.hypot(x, y);
  return Number.isFinite(length) && length > EPSILON
    ? { aimX: x / length, aimY: y / length, targetId: null }
    : { ...fallback };
}

function projectPoint(project, actor, height) {
  if (typeof project !== 'function') return null;
  try {
    const point = project(actor.x, actor.y, height);
    return hasPoint(point) && point.visible !== false ? point : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a unit aim direction and optional assisted target.
 * pointer is { x, y, valid } in client pixels, project(x, y, height) returns
 * client pixels, and screenToWorld(clientX, clientY) returns a floor X/Y point.
 * Holding the auto-fire key selects the nearest in-range living opponent;
 * manual assistance corrects the floor-ray parallax when aiming at its body.
 */
export function resolveAim(state, {
  pointer = null,
  project,
  screenToWorld,
  assist = true,
  auto = false
} = {}) {
  const actors = Array.isArray(state?.actors) ? state.actors : [];
  const player = state?.player || actors.find(actor => actor.isPlayer) || actors[0];
  const angle = Number.isFinite(player?.angle) ? player.angle : 0;
  const fallback = { aimX: Math.cos(angle), aimY: Math.sin(angle), targetId: null };
  if (!player || !hasPoint(player) || player.alive === false) return fallback;

  const params = state?.params || state?.config || {};
  // The core's beam starts at the muzzle and hits the actor's collision circle.
  const reach = nonnegative(player.weapon?.range, nonnegative(params.range, 5))
    + nonnegative(params.muzzleOffset, .35)
    + nonnegative(params.actorRadius, .35);
  const candidates = actors.filter(actor => actor !== player && actor.id !== player.id
    && actor.alive === true && hasPoint(actor)).map(actor => ({
      actor, distance: Math.hypot(actor.x - player.x, actor.y - player.y)
    })).filter(candidate => candidate.distance > EPSILON && candidate.distance <= reach + EPSILON);

  if (auto) {
    const nearest = candidates.reduce((best, candidate) =>
      !best || candidate.distance < best.distance ? candidate : best, null);
    if (!nearest) return fallback;
    const aim = direction(nearest.actor.x - player.x, nearest.actor.y - player.y, fallback);
    return { ...aim, targetId: nearest.actor.id ?? null };
  }

  if (!pointer?.valid || !hasPoint(pointer)) return fallback;
  let manual = fallback;
  if (typeof screenToWorld === 'function') {
    try {
      const floorPoint = screenToWorld(pointer.x, pointer.y);
      if (hasPoint(floorPoint)) manual = direction(floorPoint.x - player.x, floorPoint.y - player.y, fallback);
    } catch { /* Keep the last usable facing when the camera cannot intersect the floor. */ }
  }
  if (!assist) return manual;

  let selected = null;
  for (const candidate of candidates) {
    const center = projectPoint(project, candidate.actor, 1.1);
    if (!center) continue;
    const foot = projectPoint(project, candidate.actor, 0);
    const top = projectPoint(project, candidate.actor, 2.12);
    const bodyPixels = foot && top ? Math.hypot(top.x - foot.x, top.y - foot.y) : 68;
    const proximity = reach > EPSILON ? 1 - candidate.distance / reach : 0;
    // Scale with the rendered character instead of using a large invisible cone.
    const radius = clamp(bodyPixels * .48 + 5 + proximity * 8, 24, 55);
    const screenDistance = Math.hypot(pointer.x - center.x, pointer.y - center.y);
    if (screenDistance > radius) continue;
    if (!selected || screenDistance < selected.screenDistance
      || (Math.abs(screenDistance - selected.screenDistance) <= EPSILON
        && candidate.distance < selected.distance)) {
      selected = { ...candidate, screenDistance };
    }
  }
  if (!selected) return manual;
  const aim = direction(selected.actor.x - player.x, selected.actor.y - player.y, manual);
  return { ...aim, targetId: selected.actor.id ?? null };
}
