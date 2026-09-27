/*:
 * @target MZ
 * @plugindesc Enemy symbols flee instead of chasing when the party is high-level.
 * @author
 *
 * @param levelThreshold
 * @type number
 * @default 99
 * @desc Party level at/above which monsters flee.
 *
 * @param checkType
 * @type select
 * @option average
 * @option leader
 * @option lowest
 * @default leader
 * @desc Which party stat to compare against levelThreshold.
 *
 * @param sensorTag
 * @type string
 * @default PsensorF
 * @desc Note tag (without <>: or value) that marks an event as an enemy symbol.
 *
 * @param reactionDistance
 * @type number
 * @default 0
 * @desc Manhattan tiles the player must be within for fear to apply. 0 = always active (ignore distance).
 *
 * @param reactionDistanceDashBonus
 * @type number
 * @default 2
 * @desc Extra tiles added to reactionDistance while the player is dashing. Ignored if reactionDistance is 0.
 *
 * @param fleeSpeed
 * @type number
 * @default 0
 * @desc Move speed (1-6) applied to a symbol while it's fleeing. 0 = don't change speed.
 *
 * @param fleeFrequency
 * @type number
 * @default 0
 * @desc Move frequency (1-5) applied to a symbol while it's fleeing. 0 = don't change frequency.
 *
 * @param fleeBalloonId
 * @type number
 * @default 1
 * @desc Balloon icon shown once when an event starts fleeing. 0 = none.
 *
 * @param fleeSeName
 * @type file
 * @dir audio/se
 * @default
 * @desc Sound effect played once when an event starts fleeing. Empty = none.
 *
 * @param fleeSeVolume
 * @type number
 * @default 90
 * @desc Volume for fleeSeName.
 *
 * @param fleeSePitch
 * @type number
 * @default 120
 * @desc Pitch for fleeSeName.
 *
 * @param suppressTurnOnContact
 * @type boolean
 * @default true
 * @desc If true, a fleeing symbol won't turn to face the player on contact (matches its "fear", avoids breaking the flee illusion).
 *
 * @param skillSealStateId
 * @type state
 * @default 0
 * @desc Only used in advantage mode. State (with Seal Skill Type trait) applied to enemies at battle start. 0 = skip.
 *
 * @help
 * Place this plugin BELOW HalfMove.js (or whatever plugin defines
 * Game_Character.prototype.findDirectionTo) in the Plugin Manager list.
 *
 * Any map event whose note contains <PsensorF...> (configurable via
 * sensorTag) is treated as an enemy symbol. Its trigger should be
 * Event Touch (matches the "symbol encounter" convention), though
 * Action Button and Player Touch are also honored for battle setup.
 *
 * Every frame, each symbol checks the party's level (per checkType)
 * and, if reactionDistance > 0, whether the player is within range
 * (Manhattan distance, extended by reactionDistanceDashBonus while
 * the player is dashing). If both conditions hold, the symbol enters
 * a "fleeing" state: any move route calling this.findDirectionTo(x, y)
 * toward the player has its direction inverted, so chase routes become
 * flee routes automatically. No canPass/wall check is done on purpose -
 * a feared monster can path itself into a wall and get stuck there,
 * which is intentional. On entering/leaving the fleeing state, move
 * speed/frequency are swapped to fleeSpeed/fleeFrequency (and restored
 * on leaving), and the balloon/SE fire once per episode. Checks are
 * skipped while a map event is currently running.
 *
 * Touching a feared event proceeds to battle normally, but the party
 * is granted a preemptive strike (same flag the engine's own
 * Preemptive Strike encounter roll uses), and, if skillSealStateId is
 * set, that state is applied to every enemy in the troop at battle
 * start.
 *
 * This plugin only touches its own _fts-prefixed properties on
 * Game_Event and reads no external switches/variables, so it shouldn't
 * conflict with other plugins.
 */
