//=============================================================================
// RPG Maker MZ - Take a Breather
//=============================================================================

/*:
 * @target MZ
 * @plugindesc Adds a "Take a Breather" battle command. Heals the user but
 * makes them more susceptible to status effects for the rest of the turn.
 * @author You
 * @url
 *
 * @help TakeABreather.js
 *
 * Save this file as TakeABreather.js (no spaces) in your js/plugins folder.
 * PluginManager.parameters() looks up parameters by filename, so a
 * mismatched name causes every parameter to silently fall back to its
 * default.
 *
 * Adds a new battle command to every actor: "Take a Breather".
 *   - Heals the user for a % of MaxHP (default 20%).
 *   - Applies a hidden "vulnerable" flag to the user until end of turn.
 *   - While vulnerable, incoming state application rates are multiplied
 *     by a configurable factor (default 1.5x).
 *
 * Optional: point "Vulnerable State ID" at a state in your database if you
 * want a visible icon. Set it to 0 to use the internal flag only.
 *
 * Optional: "HP Floor" prevents death from lethal damage. Set to 1 to make
 * the user survive at 1 HP. Set to 0 for normal behavior. Applies only to
 * actors (the party) during battle — enemies are untouched and remain
 * killable, and the floor is automatically suspended whenever the battle
 * was flagged "Can Lose" via the Battle Processing event command, so a
 * scripted defeat still actually kills the party. Applies to all
 * in-battle HP loss for actors while active, not just Breather
 * vulnerability. This is intentional: it's meant to be an always-on
 * anti-death net for normal battles, not something scoped to the
 * breather mechanic.
 *
 * No plugin commands. No database edits required.
 *
 * @param HealPercent
 * @text Heal Percent
 * @desc Percent of MaxHP healed. 20 = 20%.
 * @type number
 * @min 0
 * @max 100
 * @default 20
 *
 * @param CommandName
 * @text Command Name
 * @desc Name shown in the actor command window.
 * @type text
 * @default Take a Breather
 *
 * @param VulnerableStateId
 * @text Vulnerable State ID
 * @desc Optional state ID to apply for visibility. 0 = use internal flag only.
 * @type state
 * @default 0
 *
 * @param StateRateMultiplier
 * @text State Rate Multiplier
 * @desc Multiplier applied to incoming state rates while vulnerable. 1.5 = +50%.
 * @type number
 * @decimals 2
 * @min 0
 * @default 1.5
 *
 * @param HpFloor
 * @text HP Floor
 * @desc Minimum HP the battler is left at when taking lethal damage. 0 = normal.
 * @type number
 * @min 0
 * @default 0
 */

