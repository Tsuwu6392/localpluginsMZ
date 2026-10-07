//=============================================================================
// LockState.js
//=============================================================================

/*:
 * @target MZ
 * @plugindesc Debug tool: lock party actors' states so nothing removes them except an explicit unlock.
 *
 * @param hotkey
 * @text Hotkey
 * @type string
 * @default S
 * @desc Single letter A-Z that opens the lock window (map and battle). Overrides any existing binding for that key.
 *
 * @command LockState
 * @text Lock State
 * @desc Locks a state on party actors. The actor must have the state (unless Add If Missing is on).
 *
 * @arg actorId
 * @text Actor
 * @type actor
 * @default 0
 * @desc (None) = entire party.
 *
 * @arg stateId
 * @text State
 * @type state
 * @default 1
 *
 * @arg addIfMissing
 * @text Add If Missing
 * @type boolean
 * @default false
 *
 * @command UnlockState
 * @text Unlock State
 * @desc Unlocks a state on party actors.
 *
 * @arg actorId
 * @text Actor
 * @type actor
 * @default 0
 * @desc (None) = entire party.
 *
 * @arg stateId
 * @text State
 * @type state
 * @default 0
 * @desc (None) = every locked state.
 *
 * @arg remove
 * @text Also Remove State
 * @type boolean
 * @default false
 *
 * @help
 * A locked state is never removed by anything: battle end, expiry, damage,
 * walking, cures, event commands, death, Recover All, equipment resistance,
 * other plugins. Its turn counter is frozen. Only an explicit unlock ends it
 * (lock window, plugin command, script call). Actors only; enemies untouched.
 * The Death state can't be locked. Locks are saved with the actor.
 *
 * Lock window
 *   Press the hotkey on the map, or in battle while choosing a command.
 *   Left: party actors with locked/active counts. Right: the actor's active
 *   states with a checkbox. OK toggles, Cancel goes back, hotkey closes.
 *
 * Skill/Item notetags
 *   <Lock State: 12, 13>     Lock these states when this skill/item adds them.
 *   <Lock All Added States>  Lock every state this skill/item adds.
 *
 * Script calls (actor = $gameActors.actor(id))
 *   actor.lockState(stateId)               -> true if locked
 *   actor.unlockState(stateId, remove)     -> remove: also remove the state
 *   actor.unlockAllStates(remove)
 *   actor.isStateLocked(stateId)
 *   actor.lockedStates()                   -> array of state IDs
 *
 * MV plugin commands
 *   LockState actorId stateId [add]        actorId 0 = party
 *   UnlockState actorId stateId [remove]   stateId 0 = all
 */