(() => {
  'use strict';
  const PLUGIN_NAME = 'FearTheStrong';
  const params = PluginManager.parameters(PLUGIN_NAME);
  const threshold = Number(params.levelThreshold || 99);
  const checkType = params.checkType || 'leader';
  const sensorTag = params.sensorTag || 'PsensorF';
  const reactionDistance = Number(params.reactionDistance || 0);
  const reactionDistanceDashBonus = Number(params.reactionDistanceDashBonus || 0);
  const fleeSpeed = Number(params.fleeSpeed || 0);
  const fleeFrequency = Number(params.fleeFrequency || 0);
  const fleeBalloonId = Number(params.fleeBalloonId || 0);
  const fleeSeName = params.fleeSeName || '';
  const fleeSeVolume = Number(params.fleeSeVolume || 90);
  const fleeSePitch = Number(params.fleeSePitch || 120);
  const suppressTurnOnContact = params.suppressTurnOnContact === 'true';
  const skillSealStateId = Number(params.skillSealStateId || 0);

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // Require a tag terminator (":" or ">") so e.g. "PsensorF" doesn't
  // false-positive on an unrelated "<PsensorFast>" tag.
  const sensorRegex = new RegExp(`<${escapeRegExp(sensorTag)}[:>]`);

  let fearedEncounterPending = false; // set true right before a feared event's command list runs
  const fearState = new WeakMap(); // Game_Event -> { fleeing, origSpeed, origFrequency }

  function getState(event) {
    let state = fearState.get(event);
    if (!state) {
      state = { fleeing: false, origSpeed: event.moveSpeed(), origFrequency: event.moveFrequency() };
      fearState.set(event, state);
    }
    return state;
  }

  function partyIsFeared() {
    const members = $gameParty.members();
    if (!members.length) return false;
    const levels = members.map(a => a.level);
    let value;
    if (checkType === 'average') value = levels.reduce((a, b) => a + b, 0) / levels.length;
    else if (checkType === 'lowest') value = Math.min(...levels);
    else value = $gameParty.leader().level;
    return value >= threshold;
  }

  function isEnemySymbol(event) {
    const data = event.event();
    return !!(data && data.note && sensorRegex.test(data.note));
  }

  function distanceToPlayer(event) {
    return Math.abs(event.deltaXFrom($gamePlayer.x)) + Math.abs(event.deltaYFrom($gamePlayer.y));
  }

  function isInReactionRange(event, state) {
    if (reactionDistance <= 0) return true;
    const dashBonus = $gamePlayer.isDashing() ? reactionDistanceDashBonus : 0;
    const jitterGuard = state.fleeing ? 1 : 0; // avoid flicker right at the boundary
    return distanceToPlayer(event) <= reactionDistance + dashBonus + jitterGuard;
  }

  function startFleeing(event, state) {
    state.fleeing = true;
    state.origSpeed = event.moveSpeed();
    state.origFrequency = event.moveFrequency();
    if (fleeSpeed > 0) event.setMoveSpeed(fleeSpeed);
    if (fleeFrequency > 0) event.setMoveFrequency(fleeFrequency);
    if (fleeBalloonId) $gameTemp.requestBalloon(event, fleeBalloonId);
    if (fleeSeName) AudioManager.playSe({ name: fleeSeName, volume: fleeSeVolume, pitch: fleeSePitch, pan: 0 });
  }

  function stopFleeing(event, state) {
    state.fleeing = false;
    event.setMoveSpeed(state.origSpeed);
    event.setMoveFrequency(state.origFrequency);
  }

  function shouldFlee(event) {
    if (!(event instanceof Game_Event) || !event._ftsIsSensor) return false;
    return getState(event).fleeing;
  }

  function reverseDir(dir) {
    return dir === 5 || dir === 0 ? dir : 10 - dir;
  }

  // Invert any pathing computed toward the player into pathing away from them.
  const _findDirectionTo = Game_Character.prototype.findDirectionTo;
  Game_Character.prototype.findDirectionTo = function(x, y) {
    if (!_findDirectionTo) return 0;
    const dir = _findDirectionTo.call(this, x, y);
    return shouldFlee(this) ? reverseDir(dir) : dir;
  };

  // Per-frame detection/forming check, mirroring the symbol encounter's
  // update_symbol_reaction -> active_symbol_encount? -> forming flow.
  const _update = Game_Event.prototype.update;
  Game_Event.prototype.update = function() {
    _update.call(this);
    if (this._erased || $gameMap.isEventRunning()) return;
    if (this._ftsIsSensor === undefined) this._ftsIsSensor = isEnemySymbol(this);
    if (!this._ftsIsSensor) return;
    const state = getState(this);
    const active = partyIsFeared() && isInReactionRange(this, state);
    if (active && !state.fleeing) startFleeing(this, state);
    else if (!active && state.fleeing) stopFleeing(this, state);
  };

  // Suppress the turn-toward-player on contact for a currently-fleeing
  // symbol, so it doesn't face the player right as it's caught.
  const _lock = Game_Event.prototype.lock;
  Game_Event.prototype.lock = function() {
    if (!this._locked && suppressTurnOnContact && shouldFlee(this)) {
      this._prelockDirection = this.direction();
      this._locked = true;
      return;
    }
    _lock.call(this);
  };

  const _start = Game_Event.prototype.start;
  Game_Event.prototype.start = function() {
    const page = this.page();
    const touchTrigger = page && (page.trigger === 0 || page.trigger === 1 || page.trigger === 2);
    if (touchTrigger && shouldFlee(this)) {
      fearedEncounterPending = true; // consumed by BattleManager.setup below
    }
    _start.call(this);
  };

  // Grant preemptive strike + optional skill-seal state when a feared
  // encounter's Battle Processing command actually runs.
  const _setup = BattleManager.setup;
  BattleManager.setup = function(troopId, canEscape, canLose) {
    _setup.call(this, troopId, canEscape, canLose);
    if (fearedEncounterPending) {
      fearedEncounterPending = false;
      this._preemptive = true;
      this._surprise = false;
      if (skillSealStateId > 0) {
        $gameTroop.members().forEach(enemy => {
          if (!enemy.isStateAffected(skillSealStateId)) {
            enemy.addState(skillSealStateId);
          }
        });
      }
    }
  };
})();