(function() {
    'use strict';

    var params = PluginManager.parameters('TakeABreather');
    var HEAL_PERCENT       = Number(params['HealPercent'] || 20);
    var COMMAND_NAME       = String(params['CommandName'] || 'Take a Breather');
    var VULN_STATE_ID      = Number(params['VulnerableStateId'] || 0);
    var STATE_RATE_MULT    = Number(params['StateRateMultiplier'] || 1.5);
    var HP_FLOOR           = Number(params['HpFloor'] || 0);

    //---------------------------------------------------------------------
    // Game_Battler - vulnerability flag
    //---------------------------------------------------------------------

    var _Game_Battler_initMembers = Game_Battler.prototype.initMembers;
    Game_Battler.prototype.initMembers = function() {
        _Game_Battler_initMembers.call(this);
        this._breatherVulnerable = false;
    };

    Game_Battler.prototype.setBreatherVulnerable = function(value) {
        this._breatherVulnerable = !!value;
        if (VULN_STATE_ID > 0) {
            if (value) {
                this.addState(VULN_STATE_ID);
            } else {
                this.removeState(VULN_STATE_ID);
            }
        }
    };

    Game_Battler.prototype.isBreatherVulnerable = function() {
        return !!this._breatherVulnerable;
    };

    //---------------------------------------------------------------------
    // Game_Battler - stateRate multiplier while vulnerable
    //---------------------------------------------------------------------

    var _Game_Battler_stateRate = Game_Battler.prototype.stateRate;
    Game_Battler.prototype.stateRate = function(stateId) {
        var rate = _Game_Battler_stateRate.call(this, stateId);
        if (this.isBreatherVulnerable()) {
            rate *= STATE_RATE_MULT;
        }
        return rate;
    };

    //---------------------------------------------------------------------
    // Game_Actor - HP floor (optional non-lethal mode for the PARTY only).
    // Patched on Game_Actor, not Game_Battler, so enemies are unaffected
    // and remain killable. Only applies during battle, and is suspended
    // whenever BattleManager.canLose() is true — i.e. the battle was set
    // up with the "Can Lose" option on the "Battle Processing" event
    // command, RPG Maker's standard way to script a loss without kicking
    // to the Game Over screen. That lets a scripted defeat actually kill
    // the party as intended, instead of everyone bobbing at HP_FLOOR.
    // Caveat: this only catches losses scripted through that flag. A
    // death forced via a Common Event's "Change HP" command outside a
    // Can-Lose battle will still be floored, since there's no generic
    // signal to detect "this HP=0 is intentional" in that case.
    //---------------------------------------------------------------------

    if (HP_FLOOR > 0) {
        var _Game_Actor_setHp = Game_Actor.prototype.setHp;
        Game_Actor.prototype.setHp = function(hp) {
            var scriptedLoss = $gameParty.inBattle() &&
                BattleManager.canLose && BattleManager.canLose();
            var floored = scriptedLoss ? hp : Math.max(hp, HP_FLOOR);
            _Game_Actor_setHp.call(this, floored);
        };
    }

    //---------------------------------------------------------------------
    // Game_Actor - breather action
    //---------------------------------------------------------------------

    Game_Actor.prototype.performBreather = function() {
        var heal = Math.floor(this.mhp * HEAL_PERCENT / 100);
        this.gainHp(heal);
        this.startDamagePopup && this.startDamagePopup();
        this.setBreatherVulnerable(true);
    };

    //---------------------------------------------------------------------
    // Window_ActorCommand - add the command
    //---------------------------------------------------------------------

    var _Window_ActorCommand_makeCommandList = Window_ActorCommand.prototype.makeCommandList;
    Window_ActorCommand.prototype.makeCommandList = function() {
        _Window_ActorCommand_makeCommandList.call(this);
        if (this._actor) {
            this.addCommand(COMMAND_NAME, 'breather', this._actor.canMove());
        }
    };

    //---------------------------------------------------------------------
    // Scene_Battle - handle command selection and execution
    //---------------------------------------------------------------------

    var _Scene_Battle_createActorCommandWindow = Scene_Battle.prototype.createActorCommandWindow;
    Scene_Battle.prototype.createActorCommandWindow = function() {
        _Scene_Battle_createActorCommandWindow.call(this);
        this._actorCommandWindow.setHandler('breather', this.commandBreather.bind(this));
    };

    Scene_Battle.prototype.commandBreather = function() {
        var actor = BattleManager.actor();
        if (actor) {
            actor.performBreather();
        }
        // selectNextCommand advances to the next actor's command input if
        // the party has more members left to queue, or proceeds to action
        // execution only once everyone has chosen. This is unchanged
        // between MV and MZ.
        this.selectNextCommand();
    };

    //---------------------------------------------------------------------
    // Cleanup - clear the flag at end of turn and end of battle
    //---------------------------------------------------------------------

    var _BattleManager_endTurn = BattleManager.endTurn;
    BattleManager.endTurn = function() {
        _BattleManager_endTurn.call(this);
        this.clearBreatherFlags();
    };

    var _BattleManager_endBattle = BattleManager.endBattle;
    BattleManager.endBattle = function(result) {
        this.clearBreatherFlags();
        _BattleManager_endBattle.call(this, result);
    };

    BattleManager.clearBreatherFlags = function() {
        if ($gameParty && $gameParty.members) {
            $gameParty.members().forEach(function(actor) {
                actor.setBreatherVulnerable(false);
            });
        }
        if ($gameTroop && $gameTroop.members) {
            $gameTroop.members().forEach(function(enemy) {
                enemy.setBreatherVulnerable(false);
            });
        }
    };

})();