(() => {
    'use strict';

    const script = document.currentScript;
    const NAME = script
        ? decodeURIComponent(script.src.split('/').pop()).replace(/\.js$/i, '')
        : 'LockState';
    const raw = PluginManager.parameters(NAME);
    const hotkeyParam = String(raw.hotkey === undefined ? 'S' : raw.hotkey).trim();
    const HOTKEY = /^[a-z]$/i.test(hotkeyParam) ? hotkeyParam.toUpperCase() : 'S';
    const bool = (v, d) => (v === undefined || v === '' ? d : String(v) === 'true');

    let actionItem = null; // item/skill whose add-state effect is executing

    const parseIds = v =>
        String(v === undefined ? '' : v)
            .split(',')
            .map(s => Number(s.trim()))
            .filter(n => n > 0);

    const locksOnAdd = (item, stateId) => {
        if (!item || !item.meta) return false;
        if (item.meta['Lock All Added States']) return true;
        return parseIds(item.meta['Lock State']).includes(stateId);
    };

    //-------------------------------------------------------------------------
    // Game_Actor: lock storage and enforcement
    //-------------------------------------------------------------------------

    Game_Actor.prototype.lockedStates = function() {
        if (!this._lockedStates) this._lockedStates = [];
        return this._lockedStates;
    };

    Game_Actor.prototype.isStateLocked = function(stateId) {
        return !!this._lockedStates && this._lockedStates.includes(stateId);
    };

    Game_Actor.prototype.canLockState = function(stateId) {
        return !!$dataStates[stateId] && stateId !== this.deathStateId();
    };

    Game_Actor.prototype.lockState = function(stateId) {
        if (!this.isStateAffected(stateId) || !this.canLockState(stateId)) return false;
        if (!this.isStateLocked(stateId)) this.lockedStates().push(stateId);
        return true;
    };

    Game_Actor.prototype.unlockState = function(stateId, remove) {
        const list = this.lockedStates();
        const i = list.indexOf(stateId);
        if (i >= 0) list.splice(i, 1);
        if (remove) this.removeState(stateId);
    };

    Game_Actor.prototype.unlockAllStates = function(remove) {
        this.lockedStates().slice().forEach(id => this.unlockState(id, remove));
    };

    // Fresh setup starts with no locks.
    const _setup = Game_Actor.prototype.setup;
    Game_Actor.prototype.setup = function(actorId) {
        this._lockedStates = [];
        _setup.call(this, actorId);
    };

    // removeState: blocked silently (no "removed" log line).
    // eraseState: blocked too, so nothing else can strip a locked state.
    const _removeState = Game_Actor.prototype.removeState;
    Game_Actor.prototype.removeState = function(stateId) {
        if (this.isStateLocked(stateId)) return;
        _removeState.call(this, stateId);
    };

    const _eraseState = Game_Actor.prototype.eraseState;
    Game_Actor.prototype.eraseState = function(stateId) {
        if (this.isStateLocked(stateId)) return;
        _eraseState.call(this, stateId);
    };

    // Death, Recover All, etc. call clearStates; locked states survive it.
    const _clearStates = Game_Actor.prototype.clearStates;
    Game_Actor.prototype.clearStates = function() {
        const keep = Array.from(new Set(this._lockedStates || []))
            .filter(id => (this._states || []).includes(id));
        const turns = {};
        const steps = {};
        keep.forEach(id => {
            turns[id] = this._stateTurns[id];
            if (this._stateSteps) steps[id] = this._stateSteps[id];
        });
        _clearStates.call(this);
        if (this._lockedStates) this._lockedStates = keep.slice();
        keep.forEach(id => {
            // Another plugin's clearStates may have left it in place already.
            if (!this._states.includes(id)) this._states.push(id);
            this._stateTurns[id] = turns[id];
            if (steps[id] !== undefined) this._stateSteps[id] = steps[id];
        });
    };

    // Frozen turn counters.
    const _updateStateTurns = Game_Actor.prototype.updateStateTurns;
    Game_Actor.prototype.updateStateTurns = function() {
        const frozen = {};
        this.lockedStates().forEach(id => {
            if (this._stateTurns[id] !== undefined) frozen[id] = this._stateTurns[id];
        });
        _updateStateTurns.call(this);
        Object.keys(frozen).forEach(id => { this._stateTurns[id] = frozen[id]; });
    };

    // Lock states added by a skill/item carrying the notetags.
    // A state's identity is (actor, stateId): there is only ever one instance.
    Game_Actor.prototype.normalizeStates = function() {
        if (this._states && new Set(this._states).size !== this._states.length) {
            this._states = Array.from(new Set(this._states));
        }
        if (this._lockedStates && new Set(this._lockedStates).size !== this._lockedStates.length) {
            this._lockedStates = Array.from(new Set(this._lockedStates));
        }
    };

    const _refresh = Game_Actor.prototype.refresh;
    Game_Actor.prototype.refresh = function() {
        this.normalizeStates(); // also heals saves that already hold duplicates
        _refresh.call(this);
    };

    const _addNewState = Game_Actor.prototype.addNewState;
    Game_Actor.prototype.addNewState = function(stateId) {
        if (this._states.includes(stateId)) return;
        _addNewState.call(this, stateId);
    };

    const _addState = Game_Actor.prototype.addState;
    Game_Actor.prototype.addState = function(stateId) {
        // Re-applying a locked state is the same instance: nothing to do.
        if (this.isStateLocked(stateId) && this.isStateAffected(stateId)) return;
        _addState.call(this, stateId);
        this.normalizeStates();
        if (actionItem && this.isStateAffected(stateId) && locksOnAdd(actionItem, stateId)) {
            this.lockState(stateId);
        }
    };

    const _itemEffectAddState = Game_Action.prototype.itemEffectAddState;
    Game_Action.prototype.itemEffectAddState = function(target, effect) {
        const prev = actionItem;
        actionItem = this.item();
        try {
            _itemEffectAddState.call(this, target, effect);
        } finally {
            actionItem = prev;
        }
    };

    //-------------------------------------------------------------------------
    // Plugin commands (party actors only)
    //-------------------------------------------------------------------------

    const partyTargets = actorId => {
        const members = $gameParty.allMembers();
        return actorId > 0 ? members.filter(a => a.actorId() === actorId) : members;
    };

    const doLock = (actorId, stateId, add) => {
        if (stateId <= 0) return;
        partyTargets(actorId).forEach(a => {
            if (add && !a.isStateAffected(stateId)) a.addState(stateId);
            a.lockState(stateId);
        });
    };

    const doUnlock = (actorId, stateId, remove) => {
        partyTargets(actorId).forEach(a => {
            if (stateId > 0) a.unlockState(stateId, remove);
            else a.unlockAllStates(remove);
        });
    };

    if (typeof PluginManager.registerCommand === 'function') {
        // MZ
        PluginManager.registerCommand(NAME, 'LockState', args => {
            doLock(Number(args.actorId || 0), Number(args.stateId || 0), bool(args.addIfMissing, false));
        });
        PluginManager.registerCommand(NAME, 'UnlockState', args => {
            doUnlock(Number(args.actorId || 0), Number(args.stateId || 0), bool(args.remove, false));
        });
    } else {
        // MV
        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function(command, args) {
            _pluginCommand.call(this, command, args);
            const actorId = Number(args[0] || 0);
            const stateId = Number(args[1] || 0);
            const flag = String(args[2] || '').toLowerCase();
            if (command === 'LockState') doLock(actorId, stateId, flag === 'add');
            if (command === 'UnlockState') doUnlock(actorId, stateId, flag === 'remove');
        };
    }

    //-------------------------------------------------------------------------
    // Lock window UI
    //-------------------------------------------------------------------------

    const isMZ = Utils.RPGMAKER_NAME === 'MZ';

    const makeWindow = (Class, x, y, w, h) =>
        isMZ ? new Class(new Rectangle(x, y, w, h)) : new Class(x, y, w, h);

    const textColor = (win, n) =>
        typeof ColorManager !== 'undefined' ? ColorManager.textColor(n) : win.textColor(n);

    const lineRect = (win, i) =>
        win.itemLineRect ? win.itemLineRect(i) : win.itemRectForText(i);

    Input.keyMapper[HOTKEY.charCodeAt(0)] = 'lockStates';

    // --- Actor list ---------------------------------------------------------

    function Window_LockActors() {
        this.initialize.apply(this, arguments);
    }
    // MZ moved drawActorName to Window_StatusBase; MV has it on Window_Base.
    const ActorsBase = typeof Window_StatusBase !== 'undefined'
        ? Window_StatusBase
        : Window_Selectable;
    Window_LockActors.prototype = Object.create(ActorsBase.prototype);
    Window_LockActors.prototype.constructor = Window_LockActors;

    Window_LockActors.prototype.setStatesWindow = function(win) {
        this._statesWindow = win;
        this.updateStatesWindow();
    };

    Window_LockActors.prototype.maxItems = function() {
        return $gameParty.allMembers().length;
    };

    Window_LockActors.prototype.actor = function() {
        return $gameParty.allMembers()[this.index()] || null;
    };

    Window_LockActors.prototype.isCurrentItemEnabled = function() {
        const actor = this.actor();
        return !!actor && actor.states().length > 0;
    };

    Window_LockActors.prototype.select = function(index) {
        Window_Selectable.prototype.select.call(this, index);
        this.updateStatesWindow();
    };

    Window_LockActors.prototype.updateStatesWindow = function() {
        if (this._statesWindow) this._statesWindow.setActor(this.actor());
    };

    Window_LockActors.prototype.drawItem = function(index) {
        const actor = $gameParty.allMembers()[index];
        if (!actor) return;
        const rect = lineRect(this, index);
        const info = actor.lockedStates().length + '/' + actor.states().length;
        const infoW = this.textWidth('00/00');
        this.changePaintOpacity(actor.states().length > 0);
        this.drawActorName(actor, rect.x, rect.y, rect.width - infoW - 8);
        this.drawText(info, rect.x + rect.width - infoW, rect.y, infoW, 'right');
        this.changePaintOpacity(true);
    };

    Window_LockActors.prototype.refresh = function() {
        if (!isMZ) this.createContents();
        Window_Selectable.prototype.refresh.call(this);
    };

    // --- State list with checkboxes ----------------------------------------

    function Window_LockStates() {
        this.initialize.apply(this, arguments);
    }
    Window_LockStates.prototype = Object.create(Window_Selectable.prototype);
    Window_LockStates.prototype.constructor = Window_LockStates;

    Window_LockStates.prototype.setActor = function(actor) {
        this._actor = actor;
        this.deselect();
        this.refresh();
    };

    Window_LockStates.prototype.maxItems = function() {
        return this._data ? this._data.length : 0;
    };

    Window_LockStates.prototype.currentState = function() {
        return this._data ? this._data[this.index()] || null : null;
    };

    Window_LockStates.prototype.isStateEnabled = function(state) {
        return this._actor.isStateLocked(state.id) || this._actor.canLockState(state.id);
    };

    Window_LockStates.prototype.isCurrentItemEnabled = function() {
        const state = this.currentState();
        return !!state && this.isStateEnabled(state);
    };

    Window_LockStates.prototype.makeItemList = function() {
        this._data = this._actor ? this._actor.states().filter(s => !!s) : [];
    };

    Window_LockStates.prototype.refresh = function() {
        this.makeItemList();
        if (!isMZ) this.createContents();
        Window_Selectable.prototype.refresh.call(this);
    };

    Window_LockStates.prototype.drawItem = function(index) {
        const state = this._data[index];
        if (!state) return;
        const rect = lineRect(this, index);
        const enabled = this.isStateEnabled(state);
        const locked = this._actor.isStateLocked(state.id);
        const size = 20;
        const bx = rect.x;
        const by = rect.y + Math.floor((rect.height - size) / 2);
        const color = textColor(this, 0);

        this.changePaintOpacity(enabled);
        this.contents.strokeRect(bx, by, size, size, color);
        this.contents.strokeRect(bx + 1, by + 1, size - 2, size - 2, color);
        if (locked) this.contents.fillRect(bx + 5, by + 5, size - 10, size - 10, color);

        let x = bx + size + 8;
        if (state.iconIndex > 0) {
            this.drawIcon(state.iconIndex, x, rect.y + 2);
            x += 36;
        }
        const tw = this.textWidth('000t');
        this.drawText(state.name, x, rect.y, rect.x + rect.width - tw - 8 - x);
        const turns = this._actor._stateTurns ? this._actor._stateTurns[state.id] : 0;
        if (turns > 0) {
            this.drawText(turns + 't', rect.x + rect.width - tw, rect.y, tw, 'right');
        }
        this.changePaintOpacity(true);
    };

    // --- Hint bar -----------------------------------------------------------

    function Window_LockHint() {
        this.initialize.apply(this, arguments);
    }
    Window_LockHint.prototype = Object.create(Window_Base.prototype);
    Window_LockHint.prototype.constructor = Window_LockHint;

    Window_LockHint.prototype.refresh = function() {
        this.contents.clear();
        this.drawText(
            'OK: toggle lock    Cancel: back    ' + HOTKEY + ': close',
            0, 0, this.contents.width, 'center'
        );
    };

    // Builds the three windows and wires their handlers. Shared by the
    // map scene and the in-battle overlay.
    const createLockWindows = (scene, top, avail, onClose) => {
        const hintH = 72;
        const listH = avail - hintH;
        const aw = Math.floor(Graphics.boxWidth * 0.35);
        const actorWin = makeWindow(Window_LockActors, 0, top, aw, listH);
        const statesWin = makeWindow(Window_LockStates, aw, top, Graphics.boxWidth - aw, listH);
        const hintWin = makeWindow(Window_LockHint, 0, top + listH, Graphics.boxWidth, hintH);

        actorWin.setStatesWindow(statesWin);
        actorWin.setHandler('ok', () => {
            statesWin.activate();
            statesWin.select(0);
        });
        actorWin.setHandler('cancel', onClose);
        statesWin.setHandler('ok', () => {
            const actor = actorWin.actor();
            const state = statesWin.currentState();
            if (actor && state) {
                if (actor.isStateLocked(state.id)) actor.unlockState(state.id, false);
                else actor.lockState(state.id);
            }
            statesWin.refresh();
            actorWin.refresh();
            statesWin.activate();
        });
        statesWin.setHandler('cancel', () => {
            statesWin.deselect();
            actorWin.activate();
        });

        scene.addWindow(actorWin);
        scene.addWindow(statesWin);
        scene.addWindow(hintWin);
        hintWin.refresh();
        return { actor: actorWin, states: statesWin, hint: hintWin };
    };

    // --- Map scene ----------------------------------------------------------

    function Scene_LockState() {
        this.initialize.apply(this, arguments);
    }
    Scene_LockState.prototype = Object.create(Scene_MenuBase.prototype);
    Scene_LockState.prototype.constructor = Scene_LockState;

    Scene_LockState.prototype.initialize = function() {
        Scene_MenuBase.prototype.initialize.call(this);
    };

    Scene_LockState.prototype.create = function() {
        Scene_MenuBase.prototype.create.call(this);
        const top = this.mainAreaTop ? this.mainAreaTop() : 0;
        const avail = this.mainAreaHeight ? this.mainAreaHeight() : Graphics.boxHeight;
        const ui = createLockWindows(this, top, avail, this.popScene.bind(this));
        this._actorWindow = ui.actor;
        this._statesWindow = ui.states;
        this._hintWindow = ui.hint;
    };

    Scene_LockState.prototype.start = function() {
        Scene_MenuBase.prototype.start.call(this);
        this._actorWindow.refresh();
        const i = $gameParty.allMembers().indexOf($gameParty.menuActor());
        this._actorWindow.select(Math.max(0, i));
        this._actorWindow.activate();
    };

    Scene_LockState.prototype.update = function() {
        Scene_MenuBase.prototype.update.call(this);
        if (Input.isTriggered('lockStates')) {
            SoundManager.playCancel();
            this.popScene();
        }
    };

    const _Scene_Map_updateScene = Scene_Map.prototype.updateScene;
    Scene_Map.prototype.updateScene = function() {
        _Scene_Map_updateScene.call(this);
        if (!SceneManager.isSceneChanging()) this.updateLockStateCall();
    };

    Scene_Map.prototype.updateLockStateCall = function() {
        if (!$gameMap.isEventRunning()) {
            if (Input.isTriggered('lockStates')) this._lockStateCalling = true;
            if (this._lockStateCalling && !$gamePlayer.isMoving()) {
                this._lockStateCalling = false;
                $gamePlayer.straighten();
                SoundManager.playOk();
                SceneManager.push(Scene_LockState);
            }
        } else {
            this._lockStateCalling = false;
        }
    };

    //-------------------------------------------------------------------------
    // In-battle overlay (same windows, no scene push)
    //-------------------------------------------------------------------------

    const _Scene_Battle_createAllWindows = Scene_Battle.prototype.createAllWindows;
    Scene_Battle.prototype.createAllWindows = function() {
        _Scene_Battle_createAllWindows.call(this);
        this._lockUI = createLockWindows(this, 0, Graphics.boxHeight, this.closeLockUI.bind(this));
        this._lockUI.actor.hide();
        this._lockUI.states.hide();
        this._lockUI.hint.hide();
        this._lockUI.actor.deactivate();
        this._lockUI.states.deactivate();
    };

    Scene_Battle.prototype.isLockUIOpen = function() {
        return !!this._lockUI && this._lockUI.actor.visible;
    };

    Scene_Battle.prototype.openLockUI = function() {
        const ui = this._lockUI;
        // Park every currently active input window so it can't take input.
        this._lockPrevActive = this._windowLayer.children.filter(
            w => w.active && w !== ui.actor && w !== ui.states
        );
        this._lockPrevActive.forEach(w => w.deactivate());
        ui.actor.show();
        ui.states.show();
        ui.hint.show();
        ui.actor.refresh();
        const i = $gameParty.allMembers().indexOf(BattleManager.actor());
        ui.actor.select(Math.max(0, i));
        ui.actor.activate();
    };

    Scene_Battle.prototype.closeLockUI = function() {
        const ui = this._lockUI;
        ui.actor.deactivate();
        ui.states.deactivate();
        ui.states.deselect();
        ui.actor.hide();
        ui.states.hide();
        ui.hint.hide();
        (this._lockPrevActive || []).forEach(w => { if (w.visible) w.activate(); });
        this._lockPrevActive = [];
    };

    // Keep the battle flow from reshuffling input windows while the overlay is up.
    const _isAnyInputWindowActive = Scene_Battle.prototype.isAnyInputWindowActive;
    Scene_Battle.prototype.isAnyInputWindowActive = function() {
        return this.isLockUIOpen() || _isAnyInputWindowActive.call(this);
    };

    const _needsInputWindowChange = Scene_Battle.prototype.needsInputWindowChange;
    if (_needsInputWindowChange) {
        Scene_Battle.prototype.needsInputWindowChange = function() {
            return this.isLockUIOpen() ? false : _needsInputWindowChange.call(this);
        };
    }

    // MZ time-progress battle: pause the clock while the overlay is open.
    const _isTimeActive = Scene_Battle.prototype.isTimeActive;
    if (_isTimeActive) {
        Scene_Battle.prototype.isTimeActive = function() {
            return this.isLockUIOpen() ? false : _isTimeActive.call(this);
        };
    }

    const _Scene_Battle_update = Scene_Battle.prototype.update;
    Scene_Battle.prototype.update = function() {
        _Scene_Battle_update.call(this);
        if (this._lockUI && Input.isTriggered('lockStates')) {
            if (this.isLockUIOpen()) {
                SoundManager.playCancel();
                this.closeLockUI();
            } else if (BattleManager.isInputting() && !this.isBusy()) {
                SoundManager.playOk();
                this.openLockUI();
            }
        }
    };

    window.Scene_LockState = Scene_LockState;
})();
